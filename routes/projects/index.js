import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  PROTOCOL_SYSTEM,
  buildProtocolUserPrompt,
  normalizeProtocolOutput,
} from '../../services/prompts/protocol.js'
import { seedChecklistForProject, getProjectProgress } from '../../services/prisma.js'

const router = express.Router()

// ---------- 工具:解析 JSON 字段(项目/协议表里多列是 JSON 字符串) ----------
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

function ownProjectOr404(db, projectId, userId) {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
  return parseProject(row)
}

// ---------- GET /projects 列表 ----------
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT version FROM protocols WHERE project_id = p.id AND approved_by_user = 1 ORDER BY version DESC LIMIT 1) AS approved_version,
              (SELECT version FROM protocols WHERE project_id = p.id ORDER BY version DESC LIMIT 1) AS latest_version
       FROM projects p
       WHERE user_id = ?
       ORDER BY updated_at DESC`
    )
    .all(req.user.id)
  res.render('projects/list', {
    title: '研究项目',
    projects: rows.map(parseProject),
  })
})

// ---------- GET /projects/new ----------
router.get('/new', (req, res) => {
  res.render('projects/new', {
    title: '新建项目',
    values: {},
    errors: {},
  })
})

// ---------- POST /projects ----------
router.post('/', (req, res) => {
  const db = req.app.locals.db
  const body = req.body || {}

  const errors = {}
  const title = String(body.title || '').trim()
  const topic = String(body.topic || '').trim()
  if (!title) errors.title = '标题必填'
  if (!topic) errors.topic = '研究主题必填'
  if (title.length > 200) errors.title = '标题过长(<200 字)'
  if (topic.length > 5000) errors.topic = '主题过长(<5000 字)'

  if (Object.keys(errors).length > 0) {
    return res.status(400).render('projects/new', {
      title: '新建项目',
      values: body,
      errors,
    })
  }

  const id = randomId('proj')
  const databases = Array.isArray(body.databases) ? body.databases : (body.databases ? [body.databases] : [])
  const languageLimits = Array.isArray(body.language_limits) ? body.language_limits : (body.language_limits ? [body.language_limits] : [])
  const documentTypes = Array.isArray(body.document_types) ? body.document_types : (body.document_types ? [body.document_types] : [])
  const seedTitles = String(body.seed_titles || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  db.prepare(
    `INSERT INTO projects
       (id, user_id, title, review_type, discipline, topic, goal,
        year_start, year_end, databases, language_limits, document_types, seed_titles, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).run(
    id,
    req.user.id,
    title,
    body.review_type || null,
    String(body.discipline || '').trim() || null,
    topic,
    String(body.goal || '').trim() || null,
    body.year_start ? parseInt(body.year_start) : null,
    body.year_end ? parseInt(body.year_end) : null,
    JSON.stringify(databases),
    JSON.stringify(languageLimits),
    JSON.stringify(documentTypes),
    JSON.stringify(seedTitles),
  )

  // 种 PRISMA 27 项清单
  try {
    seedChecklistForProject(db, id)
  } catch (e) {
    console.error('[projects] seedChecklistForProject failed:', e.message)
  }

  audit(db, req, {
    eventType: 'project_created',
    userId: req.user.id,
    projectId: id,
    payload: { title, topic_snippet: topic.slice(0, 200) },
  })

  req.session.flash = { type: 'success', message: '项目已创建,接下来生成研究协议。' }
  res.redirect(`/projects/${id}`)
})

// ---------- GET /projects/:id/progress.json (前端 stepper 轮询用) ----------
router.get('/:id/progress.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })
  res.json(getProjectProgress(db, project.id))
})

// ---------- GET /projects/:id 详情 ----------
router.get('/:id', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const protocols = db
    .prepare('SELECT * FROM protocols WHERE project_id = ? ORDER BY version DESC')
    .all(project.id)
    .map(parseProtocol)

  const latest = protocols[0] || null
  const approved = protocols.find((p) => p.approved_by_user) || null

  // 最近 LLM 调用记录(给项目仪表盘用)
  const recentUsage = db
    .prepare(
      `SELECT id, action_type, model, status, duration_ms, started_at
       FROM usage_logs
       WHERE user_id = ? AND project_id = ?
       ORDER BY started_at DESC LIMIT 10`
    )
    .all(req.user.id, project.id)

  res.render('projects/detail', {
    title: project.title,
    project,
    protocols,
    latestProtocol: latest,
    approvedProtocol: approved,
    recentUsage,
  })
})

// ---------- POST /projects/:id/protocol/generate ----------
router.post('/:id/protocol/generate', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  // 用户消息
  const userPrompt = buildProtocolUserPrompt({
    topic: project.topic,
    discipline: project.discipline || '',
    goal: project.goal || '',
    yearStart: project.year_start,
    yearEnd: project.year_end,
    databases: project.databases,
    languageLimits: project.language_limits,
    documentTypes: project.document_types,
    seedTitles: project.seed_titles,
  })

  const result = await runLlm(db, {
    userId: req.user.id,
    actionType: 'protocol_gen',
    projectId: project.id,
    system: PROTOCOL_SYSTEM,
    prompt: userPrompt,
    expectJson: true,
    model: 'heavy',
    maxTokens: 4096,
    timeoutMs: 180_000,
  })

  if (!result.ok) {
    req.session.flash = {
      type: 'error',
      message: `生成失败:${result.status} — ${result.error || ''}`.slice(0, 300),
    }
    return res.redirect(`/projects/${project.id}`)
  }

  // 提取并标准化
  const normalized = normalizeProtocolOutput(result.data || null)

  // 下一个 version
  const { maxV } = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxV FROM protocols WHERE project_id = ?')
    .get(project.id)
  const version = maxV + 1
  const protocolId = randomId('proto')

  db.prepare(
    `INSERT INTO protocols
       (id, project_id, version, research_questions, inclusion_criteria, exclusion_criteria,
        concept_groups, recommended_review_type, rationale, clarification_questions,
        generated_by, model, approved_by_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, 0)`
  ).run(
    protocolId,
    project.id,
    version,
    JSON.stringify(normalized.research_questions),
    JSON.stringify(normalized.inclusion_criteria),
    JSON.stringify(normalized.exclusion_criteria),
    JSON.stringify(normalized.concept_groups),
    normalized.recommended_review_type,
    normalized.rationale,
    JSON.stringify(normalized.clarification_questions),
    result.model,
  )

  db.prepare(`UPDATE projects SET status = 'protocol_pending', updated_at = datetime('now') WHERE id = ?`).run(project.id)

  audit(db, req, {
    eventType: 'protocol_generated',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      version,
      model: result.model,
      provider: result.provider,
      duration_ms: result.durationMs,
      had_json: !!result.data,
    },
  })

  req.session.flash = {
    type: 'success',
    message: `协议 v${version} 已生成(${result.model}, ${result.durationMs}ms)。请审阅并审批。`,
  }
  res.redirect(`/projects/${project.id}#protocol-v${version}`)
})

// ---------- POST /projects/:id/protocol/:protocolId/approve ----------
router.post('/:id/protocol/:protocolId/approve', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const row = db
    .prepare('SELECT * FROM protocols WHERE id = ? AND project_id = ?')
    .get(req.params.protocolId, project.id)
  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '协议版本不存在' })
  }
  // 先把同 project 其他版本撤销 approval
  db.transaction(() => {
    db.prepare('UPDATE protocols SET approved_by_user = 0, approved_at = NULL WHERE project_id = ?').run(project.id)
    db.prepare(`UPDATE protocols SET approved_by_user = 1, approved_at = datetime('now') WHERE id = ?`).run(row.id)
    db.prepare(`UPDATE projects SET status = 'protocol_approved', updated_at = datetime('now') WHERE id = ?`).run(project.id)
  })()
  audit(db, req, {
    eventType: 'protocol_approved',
    userId: req.user.id,
    projectId: project.id,
    payload: { protocol_id: row.id, version: row.version },
  })
  req.session.flash = { type: 'success', message: `协议 v${row.version} 已审批,可以进入下一步:检索式生成(Phase 3)。` }
  res.redirect(`/projects/${project.id}`)
})

// ---------- POST /projects/:id/protocol/:protocolId/edit ----------
router.post('/:id/protocol/:protocolId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  const row = db
    .prepare('SELECT * FROM protocols WHERE id = ? AND project_id = ?')
    .get(req.params.protocolId, project.id)
  if (!row) return res.status(404).render('error', { title: 'Not Found', message: '协议版本不存在' })

  // 用户提交的编辑后内容
  const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)
  const research_questions = splitLines(req.body.research_questions)
  const inclusion_criteria = splitLines(req.body.inclusion_criteria)
  const exclusion_criteria = splitLines(req.body.exclusion_criteria)
  // concept_groups 暂支持 JSON 粘贴(进阶 UI 之后再做)
  let concept_groups = []
  try {
    const x = JSON.parse(req.body.concept_groups_json || '[]')
    if (Array.isArray(x)) concept_groups = x
  } catch {
    req.session.flash = { type: 'error', message: 'Concept Groups JSON 解析失败,该字段未更新' }
  }

  // 新建一个 version,而不是修改原 row
  const { maxV } = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxV FROM protocols WHERE project_id = ?')
    .get(project.id)
  const version = maxV + 1
  const newId = randomId('proto')

  db.prepare(
    `INSERT INTO protocols
       (id, project_id, version, research_questions, inclusion_criteria, exclusion_criteria,
        concept_groups, recommended_review_type, rationale, clarification_questions,
        generated_by, model, approved_by_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_edited', ?, 0)`
  ).run(
    newId,
    project.id,
    version,
    JSON.stringify(research_questions),
    JSON.stringify(inclusion_criteria),
    JSON.stringify(exclusion_criteria),
    JSON.stringify(concept_groups),
    row.recommended_review_type,
    row.rationale,
    row.clarification_questions || '[]',
    row.model,
  )

  audit(db, req, {
    eventType: 'protocol_edited',
    userId: req.user.id,
    projectId: project.id,
    payload: { from_version: row.version, to_version: version },
  })
  req.session.flash = { type: 'success', message: `已基于 v${row.version} 创建编辑版 v${version}` }
  res.redirect(`/projects/${project.id}#protocol-v${version}`)
})

export default router
