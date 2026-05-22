/**
 * Phase 3 Agent E — WoS / Scopus / PubMed 检索式 AI 生成
 *
 * 挂载点(由汇总层在 server.js 完成):
 *   app.use('/projects/:id/search', requireUser, searchRouter)
 *
 * 但 Express 嵌套路由器拿不到 :id,所以本路由器用 mergeParams = true,
 * 实际挂载点会是 app.use('/projects', requireUser, searchRouter) 风格 —
 * 见 SUMMARY-E.md "server.js mount" 一节。
 *
 * 路由清单:
 *   GET  /projects/:id/search                              渲染检索式页
 *   POST /projects/:id/search/generate                     调 Claude 生成 9 条
 *   POST /projects/:id/search/:strategyId/log              回填命中数 + 检索日期
 *   POST /projects/:id/search/:strategyId/notes            回填备注
 *   GET  /projects/:id/search/export.md                    导出 Markdown 附录
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  SEARCH_SYSTEM,
  buildSearchUserPrompt,
  normalizeSearchOutput,
  SEARCH_DATABASES,
  SEARCH_QUERY_TYPES,
} from '../../services/prompts/search.js'
import {
  RECOMMEND_SYSTEM,
  buildRecommendPrompt,
  normalizeRecommendOutput,
} from '../../services/prompts/search-recommend.js'
import { getProjectProgress } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

// ============================================================
// 工具
// ============================================================

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

function parseStrategy(row) {
  if (!row) return null
  let filters = null
  if (row.filters) {
    try { filters = JSON.parse(row.filters) } catch { filters = null }
  }
  return { ...row, filters }
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

function listStrategies(db, projectId) {
  // 同一批 version 一起返回,version DESC,在每个 version 内按 database / query_type 排序
  const rows = db
    .prepare(
      `SELECT * FROM search_strategies
       WHERE project_id = ?
       ORDER BY version DESC, database_name ASC, query_type ASC, created_at ASC`
    )
    .all(projectId)
  return rows.map(parseStrategy)
}

const DB_LABEL = {
  wos: 'Web of Science',
  scopus: 'Scopus',
  pubmed: 'PubMed',
}
const QT_LABEL = {
  high_recall: '高召回',
  balanced: '平衡',
  high_precision: '高精确',
}

// ============================================================
// GET /projects/:id/search
// ============================================================
router.get('/:id/search', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const approvedProtocol = getApprovedProtocol(db, project.id)
  const strategies = listStrategies(db, project.id)

  // 按 (version, database) 分组,便于 EJS 渲染 tab
  const latestVersion = strategies.length ? strategies[0].version : null
  const latestBatch = latestVersion == null
    ? []
    : strategies.filter((s) => s.version === latestVersion)

  const byDatabase = { wos: [], scopus: [], pubmed: [] }
  for (const s of latestBatch) {
    if (byDatabase[s.database_name]) byDatabase[s.database_name].push(s)
  }
  // 每个 database 内按 query_type 顺序排序
  const QT_ORDER = { high_recall: 0, balanced: 1, high_precision: 2 }
  for (const k of Object.keys(byDatabase)) {
    byDatabase[k].sort((a, b) => (QT_ORDER[a.query_type] ?? 9) - (QT_ORDER[b.query_type] ?? 9))
  }

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[search] getProjectProgress failed:', e.message)
  }

  // 已回填命中数的条数(用于 UI 上"还差几条才能跑推荐"的提示)
  const loggedCount = latestBatch.filter((s) => s.result_count != null).length

  // ephemeral 推荐结果 — 仅当本次 redirect 来自 recommend-best 时存在
  let recommendation = null
  if (req.session && req.session.searchRecommendation
      && req.session.searchRecommendation.projectId === project.id) {
    const rec = req.session.searchRecommendation
    // 把 strategy_id 拼成 view 用的完整对象
    const byId = new Map(latestBatch.map((s) => [s.id, s]))
    const decorate = (id) => {
      const s = byId.get(id)
      if (!s) return null
      return {
        id: s.id,
        database_name: s.database_name,
        query_type: s.query_type,
        result_count: s.result_count,
        rationale: s.rationale,
        dbLabel: DB_LABEL[s.database_name] || s.database_name,
        qtLabel: QT_LABEL[s.query_type] || s.query_type,
      }
    }
    recommendation = {
      primary: {
        ...decorate(rec.data.primary_choice.strategy_id),
        reason: rec.data.primary_choice.reason,
      },
      secondary: rec.data.secondary_choices
        .map((sc) => {
          const d = decorate(sc.strategy_id)
          return d ? { ...d, role: sc.role, reason: sc.reason } : null
        })
        .filter(Boolean),
      warnings: rec.data.warnings,
      estimated_workload: rec.data.estimated_screening_workload,
      durationMs: rec.durationMs,
      model: rec.model,
    }
    delete req.session.searchRecommendation
  }

  res.render('projects/search', {
    title: `检索式 · ${project.title}`,
    project,
    approvedProtocol,
    strategies,            // 全量历史(版本切换 / 历史展示)
    latestBatch,           // 最新一批
    latestVersion,
    byDatabase,            // 仅最新一批分组
    progress,
    loggedCount,
    recommendation,
    dbLabel: DB_LABEL,
    qtLabel: QT_LABEL,
    dbOrder: SEARCH_DATABASES,
    qtOrder: SEARCH_QUERY_TYPES,
  })
})

// ============================================================
// POST /projects/:id/search/generate
// ============================================================
router.post('/:id/search/generate', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const approved = getApprovedProtocol(db, project.id)
  if (!approved) {
    req.session.flash = {
      type: 'error',
      message: '请先生成并审批研究协议,才能生成检索式。',
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  const userPrompt = buildSearchUserPrompt({
    protocol: approved,
    projectInput: {
      topic: project.topic,
      discipline: project.discipline,
      goal: project.goal,
      year_start: project.year_start,
      year_end: project.year_end,
      databases: project.databases,
      language_limits: project.language_limits,
      document_types: project.document_types,
    },
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'search_strategy',
      projectId: project.id,
      system: SEARCH_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 8192,       // 9 条检索式 + 同义词扩展 + 警告,中文较长
      timeoutMs: 480_000,    // 8 分钟:CLI spawn 开销 + Sonnet 输出 9 条长检索式
    })
  } catch (e) {
    console.error('[search/generate] runLlm threw:', e)
    req.session.flash = {
      type: 'error',
      message: `生成失败:${(e?.message || String(e)).slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  if (!result.ok) {
    audit(db, req, {
      eventType: 'search_generate_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { status: result.status, error: (result.error || '').slice(0, 300) },
    })
    req.session.flash = {
      type: 'error',
      message: `生成失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  // 标准化
  const normalized = normalizeSearchOutput(result.data || null)

  // 最少 6 条(2 数据库 × 3 版本)才算有意义,否则记审计 + 失败 flash
  if (normalized.strategies.length < 6) {
    audit(db, req, {
      eventType: 'search_generate_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        status: 'parsed_too_few',
        count: normalized.strategies.length,
        model: result.model,
        had_json: !!result.data,
      },
    })
    req.session.flash = {
      type: 'error',
      message: `LLM 返回的检索式过少(${normalized.strategies.length} 条),请重试或检查协议是否完整。`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  // 同一批共享 version 号
  const { maxV } = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxV FROM search_strategies WHERE project_id = ?')
    .get(project.id)
  const version = maxV + 1

  const insertStmt = db.prepare(
    `INSERT INTO search_strategies
       (id, project_id, database_name, query_type, query_text, filters,
        rationale, version, generated_by, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)`
  )

  // 把 expanded_terms 也存到 notes 字段(第一条记录里),用户可以看到
  // 为了简单起见这里把它放到"第一个 strategy"的 notes 里
  let perDbCount = { wos: 0, scopus: 0, pubmed: 0 }

  const tx = db.transaction(() => {
    for (const s of normalized.strategies) {
      insertStmt.run(
        randomId('strat'),
        project.id,
        s.database_name || s.database,
        s.query_type,
        s.query_text,
        s.filters ? JSON.stringify(s.filters) : null,
        s.rationale || null,
        version,
        result.model,
      )
      if (perDbCount[s.database] != null) perDbCount[s.database] += 1
    }
    // 更新项目 status:protocol_approved → searching(只在第一次)
    if (project.status === 'protocol_approved') {
      db.prepare(`UPDATE projects SET status = 'searching', updated_at = datetime('now') WHERE id = ?`).run(project.id)
    } else {
      db.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).run(project.id)
    }
  })
  tx()

  audit(db, req, {
    eventType: 'search_generated',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      version,
      model: result.model,
      provider: result.provider,
      duration_ms: result.durationMs,
      count_total: normalized.strategies.length,
      count_per_db: perDbCount,
      warnings_count: normalized.warnings.length,
      had_expanded_terms: Object.keys(normalized.expanded_terms || {}).length > 0,
    },
  })

  const warnText = normalized.warnings.length
    ? `(注意:${normalized.warnings.slice(0, 2).join(';')})`
    : ''
  req.session.flash = {
    type: 'success',
    message: `已生成检索式 v${version}:${normalized.strategies.length} 条 / ${result.durationMs}ms ${warnText}`.trim(),
  }
  res.redirect(`/projects/${project.id}/search`)
})

// ============================================================
// POST /projects/:id/search/:strategyId/log
//   表单字段:result_count, search_date
// ============================================================
router.post('/:id/search/:strategyId/log', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const row = db
    .prepare('SELECT id FROM search_strategies WHERE id = ? AND project_id = ?')
    .get(req.params.strategyId, project.id)
  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '检索式不存在' })
  }

  const rcRaw = String(req.body.result_count ?? '').trim()
  let resultCount = null
  if (rcRaw !== '') {
    const n = Number.parseInt(rcRaw, 10)
    if (Number.isFinite(n) && n >= 0) resultCount = n
  }
  let searchDate = String(req.body.search_date ?? '').trim() || null
  // 简单校验 YYYY-MM-DD
  if (searchDate && !/^\d{4}-\d{2}-\d{2}$/.test(searchDate)) {
    searchDate = null
  }

  db.prepare(
    `UPDATE search_strategies SET result_count = ?, search_date = ? WHERE id = ?`
  ).run(resultCount, searchDate, row.id)

  audit(db, req, {
    eventType: 'search_logged',
    userId: req.user.id,
    projectId: project.id,
    payload: { strategy_id: row.id, result_count: resultCount, search_date: searchDate },
  })

  req.session.flash = { type: 'success', message: '检索记录已保存。' }
  res.redirect(`/projects/${project.id}/search`)
})

// ============================================================
// POST /projects/:id/search/:strategyId/notes
// ============================================================
router.post('/:id/search/:strategyId/notes', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const row = db
    .prepare('SELECT id FROM search_strategies WHERE id = ? AND project_id = ?')
    .get(req.params.strategyId, project.id)
  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '检索式不存在' })
  }

  const notes = String(req.body.notes ?? '').slice(0, 4000).trim() || null
  db.prepare(`UPDATE search_strategies SET notes = ? WHERE id = ?`).run(notes, row.id)

  audit(db, req, {
    eventType: 'search_note_updated',
    userId: req.user.id,
    projectId: project.id,
    payload: { strategy_id: row.id, has_notes: !!notes },
  })

  req.session.flash = { type: 'success', message: '备注已保存。' }
  res.redirect(`/projects/${project.id}/search`)
})

// ============================================================
// POST /projects/:id/search/recommend-best
//   基于已回填的命中数,让 LLM 推荐"主检索"。
//   推荐结果纯 ephemeral,放在 session.searchRecommendation,
//   下次刷新 GET /search 时被 pop 并展示。
// ============================================================
router.post('/:id/search/recommend-best', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const strategies = listStrategies(db, project.id)
  const latestVersion = strategies.length ? strategies[0].version : null
  const latestBatch = latestVersion == null
    ? []
    : strategies.filter((s) => s.version === latestVersion)
  const logged = latestBatch.filter((s) => s.result_count != null)

  if (logged.length < 3) {
    req.session.flash = {
      type: 'error',
      message: `至少需要 3 条检索式回填命中数,才能让 AI 推荐(当前 ${logged.length} 条)。`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  audit(db, req, {
    eventType: 'search_recommend_requested',
    userId: req.user.id,
    projectId: project.id,
    payload: { logged_count: logged.length, version: latestVersion },
  })

  const userPrompt = buildRecommendPrompt({
    topic: project.topic,
    strategies: logged.map((s) => ({
      id: s.id,
      database_name: s.database_name,
      query_type: s.query_type,
      result_count: s.result_count,
      rationale: s.rationale,
      query_text: s.query_text,
    })),
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'search_recommend',
      projectId: project.id,
      system: RECOMMEND_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'standard',
      maxTokens: 1024,
      timeoutMs: 60_000,
    })
  } catch (e) {
    console.error('[search/recommend-best] runLlm threw:', e)
    req.session.flash = {
      type: 'error',
      message: `AI 推荐失败:${(e?.message || String(e)).slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  if (!result.ok) {
    audit(db, req, {
      eventType: 'search_recommend_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { status: result.status, error: (result.error || '').slice(0, 300) },
    })
    req.session.flash = {
      type: 'error',
      message: `AI 推荐失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  const validIds = new Set(logged.map((s) => s.id))
  const normalized = normalizeRecommendOutput(result.data || null, validIds)

  if (!normalized.ok) {
    audit(db, req, {
      eventType: 'search_recommend_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        status: 'normalize_failed',
        error: normalized.error,
        had_json: !!result.data,
        model: result.model,
      },
    })
    req.session.flash = {
      type: 'error',
      message: `AI 推荐结果无效:${normalized.error}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  // 存入 session,供 GET /search 渲染时 pop
  req.session.searchRecommendation = {
    projectId: project.id,
    version: latestVersion,
    data: normalized.data,
    durationMs: result.durationMs,
    model: result.model,
    createdAt: Date.now(),
  }

  audit(db, req, {
    eventType: 'search_recommended',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      version: latestVersion,
      model: result.model,
      provider: result.provider,
      duration_ms: result.durationMs,
      logged_count: logged.length,
      primary_strategy_id: normalized.data.primary_choice.strategy_id,
      secondary_count: normalized.data.secondary_choices.length,
      warnings_count: normalized.data.warnings.length,
      estimated_workload: normalized.data.estimated_screening_workload,
    },
  })

  res.redirect(`/projects/${project.id}/search`)
})

// ============================================================
// GET /projects/:id/search/export.md
// ============================================================
router.get('/:id/search/export.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const approved = getApprovedProtocol(db, project.id)
  const strategies = listStrategies(db, project.id)

  // 取最新版本
  const latestVersion = strategies.length ? strategies[0].version : null
  const latest = latestVersion == null
    ? []
    : strategies.filter((s) => s.version === latestVersion)

  // 按 db / qt 分组
  const QT_ORDER = { high_recall: 0, balanced: 1, high_precision: 2 }
  const grouped = {}
  for (const s of latest) {
    if (!grouped[s.database_name]) grouped[s.database_name] = []
    grouped[s.database_name].push(s)
  }
  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => (QT_ORDER[a.query_type] ?? 9) - (QT_ORDER[b.query_type] ?? 9))
  }

  const lines = []
  lines.push(`# 检索策略附录 — ${project.title}`)
  lines.push('')
  lines.push(`- 项目主题:${project.topic || '(未填)'}`)
  if (project.discipline) lines.push(`- 学科:${project.discipline}`)
  if (project.year_start || project.year_end) {
    lines.push(`- 时间范围:${project.year_start || '不限'} – ${project.year_end || '不限'}`)
  }
  if (approved) {
    lines.push(`- 关联协议:v${approved.version}(${approved.approved_at || '已审批'})`)
  }
  if (latestVersion != null) {
    lines.push(`- 检索式版本:v${latestVersion}`)
  }
  lines.push(`- 导出时间:${new Date().toISOString()}`)
  lines.push('')

  // 协议要点
  if (approved) {
    lines.push('## 协议要点')
    lines.push('')
    if (Array.isArray(approved.research_questions) && approved.research_questions.length) {
      lines.push('**研究问题:**')
      lines.push('')
      approved.research_questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`))
      lines.push('')
    }
    if (Array.isArray(approved.concept_groups) && approved.concept_groups.length) {
      lines.push('**概念组:**')
      lines.push('')
      approved.concept_groups.forEach((g, i) => {
        const terms = Array.isArray(g.terms) ? g.terms : []
        lines.push(`${i + 1}. **${g.name || '未命名'}**: ${terms.join(' OR ')}`)
      })
      lines.push('')
    }
  }

  // 检索式
  if (!latest.length) {
    lines.push('## 检索式')
    lines.push('')
    lines.push('_(尚未生成)_')
  } else {
    lines.push('## 检索式(PRISMA 2020 #6 信息来源 + #7 检索策略)')
    lines.push('')
    for (const dbKey of SEARCH_DATABASES) {
      const group = grouped[dbKey]
      if (!group || group.length === 0) continue
      lines.push(`### ${DB_LABEL[dbKey] || dbKey}`)
      lines.push('')
      for (const s of group) {
        lines.push(`#### ${QT_LABEL[s.query_type] || s.query_type}`)
        lines.push('')
        if (s.rationale) {
          lines.push(`- 设计理由:${s.rationale}`)
        }
        if (s.filters) {
          const fparts = []
          if (s.filters.year_range) fparts.push(`年份 ${s.filters.year_range.join('-')}`)
          if (s.filters.document_types) fparts.push(`类型 ${s.filters.document_types.join('/')}`)
          if (s.filters.language) fparts.push(`语言 ${s.filters.language.join('/')}`)
          if (fparts.length) lines.push(`- 过滤:${fparts.join(';')}`)
        }
        if (s.search_date) lines.push(`- 检索日期:${s.search_date}`)
        if (s.result_count != null) lines.push(`- 命中数:${s.result_count}`)
        if (s.notes) lines.push(`- 备注:${s.notes}`)
        lines.push('')
        // query_text 包在代码块里
        lines.push('```')
        lines.push(s.query_text)
        lines.push('```')
        lines.push('')
      }
    }
  }

  // 命中汇总
  const logged = latest.filter((s) => s.result_count != null)
  if (logged.length) {
    lines.push('## 命中数汇总')
    lines.push('')
    lines.push('| 数据库 | 版本 | 命中数 | 检索日期 |')
    lines.push('|---|---|---:|---|')
    for (const s of logged) {
      lines.push(`| ${DB_LABEL[s.database_name] || s.database_name} | ${QT_LABEL[s.query_type] || s.query_type} | ${s.result_count} | ${s.search_date || '—'} |`)
    }
    lines.push('')
    const total = logged.reduce((acc, s) => acc + (s.result_count || 0), 0)
    lines.push(`合计:${total}(${logged.length} 条已记录命中)`)
    lines.push('')
  }

  const body = lines.join('\n')
  const safeTitle = (project.title || 'project').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'project'
  const filename = `search-strategy-${safeTitle}-v${latestVersion ?? 'na'}.md`

  audit(db, req, {
    eventType: 'search_exported_md',
    userId: req.user.id,
    projectId: project.id,
    payload: { version: latestVersion, strategy_count: latest.length, bytes: Buffer.byteLength(body, 'utf8') },
  })

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(body)
})

export default router
