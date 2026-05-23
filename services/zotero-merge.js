/**
 * Zotero 包合并 —— 把 Zotero 包里的 "更全" 字段合并到系统已 include 的 records。
 * ------------------------------------------------------------
 * 输入:reconcilePackage() 的报告(只关心 matched 数组)。
 *
 * 合并规则(按字段):
 *   - abstract:取更长的(zotero 通常更全;系统里有时只有半句话)
 *   - keywords:union(去重保序;zotero 有些 keywords 系统没有)
 *   - doi:系统没就补
 *   - authors_text / journal / year:系统空就补,不空不动
 *   - PDF 附件:如果 zotero 有 pdf 附件且系统 record 没 has_pdf=1,
 *     就把 PDF 拷贝到 SLR_PDF_ROOT/<record_id>.pdf,
 *     插入 attachments 行,并 UPDATE records.has_pdf = 1
 *
 * 不做的事:
 *   - 不删除任何 record
 *   - 不修改 screening_decisions(include/exclude/uncertain 完全不动)
 *   - 不处理 extra_in_zotero / extra_in_system(只展示给用户)
 *
 * 返回 { updated_records, pdfs_attached, fields_merged_count }
 *   updated_records       = 至少触发过一次字段更新的 record 数
 *   pdfs_attached         = 这次合并成功挂上 PDF 的数量
 *   fields_merged_count   = 实际触发的 field-set 总数(每条最多 5+1)
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomId } from './crypto.js'
import { normalizeDoi } from './dedup.js'

// PDF 落盘根目录;dev/test 用 SLR_PDF_ROOT 覆盖。
const PDF_ROOT = path.resolve(process.env.SLR_PDF_ROOT || '/var/lib/slr/pdfs')

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    // 没权限就让后续 copy 自然报错,这里只是 warn
    console.error('[zotero-merge] mkdir failed:', dir, e.message)
  }
}

/** 解析 keywords_json,容错返回数组 */
function parseKeywords(j) {
  if (!j) return []
  try {
    const v = JSON.parse(j)
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  } catch {
    // ignore
  }
  return []
}

/** 把两组 keywords 合并:去重保序,大小写不敏感比较,但保留首次出现的原拼写 */
function unionKeywords(existing, incoming) {
  const seen = new Set()
  const out = []
  for (const k of [...existing, ...incoming]) {
    if (!k) continue
    const t = String(k).trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** 是否"空"(NULL / 空串 / 只空白) */
function isEmpty(v) {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  return false
}

/**
 * 复制单个 zotero 附件到 PDF_ROOT。
 * 返回 { ok: true, dest_path, size_bytes } 或 { ok: false, error: '...' }。
 * 失败不抛,但失败原因会被调用方收集,最终写入 zotero_packages.error_message
 * 并在 UI 展示,避免静默数据不一致(PDF 没拷上但 record 仍标 has_pdf)。
 */
async function copyPdfForRecord(srcPath, recordId) {
  if (!srcPath) return { ok: false, error: 'no_source_path' }
  try {
    if (!fs.existsSync(srcPath)) return { ok: false, error: `source_missing: ${path.basename(srcPath)}` }
    const st = await fsp.stat(srcPath)
    if (!st.isFile()) return { ok: false, error: 'source_not_regular_file' }
    if (st.size === 0)  return { ok: false, error: 'source_empty' }
    ensureDirSync(PDF_ROOT)
    const dest = path.join(PDF_ROOT, `${recordId}.pdf`)

    // 旧版用 fs.copyFile → 同一个 PDF 在磁盘上有两份(Zotero extracted/ 一份 + /pdfs/ 一份),
    //   200 篇综述项目能轻松翻倍到 1.2 GB 而看起来"只用了 600 MB"。
    // 新版用 hard link:同一 inode、两个路径,磁盘只占一份;两侧路径都可读;删一侧
    //   不影响另一侧(refcount=2,需要双方都删才真正释放)。
    //   跨文件系统会 EXDEV 报错 → 自动 fallback 到 copy(防 dev/test 跨盘场景)。
    //   dest 已存在(重复 merge / retry)→ unlink 再 link,避免 EEXIST。
    try {
      try { await fsp.unlink(dest) } catch { /* not exists, fine */ }
      await fsp.link(srcPath, dest)
    } catch (e) {
      if (e.code === 'EXDEV') {
        // 跨文件系统,只能复制
        await fsp.copyFile(srcPath, dest)
      } else {
        throw e
      }
    }

    // 验证目标大小一致(防部分写入)
    const destSt = await fsp.stat(dest)
    if (destSt.size !== st.size) {
      return { ok: false, error: `copy_size_mismatch: src=${st.size} dest=${destSt.size}` }
    }
    return { ok: true, dest_path: dest, size_bytes: st.size }
  } catch (e) {
    console.error('[zotero-merge] copyPdf failed for', recordId, e.message)
    return { ok: false, error: `copy_exception: ${e.message.slice(0, 200)}` }
  }
}

/**
 * 主入口:把 reconciliation 报告里 matched 的字段合并到系统 records。
 *
 * 注意:函数是 async(要复制 PDF),但 DB 写都用同步 better-sqlite3。
 * 我们不把整个流程包成单个 transaction —— 不同 record 的更新互相独立,
 * 中途任一条失败也不应回滚已成功的(部分成功比全有全无更友好)。
 */
export async function mergeZoteroIntoSystem(db, projectId, reconciliationReport) {
  if (!projectId) throw new Error('projectId required')
  if (!reconciliationReport || !Array.isArray(reconciliationReport.matched)) {
    throw new Error('reconciliationReport.matched missing')
  }

  const getRecord = db.prepare(
    `SELECT id, title, doi, authors_text, year, journal, abstract, keywords_json,
            has_pdf, package_id
       FROM records
      WHERE id = ? AND project_id = ?`
  )

  const insertAttachment = db.prepare(`
    INSERT INTO attachments (
      id, record_id, package_id,
      attachment_kind, filename, storage_path, size_bytes, mime_type, zotero_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let updatedRecords = 0
  let pdfsAttached = 0
  let fieldsMergedCount = 0
  const pdfErrors = []  // { record_id, title, reason } — 用于回传 + 写 zotero_packages.error_message + UI 警告

  for (const m of reconciliationReport.matched) {
    const sysId = m.system_record_id
    const z = m.zotero_record
    if (!sysId || !z) continue

    const row = getRecord.get(sysId, projectId)
    if (!row) continue // 可能 race 被删了

    // ---- 1) 收集要更新的字段 ----
    const sets = []
    const params = []

    // abstract:取更长的
    const zAbs = (z.abstract || '').trim()
    const sAbs = (row.abstract || '').trim()
    if (zAbs && zAbs.length > sAbs.length) {
      sets.push('abstract = ?')
      params.push(zAbs)
      fieldsMergedCount++
    }

    // keywords:union
    const sKw = parseKeywords(row.keywords_json)
    const zKw = Array.isArray(z.keywords) ? z.keywords : []
    if (zKw.length > 0) {
      const merged = unionKeywords(sKw, zKw)
      // 仅当合并后有新增项才写
      if (merged.length > sKw.length) {
        sets.push('keywords_json = ?')
        params.push(JSON.stringify(merged))
        fieldsMergedCount++
      }
    }

    // doi:系统没就补(归一化后比较)
    const sDoi = normalizeDoi(row.doi || '')
    const zDoi = normalizeDoi(z.doi || '')
    if (!sDoi && zDoi) {
      sets.push('doi = ?')
      params.push(zDoi)
      fieldsMergedCount++
    }

    // authors_text / journal / year:空就补
    if (isEmpty(row.authors_text) && !isEmpty(z.authors_text)) {
      sets.push('authors_text = ?')
      params.push(z.authors_text)
      fieldsMergedCount++
    }
    if (isEmpty(row.journal) && !isEmpty(z.journal)) {
      sets.push('journal = ?')
      params.push(z.journal)
      fieldsMergedCount++
    }
    if ((row.year == null) && z.year != null) {
      sets.push('year = ?')
      params.push(z.year)
      fieldsMergedCount++
    }

    let touched = sets.length > 0

    // ---- 2) PDF 附件 ----
    // zotero record 上 attachments[] 来自 zotero-ingest parse 结果,每个有
    //   { zotero_item_id, kind, filename, storage_path, mime_type }
    // 只挑第一个 kind === 'pdf' 的。
    let pdfDestPath = null
    let pdfMeta = null
    if (!row.has_pdf && Array.isArray(z.attachments)) {
      const firstPdf = z.attachments.find((a) => a && a.kind === 'pdf' && a.storage_path)
      if (firstPdf) {
        const copied = await copyPdfForRecord(firstPdf.storage_path, sysId)
        if (copied.ok) {
          pdfDestPath = copied.dest_path
          pdfMeta = { ...firstPdf, size_bytes: copied.size_bytes }
        } else {
          // 重要:zotero 包里说这条有 PDF,但实际拷不过来 — 不要静默,
          // 收集到 pdfErrors 让调用方写 zotero_packages.error_message 并 UI 提示。
          // record.has_pdf 保持 0(不会假装有);screening 决定也不动。
          pdfErrors.push({
            record_id: sysId,
            title: String(row.title || '').slice(0, 120),
            reason: copied.error,
            src: firstPdf.storage_path,
          })
        }
      }
    }

    if (pdfDestPath) {
      sets.push('has_pdf = 1')
      // 有真 PDF 后,之前用户标的"容缺"过时了,自动清回 NULL(pending)
      sets.push('pdf_status = NULL')
      // 没参数
      pdfsAttached++
      fieldsMergedCount++
      touched = true
    }

    // ---- 3) 写库 ----
    if (sets.length > 0) {
      const sql = `UPDATE records SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`
      try {
        db.prepare(sql).run(...params, sysId, projectId)
      } catch (e) {
        console.error('[zotero-merge] UPDATE failed for', sysId, e.message)
        touched = false
      }
    }

    if (pdfDestPath && pdfMeta) {
      try {
        insertAttachment.run(
          randomId('att'),
          sysId,
          row.package_id || null,
          'pdf',
          pdfMeta.filename || path.basename(pdfDestPath),
          pdfDestPath,
          pdfMeta.size_bytes || null,
          pdfMeta.mime_type || 'application/pdf',
          pdfMeta.zotero_item_id || null,
        )
      } catch (e) {
        console.error('[zotero-merge] INSERT attachment failed for', sysId, e.message)
      }
    }

    if (touched) updatedRecords++
  }

  return {
    updated_records: updatedRecords,
    pdfs_attached: pdfsAttached,
    fields_merged_count: fieldsMergedCount,
    pdf_errors: pdfErrors,  // 调用方应该把这个写进 zotero_packages.error_message 给用户看
  }
}
