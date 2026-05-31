/**
 * services/pdf-offload.js — 2026-05-31
 *
 * PDF 源文件 offload:一旦 PDF 解析成 paper_chunks,源文件就只剩"用户下载预览"
 * 一个消费者(所有 LLM 抽取读 paper_chunks.text,从不重读 PDF 字节)。chunk 成功后
 * 删源文件腾出磁盘空间,paper_chunks + attachments 元数据行全保留。
 *
 * 安全边界:
 *   - 只在 paper_chunks 存在时才删(0 chunks / requires_ocr 扫描件 → 跳过,
 *     源文件是唯一内容副本)
 *   - 只删 DATA_DIR 内的文件(防越权 rm)
 *   - 同 record 的所有 PDF attachment 路径全删(Zotero+merge 会建 extracted/ +
 *     /pdfs/ 两条 hardlink 指同 inode,必须全删才真正释放 inode)
 *   - 不删 attachments 行,只标 pdf_offloaded_at + unlink 物理文件
 *   - 配额:storage-quota.js 用 pdf_offloaded_at IS NULL 排除已删的
 *
 * 用法:
 *   import { offloadRecordPdf, offloadAllChunkedPdfs } from './pdf-offload.js'
 *   const r = offloadRecordPdf(db, { recordId, reason: 'auto_after_chunk' })
 *   const all = offloadAllChunkedPdfs(db, { projectId })  // projectId=null → 全平台
 */

import fs from 'node:fs'
import path from 'node:path'
import { audit } from './audit.js'

const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const PDF_ROOT  = process.env.SLR_PDF_ROOT || path.join(DATA_DIR, 'pdfs')
const SAFE_ROOT = path.resolve(DATA_DIR)

/** 安全 unlink:只允许删 DATA_DIR 内的文件。返回 { ok, bytes }。*/
function safeUnlink(p) {
  if (!p) return { ok: false, bytes: 0 }
  const abs = path.resolve(p)
  // 必须严格在 SAFE_ROOT 之下(防 ../ 越权 + 防删 SAFE_ROOT 本身)
  if (abs !== SAFE_ROOT && !abs.startsWith(SAFE_ROOT + path.sep)) {
    console.warn('[pdf-offload] refusing unlink outside DATA_DIR:', abs)
    return { ok: false, bytes: 0 }
  }
  try {
    if (!fs.existsSync(abs)) return { ok: false, bytes: 0 }
    let bytes = 0
    try { bytes = fs.statSync(abs).size } catch {}
    fs.unlinkSync(abs)
    return { ok: true, bytes }
  } catch (e) {
    console.warn('[pdf-offload] unlink failed:', abs, e.message)
    return { ok: false, bytes: 0 }
  }
}

/**
 * Offload 单个 record 的 PDF 源文件(chunk 成功后)。
 * @returns {{ offloaded_n:number, bytes_freed:number, skipped?:string }}
 */
export function offloadRecordPdf(db, { recordId, reason = 'manual', req = null }) {
  if (!recordId) return { offloaded_n: 0, bytes_freed: 0, skipped: 'no_record_id' }

  // 1) 守卫:必须有 chunks(0 chunks / requires_ocr → 源文件是唯一内容副本,不删)
  const chunkRow = db.prepare(
    `SELECT COUNT(*) AS n FROM paper_chunks WHERE record_id = ?`
  ).get(recordId)
  if (!chunkRow || chunkRow.n === 0) {
    return { offloaded_n: 0, bytes_freed: 0, skipped: 'no_chunks' }
  }

  // 2) 取该 record 所有未 offload 的 PDF attachment
  const pdfAtts = db.prepare(
    `SELECT id, storage_path, size_bytes
       FROM attachments
      WHERE record_id = ? AND attachment_kind = 'pdf' AND pdf_offloaded_at IS NULL`
  ).all(recordId)
  if (pdfAtts.length === 0) {
    return { offloaded_n: 0, bytes_freed: 0, skipped: 'nothing_to_offload' }
  }

  // 3) unlink 每个 attachment 的 storage_path
  let bytesFreed = 0
  const unlinkedPaths = new Set()
  for (const a of pdfAtts) {
    if (a.storage_path) {
      const r = safeUnlink(a.storage_path)
      if (r.ok) { bytesFreed += r.bytes; unlinkedPaths.add(path.resolve(a.storage_path)) }
    }
  }
  // 3b) 同 record 的 /pdfs/<recordId>.pdf hardlink 兄弟(可能不在 attachments 里独立成行,
  //     或是同 inode 的第二条 link — 必须删才真正释放 inode)
  const pdfsHardlink = path.join(PDF_ROOT, `${recordId}.pdf`)
  if (!unlinkedPaths.has(path.resolve(pdfsHardlink))) {
    const r = safeUnlink(pdfsHardlink)
    // hardlink 删除不重复计 bytes(同 inode 已在上面计过);只在它是独立文件时算
    if (r.ok) bytesFreed += r.bytes
  }

  // 4) 事务标记 pdf_offloaded_at
  const tx = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE attachments SET pdf_offloaded_at = datetime('now', '+8 hours') WHERE id = ?`
    )
    for (const a of pdfAtts) upd.run(a.id)
  })
  try { tx() } catch (e) {
    console.error('[pdf-offload] mark offloaded tx failed:', e.message)
    return { offloaded_n: 0, bytes_freed: bytesFreed, skipped: 'tx_failed' }
  }

  // 5) audit
  try {
    audit(db, req || { user: { id: null }, ip: '', get: () => '' }, {
      eventType: 'record_pdf_offloaded',
      userId: null,
      payload: {
        record_id: recordId,
        reason,
        attachments_offloaded: pdfAtts.length,
        bytes_freed: bytesFreed,
      },
    })
  } catch {}

  return { offloaded_n: pdfAtts.length, bytes_freed: bytesFreed }
}

/**
 * 批量 offload 所有(或单项目)有 chunks + 有未 offload PDF 的 record。
 * @param {object} opts
 *   - projectId: 限定项目(null = 全平台)
 *   - reason: audit 用
 * @returns {{ records_processed:number, records_offloaded:number, total_bytes_freed:number, per_record:Array }}
 */
export function offloadAllChunkedPdfs(db, { projectId = null, reason = 'batch_sweep', req = null } = {}) {
  // 找候选 record:有未 offload 的 PDF attachment + 至少 1 个 chunk
  const params = []
  let projFilter = ''
  if (projectId) { projFilter = 'AND r.project_id = ?'; params.push(projectId) }

  const candidates = db.prepare(`
    SELECT DISTINCT r.id AS record_id
      FROM records r
      JOIN attachments a ON a.record_id = r.id
     WHERE a.attachment_kind = 'pdf'
       AND a.pdf_offloaded_at IS NULL
       AND EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.record_id = r.id)
       ${projFilter}
  `).all(...params)

  let recordsOffloaded = 0
  let totalBytes = 0
  const perRecord = []
  for (const c of candidates) {
    const r = offloadRecordPdf(db, { recordId: c.record_id, reason, req })
    if (r.offloaded_n > 0) {
      recordsOffloaded++
      totalBytes += r.bytes_freed
      perRecord.push({ record_id: c.record_id, offloaded_n: r.offloaded_n, bytes_freed: r.bytes_freed })
    }
  }

  return {
    records_processed: candidates.length,
    records_offloaded: recordsOffloaded,
    total_bytes_freed: totalBytes,
    per_record: perRecord,
  }
}
