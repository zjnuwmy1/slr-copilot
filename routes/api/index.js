/**
 * routes/api/index.js — P1.3 (2026-05-31): 程序化 JSON API(给本地 agent / CLI 用)
 *
 * 挂载(server.js):
 *   app.use('/api', requireApiOrUser(db), apiRouter)
 *
 * 认证:requireApiOrUser —— Authorization: Bearer slr_xxx(P1.1)或回退 cookie-session。
 * 统一信封:{ ok, status, data?, error? }。所有响应都是机读 JSON。
 *
 * 本文件(P1.3)实现:
 *   GET /api/projects                 — 列出当前用户的项目(机读)
 *   GET /api/projects/:id/status      — 统一项目状态:9 步状态 + 当前 running job + 下一步是否 ready
 *
 * 后续(P1.4)将在此基础上加:
 *   POST /api/projects/:id/run        — 启动自治流水线(pipeline_run)
 *   GET  /api/projects/:id/run/status — 流水线进度
 */

import { Router } from 'express'
import { getProjectProgress, seedChecklistForProject } from '../../services/prisma.js'
import { computePrismaFlow } from '../../services/prisma-flow.js'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { startPipelineRun, getPipelineStatus, computePipelinePlan } from '../../services/pipeline-orchestrator.js'

const router = Router()

// SR 9 步固定顺序(与 getProjectProgress.stepStatus 的 key 对齐)
const STEP_ORDER = [
  'protocol', 'search', 'screening', 'extraction',
  'rob', 'synthesis', 'certainty', 'report', 'submission',
]

// 只能操作自己的项目(agent 用 token 代表某个 user,作用域=该 user 的项目)
function ownProject(db, projectId, userId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId) || null
}

function notFound(res) {
  return res.status(404).json({ ok: false, status: 'not_found', error: 'project_not_found_or_forbidden' })
}

// GET /api/projects — 列出当前用户的项目(机读,供 CLI `slr list` / 选 id)
router.get('/projects', (req, res) => {
  const db = req.app.locals.db
  const rows = db.prepare(
    `SELECT id, title, topic, discipline, review_type, autonomous_mode, status, created_at, updated_at
       FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
  ).all(req.user.id)
  res.json({
    ok: true,
    status: 'ok',
    data: {
      projects: rows.map((p) => ({
        ...p,
        autonomous_mode: !!p.autonomous_mode,
      })),
      count: rows.length,
    },
  })
})

// POST /api/projects — 创建项目(CLI / agent 入口)
//   body: { topic*(必填), title?, review_type?, discipline?, goal?, autonomous?,
//           year_start?, year_end?, databases?[], language_limits?[], document_types?[] }
//   返回 { id, ... }。镜像网页 POST /projects 的校验 + seedChecklistForProject。
router.post('/projects', (req, res) => {
  const db = req.app.locals.db
  const b = req.body || {}
  const topic = String(b.topic || '').trim()
  if (!topic) return res.status(400).json({ ok: false, status: 'invalid', error: 'topic_required' })
  if (topic.length > 5000) return res.status(400).json({ ok: false, status: 'invalid', error: 'topic_too_long' })
  // title 可选:不给就从 topic 截一段
  let title = String(b.title || '').trim() || topic.slice(0, 120)
  if (title.length > 200) title = title.slice(0, 200)

  const asArr = (v) => Array.isArray(v) ? v : (v ? [v] : [])
  const autonomous = (b.autonomous === true || b.autonomous === 1 || b.autonomous === '1' || b.autonomous === 'true') ? 1 : 0
  const id = randomId('proj')
  try {
    db.prepare(
      `INSERT INTO projects
         (id, user_id, title, review_type, discipline, topic, goal,
          year_start, year_end, databases, language_limits, document_types, seed_titles,
          status, autonomous_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
    ).run(
      id, req.user.id, title,
      b.review_type ? String(b.review_type).trim() : 'systematic_review',
      String(b.discipline || '').trim() || null,
      topic,
      String(b.goal || '').trim() || null,
      b.year_start ? parseInt(b.year_start, 10) : null,
      b.year_end ? parseInt(b.year_end, 10) : null,
      JSON.stringify(asArr(b.databases)),
      JSON.stringify(asArr(b.language_limits)),
      JSON.stringify(asArr(b.document_types)),
      JSON.stringify(String(b.seed_titles || '').split('\n').map((s) => s.trim()).filter(Boolean)),
      autonomous,
    )
  } catch (e) {
    return res.status(500).json({ ok: false, status: 'error', error: 'create_failed', detail: e?.message, request_id: req.id })
  }
  try { seedChecklistForProject(db, id) } catch (e) { console.warn('[api] seedChecklist failed:', e?.message) }
  audit(db, req, { eventType: 'project_created', userId: req.user.id, projectId: id, payload: { via: 'api', autonomous, topic_snippet: topic.slice(0, 200) } })

  res.status(201).json({
    ok: true, status: 'created',
    data: { id, title, review_type: b.review_type || 'systematic_review', autonomous_mode: !!autonomous },
  })
})

// GET /api/projects/:id/protocol — 最新 + 已审批协议(机读)
router.get('/projects/:id/protocol', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  let rows = []
  try {
    rows = db.prepare(
      `SELECT id, version, approved_by_user, approved_at, created_at,
              research_questions, inclusion_criteria, exclusion_criteria,
              concept_groups, recommended_review_type, rationale
         FROM protocols WHERE project_id = ? ORDER BY version DESC`
    ).all(project.id)
  } catch { /* table 可能空 */ }
  const arr = (s) => { try { const x = JSON.parse(s || '[]'); return Array.isArray(x) ? x : [] } catch { return [] } }
  const parse = (r) => ({
    id: r.id, version: r.version, approved: !!r.approved_by_user,
    approved_at: r.approved_at, created_at: r.created_at,
    research_questions: arr(r.research_questions),
    inclusion_criteria: arr(r.inclusion_criteria),
    exclusion_criteria: arr(r.exclusion_criteria),
    concept_groups: arr(r.concept_groups),
    recommended_review_type: r.recommended_review_type || null,
    rationale: r.rationale || null,
  })
  const all = rows.map(parse)
  res.json({
    ok: true, status: 'ok',
    data: { latest: all[0] || null, approved: all.find((p) => p.approved) || null, versions: all.length },
  })
})

// GET /api/projects/:id/matrix — literature_matrix 行(机读)
router.get('/projects/:id/matrix', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  let rows = []
  try {
    rows = db.prepare(
      `SELECT record_id, fields, completeness, filled_by, updated_at
         FROM literature_matrix WHERE project_id = ? ORDER BY updated_at DESC`
    ).all(project.id)
  } catch {}
  res.json({
    ok: true, status: 'ok',
    data: {
      rows: rows.map((r) => { let f = {}; try { f = JSON.parse(r.fields || '{}') } catch {} ; return { record_id: r.record_id, completeness: r.completeness, filled_by: r.filled_by, fields: f } }),
      count: rows.length,
    },
  })
})

// GET /api/projects/:id/themes — synthesis 主题 + 主题级 certainty(机读)
router.get('/projects/:id/themes', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  let themes = []
  try {
    themes = db.prepare(
      `SELECT id, name, description, display_order, supporting_record_ids
         FROM themes WHERE project_id = ? ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    ).all(project.id)
  } catch {}
  let certByTheme = {}
  try {
    const tc = db.prepare(`SELECT theme_id, overall_certainty, grading_framework FROM theme_certainty WHERE project_id = ?`).all(project.id)
    for (const c of tc) certByTheme[c.theme_id] = { overall_certainty: c.overall_certainty, framework: c.grading_framework }
  } catch {}
  res.json({
    ok: true, status: 'ok',
    data: {
      themes: themes.map((t) => {
        let recs = []; try { recs = JSON.parse(t.supporting_record_ids || '[]') } catch {}
        return { id: t.id, name: t.name, description: t.description, supporting_count: recs.length, certainty: certByTheme[t.id] || null }
      }),
      count: themes.length,
    },
  })
})

// GET /api/projects/:id/prisma — PRISMA flow 计数(复用 computePrismaFlow,带 degraded 标志)
router.get('/projects/:id/prisma', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  let flow = null
  try { flow = computePrismaFlow(db, project.id) } catch (e) {
    return res.status(500).json({ ok: false, status: 'error', error: 'prisma_failed', detail: e?.message, request_id: req.id })
  }
  res.json({ ok: true, status: 'ok', data: flow })
})

// GET /api/projects/:id/manuscript — 已生成的最新各章节(markdown,机读)
router.get('/projects/:id/manuscript', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  let rows = []
  try {
    rows = db.prepare(
      `SELECT ds.section_name, ds.content_markdown, ds.version, ds.updated_at,
              ds.hallucinated_recs_json
         FROM draft_sections ds
         JOIN (SELECT section_name, MAX(version) AS mv FROM draft_sections WHERE project_id = ? GROUP BY section_name) m
           ON m.section_name = ds.section_name AND m.mv = ds.version
        WHERE ds.project_id = ?`
    ).all(project.id, project.id)
  } catch {}
  const sections = rows
    .filter((r) => r.content_markdown && r.content_markdown.trim())
    .map((r) => {
      let hall = []; try { hall = JSON.parse(r.hallucinated_recs_json || '[]') } catch {}
      return { section: r.section_name, version: r.version, updated_at: r.updated_at, hallucinated_recs: hall, content_markdown: r.content_markdown }
    })
  res.json({
    ok: true, status: 'ok',
    data: { sections, section_count: sections.length },
  })
})

// GET /api/projects/:id/status — 统一状态端点(agent 轮询推进的核心)
router.get('/projects/:id/status', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    return res.status(500).json({ ok: false, status: 'error', error: 'progress_failed', detail: e?.message, request_id: req.id })
  }
  if (!progress) return notFound(res)

  const stepStatus = progress.stepStatus || {}

  // 当前 running 的后台任务(batch_jobs)— 跨 kind
  let runningJobs = []
  try {
    runningJobs = db.prepare(
      `SELECT id, kind, status, total, done, failed, started_at
         FROM batch_jobs
        WHERE project_id = ? AND status = 'running'
        ORDER BY started_at DESC`
    ).all(project.id)
  } catch { /* 表可能缺,空数组 */ }

  // 下一步:按固定顺序找第一个非 done 的步骤;ready = 未被 locked
  let nextStep = null
  for (const key of STEP_ORDER) {
    const st = stepStatus[key]
    if (!st) continue
    if (st.status !== 'done') {
      nextStep = { key, status: st.status, ready: st.status !== 'locked', summary: st.summary || null }
      break
    }
  }

  const stepsDone = STEP_ORDER.filter((k) => stepStatus[k]?.status === 'done').length

  res.json({
    ok: true,
    status: 'ok',
    data: {
      project: {
        id: project.id,
        title: project.title,
        review_type: project.review_type || null,
        autonomous_mode: !!project.autonomous_mode,
        status: project.status || null,
      },
      steps: STEP_ORDER.map((key) => ({
        key,
        status: stepStatus[key]?.status || 'not_started',
        summary: stepStatus[key]?.summary || null,
      })),
      next_step: nextStep,
      running_jobs: runningJobs,
      prisma: progress.prismaProgress || null,
      overall: {
        steps_done: stepsDone,
        steps_total: STEP_ORDER.length,
        all_done: stepsDone === STEP_ORDER.length,
      },
      // 流水线编排器状态(P1.4 填,这里先透出原始列以便 agent 早接入)
      pipeline_run_status: project.pipeline_run_status || null,
    },
  })
})

// POST /api/projects/:id/run — 启动自治流水线(P1.4)
//   按 review_type 步骤序列依次跑;autonomous 自动过 gate;缺数据/失败 → 停 + 标明卡在哪步。
//   立即返回 job_id,之后轮询 GET /run/status。可恢复(重启后重 POST 即从卡处续)。
router.post('/projects/:id/run', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)

  // 已在跑 → 返回当前状态而非重复启动
  const cur = getPipelineStatus(db, project)
  if (cur.running) {
    return res.status(409).json({ ok: false, status: 'already_running', data: cur })
  }

  const r = startPipelineRun(db, { project, userId: req.user.id })
  if (!r.ok) return res.status(409).json({ ok: false, status: 'start_failed', error: r.error, detail: r.detail })

  audit(db, req, { eventType: 'pipeline_run_started', userId: req.user.id, projectId: project.id, payload: { job_id: r.jobId, autonomous: r.autonomous, sequence: r.sequence } })
  res.status(202).json({
    ok: true, status: 'started',
    data: { job_id: r.jobId, autonomous: r.autonomous, sequence: r.sequence, poll: `/api/projects/${project.id}/run/status` },
  })
})

// GET /api/projects/:id/run/status — 流水线运行状态(agent 轮询)
router.get('/projects/:id/run/status', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  res.json({ ok: true, status: 'ok', data: getPipelineStatus(db, project) })
})

// GET /api/projects/:id/run/plan — 只读预览:按 review_type 会跑哪些步、当前到哪
router.get('/projects/:id/run/plan', (req, res) => {
  const db = req.app.locals.db
  const project = ownProject(db, req.params.id, req.user.id)
  if (!project) return notFound(res)
  res.json({ ok: true, status: 'ok', data: computePipelinePlan(db, project) })
})

export default router
