/**
 * 项目级联删除 — DB 用 ON DELETE CASCADE 自动清子表,
 * 文件系统手动清(packages 目录 + records project 目录)。
 *
 * 调用方传 actorUserId(谁干的,会被审计);
 * 如果 actor != project.user_id,自动判定为 admin 操作。
 */

import fs from 'node:fs'
import path from 'node:path'
import { audit } from './audit.js'

const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOAD_ROOT = process.env.SLR_UPLOAD_ROOT || path.join(DATA_DIR, 'uploads')
const PDF_ROOT    = process.env.SLR_PDF_ROOT    || path.join(DATA_DIR, 'pdfs')
const SAFE_ROOT = path.resolve(DATA_DIR)

/**
 * 删项目。**调用方必须先校验权限**(req.user.id === project.user_id 或 req.user.role === 'admin')。
 *
 * 返回 { ok, summary } 或 { ok: false, error }:
 *   summary = { project_id, db_rows_deleted: { records, attachments, ... }, files_removed, bytes_removed, errors }
 */
export function deleteProject(db, { projectId, actorUserId, req = null }) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  if (!project) return { ok: false, error: 'not_found' }

  // 1. 收集文件路径(在删 DB 之前,删完就找不到了)
  const packagePaths = db
    .prepare('SELECT storage_path FROM zotero_packages WHERE project_id = ?')
    .all(projectId)
    .map((r) => r.storage_path)
    .filter(Boolean)
    .map((p) => path.resolve(p))
    .filter((p) => p.startsWith(SAFE_ROOT + path.sep))

  const recordsProjectDir = path.resolve(UPLOAD_ROOT, 'records', projectId)
  const recordsDirExists = (() => {
    try { return fs.statSync(recordsProjectDir).isDirectory() } catch { return false }
  })()

  // 1b. 收集所有 attachments 的 storage_path(包括单篇补传的 PDF、zotero-merge 的 PDF)+
  //     该项目所有 records 在 /var/lib/slr/pdfs/<record_id>.pdf 的默认路径
  const attachmentPaths = db
    .prepare(`SELECT a.storage_path FROM attachments a
              JOIN records r ON r.id = a.record_id
              WHERE r.project_id = ?`)
    .all(projectId)
    .map((r) => r.storage_path)
    .filter(Boolean)

  // 同时收集 /var/lib/slr/pdfs/<record_id>.pdf 这种 convention 路径
  //   (单篇补传 + zotero-merge 都用这个约定;DB 里 attachments.storage_path 也应该是这个,
  //    但兜底:如果有遗漏的孤儿文件,按 record_id 推算路径再删一次)
  const recordIds = db
    .prepare('SELECT id FROM records WHERE project_id = ?')
    .all(projectId)
    .map((r) => r.id)
  for (const rid of recordIds) {
    attachmentPaths.push(path.join(PDF_ROOT, `${rid}.pdf`))
  }

  const safeAttachmentPaths = Array.from(new Set(attachmentPaths))
    .map((p) => path.resolve(p))
    .filter((p) => p.startsWith(SAFE_ROOT + path.sep))

  // 2. 提前统计行数(用于 audit / 反馈)
  const countSafe = (sql) => {
    try { return db.prepare(sql).get(projectId).c } catch { return 0 }
  }
  const rowCounts = {
    protocols:           countSafe('SELECT COUNT(*) AS c FROM protocols WHERE project_id = ?'),
    search_strategies:   countSafe('SELECT COUNT(*) AS c FROM search_strategies WHERE project_id = ?'),
    prisma_checklist:    countSafe('SELECT COUNT(*) AS c FROM prisma_checklist WHERE project_id = ?'),
    zotero_packages:     countSafe('SELECT COUNT(*) AS c FROM zotero_packages WHERE project_id = ?'),
    records:             countSafe('SELECT COUNT(*) AS c FROM records WHERE project_id = ?'),
    attachments: (() => {
      try {
        return db.prepare(
          'SELECT COUNT(*) AS c FROM attachments a JOIN records r ON r.id = a.record_id WHERE r.project_id = ?'
        ).get(projectId).c
      } catch { return 0 }
    })(),
    paper_chunks: (() => {
      try {
        return db.prepare(
          'SELECT COUNT(*) AS c FROM paper_chunks pc JOIN records r ON r.id = pc.record_id WHERE r.project_id = ?'
        ).get(projectId).c
      } catch { return 0 }
    })(),
    screening_decisions: countSafe('SELECT COUNT(*) AS c FROM screening_decisions WHERE project_id = ?'),
    extractions:         countSafe('SELECT COUNT(*) AS c FROM extractions WHERE project_id = ?'),
    themes:              countSafe('SELECT COUNT(*) AS c FROM themes WHERE project_id = ?'),
    evidence_points:     countSafe('SELECT COUNT(*) AS c FROM evidence_points WHERE project_id = ?'),
    draft_sections:      countSafe('SELECT COUNT(*) AS c FROM draft_sections WHERE project_id = ?'),
    grade_assessments:   countSafe('SELECT COUNT(*) AS c FROM grade_assessments WHERE project_id = ?'),
  }

  // 3. DB cascade delete(单事务)
  let dbResult
  try {
    db.transaction(() => {
      // 先把跟 project_id 关联的 audit_events / usage_logs 的 project_id 置 NULL
      // (这两张表没有 CASCADE,留着方便审计追溯)
      db.prepare('UPDATE audit_events SET project_id = NULL WHERE project_id = ?').run(projectId)
      db.prepare('UPDATE usage_logs SET project_id = NULL WHERE project_id = ?').run(projectId)
      dbResult = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    })()
  } catch (e) {
    return { ok: false, error: 'db_delete_failed', detail: e.message }
  }

  // 4. 删文件系统(best-effort,失败不回滚 DB)
  let bytesRemoved = 0
  let filesRemoved = 0
  const fileErrors = []
  const removedPaths = []

  function rmRecursive(p) {
    if (!p) return
    const abs = path.resolve(p)
    if (!abs.startsWith(SAFE_ROOT + path.sep)) {
      fileErrors.push({ path: p, message: 'refused: outside DATA_DIR' })
      return
    }
    try {
      // 先统计大小再删
      const stat = (() => { try { return fs.statSync(abs) } catch { return null } })()
      if (!stat) return
      if (stat.isDirectory()) {
        const { bytes, files } = countDir(abs)
        bytesRemoved += bytes
        filesRemoved += files
      } else {
        bytesRemoved += stat.size
        filesRemoved += 1
      }
      fs.rmSync(abs, { recursive: true, force: true })
      removedPaths.push(abs)
    } catch (e) {
      fileErrors.push({ path: p, message: e.message })
    }
  }

  for (const p of packagePaths) rmRecursive(p)
  if (recordsDirExists) rmRecursive(recordsProjectDir)
  // 删 attachments(单篇 PDF 补传 + zotero-merge 拷过来的 PDF + 任何 attachments 表里的文件)
  for (const p of safeAttachmentPaths) rmRecursive(p)

  // 5. audit
  const isAdminAction = actorUserId !== project.user_id
  audit(db, req, {
    eventType: isAdminAction ? 'admin_project_deleted' : 'project_deleted',
    userId: project.user_id,
    actorUserId,
    targetUserId: project.user_id,
    projectId: null,  // 已经删了
    payload: {
      project_id: projectId,
      project_title: project.title,
      db_rows_deleted: rowCounts,
      files_removed: filesRemoved,
      bytes_removed: bytesRemoved,
      paths_removed: removedPaths.slice(0, 20),
      file_errors: fileErrors.slice(0, 10),
    },
  })

  return {
    ok: true,
    summary: {
      project_id: projectId,
      project_title: project.title,
      db_rows_deleted: rowCounts,
      files_removed: filesRemoved,
      bytes_removed: bytesRemoved,
      file_errors: fileErrors,
    },
  }
}

function countDir(dir) {
  let bytes = 0, files = 0
  function walk(p) {
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isFile()) { bytes += st.size; files += 1; return }
    if (!st.isDirectory()) return
    let entries
    try { entries = fs.readdirSync(p) } catch { return }
    for (const n of entries) walk(path.join(p, n))
  }
  walk(dir)
  return { bytes, files }
}
