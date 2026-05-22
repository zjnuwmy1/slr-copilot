/**
 * Phase 5 Agent M — 标题/摘要 AI 初筛
 *
 * 挂载方式(由 server.js 汇总层完成):
 *   import projectScreeningRouter from './routes/projects/screening.js'
 *   // 必须在 projectsRouter 之前,否则通用占位 /:id/screening 会先匹配
 *   app.use('/projects', requireUser, projectScreeningRouter)
 *
 * 路由清单:
 *   GET  /:id/screening                        列表 + 过滤 + 统计
 *   POST /:id/screening/run-one/:recordId      对单条同步跑 AI
 *   POST /:id/screening/run-batch              fire-and-forget 批量跑所有未跑
 *   GET  /:id/screening/progress.json          批量进度
 *   POST /:id/screening/decide/:recordId       人工 include/exclude/uncertain
 *   GET  /:id/screening/export.csv             导出 PRISMA 筛选 log
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  SCREENING_SYSTEM,
  buildScreeningUserPrompt,
  normalizeScreeningOutput,
  SCREENING_DECISIONS,
  SUGGEST_TARGET_SYSTEM,
  buildSuggestTargetPrompt,
  normalizeSuggestTargetOutput,
} from '../../services/prompts/screening.js'
import { getProjectProgress } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

// ============================================================
// 工具
// ============================================================

// 把 POST body 里的 redirect_to 落到一个**严格在本项目下**的安全 URL,
// 防 open redirect:必须以 `/projects/${projectId}/` 开头(同 origin、同项目)。
// 不合法时回退到 fallback。
function safeRedirectTo(req, projectId, fallback) {
  const raw = String((req.body && req.body.redirect_to) || '').trim()
  if (!raw) return fallback
  // 简单白名单:必须以 /projects/{projectId}/ 开头,且不能含 newline / 协议头
  if (raw.includes('\n') || raw.includes('\r')) return fallback
  if (raw.startsWith(`/projects/${projectId}/`)) return raw.slice(0, 500)
  return fallback
}

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

function getApprovedProtocol(db, projectId) {
  const row = db
    .prepare(
      `SELECT * FROM protocols
       WHERE project_id = ? AND approved_by_user = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(projectId)
  return parseProtocol(row)
}

// 校验 record 归属 + 返回 normalize 后的 record(给 AI 用)
function getRecordInProject(db, projectId, recordId) {
  const row = db
    .prepare('SELECT * FROM records WHERE id = ? AND project_id = ?')
    .get(recordId, projectId)
  if (!row) return null
  return {
    ...row,
    keywords_list: parseJsonArrayField(row.keywords_json),
  }
}

// 把 screening_decisions 行解析成 view-friendly
function parseDecision(row) {
  if (!row) return null
  return {
    ...row,
    ai_matched_inclusion: parseJsonArrayField(row.ai_matched_inclusion),
    ai_matched_exclusion: parseJsonArrayField(row.ai_matched_exclusion),
    ai_need_full_text:    parseJsonArrayField(row.ai_need_full_text),
  }
}

/**
 * 找到或创建一条 screening_decisions 记录(stage = 'title_abstract')。
 * UNIQUE(record_id, stage),所以幂等。
 */
function ensureScreeningRow(db, { recordId, projectId }) {
  const existing = db
    .prepare(`SELECT * FROM screening_decisions WHERE record_id = ? AND stage = 'title_abstract'`)
    .get(recordId)
  if (existing) return existing
  const id = randomId('scr')
  db.prepare(
    `INSERT INTO screening_decisions (id, record_id, project_id, stage, ai_suggestion, human_decision)
     VALUES (?, ?, ?, 'title_abstract', 'not_run', 'not_decided')`
  ).run(id, recordId, projectId)
  return db
    .prepare(`SELECT * FROM screening_decisions WHERE id = ?`)
    .get(id)
}

// ============================================================
// 批量任务进度(in-memory,Node 进程重启会丢)
// ============================================================
const batchProgress = new Map()
// key = projectId,value = { total, done, errors, started_at, finished_at, current_title, status }

function progressGet(projectId) {
  return batchProgress.get(projectId) || null
}

function progressInit(projectId, total) {
  const p = {
    total,
    done: 0,
    errors: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    current_title: null,
    status: total > 0 ? 'running' : 'finished',
  }
  batchProgress.set(projectId, p)
  return p
}

function progressUpdate(projectId, patch) {
  const cur = batchProgress.get(projectId)
  if (!cur) return
  Object.assign(cur, patch)
}

// 项目级互斥锁:同一个项目同时只能跑一个批量任务
const runningBatches = new Set()

// ============================================================
// AI 单条调用 — 跑完写库
// ============================================================
async function runScreeningOnce(db, {
  userId,
  project,
  protocol,
  record,
  req,        // 用于 audit
}) {
  // 确保 row 存在
  ensureScreeningRow(db, { recordId: record.id, projectId: project.id })

  // 把项目级 metadata(年份 / 文献类型 / 语言)也传给 prompt builder,
  // 用作客观决策树里"文献类型明显不符"的判断依据。
  // targetIncludePct = 用户期望纳入率(0-100 整数或 null),作为边缘 case 软目标。
  const targetIncludePct = (project.screening_target_include_pct != null
    && Number.isFinite(Number(project.screening_target_include_pct)))
    ? Number(project.screening_target_include_pct)
    : null
  const userPrompt = buildScreeningUserPrompt({
    protocol,
    record,
    projectInput: {
      year_start: project.year_start,
      year_end: project.year_end,
      document_types: Array.isArray(project.document_types) ? project.document_types : [],
      language_limits: Array.isArray(project.language_limits) ? project.language_limits : [],
    },
    targetIncludePct,
  })

  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'screening',
      projectId: project.id,
      system: SCREENING_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'light',     // haiku 4.5 — 便宜快,适合 176 条批量
      maxTokens: 1024,
      timeoutMs: 60_000,
    })
  } catch (e) {
    // runLlm 内部会兜异常,这里走到说明非常意外
    db.prepare(
      `UPDATE screening_decisions
       SET ai_suggestion = 'uncertain', ai_reason = ?, ai_ran_at = datetime('now'), updated_at = datetime('now')
       WHERE record_id = ? AND stage = 'title_abstract'`
    ).run(`llm_threw: ${(e?.message || String(e)).slice(0, 300)}`, record.id)
    return { ok: false, decision: 'uncertain', error: e?.message || 'llm_threw' }
  }

  // LLM 失败(quota / rate_limited / timeout / no_credential ...)→ 不入库 AI 结果,
  // 只把这条标 uncertain + reason,避免阻塞批量任务。
  if (!result.ok) {
    db.prepare(
      `UPDATE screening_decisions
       SET ai_suggestion = 'uncertain', ai_reason = ?, ai_model = ?, ai_ran_at = datetime('now'), updated_at = datetime('now')
       WHERE record_id = ? AND stage = 'title_abstract'`
    ).run(
      `llm_error[${result.status}]: ${(result.error || '').slice(0, 240)}`,
      result.model || null,
      record.id,
    )
    return { ok: false, decision: 'uncertain', status: result.status, error: result.error }
  }

  // normalize
  const norm = normalizeScreeningOutput(result.data || null)
  // 如果 JSON 解析失败(result.data == null)或 normalize 后空 decision,记 json_parse_failed
  let aiReason = norm.reason
  if (!result.data) {
    aiReason = `json_parse_failed; ${aiReason || ''}`.slice(0, 800)
    norm.decision = 'uncertain'
  }

  db.prepare(
    `UPDATE screening_decisions
     SET ai_suggestion = ?, ai_reason = ?, ai_confidence = ?, ai_model = ?,
         ai_matched_inclusion = ?, ai_matched_exclusion = ?,
         ai_matched_concepts  = ?, ai_need_full_text = ?,
         ai_ran_at = datetime('now'),
         updated_at = datetime('now')
     WHERE record_id = ? AND stage = 'title_abstract'`
  ).run(
    norm.decision,
    aiReason || null,
    norm.confidence,
    result.model || null,
    JSON.stringify(norm.matched_inclusion),
    JSON.stringify(norm.matched_exclusion),
    JSON.stringify(norm.matched_concepts || []),
    JSON.stringify(norm.need_full_text_check),
    record.id,
  )

  audit(db, req, {
    eventType: 'screening_ai_ran',
    userId,
    projectId: project.id,
    payload: {
      record_id: record.id,
      decision: norm.decision,
      confidence: norm.confidence,
      model: result.model,
      duration_ms: result.durationMs,
      json_parse_failed: !result.data,
    },
  })

  return { ok: true, decision: norm.decision, confidence: norm.confidence }
}

// ============================================================
// GET /:id/screening
// 合并了原 /records 的过滤 + 分页 + 元数据展示。
// 过滤参数:
//   ai           — AI 建议状态(include/exclude/uncertain/not_run)
//   human        — 人工决定状态(include/exclude/uncertain/not_decided)
//   q            — 关键词(标题/作者/期刊/DOI)
//   year_from    — 年份起
//   year_to      — 年份止
//   has_pdf=1    — 只看含 PDF 的
//   has_doi=1    — 只看含 DOI 的
//   only_multi_language=1 — 只看多语言条目
//   only_non_english=1    — 只看纯非英文条目
//   page         — 分页(50/页)
// ============================================================
const PAGE_SIZE = 50

router.get('/:id/screening', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const protocol = getApprovedProtocol(db, project.id)

  // ---- 解析过滤 ----
  const filterAi    = String(req.query.ai || '').trim()
  const filterHuman = String(req.query.human || '').trim()
  const AI_VALUES   = ['include', 'exclude', 'uncertain', 'not_run']
  const HUMAN_VALUES = ['include', 'exclude', 'uncertain', 'not_decided']
  const aiF    = AI_VALUES.includes(filterAi) ? filterAi : null
  const humanF = HUMAN_VALUES.includes(filterHuman) ? filterHuman : null

  const q = (req.query.q ? String(req.query.q).slice(0, 200).trim() : '')
  let yearFrom = null, yearTo = null
  if (req.query.year_from) {
    const n = parseInt(req.query.year_from, 10)
    if (Number.isFinite(n) && n > 0 && n < 9999) yearFrom = n
  }
  if (req.query.year_to) {
    const n = parseInt(req.query.year_to, 10)
    if (Number.isFinite(n) && n > 0 && n < 9999) yearTo = n
  }
  const onlyPdf = req.query.has_pdf === '1' || req.query.has_pdf === 'on' || req.query.has_pdf === 'true'
  const onlyDoi = req.query.has_doi === '1' || req.query.has_doi === 'on' || req.query.has_doi === 'true'
  const onlyMultiLang = req.query.only_multi_language === '1'
  const onlyNonEnglish = req.query.only_non_english === '1'

  let page = parseInt(req.query.page, 10)
  if (!Number.isFinite(page) || page < 1) page = 1

  // ---- where 构造 ----
  const where = ['r.project_id = ?', 'r.duplicate_of_record_id IS NULL']
  const params = [project.id]
  if (aiF) {
    where.push(`COALESCE(sd.ai_suggestion, 'not_run') = ?`)
    params.push(aiF)
  }
  if (humanF) {
    where.push(`COALESCE(sd.human_decision, 'not_decided') = ?`)
    params.push(humanF)
  }
  if (onlyPdf) where.push('r.has_pdf = 1')
  if (onlyDoi) where.push("r.doi IS NOT NULL AND r.doi != ''")
  if (onlyMultiLang) {
    where.push(`(r.language IS NOT NULL AND r.language != '' AND
      (r.language LIKE '%;%' OR r.language LIKE '%,%' OR r.language LIKE '%/%' OR r.language LIKE '%、%'))`)
  }
  if (onlyNonEnglish) {
    where.push(`(r.language IS NOT NULL AND r.language != ''
      AND LOWER(r.language) NOT LIKE '%english%'
      AND LOWER(r.language) NOT LIKE '%eng%'
      AND LOWER(r.language) NOT LIKE 'en;%'
      AND LOWER(r.language) != 'en')`)
  }
  if (yearFrom != null) { where.push('r.year >= ?'); params.push(yearFrom) }
  if (yearTo != null) { where.push('r.year <= ?'); params.push(yearTo) }
  if (q) {
    where.push(`(r.title LIKE ? OR r.authors_text LIKE ? OR r.journal LIKE ? OR r.doi LIKE ?)`)
    const like = `%${q}%`
    params.push(like, like, like, like)
  }
  const whereSql = where.join(' AND ')

  // ---- 总条数 + 分页 ----
  const totalFiltered = (db.prepare(
    `SELECT COUNT(*) AS n FROM records r
     LEFT JOIN screening_decisions sd ON sd.record_id = r.id AND sd.stage = 'title_abstract'
     WHERE ${whereSql}`
  ).get(...params) || {}).n || 0
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE))
  if (page > totalPages) page = totalPages
  const offset = (page - 1) * PAGE_SIZE

  // ---- 主查询 ----
  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.year, r.journal, r.authors_text, r.abstract,
              r.keywords_json, r.has_pdf, r.doi, r.language, r.source_databases,
              sd.id AS sd_id, sd.ai_suggestion, sd.ai_reason, sd.ai_confidence,
              sd.ai_model, sd.ai_matched_inclusion, sd.ai_matched_exclusion,
              sd.ai_matched_concepts, sd.ai_need_full_text, sd.ai_ran_at,
              sd.human_decision, sd.human_reason, sd.decided_at
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE ${whereSql}
       ORDER BY (r.year IS NULL), r.year DESC, r.title
       LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, offset)
    .map((r) => {
      const langRaw = (r.language || '').trim()
      let langList = []
      if (langRaw) langList = langRaw.split(/[;,\/、]/).map((s) => s.trim()).filter(Boolean)
      const lower = langList.map((l) => l.toLowerCase())
      const hasEnglish = lower.some((l) => l === 'english' || l === 'eng' || l === 'en')
      const hasOther = lower.some((l) => l && l !== 'english' && l !== 'eng' && l !== 'en' && l !== 'unspecified' && l !== 'unknown')
      let sourceDbs = []
      if (r.source_databases) {
        try {
          const parsed = JSON.parse(r.source_databases)
          if (Array.isArray(parsed)) sourceDbs = parsed.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
        } catch { /* ignore */ }
      }
      return {
        ...r,
        ai_matched_inclusion: parseJsonArrayField(r.ai_matched_inclusion),
        ai_matched_exclusion: parseJsonArrayField(r.ai_matched_exclusion),
        ai_matched_concepts:  parseJsonArrayField(r.ai_matched_concepts),
        ai_need_full_text:    parseJsonArrayField(r.ai_need_full_text),
        keywords_list:        parseJsonArrayField(r.keywords_json),
        ai_suggestion: r.ai_suggestion || 'not_run',
        human_decision: r.human_decision || 'not_decided',
        has_abstract: !!(r.abstract && String(r.abstract).trim()),
        has_doi: !!(r.doi && String(r.doi).trim()),
        language_list: langList,
        is_multi_language: hasOther,
        is_non_english_only: langList.length > 0 && !hasEnglish,
        source_databases_list: sourceDbs,
      }
    })

  // 统计(项目全貌,不受过滤影响)
  // ai_failed:LLM 调用失败的条目(可一键重跑)— 任何以 llm_/codex_/json_/spawn_/proc_ 等错误前缀开头的 reason
  const statsRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(sd.ai_suggestion, 'not_run') != 'not_run' THEN 1 ELSE 0 END) AS ai_done,
         SUM(CASE WHEN sd.ai_suggestion = 'include'  THEN 1 ELSE 0 END) AS ai_include,
         SUM(CASE WHEN sd.ai_suggestion = 'exclude'  THEN 1 ELSE 0 END) AS ai_exclude,
         SUM(CASE WHEN sd.ai_suggestion = 'uncertain' THEN 1 ELSE 0 END) AS ai_uncertain,
         SUM(CASE WHEN COALESCE(sd.human_decision, 'not_decided') != 'not_decided' THEN 1 ELSE 0 END) AS human_done,
         SUM(CASE WHEN sd.human_decision = 'include'  THEN 1 ELSE 0 END) AS human_include,
         SUM(CASE WHEN sd.human_decision = 'exclude'  THEN 1 ELSE 0 END) AS human_exclude,
         SUM(CASE WHEN sd.human_decision = 'uncertain' THEN 1 ELSE 0 END) AS human_uncertain,
         SUM(CASE WHEN sd.ai_reason LIKE 'llm_%'
                    OR sd.ai_reason LIKE 'codex_%'
                    OR sd.ai_reason LIKE 'json_parse_failed%'
                    OR sd.ai_reason LIKE 'spawn_%'
                    OR sd.ai_reason LIKE 'proc_%' THEN 1 ELSE 0 END) AS ai_failed
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ? AND r.duplicate_of_record_id IS NULL`
    )
    .get(project.id) || {}
  const stats = {
    total: statsRow.total || 0,
    ai_done: statsRow.ai_done || 0,
    ai_include: statsRow.ai_include || 0,
    ai_exclude: statsRow.ai_exclude || 0,
    ai_uncertain: statsRow.ai_uncertain || 0,
    ai_failed: statsRow.ai_failed || 0,  // LLM 调用失败的条目数(可一键重跑)
    human_done: statsRow.human_done || 0,
    human_include: statsRow.human_include || 0,
    human_exclude: statsRow.human_exclude || 0,
    human_uncertain: statsRow.human_uncertain || 0,
  }
  stats.ai_pending = stats.total - stats.ai_done
  stats.human_pending = stats.total - stats.human_done

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[screening] getProjectProgress failed:', e.message)
  }

  // 年份范围(给过滤表单 placeholder 用)
  const yearRange = db
    .prepare('SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM records WHERE project_id = ? AND year IS NOT NULL')
    .get(project.id) || {}

  // 给视图用:重建当前 URL(保留所有过滤,用于"清空过滤"、AI/Human chip 切换的 base URL)
  const buildHref = (overrides = {}) => {
    const qs = new URLSearchParams()
    const cur = { ai: aiF, human: humanF, q, year_from: yearFrom, year_to: yearTo,
                  has_pdf: onlyPdf ? '1' : '', has_doi: onlyDoi ? '1' : '',
                  only_multi_language: onlyMultiLang ? '1' : '',
                  only_non_english: onlyNonEnglish ? '1' : '' }
    const merged = { ...cur, ...overrides }
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== '' && v !== false) qs.set(k, String(v))
    }
    const s = qs.toString()
    return s ? `/projects/${project.id}/screening?${s}` : `/projects/${project.id}/screening`
  }
  const pageHref = (p) => {
    const qs = new URLSearchParams()
    if (aiF) qs.set('ai', aiF)
    if (humanF) qs.set('human', humanF)
    if (q) qs.set('q', q)
    if (yearFrom != null) qs.set('year_from', String(yearFrom))
    if (yearTo != null) qs.set('year_to', String(yearTo))
    if (onlyPdf) qs.set('has_pdf', '1')
    if (onlyDoi) qs.set('has_doi', '1')
    if (onlyMultiLang) qs.set('only_multi_language', '1')
    if (onlyNonEnglish) qs.set('only_non_english', '1')
    if (p > 1) qs.set('page', String(p))
    const s = qs.toString()
    return s ? `/projects/${project.id}/screening?${s}` : `/projects/${project.id}/screening`
  }

  // 项目级目标纳入率 + 当前实际通过率(给 UI 展示对比)
  const targetIncludePct = (project.screening_target_include_pct != null
    && Number.isFinite(Number(project.screening_target_include_pct)))
    ? Number(project.screening_target_include_pct)
    : null
  const actualIncludePct = stats.ai_done > 0
    ? Math.round((stats.ai_include / stats.ai_done) * 100)
    : null

  res.render('projects/screening', {
    title: `初筛 · ${project.title}`,
    project,
    protocol,
    rows,
    stats,
    filterAi: aiF,
    filterHuman: humanF,
    filters: {
      q, year_from: yearFrom, year_to: yearTo,
      has_pdf: onlyPdf, has_doi: onlyDoi,
      only_multi_language: onlyMultiLang, only_non_english: onlyNonEnglish,
    },
    yearRange: { min_year: yearRange.min_year || null, max_year: yearRange.max_year || null },
    page,
    totalPages,
    totalFiltered,
    pageSize: PAGE_SIZE,
    pageHref,
    buildHref,
    batch: progressGet(project.id),
    progress,
    targetIncludePct,
    actualIncludePct,
    currentStep: 'screening',
    stepLabel: '3. 筛选(Screening)',
  })
})

// ============================================================
// POST /:id/screening/target
//   body: target_include_pct(0-100 整数,或 'clear' 清空)
//   保存用户期望的初筛通过率,会注入到后续 screening prompt
// ============================================================
router.post('/:id/screening/target', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const raw = String(req.body.target_include_pct || '').trim()
  let pct = null
  if (raw && raw.toLowerCase() !== 'clear') {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      req.session.flash = { type: 'error', message: '目标纳入率必须是 0-100 的整数(留空 / 输入 clear = 清除)。' }
      return res.redirect(`/projects/${project.id}/screening`)
    }
    pct = n
  }

  db.prepare(
    `UPDATE projects SET screening_target_include_pct = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(pct, project.id)

  audit(db, req, {
    eventType: 'screening_target_set',
    userId: req.user.id,
    projectId: project.id,
    payload: { target_include_pct: pct },
  })

  req.session.flash = {
    type: 'success',
    message: pct == null
      ? '已清除目标通过率,后续 AI 初筛不再注入软目标。'
      : `已设置目标通过率 ~${pct}%。下次 AI 初筛(单条或批量)会按此软目标判定边缘 case。`,
  }
  res.redirect(`/projects/${project.id}/screening`)
})

// ============================================================
// POST /:id/screening/target/suggest
//   AI 根据协议反推一个合理通过率;返回 JSON(给前端 AJAX 调)
// ============================================================
router.post('/:id/screening/target/suggest', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const protocol = getApprovedProtocol(db, project.id)
  if (!protocol) return res.status(400).json({ ok: false, error: '请先审批协议再让 AI 推荐通过率。' })

  const userPrompt = buildSuggestTargetPrompt({
    protocol,
    projectInput: {
      topic: project.topic, discipline: project.discipline, goal: project.goal,
      document_types: Array.isArray(project.document_types) ? project.document_types : [],
      year_start: project.year_start, year_end: project.year_end,
    },
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'screening_target_suggest',
      projectId: project.id,
      system: SUGGEST_TARGET_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'light',
      maxTokens: 400,
      timeoutMs: 60_000,
    })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'LLM 调用异常:' + (e?.message || '').slice(0, 200) })
  }

  if (!result.ok) {
    return res.status(502).json({
      ok: false,
      error: `AI 推荐失败:${result.status} ${(result.error || '').slice(0, 200)}`,
    })
  }

  const norm = normalizeSuggestTargetOutput(result.data || null)
  if (!norm) {
    return res.status(502).json({ ok: false, error: 'AI 返回解析失败,可重试。' })
  }

  audit(db, req, {
    eventType: 'screening_target_suggested',
    userId: req.user.id,
    projectId: project.id,
    payload: { recommended_pct: norm.recommended_pct, reasoning: norm.reasoning, model: result.model },
  })

  res.json({ ok: true, recommended_pct: norm.recommended_pct, reasoning: norm.reasoning, model: result.model })
})

// ============================================================
// POST /:id/screening/run-one/:recordId
// ============================================================
router.post('/:id/screening/run-one/:recordId', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const protocol = getApprovedProtocol(db, project.id)
  const screeningUrl = `/projects/${project.id}/screening`
  const redirectUrl = safeRedirectTo(req, project.id, screeningUrl)
  if (!protocol) {
    req.session.flash = {
      type: 'error',
      message: '请先在第 1 步生成并审批研究协议(没有纳排标准无法判断)。',
    }
    return res.redirect(redirectUrl)
  }
  const record = getRecordInProject(db, project.id, req.params.recordId)
  if (!record) {
    return res.status(404).render('error', { title: 'Not Found', message: '文献条目不存在或不属于本项目' })
  }

  const r = await runScreeningOnce(db, {
    userId: req.user.id,
    project,
    protocol,
    record,
    req,
  })

  if (r.ok) {
    req.session.flash = {
      type: 'success',
      message: `已对《${(record.title || '').slice(0, 40)}》跑完 AI:${r.decision}${r.confidence != null ? `(置信度 ${r.confidence.toFixed(2)})` : ''}`,
    }
  } else {
    req.session.flash = {
      type: 'error',
      message: `AI 调用失败:${r.status || ''} ${r.error || ''}`.slice(0, 240),
    }
  }
  // 加锚点定位到当前 record(records 列表页和 screening 页都用 row-<recordId> 作为 id)
  const anchor = `#row-${record.id}`
  res.redirect(redirectUrl + anchor)
})

// ============================================================
// POST /:id/screening/run-batch
//
// fire-and-forget:启动后台任务,立即重定向回 /screening,前端轮询 progress.json
// ============================================================
router.post('/:id/screening/run-batch', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const protocol = getApprovedProtocol(db, project.id)
  const screeningUrl = `/projects/${project.id}/screening`
  const redirectUrl = safeRedirectTo(req, project.id, screeningUrl)
  if (!protocol) {
    req.session.flash = {
      type: 'error',
      message: '请先在第 1 步生成并审批研究协议(没有纳排标准无法判断)。',
    }
    return res.redirect(redirectUrl)
  }

  // 已有任务在跑:不允许重入
  if (runningBatches.has(project.id)) {
    req.session.flash = {
      type: 'error',
      message: '已有批量任务在跑,请等它跑完再启动新一批(或刷新页面查看进度)。',
    }
    return res.redirect(redirectUrl)
  }

  // 找出 ai_suggestion = 'not_run' 或者还没建 screening_decisions 行的 records
  const targets = db
    .prepare(
      `SELECT r.id
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ?
         AND r.duplicate_of_record_id IS NULL
         AND (sd.ai_suggestion IS NULL OR sd.ai_suggestion = 'not_run')
       ORDER BY r.title`
    )
    .all(project.id)

  if (targets.length === 0) {
    req.session.flash = { type: 'success', message: '没有未跑的条目,AI 初筛已全部完成。' }
    return res.redirect(redirectUrl)
  }

  runningBatches.add(project.id)
  progressInit(project.id, targets.length)

  const userId = req.user.id

  // 给批量任务造一个最简的 req-like 对象给 audit 用(原 req 在响应之后会被回收)
  const fakeReq = {
    ip: req.ip,
    get: (h) => req.get(h),
  }

  audit(db, req, {
    eventType: 'screening_batch_started',
    userId,
    projectId: project.id,
    payload: { total: targets.length },
  })

  // 立刻响应,后台串行跑
  req.session.flash = {
    type: 'success',
    message: `已启动批量 AI 初筛:${targets.length} 条。请保持页面打开,进度会实时刷新(关闭页面 / 进程重启会丢进度)。`,
  }
  res.redirect(redirectUrl)

  // 在响应后跑(setImmediate 让 res.end 真正发出去)
  setImmediate(async () => {
    try {
      for (const t of targets) {
        const record = getRecordInProject(db, project.id, t.id)
        if (!record) {
          progressUpdate(project.id, {
            done: (batchProgress.get(project.id)?.done || 0) + 1,
            errors: (batchProgress.get(project.id)?.errors || 0) + 1,
          })
          continue
        }
        progressUpdate(project.id, { current_title: (record.title || '').slice(0, 80) })
        const r = await runScreeningOnce(db, {
          userId,
          project,
          protocol,
          record,
          req: fakeReq,
        })
        const cur = batchProgress.get(project.id) || { done: 0, errors: 0 }
        progressUpdate(project.id, {
          done: cur.done + 1,
          errors: cur.errors + (r.ok ? 0 : 1),
        })
      }
    } catch (e) {
      console.error('[screening] batch loop crashed:', e)
    } finally {
      progressUpdate(project.id, {
        status: 'finished',
        current_title: null,
        finished_at: new Date().toISOString(),
      })
      runningBatches.delete(project.id)
      const final = progressGet(project.id) || {}
      audit(db, fakeReq, {
        eventType: 'screening_batch_finished',
        userId,
        projectId: project.id,
        payload: { total: final.total, done: final.done, errors: final.errors },
      })
    }
  })
})

// ============================================================
// POST /:id/screening/run-failed
//   一键重跑所有 LLM 调用失败的条目(ai_reason 以错误前缀开头)。
//   原因前缀:llm_error / llm_threw / codex_xxx / json_parse_failed / spawn_ / proc_
//   失败重跑不改变 human_decision,只覆盖 ai_* 字段。
// ============================================================
router.post('/:id/screening/run-failed', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const protocol = getApprovedProtocol(db, project.id)
  const screeningUrl = `/projects/${project.id}/screening`
  const redirectUrl = safeRedirectTo(req, project.id, screeningUrl)
  if (!protocol) {
    req.session.flash = {
      type: 'error',
      message: '请先在第 1 步审批协议,才能跑 AI 初筛。',
    }
    return res.redirect(redirectUrl)
  }
  if (runningBatches.has(project.id)) {
    req.session.flash = {
      type: 'error',
      message: '已有批量任务在跑,请等它跑完(刷新页面看进度)。',
    }
    return res.redirect(redirectUrl)
  }

  // 找所有 ai_reason 是错误前缀的 records — 这些是 LLM 调用失败的,需要重跑
  const targets = db
    .prepare(
      `SELECT r.id
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ?
         AND r.duplicate_of_record_id IS NULL
         AND sd.ai_reason IS NOT NULL
         AND (sd.ai_reason LIKE 'llm_%'
              OR sd.ai_reason LIKE 'codex_%'
              OR sd.ai_reason LIKE 'json_parse_failed%'
              OR sd.ai_reason LIKE 'spawn_%'
              OR sd.ai_reason LIKE 'proc_%')
       ORDER BY r.title`
    )
    .all(project.id)

  if (targets.length === 0) {
    req.session.flash = { type: 'success', message: '没有失败的条目可重跑。' }
    return res.redirect(redirectUrl)
  }

  runningBatches.add(project.id)
  progressInit(project.id, targets.length)
  const userId = req.user.id
  const fakeReq = { ip: req.ip, get: (h) => req.get(h) }

  audit(db, req, {
    eventType: 'screening_batch_started',
    userId,
    projectId: project.id,
    payload: { total: targets.length, mode: 'run_failed' },
  })

  req.session.flash = {
    type: 'success',
    message: `已启动重跑 ${targets.length} 条失败条目。保持页面打开看进度,完成后会通知。`,
  }
  res.redirect(redirectUrl)

  setImmediate(async () => {
    try {
      for (const t of targets) {
        const record = getRecordInProject(db, project.id, t.id)
        if (!record) {
          progressUpdate(project.id, {
            done: (batchProgress.get(project.id)?.done || 0) + 1,
            errors: (batchProgress.get(project.id)?.errors || 0) + 1,
          })
          continue
        }
        progressUpdate(project.id, { current_title: (record.title || '').slice(0, 80) })
        const r = await runScreeningOnce(db, { userId, project, protocol, record, req: fakeReq })
        const cur = batchProgress.get(project.id) || { done: 0, errors: 0 }
        progressUpdate(project.id, {
          done: cur.done + 1,
          errors: cur.errors + (r.ok ? 0 : 1),
        })
      }
    } catch (e) {
      console.error('[screening] run-failed loop crashed:', e)
    } finally {
      progressUpdate(project.id, {
        status: 'finished', current_title: null,
        finished_at: new Date().toISOString(),
      })
      runningBatches.delete(project.id)
      const final = progressGet(project.id) || {}
      audit(db, fakeReq, {
        eventType: 'screening_batch_finished',
        userId, projectId: project.id,
        payload: { total: final.total, done: final.done, errors: final.errors, mode: 'run_failed' },
      })
    }
  })
})

// ============================================================
// GET /:id/screening/progress.json
// ============================================================
router.get('/:id/screening/progress.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })

  const p = progressGet(project.id)
  if (!p) {
    return res.json({ running: false, total: 0, done: 0, errors: 0 })
  }
  res.json({
    running: p.status === 'running',
    status: p.status,
    total: p.total,
    done: p.done,
    errors: p.errors,
    pct: p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
    started_at: p.started_at,
    finished_at: p.finished_at,
    current_title: p.current_title,
  })
})

// ============================================================
// POST /:id/screening/decide/:recordId
//   body: decision (include|exclude|uncertain), reason
// ============================================================
router.post('/:id/screening/decide/:recordId', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  // 检测前端是否要 JSON 响应(AJAX 模式)— 避免整页跳转
  const wantsJson =
    (req.get('Accept') || '').includes('application/json') ||
    req.get('X-Requested-With') === 'XMLHttpRequest'

  if (!project) {
    if (wantsJson) return res.status(404).json({ ok: false, error: '项目不存在' })
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const record = getRecordInProject(db, project.id, req.params.recordId)
  if (!record) {
    if (wantsJson) return res.status(404).json({ ok: false, error: '文献条目不存在或不属于本项目' })
    return res.status(404).render('error', { title: 'Not Found', message: '文献条目不存在或不属于本项目' })
  }

  const screeningUrl = `/projects/${project.id}/screening`
  const redirectUrl = safeRedirectTo(req, project.id, screeningUrl)

  const decision = String(req.body.decision || '').trim()
  if (!SCREENING_DECISIONS.includes(decision)) {
    if (wantsJson) return res.status(400).json({ ok: false, error: '决定值非法' })
    req.session.flash = { type: 'error', message: '决定值非法' }
    return res.redirect(redirectUrl)
  }
  const reason = String(req.body.reason || '').slice(0, 2000).trim() || null

  // 确保行存在
  ensureScreeningRow(db, { recordId: record.id, projectId: project.id })

  db.prepare(
    `UPDATE screening_decisions
     SET human_decision = ?, human_reason = ?, decided_at = datetime('now'),
         decided_by = ?, updated_at = datetime('now')
     WHERE record_id = ? AND stage = 'title_abstract'`
  ).run(decision, reason, req.user.id, record.id)

  audit(db, req, {
    eventType: 'screening_decided',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      record_id: record.id,
      decision,
      has_reason: !!reason,
    },
  })

  if (wantsJson) {
    return res.json({ ok: true, record_id: record.id, decision, reason: reason || null })
  }
  req.session.flash = { type: 'success', message: `已记录人工决定:${decision}` }
  // 跳回 + 锚点定位到当前 record
  res.redirect(redirectUrl + `#row-${record.id}`)
})

// ============================================================
// GET /:id/screening/export.csv
// ============================================================
router.get('/:id/screening/export.csv', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const rows = db
    .prepare(
      `SELECT r.id AS record_id, r.title, r.year, r.journal, r.doi,
              sd.ai_suggestion, sd.ai_reason, sd.ai_confidence, sd.ai_model, sd.ai_ran_at,
              sd.human_decision, sd.human_reason, sd.decided_at
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ? AND r.duplicate_of_record_id IS NULL
       ORDER BY (r.year IS NULL), r.year DESC, r.title`
    )
    .all(project.id)

  const header = [
    'record_id', 'title', 'year', 'journal', 'doi',
    'ai_suggestion', 'ai_confidence', 'ai_model', 'ai_reason', 'ai_ran_at',
    'human_decision', 'human_reason', 'decided_at',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      csv(r.record_id),
      csv(r.title),
      csv(r.year),
      csv(r.journal),
      csv(r.doi),
      csv(r.ai_suggestion || 'not_run'),
      csv(r.ai_confidence),
      csv(r.ai_model),
      csv(r.ai_reason),
      csv(r.ai_ran_at),
      csv(r.human_decision || 'not_decided'),
      csv(r.human_reason),
      csv(r.decided_at),
    ].join(','))
  }
  const body = lines.join('\n')

  audit(db, req, {
    eventType: 'screening_exported_csv',
    userId: req.user.id,
    projectId: project.id,
    payload: { rows: rows.length, bytes: Buffer.byteLength(body, 'utf8') },
  })

  const safeTitle = (project.title || 'project').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'project'
  const filename = `screening-log-${safeTitle}.csv`
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  // 加 BOM 让 Excel 正确识别 UTF-8
  res.send('﻿' + body)
})

/** 把任意值转 CSV 安全字符串(双引号包裹 + 双引号转义) */
function csv(v) {
  if (v == null) return ''
  let s = String(v)
  // 去掉换行,避免一行多 record
  s = s.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    s = '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export default router
