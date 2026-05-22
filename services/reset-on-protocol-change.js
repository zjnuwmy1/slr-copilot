/**
 * 协议重批时清空"基于旧协议的衍生数据"。
 *
 * 触发条件:用户审批一份新协议版本,且项目里:
 *   1. 之前已审批过另一份协议(说明旧的纳排标准已用过)
 *   2. 已经产生了基于旧协议的导入论文 / 筛选 / 抽取 / 综合等数据
 *
 * 清空范围(按 FK 反向依赖顺序):
 *   grade_assessments / draft_sections / evidence_points / themes /
 *   literature_matrix / extractions / screening_decisions /
 *   paper_chunks(CASCADE)/ attachments(CASCADE)/ records /
 *   zotero_packages(+ 文件系统)
 *
 * 保留(跨协议有意义的数据):
 *   protocols                — 全部历史版本
 *   search_strategies        — 检索式历史(用户对比要用)
 *   final_search_records     — 最终方案快照(审计)
 *   prisma_checklist         — PRISMA 27 项报告
 *   matrix_columns           — 用户自定义抽取字段
 *   target_journal_templates — 目标期刊模板
 *   pending_iterations       — 迭代建议历史
 *   audit_events / usage_logs — 审计 / 计量
 *
 * 重要:本 service **必须由调用方先做权限校验 + 用户确认**(返回的 counts 用于
 *      在确认页展示)。不做静默清空。
 */

import fs from 'node:fs'
import path from 'node:path'
import { audit } from './audit.js'

const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOAD_ROOT = process.env.SLR_UPLOAD_ROOT || path.join(DATA_DIR, 'uploads')
const SAFE_ROOT = path.resolve(DATA_DIR)

function safeCount(db, sql, projectId) {
  try { return db.prepare(sql).get(projectId).c || 0 } catch { return 0 }
}

/**
 * 统计"如果现在重置,会删多少行各表"。用于审批前的确认页。
 */
export function countDerivedRows(db, projectId) {
  const c = (sql) => safeCount(db, sql, projectId)
  return {
    records:             c('SELECT COUNT(*) AS c FROM records WHERE project_id = ?'),
    attachments: (() => {
      try {
        return db.prepare(
          `SELECT COUNT(*) AS c FROM attachments a
           JOIN records r ON r.id = a.record_id
           WHERE r.project_id = ?`
        ).get(projectId).c || 0
      } catch { return 0 }
    })(),
    paper_chunks: (() => {
      try {
        return db.prepare(
          `SELECT COUNT(*) AS c FROM paper_chunks pc
           JOIN records r ON r.id = pc.record_id
           WHERE r.project_id = ?`
        ).get(projectId).c || 0
      } catch { return 0 }
    })(),
    zotero_packages:     c('SELECT COUNT(*) AS c FROM zotero_packages WHERE project_id = ?'),
    screening_decisions: c('SELECT COUNT(*) AS c FROM screening_decisions WHERE project_id = ?'),
    extractions:         c('SELECT COUNT(*) AS c FROM extractions WHERE project_id = ?'),
    themes:              c('SELECT COUNT(*) AS c FROM themes WHERE project_id = ?'),
    evidence_points:     c('SELECT COUNT(*) AS c FROM evidence_points WHERE project_id = ?'),
    draft_sections:      c('SELECT COUNT(*) AS c FROM draft_sections WHERE project_id = ?'),
    grade_assessments:   c('SELECT COUNT(*) AS c FROM grade_assessments WHERE project_id = ?'),
    literature_matrix:   c('SELECT COUNT(*) AS c FROM literature_matrix WHERE project_id = ?'),
  }
}

/**
 * 任意一项 > 0 即认为"有衍生数据,需要确认才能清"。
 */
export function hasDerivedData(db, projectId) {
  const r = countDerivedRows(db, projectId)
  return Object.values(r).some((n) => n > 0)
}

/**
 * 估算占用的磁盘空间(zotero packages + records dir)。仅用于显示。
 */
export function estimateDiskUsage(db, projectId) {
  let bytes = 0
  let files = 0
  const packagePaths = db
    .prepare('SELECT storage_path FROM zotero_packages WHERE project_id = ?')
    .all(projectId)
    .map((r) => r.storage_path)
    .filter(Boolean)

  for (const p of packagePaths) {
    const abs = path.resolve(p)
    if (!abs.startsWith(SAFE_ROOT + path.sep)) continue
    const r = countDir(abs)
    bytes += r.bytes
    files += r.files
  }
  const recordsDir = path.resolve(UPLOAD_ROOT, 'records', projectId)
  if (recordsDir.startsWith(SAFE_ROOT + path.sep)) {
    const r = countDir(recordsDir)
    bytes += r.bytes
    files += r.files
  }
  return { bytes, files }
}

/**
 * 真正执行清空。**必须先做权限 + 用户确认**。
 *
 * @returns {Object} { db_rows_deleted, files_removed, bytes_removed, file_errors }
 */
export function clearDerivedData(db, projectId, { actorUserId, req = null } = {}) {
  // 1. 收集要删的文件路径(在 DB 删除前,DELETE 后 storage_path 就没了)
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

  // 2. 提前统计行数(用于反馈 / audit)
  const rowCounts = countDerivedRows(db, projectId)

  // 3. DB 删除(单事务,按 FK 反向依赖)
  //    records 上挂着 ON DELETE CASCADE 的子表(attachments, paper_chunks),
  //    但我们显式按表删,稳妥。
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM grade_assessments  WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM draft_sections     WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM evidence_points    WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM themes             WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM literature_matrix  WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM extractions        WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM screening_decisions WHERE project_id = ?').run(projectId)
      // paper_chunks / attachments 显式删一遍(以防 CASCADE 配置漂移)
      try {
        db.prepare(
          `DELETE FROM paper_chunks WHERE record_id IN (
             SELECT id FROM records WHERE project_id = ?
           )`
        ).run(projectId)
      } catch (e) { /* 没这张表就算了 */ }
      try {
        db.prepare(
          `DELETE FROM attachments WHERE record_id IN (
             SELECT id FROM records WHERE project_id = ?
           )`
        ).run(projectId)
      } catch (e) { /* same */ }
      db.prepare('DELETE FROM records         WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM zotero_packages WHERE project_id = ?').run(projectId)
      // project 状态回退到 protocol_approved(刚审批新协议)
      db.prepare(`UPDATE projects SET status = 'protocol_approved', updated_at = datetime('now') WHERE id = ?`).run(projectId)
    })()
  } catch (e) {
    return {
      db_rows_deleted: rowCounts,
      files_removed: 0,
      bytes_removed: 0,
      file_errors: [{ phase: 'db', message: e.message }],
      db_error: e.message,
    }
  }

  // 4. 删文件系统(best-effort,失败不回滚)
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

  // 5. audit
  audit(db, req, {
    eventType: 'project_reset_on_protocol_change',
    userId: actorUserId,
    projectId,
    payload: {
      db_rows_deleted: rowCounts,
      files_removed: filesRemoved,
      bytes_removed: bytesRemoved,
      paths_removed: removedPaths.slice(0, 20),
      file_errors: fileErrors.slice(0, 10),
    },
  })

  return {
    db_rows_deleted: rowCounts,
    files_removed: filesRemoved,
    bytes_removed: bytesRemoved,
    file_errors: fileErrors,
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

/**
 * 把字节数格式化成人类可读(给 UI 用)
 */
export function formatBytes(b) {
  if (!b || b < 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}
