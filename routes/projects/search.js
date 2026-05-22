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
  buildSearchSystem,
  buildSearchUserPrompt,
  resolveTargetDatabases,
  normalizeSearchOutput,
  SEARCH_DATABASES,
  SEARCH_QUERY_TYPES,
} from '../../services/prompts/search.js'
import {
  RECOMMEND_SYSTEM,
  buildRecommendSystem,
  buildRecommendPrompt,
  normalizeRecommendOutput,
} from '../../services/prompts/search-recommend.js'
import { getProjectProgress } from '../../services/prisma.js'
import { getLockState, lockSearch, unlockSearch } from '../../services/search-lock.js'

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
  main: 'AI 优化主检索',
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

  // 只为用户在项目里勾选的库准备 tab(IEEE / ACM 等不在 prompt 支持列表里,自动落到 ['wos','scopus','pubmed'] 兜底)
  const targetDatabases = resolveTargetDatabases(project.databases)

  // **exploration 最新批**:只看非 main 的 query_type,版本号取这些里最高的。
  // 这样即便 main 是更新的版本,下方的 tabs 仍然展示完整的 9 条 exploration。
  const explorationStrategies = strategies.filter((s) => s.query_type !== 'main')
  const latestVersion = explorationStrategies.length
    ? explorationStrategies.reduce((m, s) => Math.max(m, s.version || 0), 0)
    : null
  const latestBatch = latestVersion == null
    ? []
    : explorationStrategies.filter((s) => s.version === latestVersion)

  const byDatabase = {}
  for (const k of targetDatabases) byDatabase[k] = []
  for (const s of latestBatch) {
    // 历史 batch 里可能有未选中的库残留(例如以前生成时还是 3 库默认),也展示
    if (!byDatabase[s.database_name]) byDatabase[s.database_name] = []
    byDatabase[s.database_name].push(s)
  }
  // 每个 database 内按 query_type 顺序排序
  const QT_ORDER = { high_recall: 0, balanced: 1, high_precision: 2 }
  for (const k of Object.keys(byDatabase)) {
    byDatabase[k].sort((a, b) => (QT_ORDER[a.query_type] ?? 9) - (QT_ORDER[b.query_type] ?? 9))
  }
  // dbOrder = 用户选中的 + 历史 batch 里多出来的(放后面)
  const dbOrderForView = [
    ...targetDatabases,
    ...Object.keys(byDatabase).filter((k) => !targetDatabases.includes(k)),
  ]

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[search] getProjectProgress failed:', e.message)
  }

  // exploration:已回填命中数的条数(用于 UI 上"还差几条才能优化主检索"的提示)
  const explorationLogged = strategies.filter(
    (s) => s.query_type !== 'main' && s.result_count != null
      && targetDatabases.includes(s.database_name)
  ).length

  // 最新一批 main(AI 优化主检索)— 在版本号最高的"含 main"那一批
  const mainStrategies = strategies.filter((s) => s.query_type === 'main')
  let latestMainVersion = null
  let latestMainBatch = []
  if (mainStrategies.length) {
    latestMainVersion = mainStrategies.reduce((m, s) => Math.max(m, s.version || 0), 0)
    latestMainBatch = mainStrategies
      .filter((s) => s.version === latestMainVersion)
      .slice()
      .sort((a, b) => {
        const ai = targetDatabases.indexOf(a.database_name)
        const bi = targetDatabases.indexOf(b.database_name)
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
      })
  }

  // 兼容老 session(从旧版升级时如果还有 stale 数据,清掉即可)
  if (req.session && req.session.searchRecommendation) {
    delete req.session.searchRecommendation
  }

  // 锁定状态(用户即将上传 CSV 前的最终方案落盘)
  const lockState = getLockState(db, project)

  res.render('projects/search', {
    title: `检索式 · ${project.title}`,
    project,
    approvedProtocol,
    strategies,
    latestBatch,
    latestVersion,
    byDatabase,
    progress,
    loggedCount: explorationLogged,
    latestMainBatch,
    latestMainVersion,
    lockState,
    dbLabel: DB_LABEL,
    qtLabel: QT_LABEL,
    dbOrder: dbOrderForView,
    targetDatabases,
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

  // 只为用户勾选的库生成 — 不再硬编码三库
  const targetDatabases = resolveTargetDatabases(project.databases)
  const expectedCount = targetDatabases.length * 3

  const dynamicSystem = buildSearchSystem({ targetDatabases })
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
    targetDatabases,
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'search_strategy',
      projectId: project.id,
      system: dynamicSystem,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 8192,
      timeoutMs: 480_000,
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
  // 只保留 LLM 给出的 *本次 targetDatabases* 内的策略,避免历史污染
  normalized.strategies = normalized.strategies.filter((s) => targetDatabases.includes(s.database))

  // 至少 expectedCount * 2/3 条(允许 LLM 漏一两条但不能整库缺)
  const minRequired = Math.max(2, Math.floor(expectedCount * 2 / 3))
  if (normalized.strategies.length < minRequired) {
    audit(db, req, {
      eventType: 'search_generate_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        status: 'parsed_too_few',
        count: normalized.strategies.length,
        expected: expectedCount,
        target_databases: targetDatabases,
        model: result.model,
        had_json: !!result.data,
      },
    })
    req.session.flash = {
      type: 'error',
      message: `LLM 返回的检索式过少(${normalized.strategies.length}/${expectedCount} 条),请重试或检查协议是否完整。`,
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

  // 必须有审批协议
  const approved = getApprovedProtocol(db, project.id)
  if (!approved) {
    req.session.flash = { type: 'error', message: '请先审批研究协议,才能让 AI 优化主检索。' }
    return res.redirect(`/projects/${project.id}/search`)
  }

  const targetDatabases = resolveTargetDatabases(project.databases)

  // 拉所有 exploration(非 main)且已回填命中数的策略,作为优化反馈信号
  const allStrategies = listStrategies(db, project.id)
  const exploration = allStrategies.filter(
    (s) => s.query_type !== 'main' && targetDatabases.includes(s.database_name)
  )
  const logged = exploration.filter((s) => s.result_count != null)

  if (logged.length < 2) {
    req.session.flash = {
      type: 'error',
      message: `至少需要 2 条 exploration 检索式回填命中数,AI 才能基于反馈优化主检索(当前 ${logged.length} 条)。`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  audit(db, req, {
    eventType: 'search_recommend_requested',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      logged_count: logged.length,
      target_databases: targetDatabases,
    },
  })

  const dynamicSystem = buildRecommendSystem({ targetDatabases })
  const userPrompt = buildRecommendPrompt({
    topic: project.topic,
    protocol: approved,
    projectInput: {
      year_start: project.year_start,
      year_end: project.year_end,
      document_types: project.document_types,
      language_limits: project.language_limits,
      discipline: project.discipline,
      goal: project.goal,
    },
    targetDatabases,
    previousStrategies: logged.map((s) => ({
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
      system: dynamicSystem,
      prompt: userPrompt,
      expectJson: true,
      // 主检索质量直接影响后续筛选基线 → 锁旗舰,不走 alias
      model: 'claude-opus-4-7',
      maxTokens: 4096,    // optimized_queries × N + rationale + filters,4K 给足
      timeoutMs: 300_000, // 5 分钟:LLM 要消化前面所有命中数 + 重写检索式
    })
  } catch (e) {
    console.error('[search/recommend-best] runLlm threw:', e)
    req.session.flash = {
      type: 'error',
      message: `AI 优化失败:${(e?.message || String(e)).slice(0, 200)}`,
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
      message: `AI 优化失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  const knownStrategyIds = new Set(logged.map((s) => s.id))
  const normalized = normalizeRecommendOutput(result.data || null, {
    targetDatabases,
    knownStrategyIds,
  })

  if (!normalized.ok) {
    // 捕获实际的 raw 形状,便于排查 LLM 字段漂移
    let rawShape = null
    try {
      if (result.data && typeof result.data === 'object') {
        rawShape = {
          top_keys: Object.keys(result.data).slice(0, 20),
          // 把 raw 序列化截断保存(脱敏过的 ID 已经在 prompt 里,不算敏感)
          raw_truncated: JSON.stringify(result.data).slice(0, 1000),
        }
      }
    } catch { /* ignore */ }
    audit(db, req, {
      eventType: 'search_recommend_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        status: 'normalize_failed',
        error: normalized.error,
        had_json: !!result.data,
        model: result.model,
        raw_shape: rawShape,
        // 也把 LLM 原始文本前 800 字捕进来,看是不是包了 markdown / 解释
        raw_text_head: typeof result.text === 'string' ? result.text.slice(0, 800) : null,
      },
    })
    req.session.flash = {
      type: 'error',
      message: `AI 推荐结果无效:${normalized.error}`,
    }
    return res.redirect(`/projects/${project.id}/search`)
  }

  // 把优化主检索作为新 version 持久化进 search_strategies
  // (query_type='main',与 exploration 共用同一张表,但用版本号 + 类型区分)
  const { maxV } = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxV FROM search_strategies WHERE project_id = ?')
    .get(project.id)
  const mainVersion = maxV + 1

  const insertMain = db.prepare(
    `INSERT INTO search_strategies
       (id, project_id, database_name, query_type, query_text, filters,
        rationale, version, generated_by, model)
     VALUES (?, ?, ?, 'main', ?, ?, ?, ?, 'ai', ?)`
  )

  const insertedIds = []
  const tx = db.transaction(() => {
    for (const q of normalized.data.optimized_queries) {
      const strategyId = randomId('strat')
      // rationale 里追加 based_on 信息,方便用户复盘 LLM 参考了哪些 exploration
      let rationale = q.rationale || ''
      if (Array.isArray(q.based_on_strategy_ids) && q.based_on_strategy_ids.length) {
        rationale += (rationale ? '\n' : '') + `(参考 exploration: ${q.based_on_strategy_ids.join(', ')})`
      }
      if (q.expected_count_estimate != null) {
        rationale += (rationale ? ' ' : '') + `· 预估命中 ${q.expected_count_estimate}`
      }
      insertMain.run(
        strategyId,
        project.id,
        q.database,
        q.query_text,
        q.filters ? JSON.stringify(q.filters) : null,
        rationale.slice(0, 800),
        mainVersion,
        result.model,
      )
      insertedIds.push(strategyId)
    }
    db.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).run(project.id)
  })
  tx()

  audit(db, req, {
    eventType: 'search_main_optimized',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      main_version: mainVersion,
      model: result.model,
      provider: result.provider,
      duration_ms: result.durationMs,
      logged_count: logged.length,
      target_databases: targetDatabases,
      generated_count: normalized.data.optimized_queries.length,
      missing_databases: normalized.data.missing_databases || [],
      warnings_count: normalized.data.warnings.length,
    },
  })

  const summary = normalized.data.optimized_queries
    .map((q) => `${q.database.toUpperCase()}${q.expected_count_estimate != null ? ' (~'+q.expected_count_estimate+')' : ''}`)
    .join(' · ')
  const missingHint = (normalized.data.missing_databases || []).length
    ? `(漏了 ${normalized.data.missing_databases.join(', ')},可重试)`
    : ''
  req.session.flash = {
    type: 'success',
    message: `已生成主检索 v${mainVersion}:${summary}${missingHint}`,
  }
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
  const QT_ORDER = { main: -1, high_recall: 0, balanced: 1, high_precision: 2 }
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

// ============================================================
// POST /projects/:id/search/lock
//   表单字段:database_X__used / __query_text / __strategy_id / __result_count
//             / __search_date / __notes(X = 'wos' / 'scopus' / 'pubmed')
//   把"每个目标库实际用了什么检索式"快照写到 final_search_records,
//   并标记 projects.search_locked_at。
// ============================================================
router.post('/:id/search/lock', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const targetDatabases = resolveTargetDatabases(project.databases)

  // 从 form body 抽取每个库的字段(input name = "<db>__<field>")
  const entries = []
  for (const d of targetDatabases) {
    const usedRaw = req.body[`${d}__used`]
    const used = usedRaw === '1' || usedRaw === 'on' || usedRaw === 'true'
    entries.push({
      database: d,
      used,
      strategy_id: req.body[`${d}__strategy_id`] || null,
      query_text: req.body[`${d}__query_text`] || '',
      result_count: req.body[`${d}__result_count`],
      search_date: req.body[`${d}__search_date`] || '',
      notes: req.body[`${d}__notes`] || '',
    })
  }

  const result = lockSearch(db, project.id, entries, targetDatabases)
  if (!result.ok) {
    audit(db, req, {
      eventType: 'search_lock_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { error: result.error, target_databases: targetDatabases },
    })
    req.session.flash = { type: 'error', message: `锁定失败:${result.error}` }
    return res.redirect(`/projects/${project.id}/search`)
  }

  audit(db, req, {
    eventType: 'search_locked',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      written: result.written,
      target_databases: targetDatabases,
      used_databases: entries.filter((e) => e.used).map((e) => e.database),
    },
  })

  const usedSummary = entries
    .filter((e) => e.used)
    .map((e) => `${e.database.toUpperCase()}${
      e.result_count ? ` (${e.result_count})` : ''
    }`)
    .join(' · ')
  req.session.flash = {
    type: 'success',
    message: `检索方案已锁定 · 使用的库:${usedSummary || '无'} · 现在可以上传 CSV。`,
  }
  res.redirect(`/projects/${project.id}/search`)
})

// ============================================================
// POST /projects/:id/search/unlock
//   解锁(允许用户继续修改后重锁)。final_search_records 保留作为历史。
// ============================================================
router.post('/:id/search/unlock', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  if (!project.search_locked_at) {
    req.session.flash = { type: 'error', message: '当前未锁定,无需解锁。' }
    return res.redirect(`/projects/${project.id}/search`)
  }
  unlockSearch(db, project.id)
  audit(db, req, {
    eventType: 'search_unlocked',
    userId: req.user.id,
    projectId: project.id,
    payload: { previously_locked_at: project.search_locked_at },
  })
  req.session.flash = { type: 'success', message: '检索方案已解锁,可重新调整。' }
  res.redirect(`/projects/${project.id}/search`)
})

export default router
