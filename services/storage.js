/**
 * 储存空间监控 + 孤儿文件检测。
 *
 * 物理布局(/var/lib/slr 下):
 *   db/slr.db                            主 SQLite 数据库
 *   uploads/staging/                     管理员预投放 Zotero 包(等待 admin-staging 触发)
 *   uploads/packages/<package_id>/       Zotero 包解压后的目录(含 PDF + RDF)
 *   uploads/records/<project_id>/<file>  K 路径手动新增 record 的附件
 *   user-homes/<user_id>/<cred_id>/      OAuth 凭证 HOME(.claude / .codex)
 *   claude-home/                         旧版 admin 共享凭证 HOME(legacy)
 *   pdfs/                                老的 / 未用占位
 *
 * DB 表里的路径列:
 *   zotero_packages.storage_path         绝对路径 → uploads/packages/<pid>/
 *   attachments.storage_path             绝对路径 → 单个 PDF / HTML 文件
 *   user_credentials.credential_blob_enc 加密 JSON 含 home_path(OAuth 路径)
 *
 * 公开 API:
 *   getPlatformStorage(db)                 全平台一级汇总(管理员看)
 *   getProjectStorage(db, projectId)       单项目用了多少空间(级联删除前查)
 *   getUserStorage(db, userId)             单用户总占用(项目 + OAuth)
 *   listOrphanFiles(db)                    DB 没引用、但文件系统存在的文件
 *   getDbStats(db)                         DB 文件大小 + 每张表行数 + 总占用
 */

import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOAD_ROOT = process.env.SLR_UPLOAD_ROOT || path.join(DATA_DIR, 'uploads')
const USER_HOMES = path.join(DATA_DIR, 'user-homes')
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'db', 'slr.db')

// ─────────────────────────────────────────────────────────────
// 通用工具
// ─────────────────────────────────────────────────────────────

/**
 * 递归算目录总字节数 + 文件数。安全:不跟随 symlink,目录不存在返 0/0。
 * 限制:对超大目录(>100K 文件)会慢,接受。
 */
export function diskUsage(dir) {
  let bytes = 0
  let files = 0
  function walk(p) {
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isFile()) {
      bytes += st.size
      files += 1
      return
    }
    if (!st.isDirectory()) return
    let entries
    try { entries = fs.readdirSync(p) } catch { return }
    for (const name of entries) walk(path.join(p, name))
  }
  walk(dir)
  return { bytes, files }
}

export function formatBytes(b) {
  if (b == null || isNaN(b)) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fileSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

// ─────────────────────────────────────────────────────────────
// 平台 / 用户 / 项目占用
// ─────────────────────────────────────────────────────────────

export function getPlatformStorage(db) {
  const dbBytes = fileSize(DB_PATH)
  const dbWalBytes = fileSize(DB_PATH + '-wal')
  const dbShmBytes = fileSize(DB_PATH + '-shm')

  const uploads = diskUsage(UPLOAD_ROOT)
  const userHomes = diskUsage(USER_HOMES)

  // uploads 二级分组
  const uploadsBreakdown = {
    packages: diskUsage(path.join(UPLOAD_ROOT, 'packages')),
    records:  diskUsage(path.join(UPLOAD_ROOT, 'records')),
    staging:  diskUsage(path.join(UPLOAD_ROOT, 'staging')),
  }

  // 业务计数
  const counts = {
    projects:    db.prepare('SELECT COUNT(*) AS c FROM projects').get().c,
    users:       db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get().c,
    records:     db.prepare('SELECT COUNT(*) AS c FROM records').get().c,
    attachments: db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c,
    credentials: db.prepare("SELECT COUNT(*) AS c FROM user_credentials WHERE status = 'active'").get().c,
    extractions: db.prepare('SELECT COUNT(*) AS c FROM extractions').get().c,
    paper_chunks:db.prepare('SELECT COUNT(*) AS c FROM paper_chunks').get().c,
  }

  const total = dbBytes + dbWalBytes + dbShmBytes + uploads.bytes + userHomes.bytes
  return {
    total_bytes: total,
    breakdown: {
      db:        { bytes: dbBytes + dbWalBytes + dbShmBytes, files: 1, label: 'SQLite (含 WAL)' },
      uploads:   { bytes: uploads.bytes,   files: uploads.files,   label: '上传与解析(包/PDF/staging)' },
      user_homes:{ bytes: userHomes.bytes, files: userHomes.files, label: '用户 OAuth HOME' },
    },
    uploads_breakdown: uploadsBreakdown,
    counts,
  }
}

export function getProjectStorage(db, projectId) {
  // 该项目所有附件文件(attachments 没 project_id 列,JOIN records)
  const attachments = db
    .prepare(`
      SELECT a.storage_path FROM attachments a
      JOIN records r ON r.id = a.record_id
      WHERE r.project_id = ?
    `)
    .all(projectId)
  let attachBytes = 0, attachExisting = 0, attachMissing = 0
  for (const a of attachments) {
    if (!a.storage_path) { attachMissing++; continue }
    const sz = fileSize(a.storage_path)
    if (sz > 0) { attachBytes += sz; attachExisting++ } else { attachMissing++ }
  }

  // 该项目所有 Zotero 包目录
  const packages = db
    .prepare(`SELECT id, storage_path, total_records, total_with_pdf, status FROM zotero_packages WHERE project_id = ?`)
    .all(projectId)
  let pkgBytes = 0, pkgFiles = 0
  for (const p of packages) {
    if (!p.storage_path) continue
    const u = diskUsage(p.storage_path)
    pkgBytes += u.bytes
    pkgFiles += u.files
  }

  const counts = {
    records:       db.prepare('SELECT COUNT(*) AS c FROM records WHERE project_id = ?').get(projectId).c,
    attachments:   db.prepare('SELECT COUNT(*) AS c FROM attachments a JOIN records r ON r.id = a.record_id WHERE r.project_id = ?').get(projectId).c,
    packages:      packages.length,
    chunks:        db.prepare('SELECT COUNT(*) AS c FROM paper_chunks pc JOIN records r ON r.id = pc.record_id WHERE r.project_id = ?').get(projectId).c,
    screening:     db.prepare('SELECT COUNT(*) AS c FROM screening_decisions WHERE project_id = ?').get(projectId).c,
    extractions:   db.prepare('SELECT COUNT(*) AS c FROM extractions WHERE project_id = ?').get(projectId).c,
    themes:        db.prepare('SELECT COUNT(*) AS c FROM themes WHERE project_id = ?').get(projectId).c,
    grade:         db.prepare('SELECT COUNT(*) AS c FROM grade_assessments WHERE project_id = ?').get(projectId).c,
    draft_sections:db.prepare('SELECT COUNT(*) AS c FROM draft_sections WHERE project_id = ?').get(projectId).c,
  }

  return {
    total_bytes: attachBytes + pkgBytes,
    attachments: { bytes: attachBytes, existing: attachExisting, missing: attachMissing, total: attachments.length },
    packages:    { bytes: pkgBytes, files: pkgFiles, total: packages.length },
    counts,
  }
}

export function getUserStorage(db, userId) {
  const projects = db.prepare('SELECT id, title FROM projects WHERE user_id = ?').all(userId)
  let projTotal = 0
  const perProject = []
  // 聚合用户全部项目的 DB 行计数(CSV 导入项目文件系统占用 = 0,但 DB 里其实有数据;
  //   不展示会让 admin 误以为"项目数据 0B = 啥都没有",其实有 156 篇 records)
  const dataRowsTotal = {
    records: 0, attachments: 0, screening: 0, extractions: 0,
    themes: 0, grade: 0, draft_sections: 0,
  }
  for (const p of projects) {
    const s = getProjectStorage(db, p.id)
    projTotal += s.total_bytes
    perProject.push({ id: p.id, title: p.title, ...s })
    for (const k of Object.keys(dataRowsTotal)) {
      dataRowsTotal[k] += s.counts[k] || 0
    }
  }

  // 用户的 OAuth HOME
  const userHome = path.join(USER_HOMES, userId)
  const homeUsage = diskUsage(userHome)

  return {
    total_bytes: projTotal + homeUsage.bytes,
    projects_bytes: projTotal,
    oauth_home_bytes: homeUsage.bytes,
    oauth_home_files: homeUsage.files,
    project_count: projects.length,
    per_project: perProject.sort((a, b) => b.total_bytes - a.total_bytes),
    // 新增:用户 DB 数据行汇总,UI 显示用
    data_rows_total: dataRowsTotal,
  }
}

// ─────────────────────────────────────────────────────────────
// 孤儿文件检测
// ─────────────────────────────────────────────────────────────

/**
 * 找文件系统里 DB 没引用的孤儿。返回数组,每条 { path, bytes, kind, reason }。
 *
 * 检测范围:
 *  - uploads/packages/<pid>/ 没在 zotero_packages.storage_path 里
 *  - uploads/records/<projId>/<file> 父 project 已不存在
 *  - user-homes/<uid>/ 用户已删除
 *  - user-homes/<uid>/<credId>/ 凭证已不存在
 */
export function listOrphanFiles(db) {
  const orphans = []

  // 1. uploads/packages 下的孤儿
  const packagesDir = path.join(UPLOAD_ROOT, 'packages')
  const knownPackagePaths = new Set(
    db.prepare('SELECT storage_path FROM zotero_packages').all()
      .map((r) => r.storage_path && path.resolve(r.storage_path))
      .filter(Boolean)
  )
  try {
    for (const sub of fs.readdirSync(packagesDir)) {
      const p = path.resolve(packagesDir, sub)
      if (!knownPackagePaths.has(p)) {
        const u = diskUsage(p)
        orphans.push({ path: p, bytes: u.bytes, files: u.files, kind: 'package', reason: 'no_db_ref' })
      }
    }
  } catch {}

  // 2. uploads/records 下 project 不存在的
  const recordsDir = path.join(UPLOAD_ROOT, 'records')
  const knownProjectIds = new Set(
    db.prepare('SELECT id FROM projects').all().map((r) => r.id)
  )
  try {
    for (const sub of fs.readdirSync(recordsDir)) {
      if (!knownProjectIds.has(sub)) {
        const p = path.resolve(recordsDir, sub)
        const u = diskUsage(p)
        orphans.push({ path: p, bytes: u.bytes, files: u.files, kind: 'records_project_dir', reason: 'project_deleted' })
      }
    }
  } catch {}

  // 3. user-homes 下 user 不存在
  const knownUserIds = new Set(db.prepare('SELECT id FROM users').all().map((r) => r.id))
  try {
    for (const sub of fs.readdirSync(USER_HOMES)) {
      if (!knownUserIds.has(sub)) {
        const p = path.resolve(USER_HOMES, sub)
        const u = diskUsage(p)
        orphans.push({ path: p, bytes: u.bytes, files: u.files, kind: 'user_home', reason: 'user_deleted' })
      }
    }
  } catch {}

  // 4. user-homes/<uid>/<credId> 凭证不存在 / stage-* 临时(OAuth 完成或失败留下的)
  const knownCredIds = new Set(
    db.prepare('SELECT id FROM user_credentials').all().map((r) => r.id)
  )
  try {
    for (const uid of fs.readdirSync(USER_HOMES)) {
      if (!knownUserIds.has(uid)) continue  // 整个 user-home 已经被 3 标了
      const uHome = path.join(USER_HOMES, uid)
      let subs = []
      try { subs = fs.readdirSync(uHome) } catch { continue }
      for (const sub of subs) {
        // OAuth bind 半成品
        if (sub.startsWith('stage-')) {
          const p = path.resolve(uHome, sub)
          const u = diskUsage(p)
          orphans.push({ path: p, bytes: u.bytes, files: u.files, kind: 'oauth_stage', reason: 'half_finished_binding' })
          continue
        }
        if (sub.startsWith('cred_') && !knownCredIds.has(sub)) {
          const p = path.resolve(uHome, sub)
          const u = diskUsage(p)
          orphans.push({ path: p, bytes: u.bytes, files: u.files, kind: 'orphan_credential_home', reason: 'credential_deleted' })
        }
      }
    }
  } catch {}

  return orphans.sort((a, b) => b.bytes - a.bytes)
}

/**
 * 删孤儿(批量)。仅在路径在 DATA_DIR 之内才删,防越权。
 * 返回 { removed: [paths], errors: [{path, message}] }
 */
export function deleteOrphans(orphans) {
  const removed = []
  const errors = []
  const safeRoot = path.resolve(DATA_DIR)
  for (const o of orphans) {
    const p = path.resolve(o.path)
    if (!p.startsWith(safeRoot + path.sep) && p !== safeRoot) {
      errors.push({ path: o.path, message: 'refused: outside DATA_DIR' })
      continue
    }
    try {
      fs.rmSync(p, { recursive: true, force: true })
      removed.push(o.path)
    } catch (e) {
      errors.push({ path: o.path, message: e.message })
    }
  }
  return { removed, errors }
}

// ─────────────────────────────────────────────────────────────
// DB 表占用
// ─────────────────────────────────────────────────────────────

export function getDbStats(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name)

  const rows = []
  for (const t of tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c
      rows.push({ table: t, rows: c })
    } catch {
      rows.push({ table: t, rows: null })
    }
  }
  rows.sort((a, b) => (b.rows || 0) - (a.rows || 0))

  return {
    db_path: DB_PATH,
    db_bytes: fileSize(DB_PATH),
    wal_bytes: fileSize(DB_PATH + '-wal'),
    shm_bytes: fileSize(DB_PATH + '-shm'),
    tables: rows,
  }
}
