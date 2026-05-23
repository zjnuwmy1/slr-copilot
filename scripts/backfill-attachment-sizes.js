#!/usr/bin/env node
/**
 * B1.2 — 回填 attachments.size_bytes
 *
 * 背景:历史 zotero-merge.js 写 attachments 行时漏填 size_bytes,
 *      导致 storageUsedByUser 计算偏少 → 用户能超过 1 GB 配额而不被拒。
 *
 * 本脚本扫所有 attachments where size_bytes IS NULL,fs.statSync(storage_path)
 * 取真实文件大小并回填。
 *
 * 用法:
 *   node scripts/backfill-attachment-sizes.js --dry-run   # 只统计,不写库
 *   node scripts/backfill-attachment-sizes.js --apply     # 真写库
 *
 * 找不到对应文件的(storage_path 失效)会标记到日志,不回填,留给 B1.6 sweep 处理。
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const APPLY   = args.includes('--apply')

if (!DRY_RUN && !APPLY) {
  console.error('请显式指定 --dry-run 或 --apply')
  process.exit(2)
}

const DB_PATH = process.env.SLR_DB_PATH || '/var/lib/slr/slr.db'
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`)
  process.exit(2)
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const rows = db.prepare(`
  SELECT id, storage_path, filename
    FROM attachments
   WHERE size_bytes IS NULL
      OR size_bytes = 0
`).all()

console.log(`扫到 ${rows.length} 条 attachment 缺 size_bytes`)

let okCount = 0
let missingCount = 0
let totalBytes = 0
const missing = []
const updates = []

for (const r of rows) {
  if (!r.storage_path) {
    missingCount++
    missing.push({ id: r.id, filename: r.filename, reason: 'storage_path is NULL' })
    continue
  }
  try {
    const st = fs.statSync(r.storage_path)
    if (!st.isFile()) {
      missingCount++
      missing.push({ id: r.id, filename: r.filename, reason: 'not a regular file' })
      continue
    }
    updates.push({ id: r.id, bytes: st.size })
    totalBytes += st.size
    okCount++
  } catch (e) {
    missingCount++
    missing.push({ id: r.id, filename: r.filename, reason: e.code || e.message })
  }
}

console.log(`可回填: ${okCount} 条 / 共 ${formatBytes(totalBytes)}`)
console.log(`缺失/失效: ${missingCount} 条`)

if (missing.length > 0) {
  console.log('\n--- 失效附件(storage_path 文件不存在或不是普通文件)---')
  for (const m of missing.slice(0, 30)) {
    console.log(`  [${m.id}] ${m.filename || '(no name)'} — ${m.reason}`)
  }
  if (missing.length > 30) console.log(`  ... 还有 ${missing.length - 30} 条`)
  console.log('提示:这些可以让 scripts/sweep-orphan-files.js 处理(它会清理孤儿文件)')
}

if (DRY_RUN) {
  console.log('\n[dry-run] 未写库。如要实际回填请加 --apply')
  process.exit(0)
}

if (updates.length === 0) {
  console.log('无可回填,退出')
  process.exit(0)
}

const upd = db.prepare(`UPDATE attachments SET size_bytes = ? WHERE id = ?`)
const tx = db.transaction((batch) => {
  for (const u of batch) upd.run(u.bytes, u.id)
})

console.log(`\n开始回填 ${updates.length} 条 ...`)
tx(updates)
console.log(`✓ 已回填,合计 ${formatBytes(totalBytes)} 计入用户存储统计`)
console.log('\n建议接下来跑:node scripts/sweep-orphan-files.js --dry-run')

function formatBytes(bytes) {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
