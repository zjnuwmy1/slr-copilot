#!/usr/bin/env node
/**
 * B1.6 — 扫并报告/清理 /var/lib/slr 下的孤儿文件
 *
 * 孤儿定义:
 *   - /var/lib/slr/pdfs/*.pdf  无对应的 attachments.storage_path 引用
 *   - /var/lib/slr/uploads/**  无对应的 zotero_packages.storage_path 引用
 *
 * 来源:
 *   - 失败的 zotero ingest 留下的 multer 抽取目录(B1.4 之前)
 *   - multer 拒掉的 PDF 上传(B1.3 之前)
 *   - 项目删除时清理失败
 *   - 历史代码的 bug
 *
 * 用法:
 *   node scripts/sweep-orphan-files.js --dry-run   # 仅列出 + 统计
 *   node scripts/sweep-orphan-files.js --apply     # 真删(会要求 y/N 二次确认)
 *
 * 安全约束:
 *   - 只动 /var/lib/slr/pdfs 与 /var/lib/slr/uploads(SLR_PDF_ROOT / SLR_UPLOAD_ROOT 可覆盖)
 *   - 拒绝在路径外行动
 *   - mtime < 1 小时的文件跳过(可能正在被 ingest 写入)
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const APPLY   = args.includes('--apply')

if (!DRY_RUN && !APPLY) {
  console.error('请显式指定 --dry-run 或 --apply')
  process.exit(2)
}

const DB_PATH     = process.env.SLR_DB_PATH    || '/var/lib/slr/slr.db'
const PDF_ROOT    = path.resolve(process.env.SLR_PDF_ROOT    || '/var/lib/slr/pdfs')
const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
const SAFE_ROOTS  = [PDF_ROOT, UPLOAD_ROOT]

const MIN_AGE_MS = 60 * 60 * 1000   // 1 h:避免误删正在 ingest 的临时文件

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`)
  process.exit(2)
}

const db = new Database(DB_PATH, { readonly: !APPLY })
db.pragma('journal_mode = WAL')

console.log(`DB:    ${DB_PATH}`)
console.log(`PDFs:  ${PDF_ROOT}`)
console.log(`Pkgs:  ${UPLOAD_ROOT}\n`)

// ============== 1. 收集 DB 里所有被引用的路径 ==============
const referenced = new Set()
const att = db.prepare(`SELECT storage_path FROM attachments WHERE storage_path IS NOT NULL`).all()
for (const r of att) referenced.add(path.resolve(r.storage_path))
const pkg = db.prepare(`SELECT storage_path FROM zotero_packages WHERE storage_path IS NOT NULL`).all()
for (const r of pkg) referenced.add(path.resolve(r.storage_path))

console.log(`DB 引用了 ${referenced.size} 条路径(attachments + zotero_packages)`)

// ============== 2. 扫盘 ==============
const orphanPdfs = []        // PDF_ROOT 下未被 attachments 引用的
const orphanPkgs = []        // UPLOAD_ROOT 下未被 zotero_packages 引用的(顶层目录)

let totalPdfBytes = 0
let totalPkgBytes = 0
const now = Date.now()

// PDF_ROOT:扁平结构,直接 readdir
if (fs.existsSync(PDF_ROOT)) {
  for (const name of fs.readdirSync(PDF_ROOT)) {
    const full = path.resolve(PDF_ROOT, name)
    if (!safeInside(full)) continue
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isFile()) continue
    if (now - st.mtimeMs < MIN_AGE_MS) continue   // 太新跳过
    if (!referenced.has(full)) {
      orphanPdfs.push({ path: full, bytes: st.size, mtime: st.mtime })
      totalPdfBytes += st.size
    }
  }
} else {
  console.log(`(${PDF_ROOT} 不存在,跳过)`)
}

// UPLOAD_ROOT:zotero 包是一个子目录(extractDir),按目录粒度判断
if (fs.existsSync(UPLOAD_ROOT)) {
  for (const name of fs.readdirSync(UPLOAD_ROOT)) {
    const full = path.resolve(UPLOAD_ROOT, name)
    if (!safeInside(full)) continue
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (now - st.mtimeMs < MIN_AGE_MS) continue
    if (!referenced.has(full)) {
      const bytes = st.isDirectory() ? dirSize(full) : st.size
      orphanPkgs.push({ path: full, bytes, mtime: st.mtime, isDir: st.isDirectory() })
      totalPkgBytes += bytes
    }
  }
} else {
  console.log(`(${UPLOAD_ROOT} 不存在,跳过)`)
}

console.log(`\n=== 孤儿 PDF (${PDF_ROOT}) ===`)
console.log(`${orphanPdfs.length} 个文件 / 合计 ${formatBytes(totalPdfBytes)}`)
for (const o of orphanPdfs.slice(0, 30)) {
  console.log(`  ${path.basename(o.path)}  ${formatBytes(o.bytes).padStart(10)}  ${o.mtime.toISOString()}`)
}
if (orphanPdfs.length > 30) console.log(`  ... 还有 ${orphanPdfs.length - 30} 个`)

console.log(`\n=== 孤儿 Zotero 包 (${UPLOAD_ROOT}) ===`)
console.log(`${orphanPkgs.length} 项 / 合计 ${formatBytes(totalPkgBytes)}`)
for (const o of orphanPkgs.slice(0, 30)) {
  console.log(`  ${o.isDir ? '📁' : '📄'} ${path.basename(o.path)}  ${formatBytes(o.bytes).padStart(10)}  ${o.mtime.toISOString()}`)
}
if (orphanPkgs.length > 30) console.log(`  ... 还有 ${orphanPkgs.length - 30} 项`)

const totalBytes = totalPdfBytes + totalPkgBytes
console.log(`\n合计可回收:${formatBytes(totalBytes)}`)

if (DRY_RUN || totalBytes === 0) {
  console.log('\n[dry-run] 未删除。如要执行删除请加 --apply')
  process.exit(0)
}

// ============== 3. 二次确认 ==============
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.question(`\n确认删除以上 ${orphanPdfs.length + orphanPkgs.length} 项孤儿,合计 ${formatBytes(totalBytes)}?(yes 才继续)> `, (answer) => {
  rl.close()
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('已取消')
    process.exit(0)
  }
  let deleted = 0
  let failed  = 0
  for (const o of orphanPdfs) {
    if (rmSafe(o.path)) deleted++; else failed++
  }
  for (const o of orphanPkgs) {
    if (o.isDir ? rmDirSafe(o.path) : rmSafe(o.path)) deleted++; else failed++
  }
  console.log(`\n✓ 删除 ${deleted} 项,失败 ${failed} 项`)
})

// ============== utils ==============
function safeInside(p) {
  const resolved = path.resolve(p)
  return SAFE_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

function dirSize(dir) {
  let total = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) total += dirSize(full)
      else {
        try { total += fs.statSync(full).size } catch {}
      }
    }
  } catch {}
  return total
}

function rmSafe(p) {
  if (!safeInside(p)) { console.error(`拒绝删 path-outside-safe-root: ${p}`); return false }
  try { fs.unlinkSync(p); return true } catch (e) { console.error(`unlink fail ${p}: ${e.message}`); return false }
}

function rmDirSafe(p) {
  if (!safeInside(p)) { console.error(`拒绝删 path-outside-safe-root: ${p}`); return false }
  try { fs.rmSync(p, { recursive: true, force: true }); return true } catch (e) { console.error(`rmdir fail ${p}: ${e.message}`); return false }
}

function formatBytes(bytes) {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
