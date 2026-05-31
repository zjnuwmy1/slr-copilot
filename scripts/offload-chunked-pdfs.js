#!/usr/bin/env node
/**
 * scripts/offload-chunked-pdfs.js — 2026-05-31 磁盘优化一次性积压清理
 *
 * 两件事:
 *   1. offload 所有"已 chunk + 有未 offload PDF 源文件"的 record(删源文件,
 *      保留 paper_chunks + attachments 行,标 pdf_offloaded_at)
 *   2. 删所有 status='ingested' 的 Zotero 包的冗余 upload.zip
 *
 * 安全:复用 services/pdf-offload.js 的 DATA_DIR 守卫;upload.zip 只删 UPLOAD_ROOT 内的。
 *
 * 用法:
 *   node scripts/offload-chunked-pdfs.js --dry-run   # 只统计,不删
 *   node scripts/offload-chunked-pdfs.js --apply     # 真删
 *
 * 环境变量(跟主程序一致):
 *   DB_PATH(默认 /var/lib/slr/db/slr.db)、DATA_DIR、SLR_PDF_ROOT、SLR_UPLOAD_ROOT
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

const DB_PATH     = process.env.DB_PATH        || '/var/lib/slr/db/slr.db'
const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')

if (!fs.existsSync(DB_PATH)) { console.error(`DB not found: ${DB_PATH}`); process.exit(2) }

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const db = new Database(DB_PATH, { readonly: DRY_RUN })
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

console.log(`DB:           ${DB_PATH}`)
console.log(`Mode:         ${DRY_RUN ? 'DRY-RUN (只统计)' : 'APPLY (真删)'}\n`)

// ============== 1. PDF 源文件 offload ==============
console.log('=== 1. PDF 源文件 offload(已 chunk 的)===')
const candidates = db.prepare(`
  SELECT DISTINCT r.id AS record_id
    FROM records r
    JOIN attachments a ON a.record_id = r.id
   WHERE a.attachment_kind = 'pdf'
     AND a.pdf_offloaded_at IS NULL
     AND EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.record_id = r.id)
`).all()
console.log(`候选 record(有 chunks + 有未 offload PDF):${candidates.length}`)

if (DRY_RUN) {
  // 估算可释放空间:这些 record 的 PDF attachment size_bytes 之和(每 record 取 max,近似 inode)
  let estBytes = 0
  const sizeStmt = db.prepare(
    `SELECT MAX(size_bytes) AS m FROM attachments
      WHERE record_id = ? AND attachment_kind = 'pdf' AND pdf_offloaded_at IS NULL`
  )
  for (const c of candidates) { estBytes += (sizeStmt.get(c.record_id)?.m || 0) }
  console.log(`预计可释放(估算):${fmtBytes(estBytes)}\n`)
} else {
  const { offloadAllChunkedPdfs } = await import('../services/pdf-offload.js')
  const r = offloadAllChunkedPdfs(db, { reason: 'one_time_backlog_sweep' })
  console.log(`已 offload record:${r.records_offloaded} / ${r.records_processed}`)
  console.log(`实际释放:${fmtBytes(r.total_bytes_freed)}\n`)
}

// ============== 2. Zotero upload.zip 清理 ==============
console.log('=== 2. Zotero upload.zip 清理(已 ingested 的包)===')
const pkgs = db.prepare(
  `SELECT id FROM zotero_packages WHERE status = 'ingested'`
).all()
let zipFound = 0, zipBytes = 0, zipDeleted = 0
for (const p of pkgs) {
  const zipPath = path.resolve(path.join(UPLOAD_ROOT, p.id, 'upload.zip'))
  if (!zipPath.startsWith(UPLOAD_ROOT + path.sep)) continue
  if (!fs.existsSync(zipPath)) continue
  zipFound++
  let sz = 0; try { sz = fs.statSync(zipPath).size } catch {}
  zipBytes += sz
  if (APPLY) {
    try { fs.unlinkSync(zipPath); zipDeleted++ } catch (e) { console.warn('  unlink failed:', zipPath, e.message) }
  }
}
console.log(`已 ingested 包:${pkgs.length},发现 upload.zip:${zipFound}(${fmtBytes(zipBytes)})`)
if (APPLY) console.log(`已删:${zipDeleted}`)
else console.log('(dry-run,未删)')

console.log('\n完成。' + (DRY_RUN ? ' 加 --apply 真正执行。' : ''))
// audit() 用 setImmediate 延迟写,延后关库让审计行落地(offload 的 UPDATE 已同步提交,数据安全)
setTimeout(() => { try { db.close() } catch {} }, 1000)
