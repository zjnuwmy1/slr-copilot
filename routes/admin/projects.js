/**
 * Admin 项目只读路由 — 在 server.js 用 requireAdmin 中间件保护:
 *   import adminProjectsRouter from './routes/admin/projects.js'
 *   app.use('/admin/projects', requireAdmin, adminProjectsRouter)
 *
 * 路径(相对挂载点 /admin/projects):
 *   GET    /                       → 全平台所有项目列表(? user=email & status= & q=keyword)
 *   GET    /:projectId             → 单项目只读详情(metadata + 协议 + 检索式 + records 计数 + 进度)
 *   GET    /:projectId/records.json → 项目所有 records 摘要(JSON)
 *   GET    /:projectId/audit.json  → 项目相关审计事件(JSON)
 *
 * 安全:
 *   - 整 router 走 requireAdmin(server.js 挂载时已加)
 *   - 此 router 只接受 GET。POST/DELETE/PATCH 全部 405。
 *   - 每个进入项目详情的请求审计一条 admin_viewed_project
 *   - 所有用户输入(user / status / q)走白名单或参数化
 */

import express from 'express'
import { audit } from '../../services/audit.js'
import { getProjectProgress } from '../../services/prisma.js'

const router = express.Router()

// 白名单 status —— 必须和 schema.sql 的 projects.status CHECK 一致
const ALLOWED_STATUS = new Set([
  'draft',
  'protocol_pending',
  'protocol_approved',
  'searching',
  'screening',
  'extracting',
  'synthesizing',
  'complete',
  'archived',
])

// ---------- 工具:解析 JSON 字段 ----------
function parseJsonArrayField(v) {
  if (!v) return []
  try {
    const x = JSON.parse(v)
    return Array.isArray(x) ? x : []
  } catch {
    return []
  }
}

function parseProject(row) {
  if (!row) return null
  return {
    ...row,
    databases: parseJsonArrayField(row.databases),
    language_limits: parseJsonArrayField(row.language_limits),
    document_types: parseJsonArrayField(row.document_types),
    seed_titles: parseJsonArrayField(row.seed_titles),
  }
}

function parseProtocol(row) {
  if (!row) return null
  return {
    ...row,
    research_questions: parseJsonArrayField(row.research_questions),
    inclusion_criteria: parseJsonArrayField(row.inclusion_criteria),
    exclusion_criteria: parseJsonArrayField(row.exclusion_criteria),
    concept_groups: (() => {
      try {
        const x = JSON.parse(row.concept_groups || '[]')
        return Array.isArray(x) ? x : []
      } catch { return [] }
    })(),
    clarification_questions: parseJsonArrayField(row.clarification_questions),
  }
}

// ---------- read-only guard:任何非 GET 都拒掉 ----------
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).render('error', {
      title: 'Method Not Allowed',
      message: '管理员只读视图,不允许写操作',
    })
  }
  next()
})

/**
 * 共享逻辑:列项目(可选 user_id 强 filter)
 * filters: { userQuery?, status?, q?, forcedUserId? }
 */
function listProjects(db, filters, limit = 100) {
  const where = []
  const params = []

  if (filters.forcedUserId) {
    where.push('p.user_id = ?')
    params.push(filters.forcedUserId)
  } else if (filters.userQuery) {
    const u = String(filters.userQuery).trim().toLowerCase()
    const userRow = db.prepare('SELECT id FROM users WHERE id = ? OR email = ?').get(u, u)
    if (userRow) {
      where.push('p.user_id = ?')
      params.push(userRow.id)
    } else {
      where.push('1=0')
    }
  }

  if (filters.status && ALLOWED_STATUS.has(filters.status)) {
    where.push('p.status = ?')
    params.push(filters.status)
  }

  if (filters.q) {
    const q = String(filters.q).trim()
    if (q) {
      where.push('(p.title LIKE ? OR p.topic LIKE ? OR p.discipline LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like)
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT
      p.id, p.user_id, p.title, p.topic, p.discipline, p.review_type, p.status,
      p.created_at, p.updated_at,
      u.email AS owner_email, u.display_name AS owner_name,
      (SELECT COUNT(*) FROM records r WHERE r.project_id = p.id) AS records_count,
      (SELECT COUNT(*) FROM protocols pr WHERE pr.project_id = p.id) AS protocol_versions,
      (SELECT COUNT(*) FROM protocols pr WHERE pr.project_id = p.id AND pr.approved_by_user = 1) AS approved_protocols,
      (SELECT COUNT(*) FROM draft_sections ds WHERE ds.project_id = p.id) AS draft_section_count
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    ${whereSql}
    ORDER BY p.updated_at DESC
    LIMIT ?
  `).all(...params, limit)

  return rows
}

// ---------- GET / → 全平台项目列表 ----------
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const filters = {
    userQuery: req.query.user ? String(req.query.user).slice(0, 200) : '',
    status: req.query.status ? String(req.query.status) : '',
    q: req.query.q ? String(req.query.q).slice(0, 200) : '',
  }
  const rows = listProjects(db, filters, 100)

  audit(db, req, {
    eventType: 'admin_listed_projects',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: {
      admin_email: req.user.email,
      filters: {
        user: filters.userQuery || null,
        status: filters.status || null,
        q: filters.q || null,
      },
      result_count: rows.length,
    },
  })

  res.render('admin/projects/list', {
    title: '全部项目',
    rows,
    filters,
    allowedStatus: Array.from(ALLOWED_STATUS),
    scopeUser: null,
  })
})

/**
 * 列出某用户的项目(由 admin/users.js 通过 res.render 调过来时复用同一个 view,
 * 但实际上 users.js 走 /admin/users/:id/projects 内联,所以这里不暴露独立路由)
 * — 留为内部 helper export 仍然可以,但需求里 /admin/users/:id/projects 由 users.js 拥有。
 */
export function listProjectsForUser(db, userId, filters = {}, limit = 200) {
  return listProjects(db, { ...filters, forcedUserId: userId }, limit)
}

// ---------- GET /:projectId → 单项目只读详情 ----------
router.get('/:projectId', (req, res) => {
  const db = req.app.locals.db
  const projectId = String(req.params.projectId)

  const row = db.prepare(`
    SELECT p.*,
           u.email AS owner_email, u.display_name AS owner_name, u.is_active AS owner_active
    FROM projects p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(projectId)

  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const project = parseProject(row)

  // 协议:全版本
  const protocols = db
    .prepare('SELECT * FROM protocols WHERE project_id = ? ORDER BY version DESC')
    .all(project.id)
    .map(parseProtocol)
  const approved = protocols.find((p) => p.approved_by_user) || null
  const latest = protocols[0] || null

  // 检索式:按 database 分组取最新
  const searchStrategies = db.prepare(`
    SELECT id, database_name, query_type, query_text, filters, result_count, search_date,
           version, generated_by, model, notes, created_at
    FROM search_strategies
    WHERE project_id = ?
    ORDER BY database_name, version DESC
  `).all(project.id)

  // Records 计数 + has_pdf
  const recordsStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN has_pdf = 1 THEN 1 ELSE 0 END) AS with_pdf,
      SUM(CASE WHEN duplicate_of_record_id IS NOT NULL THEN 1 ELSE 0 END) AS duplicates
    FROM records WHERE project_id = ?
  `).get(project.id) || { total: 0, with_pdf: 0, duplicates: 0 }

  // 筛选统计
  const screeningStats = db.prepare(`
    SELECT
      stage,
      COUNT(*) AS total,
      SUM(CASE WHEN human_decision = 'include' THEN 1 ELSE 0 END) AS included,
      SUM(CASE WHEN human_decision = 'exclude' THEN 1 ELSE 0 END) AS excluded,
      SUM(CASE WHEN human_decision = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
      SUM(CASE WHEN human_decision = 'not_decided' THEN 1 ELSE 0 END) AS not_decided,
      SUM(CASE WHEN ai_suggestion != 'not_run' THEN 1 ELSE 0 END) AS ai_done
    FROM screening_decisions
    WHERE project_id = ?
    GROUP BY stage
  `).all(project.id)

  // 抽取统计
  const extractionStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN human_verified = 1 THEN 1 ELSE 0 END) AS verified
    FROM extractions WHERE project_id = ?
  `).get(project.id) || { total: 0, verified: 0 }

  // 草稿章节
  const drafts = db.prepare(`
    SELECT section_name, version, user_edited, model, prompt_version, updated_at,
           LENGTH(content_markdown) AS content_len
    FROM draft_sections
    WHERE project_id = ?
    ORDER BY section_name, version DESC
  `).all(project.id)

  // Zotero 包
  const packages = db.prepare(`
    SELECT id, source_filename, status, total_records, total_with_pdf,
           total_with_doi, total_duplicates, created_at, parsed_at, ingested_at
    FROM zotero_packages
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).all(project.id)

  // 进度
  const progress = getProjectProgress(db, project.id)

  // 审计
  audit(db, req, {
    eventType: 'admin_viewed_project',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: project.user_id,
    projectId: project.id,
    payload: {
      admin_email: req.user.email,
      owner_email: project.owner_email || null,
      project_title: project.title,
    },
  })

  res.render('admin/projects/detail', {
    title: `[只读] ${project.title}`,
    project,
    owner: {
      id: project.user_id,
      email: project.owner_email,
      display_name: project.owner_name,
      is_active: project.owner_active,
    },
    protocols,
    latestProtocol: latest,
    approvedProtocol: approved,
    searchStrategies,
    recordsStats,
    screeningStats,
    extractionStats,
    drafts,
    packages,
    progress,
  })
})

// ---------- GET /:projectId/records.json ----------
router.get('/:projectId/records.json', (req, res) => {
  const db = req.app.locals.db
  const projectId = String(req.params.projectId)

  const project = db.prepare('SELECT id, user_id, title FROM projects WHERE id = ?').get(projectId)
  if (!project) {
    return res.status(404).json({ error: 'not_found' })
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 5000)
  const rows = db.prepare(`
    SELECT id, title, authors_text, year, journal, doi, item_type,
           has_pdf, duplicate_of_record_id, created_at
    FROM records
    WHERE project_id = ?
    ORDER BY (year IS NULL), year DESC, title
    LIMIT ?
  `).all(project.id, limit)

  audit(db, req, {
    eventType: 'admin_viewed_project_records',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: project.user_id,
    projectId: project.id,
    payload: { admin_email: req.user.email, record_count: rows.length },
  })

  res.json({
    project_id: project.id,
    project_title: project.title,
    record_count: rows.length,
    records: rows,
  })
})

// ---------- GET /:projectId/audit.json ----------
router.get('/:projectId/audit.json', (req, res) => {
  const db = req.app.locals.db
  const projectId = String(req.params.projectId)

  const project = db.prepare('SELECT id, user_id, title FROM projects WHERE id = ?').get(projectId)
  if (!project) {
    return res.status(404).json({ error: 'not_found' })
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 5000)
  const rows = db.prepare(`
    SELECT ae.id, ae.event_type, ae.user_id, ae.actor_user_id, ae.target_user_id,
           u_user.email AS user_email,
           u_actor.email AS actor_email,
           u_target.email AS target_email,
           ae.payload, ae.ip_address, ae.created_at
    FROM audit_events ae
    LEFT JOIN users u_user ON u_user.id = ae.user_id
    LEFT JOIN users u_actor ON u_actor.id = ae.actor_user_id
    LEFT JOIN users u_target ON u_target.id = ae.target_user_id
    WHERE ae.project_id = ?
    ORDER BY ae.id DESC
    LIMIT ?
  `).all(project.id, limit)

  for (const r of rows) {
    if (r.payload) {
      try { r.payload_parsed = JSON.parse(r.payload) } catch { r.payload_parsed = null }
    }
  }

  res.json({
    project_id: project.id,
    project_title: project.title,
    event_count: rows.length,
    events: rows,
  })
})

export default router
