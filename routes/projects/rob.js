/**
 * Step 5 Risk of Bias 路由 —— 镜像 routes/projects/matrix.js 模式
 * ------------------------------------------------------------
 *
 * 挂载点(server.js):
 *   import projectRobRouter from './routes/projects/rob.js'
 *   app.use('/projects', requireUser, projectRobRouter)
 *   ↑ 必须挂在 projectsRouter(routes/projects/index.js)之前,否则会被 stub 路由抢走
 *
 * 路由清单:
 *   GET  /:id/rob                              主页(5 tool 路由统计 + 121 篇 RoB 列表)
 *   POST /:id/rob/run-batch-ai                 Sonnet 批量 RoB 评估(后台 setImmediate)
 *   GET  /:id/rob/batch-progress.json          批量进度轮询
 *   POST /:id/rob/optimize-overlay             Opus 一次性生成项目 overlay(原子 lock)
 *   GET  /:id/rob/optimize-overlay/status.json overlay 进度轮询
 *   POST /:id/rob/:recordId/run-one-ai         单条重跑
 *   POST /:id/rob/:recordId/edit-judgment      手动改某个 domain 的判断(filled_by='ai_edited')
 *   POST /:id/rob/:recordId/edit-tool          改用什么工具评(用户覆盖自动路由)
 *   GET  /:id/rob/export.xlsx                  robvis-compatible traffic-light grid
 *   GET  /:id/rob/export.json                  完整 JSON 导出
 *
 * 只对 screening human_decision='include' + has_pdf=1(或 abstract-only 兜底)的论文做 RoB。
 */

import express from 'express'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import * as batchJobsSvc from '../../services/batch-jobs.js'
import { ratingToValence } from '../../services/rob-helpers.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'
import {
  buildPaperTextFromChunks,
  getMatrixForRecord,
} from '../../services/literature-matrix.js'
import {
  pickRobTool,
  TOOL_META,
  TOOL_SYSTEM_PROMPTS,
  OPTIMIZE_OVERLAY_SYSTEM,
  buildOptimizeOverlayUserPrompt,
  buildRobUserPrompt,
  parseRobBatchOutput,
  normalizeOverlayOutput,
  upsertRobAssessment,
  getRobForRecord,
  listRobForProject,
  listRobPass2ForProject,
  promotePass2ToPrimary,
  deleteRobForRecord,
  computeOverallRating,
  runRobFastBatch,
} from '../../services/rob.js'

const ROB_BATCH_KIND = 'rob_assessment'
const ROB_DEEP_VERIFY_KIND = 'rob_deep_verify'

// 把 overall_rating + tool 映射到 valence ('good' / 'middle' / 'bad' / 'unrated')
// 给 Deep verify 默认筛选 "中差" 用。
// (M30 起从 services/rob-helpers.js 共享,本地别名保持兼容)
const ratingValenceSrv = ratingToValence

// ---------- 工具 ----------

function parseJsonArrayField(v) {
  if (!v) return []
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : [] } catch { return [] }
}

function ownProjectOr404(db, projectId, userId) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)
  if (!row) return null
  return {
    ...row,
    databases: parseJsonArrayField(row.databases),
    language_limits: parseJsonArrayField(row.language_limits),
    document_types: parseJsonArrayField(row.document_types),
    seed_titles: parseJsonArrayField(row.seed_titles),
  }
}

// 当前已审批协议(version 最大的)
function loadApprovedProtocol(db, projectId) {
  const row = db.prepare(
    `SELECT * FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
  ).get(projectId)
  if (!row) return null
  const parseArr = (v) => { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : [] } catch { return [] } }
  return {
    ...row,
    research_questions: parseArr(row.research_questions),
    inclusion_criteria: parseArr(row.inclusion_criteria),
    exclusion_criteria: parseArr(row.exclusion_criteria),
    concept_groups: parseArr(row.concept_groups),
  }
}

// 列出 include 论文(给 RoB 评估)
//   joins screening_decisions human_decision='include' + records 信息
//   附带 study_design(从 literature_matrix 取)+ 当前 RoB(若有)
function listIncludedRecordsForRob(db, projectId) {
  // M28 加 last_rob_deep_verified_at + M26 rob_excluded_at(给 Deep verify 路由 skip 用)
  return db.prepare(`
    SELECT r.id, r.title, r.authors_text, r.year, r.journal, r.doi, r.has_pdf,
           r.last_rob_deep_verified_at, r.rob_excluded_at, r.rob_excluded_reason
      FROM records r
      INNER JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.project_id = r.project_id
        AND sd.stage = 'title_abstract'
        AND sd.human_decision = 'include'
     WHERE r.project_id = ?
       AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
     ORDER BY r.year DESC, r.title ASC
  `).all(projectId)
}

// 抽 3-4 篇代表性论文给 overlay LLM(跟 matrix 那个一样的策略,但不强依赖)
function sampleRepresentativeIncludeRecords(db, projectId, n = 4) {
  const rows = db.prepare(`
    SELECT r.id, r.title, r.year, r.journal, r.abstract
      FROM records r
      INNER JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.project_id = r.project_id
        AND sd.human_decision = 'include'
     WHERE r.project_id = ?
       AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
       AND r.abstract IS NOT NULL AND length(r.abstract) > 200
     ORDER BY r.year DESC, r.id
  `).all(projectId)
  if (rows.length <= n) return rows
  const picks = new Set()
  picks.add(0); picks.add(rows.length - 1)
  const step = Math.floor(rows.length / n)
  for (let i = 1; picks.size < n && i < n; i++) picks.add(i * step)
  return [...picks].sort((a, b) => a - b).slice(0, n).map((i) => rows[i])
}

// 解析 projects.rob_master_prompt_overlay JSON
function loadOverlay(project) {
  if (!project?.rob_master_prompt_overlay) return null
  try { return JSON.parse(project.rob_master_prompt_overlay) } catch { return null }
}

const router = express.Router({ mergeParams: true })

// ============================================================
// GET /:id/rob — 主页
// ============================================================
router.get('/:id/rob', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

    const protocol = loadApprovedProtocol(db, project.id)
    const overlay = loadOverlay(project)

    // 所有 include 论文 + 它们的 matrix.study_design + 现有 RoB
    const records = listIncludedRecordsForRob(db, project.id)
    const robRows = listRobForProject(db, project.id)
    const robByRecord = new Map(robRows.map((r) => [r.record_id, r]))
    // pass-2(Deep verification)— 用于双 pass 对比
    const robPass2Rows = listRobPass2ForProject(db, project.id)
    const robPass2ByRecord = new Map(robPass2Rows.map((r) => [r.record_id, r]))

    // matrix study_design 字段(用于自动路由)
    const matrixDesignByRecord = new Map()
    for (const r of records) {
      const m = getMatrixForRecord(db, project.id, r.id)
      let design = ''
      if (m && m.fields) {
        try {
          const f = typeof m.fields === 'string' ? JSON.parse(m.fields) : m.fields
          design = String(f?.study_design || '').slice(0, 200)
        } catch {}
      }
      matrixDesignByRecord.set(r.id, design)
    }

    // 5 tool 路由统计(按 matrix.study_design 自动路由;用户已手改的优先)
    const toolStats = { rob2: 0, robins_i: 0, nos: 0, jbi_cs: 0, mmat: 0 }
    const enriched = records.map((r) => {
      const existingRob = robByRecord.get(r.id) || null
      const pass2Rob = robPass2ByRecord.get(r.id) || null
      const design = matrixDesignByRecord.get(r.id) || ''
      const autoTool = pickRobTool(design)
      const effectiveTool = existingRob?.tool || autoTool
      toolStats[effectiveTool] = (toolStats[effectiveTool] || 0) + 1
      let parsedJudgments = null
      if (existingRob?.judgments_json) {
        try { parsedJudgments = JSON.parse(existingRob.judgments_json) } catch {}
      }
      let parsedPass2Judgments = null
      if (pass2Rob?.judgments_json) {
        try { parsedPass2Judgments = JSON.parse(pass2Rob.judgments_json) } catch {}
      }
      // 一致性 flag — 比较 pass-1 vs pass-2 overall_rating
      let agreement = null  // 'same' | 'diverge' | null(无 pass-2)
      if (existingRob && pass2Rob) {
        agreement = (existingRob.overall_rating === pass2Rob.overall_rating) ? 'same' : 'diverge'
      }
      return {
        ...r,
        study_design: design,
        auto_tool: autoTool,
        effective_tool: effectiveTool,
        rob: existingRob ? { ...existingRob, parsed_judgments: parsedJudgments } : null,
        rob_pass2: pass2Rob ? { ...pass2Rob, parsed_judgments: parsedPass2Judgments } : null,
        agreement,
      }
    })

    // batch job
    const batchJob = batchJobsSvc.getActiveJob(db, project.id, ROB_BATCH_KIND)
    const deepVerifyJob = batchJobsSvc.getActiveJob(db, project.id, ROB_DEEP_VERIFY_KIND)
    // 是否能用 Deep verify(advanced extraction 权限位 + super admin)
    const canDeepVerify = !!(req.user && (req.user.advanced_extraction_enabled || req.user.is_super_admin))

    // M26 post-RoB excluded records(rob_excluded_at IS NOT NULL)— 让 UI 显示统计 + 给每篇标 badge
    const postRobExcludedRows = db.prepare(
      `SELECT id, rob_excluded_at, rob_excluded_reason FROM records WHERE project_id = ? AND rob_excluded_at IS NOT NULL`
    ).all(project.id)
    const postRobExcludedByRid = new Map(postRobExcludedRows.map((r) => [r.id, { at: r.rob_excluded_at, reason: r.rob_excluded_reason }]))
    // enriched 里加 post_rob_excluded 标志 + M28 deep_verified 标志
    const deepVerifiedRows = db.prepare(
      `SELECT id FROM records WHERE project_id = ? AND last_rob_deep_verified_at IS NOT NULL`
    ).all(project.id)
    const deepVerifiedByRid = new Set(deepVerifiedRows.map((r) => r.id))
    enriched.forEach((r) => {
      const ex = postRobExcludedByRid.get(r.id)
      if (ex) {
        r.post_rob_excluded = true
        r.post_rob_excluded_reason = ex.reason
        r.post_rob_excluded_at = ex.at
      }
      if (deepVerifiedByRid.has(r.id)) r.deep_verified = true
    })
    const postRobExcludedCount = postRobExcludedRows.length
    const deepVerifiedCount = deepVerifiedRows.length

    // ============================================================
    // 复核优先级排序 — 把可能需要 post-RoB 排除的论文置顶
    //   1: 已标 post_rob_excluded(让用户能看到 / 改主意)
    //   2: screening_failed(MMAT 2 个 screening 任一 no)
    //   3: 高 no_information 比例(>=50% domain 都 no_information,纯理论论文征兆)
    //   4: overall_rating = 差(bad valence)
    //   5: overall_rating = 中(middle valence)
    //   6: overall_rating = 好(good valence)
    //   7: 没 RoB 评估
    // 同 priority 内按 year DESC, title ASC
    // ============================================================
    enriched.forEach((r) => {
      let prio = 7
      let reviewFlag = null
      const robData = r.rob
      if (r.post_rob_excluded) {
        prio = 1; reviewFlag = 'post_rob_excluded'
      } else if (robData) {
        // screening_failed
        if (robData.overall_rating === 'screening_failed') {
          prio = 2; reviewFlag = 'screening_failed'
        } else {
          // 高 no_information 比例
          let parsed = robData.parsed_judgments
          if (!parsed && robData.judgments_json) { try { parsed = JSON.parse(robData.judgments_json) } catch {} }
          const judgments = (parsed && Array.isArray(parsed.judgments)) ? parsed.judgments : []
          const noInfoCount = judgments.filter((j) => j && (j.judgment === 'no_information' || j.judgment === 'cant_tell')).length
          const ratio = judgments.length > 0 ? noInfoCount / judgments.length : 0
          if (ratio >= 0.5 && judgments.length >= 3) {
            prio = 3; reviewFlag = 'mostly_no_info'
            r.no_info_ratio = ratio
          } else {
            // 按 valence
            const v = ratingValenceSrv(robData.overall_rating, r.effective_tool)
            if (v === 'bad') prio = 4
            else if (v === 'middle') prio = 5
            else if (v === 'good') prio = 6
            else prio = 7
          }
        }
      }
      r.review_priority = prio
      r.review_flag = reviewFlag
    })
    enriched.sort((a, b) => {
      if (a.review_priority !== b.review_priority) return a.review_priority - b.review_priority
      if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0)
      return String(a.title || '').localeCompare(String(b.title || ''))
    })
    // 给 UI 算"待复核"小计(priority 2 + 3,不算 post_rob_excluded 因为那是已处理)
    const needsReviewCount = enriched.filter((r) => r.review_priority === 2 || r.review_priority === 3).length

    // overlay 状态
    const overlayLockStarted = project.rob_master_prompt_optimize_started_at || null
    const overlayInFlight = !!(overlayLockStarted && (Date.now() - new Date(overlayLockStarted + ' UTC').getTime() < 15 * 60 * 1000))
    const overlayAtVersion = project.rob_master_prompt_at_version || null
    const overlayStale = overlay && protocol && overlayAtVersion != null && protocol.version > overlayAtVersion

    // 进度统计
    const totalInclude = records.length
    const totalAssessed = robRows.length
    const progressPct = totalInclude > 0 ? Math.round((totalAssessed / totalInclude) * 100) : 0

    // 计算 stepper 进度 + PRISMA 清单条目(跟其他 step 页一样,不能 null,否则前几步全显"未开始")
    const progress = getProjectProgress(db, project.id)
    const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'rob')

    res.render('projects/rob', {
      title: '偏倚风险评估',
      project,
      progress,
      currentStep: 'rob',
      stepLabel: '偏倚风险评估',
      stepItems,
      protocol,
      overlay,
      overlayAtVersion,
      overlayStale,
      overlayInFlight,
      overlayLockStarted,
      records: enriched,
      toolStats,
      toolMeta: TOOL_META,
      batchJob,
      deepVerifyJob,
      canDeepVerify,
      totalInclude,
      totalAssessed,
      progressPct,
      postRobExcludedCount,
      deepVerifiedCount,
      needsReviewCount,
    })
  } catch (e) { next(e) }
})

// ============================================================
// POST /:id/rob/optimize-overlay — Opus 一次性生成 5 工具 overlay
//   原子 lock(15 min stale)+ 协议版本门(同协议只能跑一次)
// ============================================================
router.post('/:id/rob/optimize-overlay', requireAdvancedExtraction, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const protocol = loadApprovedProtocol(db, project.id)
  if (!protocol) return res.status(400).json({ ok: false, error: '请先审批协议' })

  // 协议版本门
  const optimizedVer = project.rob_master_prompt_at_version || null
  if (optimizedVer != null && protocol.version <= optimizedVer) {
    return res.status(409).json({
      ok: false,
      error_code: 'already_optimized',
      error: `本协议(v${protocol.version})已生成过 RoB overlay(在第 v${optimizedVer} 版)。重新审批协议后可再次生成。`,
      protocol_version: protocol.version,
      optimized_at_version: optimizedVer,
    })
  }

  // 至少需要 2 篇 include 才有意义
  const includeCount = db.prepare(
    `SELECT COUNT(*) AS c FROM screening_decisions
     WHERE project_id = ? AND stage = 'title_abstract' AND human_decision = 'include'`
  ).get(project.id).c
  if (includeCount < 2) {
    return res.status(400).json({
      ok: false,
      error: `生成 RoB overlay 需要至少 2 篇 include 论文作样本(当前 ${includeCount})`,
    })
  }

  // 原子 lock
  const lockResult = db.prepare(
    `UPDATE projects
        SET rob_master_prompt_optimize_started_at = datetime('now', '+8 hours')
      WHERE id = ?
        AND (rob_master_prompt_optimize_started_at IS NULL
             OR rob_master_prompt_optimize_started_at < datetime('now', '-15 minutes'))`
  ).run(project.id)

  if (lockResult.changes === 0) {
    const row = db.prepare(
      `SELECT rob_master_prompt_optimize_started_at AS started FROM projects WHERE id = ?`
    ).get(project.id)
    return res.status(409).json({
      ok: false,
      error_code: 'already_running',
      error: `已有一次 overlay 生成任务在跑(${row?.started || '?'} 开始,Opus 4.8 通常 5-8 分钟)。等它跑完或 15 分钟后解锁。`,
      started_at: row?.started || null,
    })
  }

  const releaseLock = () => {
    try {
      db.prepare(`UPDATE projects SET rob_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(project.id)
    } catch (e) { console.error('[rob optimize] release lock failed:', e.message) }
  }

  try {
    const samples = sampleRepresentativeIncludeRecords(db, project.id, 4)
    const userPrompt = buildOptimizeOverlayUserPrompt({ project, protocol, samples })

    const result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'rob_optimize_overlay',
      projectId: project.id,
      system: OPTIMIZE_OVERLAY_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      maxTokens: 8000,
      timeoutMs: 480_000,
    })

    if (!result.ok) {
      releaseLock()
      return res.status(502).json({ ok: false, error: `AI 调用失败:${result.status} ${(result.error || '').slice(0, 200)}` })
    }

    const norm = normalizeOverlayOutput(result.data || null)
    if (!norm) {
      releaseLock()
      return res.status(502).json({ ok: false, error: 'AI 输出格式不达标(每个 tool overlay 必须 ≥80 chars)' })
    }

    // 写结果 + 释放锁
    db.prepare(`
      UPDATE projects
         SET rob_master_prompt_overlay = ?,
             rob_master_prompt_at_version = ?,
             rob_master_prompt_optimize_started_at = NULL
       WHERE id = ?
    `).run(JSON.stringify({
      rob2: norm.rob2, robins_i: norm.robins_i, nos: norm.nos, jbi_cs: norm.jbi_cs, mmat: norm.mmat,
    }), protocol.version, project.id)

    audit(db, req, {
      eventType: 'rob_optimize_overlay',
      userId: req.user.id, projectId: project.id,
      payload: {
        protocol_version: protocol.version,
        lengths: { rob2: norm.rob2.length, robins_i: norm.robins_i.length, nos: norm.nos.length, jbi_cs: norm.jbi_cs.length, mmat: norm.mmat.length },
        rationale: norm.rationale,
      },
    })

    res.json({
      ok: true,
      protocol_version: protocol.version,
      lengths: { rob2: norm.rob2.length, robins_i: norm.robins_i.length, nos: norm.nos.length, jbi_cs: norm.jbi_cs.length, mmat: norm.mmat.length },
      rationale: norm.rationale,
    })
  } catch (e) {
    console.error('[rob optimize-overlay]', e)
    releaseLock()
    res.status(500).json({ ok: false, error: (e.message || String(e)).slice(0, 200) })
  }
})

// GET /:id/rob/optimize-overlay/status.json
router.get('/:id/rob/optimize-overlay/status.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false })
    const started = project.rob_master_prompt_optimize_started_at || null
    let elapsedMs = 0
    let inFlight = false
    if (started) {
      elapsedMs = Date.now() - new Date(started + ' UTC').getTime()
      inFlight = elapsedMs < 15 * 60 * 1000
    }
    res.json({
      ok: true,
      in_flight: inFlight,
      started_at: started,
      elapsed_ms: elapsedMs,
      has_fresh: !inFlight && !!project.rob_master_prompt_overlay,
      at_version: project.rob_master_prompt_at_version || null,
    })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ============================================================
//  Per-record 评估核心(单条 + 批量复用)
// ============================================================
async function runRobForRecord({
  db, userId, project, record, overlay,
  toolOverride = null,
  raterPass = 1,           // 1 = primary (Fast 或 single Deep);2 = Deep verification overlay
  parentAssessmentId = null,
  reqLike,
}) {
  if (!record) return { status: 'error', error: 'record_not_found' }

  // 1) 选 tool — 用户覆盖优先,否则按 matrix.study_design 路由
  const matrixRow = getMatrixForRecord(db, project.id, record.id)
  let matrixFields = {}
  if (matrixRow && matrixRow.fields) {
    try { matrixFields = typeof matrixRow.fields === 'string' ? JSON.parse(matrixRow.fields) : matrixRow.fields } catch {}
  }
  const studyDesign = matrixFields.study_design || ''
  const tool = toolOverride || pickRobTool(studyDesign)
  const toolMeta = TOOL_META[tool]
  if (!toolMeta) return { status: 'error', error: `unknown_tool: ${tool}` }

  // 2) 取论文文本(只要 methods/results/discussion/limitations 段,250K→80K 限缩)
  const paperPack = buildPaperTextFromChunks(db, record.id, record, {
    maxChars: 80_000,
    sectionFilter: ['methods', 'methodology', 'results', 'findings', 'discussion', 'limitations', 'conclusion'],
  })
  if (!paperPack.text) {
    return { status: 'error', error: 'no_paper_text' }
  }

  // 3) 拼 system = generic tool prompt + overlay(可选)
  const genericSystem = TOOL_SYSTEM_PROMPTS[tool]
  const overlayText = overlay && overlay[tool] ? overlay[tool] : ''
  const system = overlayText
    ? `${genericSystem}\n\n# Project-specific overlay (generated by Opus 4.8 from approved protocol + sample papers)\n${overlayText}`
    : genericSystem

  // 4) 拼 user prompt = matrix evidence digest + paper text
  const userPrompt = buildRobUserPrompt({
    record, matrixFields, paperText: paperPack.text, tool,
  })

  // 5) runLlm
  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'rob_assess_batch',
      projectId: project.id,
      system,
      prompt: userPrompt,
      expectJson: true,
      maxTokens: 6000,
      timeoutMs: 240_000,
    })
  } catch (e) {
    return { status: 'error', error: `runLlm_threw: ${(e?.message || String(e)).slice(0, 200)}`, tool }
  }

  if (!result.ok) {
    audit(db, reqLike, {
      eventType: 'rob_batch_failed',
      userId, projectId: project.id,
      payload: { record_id: record.id, tool, status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId, model: result.model },
    })
    return { status: 'failed', error: result.error, llmStatus: result.status, model: result.model, usageLogId: result.usageLogId, tool }
  }

  // 6) 解析 + 本地 roll-up
  const parsed = parseRobBatchOutput(result.data, tool)
  if (!parsed.ok) {
    audit(db, reqLike, {
      eventType: 'rob_batch_empty',
      userId, projectId: project.id,
      payload: { record_id: record.id, tool, model: result.model, errors: parsed.errors?.slice(0, 5) },
    })
    return { status: 'failed', error: 'parse_failed: ' + (parsed.errors?.join('; ') || ''), model: result.model, tool }
  }

  // 7) Upsert(支持 rater_pass=2 verification pass)
  upsertRobAssessment(db, {
    projectId: project.id,
    recordId: record.id,
    tool,
    toolVersion: parsed.parsed.tool_version,
    judgmentsJson: JSON.stringify(parsed.parsed),
    overallRating: parsed.parsed.overall_rating,
    overallRationale: parsed.parsed.overall_rationale,
    signalingAnswersJson: JSON.stringify(parsed.parsed.signaling_answers || {}),
    evidenceQuotesJson: JSON.stringify(parsed.parsed.evidence_quotes || {}),
    filledBy: 'ai',
    modelUsed: result.model,
    usageLogId: result.usageLogId,
    raterPass,
    parentAssessmentId,
  })

  // M28: pass=2 Deep 验证成功 → 标 records.last_rob_deep_verified_at
  //   这样下次 Deep verify 路由 skip 时,即使 pass-2 后来被 promote 也不会重复排队
  if (raterPass === 2) {
    try {
      db.prepare(`UPDATE records SET last_rob_deep_verified_at = datetime('now', '+8 hours') WHERE id = ?`).run(record.id)
    } catch { /* column may not exist on very old DBs */ }
  }

  audit(db, reqLike, {
    eventType: raterPass === 2 ? 'rob_deep_verify_success' : 'rob_batch_success',
    userId, projectId: project.id,
    payload: {
      record_id: record.id,
      tool,
      rater_pass: raterPass,
      parent_assessment_id: parentAssessmentId,
      overall_rating: parsed.parsed.overall_rating,
      model: result.model,
      domains_kept: parsed.parsed.judgments?.length || 0,
      validation_warnings: parsed.errors?.length || 0,
    },
  })

  return {
    status: 'success',
    tool,
    rater_pass: raterPass,
    overall_rating: parsed.parsed.overall_rating,
    domains_kept: parsed.parsed.judgments?.length || 0,
    model: result.model,
  }
}

// POST /:id/rob/:recordId/run-one-ai
router.post('/:id/rob/:recordId/run-one-ai', requireAdvancedExtraction, async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

    const record = db.prepare('SELECT * FROM records WHERE id = ? AND project_id = ?').get(req.params.recordId, project.id)
    if (!record) return res.status(404).json({ ok: false, error: 'record_not_found' })

    const overlay = loadOverlay(project)
    const toolOverride = (req.body && req.body.tool && TOOL_META[req.body.tool]) ? req.body.tool : null

    const out = await runRobForRecord({
      db, userId: req.user.id, project, record, overlay, toolOverride, reqLike: req,
    })
    res.json({ ok: out.status === 'success', ...out })
  } catch (e) { next(e) }
})

// ============================================================
// POST /:id/rob/run-batch-ai — Sonnet 批量
// ============================================================
router.post('/:id/rob/run-batch-ai', requireAdvancedExtraction, async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

    const cur = batchJobsSvc.getActiveJob(db, project.id, ROB_BATCH_KIND)
    if (cur && cur.status === 'running') {
      req.session.flash = { type: 'error', message: '已有 RoB 批量任务在跑' }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    const protocol = loadApprovedProtocol(db, project.id)
    if (!protocol) {
      req.session.flash = { type: 'error', message: '请先审批协议' }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    // overlay 不是必需(可不优化直接跑通用 prompt),但提示用户。
    const overlay = loadOverlay(project)
    const skipRerun = !(req.body && req.body.force_rerun === '1')
    const includeRecords = listIncludedRecordsForRob(db, project.id)
    let targets = includeRecords
    if (skipRerun) {
      const already = new Set(
        db.prepare(`SELECT record_id FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`)
          .all(project.id).map((r) => r.record_id)
      )
      targets = targets.filter((r) => !already.has(r.id))
    }

    if (targets.length === 0) {
      req.session.flash = {
        type: 'error',
        message: skipRerun
          ? '没有待评估论文(所有 include 论文已 RoB 过;勾"强制重跑"或先删某条)'
          : '没有 include 论文可评估',
      }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    // Fast mode(默认):N 篇/call 仅 matrix,5-10 min 跑完 121 篇
    // Deep mode:每篇 1 call 读全文 chunks(methods/results/discussion),30-60 min,质量最高
    //   Deep 仅 advanced extraction 用户(成本高 + Opus + 全文 chunks 是高级功能)
    let mode = (req.body && req.body.mode === 'deep') ? 'deep' : 'fast'
    const canAdv = !!(req.user && (req.user.advanced_extraction_enabled || req.user.is_super_admin))
    if (mode === 'deep' && !canAdv) {
      req.session.flash = { type: 'error', message: 'Deep 模式仅高级抽取用户可用,已自动切换为 Fast' }
      mode = 'fast'
    }
    // 2026-05-30:Deep 模式 pre-check chunks — 项目 0 PDF/chunks 时拒绝启动,
    //   不然 runRobForRecord 每篇都立刻 no_paper_text fail,1 秒内 126 篇全 failed(实例 bj_09defa11)。
    if (mode === 'deep') {
      const recIds = targets.map((r) => r.id)
      const placeholders = recIds.map(() => '?').join(',')
      let recordsWithChunks = 0
      if (recIds.length > 0) {
        try {
          const row = db.prepare(
            `SELECT COUNT(DISTINCT record_id) AS n FROM paper_chunks
              WHERE record_id IN (${placeholders})`
          ).get(...recIds)
          recordsWithChunks = row?.n || 0
        } catch (e) { console.warn('[rob/run-batch-ai] count chunks failed:', e.message) }
      }
      if (recordsWithChunks === 0) {
        req.session.flash = {
          type: 'error',
          message: `Deep 模式需要 PDF 全文 chunks,但 ${targets.length} 篇待评估论文里 0 篇有 chunks(很可能没上传过 PDF / PDF 没解析)。改用 Fast 模式(只读 matrix evidence)或先上传 PDF。`,
        }
        return res.redirect(`/projects/${project.id}/rob`)
      }
      // 部分有 chunks 也提示一下(Deep 会把没 chunks 的标 failed)
      if (recordsWithChunks < targets.length) {
        console.log(`[rob/run-batch-ai] Deep mode: ${recordsWithChunks}/${targets.length} have chunks (others will fail with no_paper_text)`)
      }
    }
    const batchSize = Math.max(2, Math.min(15, parseInt(req.body?.batch_size, 10) || 8))

    let jobRow
    try {
      jobRow = batchJobsSvc.startJob(db, {
        projectId: project.id, userId: req.user.id, kind: ROB_BATCH_KIND,
        total: targets.length,
        initial: { overlay_used: !!overlay, skipRerun, mode, batchSize: mode === 'fast' ? batchSize : 1 },
      })
    } catch (e) {
      req.session.flash = { type: 'error', message: '启动失败:' + e.message }
      return res.redirect(`/projects/${project.id}/rob`)
    }
    const jobId = jobRow.id

    audit(db, req, {
      eventType: 'rob_batch_started',
      userId: req.user.id, projectId: project.id,
      payload: { job_id: jobId, total: targets.length, mode, batch_size: batchSize, overlay_used: !!overlay, skip_rerun: skipRerun },
    })

    const userId = req.user.id
    setImmediate(async () => {
      try {
        if (mode === 'fast') {
          // Fast:runRobFastBatch 内部按 tool 分组 + batchSize 切片 + per-batch 单 call + upsert
          //   通过 onProgress 把进度刷给 batch_jobs
          const llmDeps = {
            runLlm,
            getMatrixForRecord,
            upsertRobAssessment,
            audit,
          }
          await runRobFastBatch({
            db, userId, project, records: targets, overlay, batchSize,
            reqLike: { user: { id: userId } },
            llmDeps,
            onProgress: ({ done, failed, current }) => {
              try {
                batchJobsSvc.updateJobProgress(db, jobId, { done, failed, current })
              } catch {}
            },
          })
        } else {
          // Deep:每篇 1 call,串行
          let done = 0, failed = 0
          for (const r of targets) {
            batchJobsSvc.updateJobProgress(db, jobId, { current: { id: r.id, title: r.title } })
            let outcome
            try {
              outcome = await runRobForRecord({
                db, userId, project, record: r, overlay,
                reqLike: { user: { id: userId } },
              })
            } catch (e) {
              outcome = { status: 'error', error: e?.message || String(e) }
            }
            done += 1
            if (outcome.status !== 'success') failed += 1
            batchJobsSvc.updateJobProgress(db, jobId, { done, failed })
          }
        }
      } finally {
        batchJobsSvc.finishJob(db, jobId, { status: 'finished' })
        try {
          const cur = batchJobsSvc.getActiveJob(db, project.id, ROB_BATCH_KIND)
          audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
            eventType: 'rob_batch_finished',
            userId, projectId: project.id,
            payload: { job_id: jobId, mode, done: cur?.done || 0, failed: cur?.failed || 0 },
          })
        } catch {}
      }
    })

    const flashMsg = mode === 'fast'
      ? `已启动 Fast 批量 RoB:${targets.length} 篇(每 ${batchSize} 篇/call 只读 matrix${overlay ? ' + 项目 overlay' : ''}),预计 ${Math.ceil(targets.length / batchSize / 2)}-${Math.ceil(targets.length / batchSize)} 分钟`
      : `已启动 Deep 批量 RoB:${targets.length} 篇(每篇读 methods/results 全文 chunks),~30-60 分钟`
    req.session.flash = { type: 'success', message: flashMsg }
    res.redirect(`/projects/${project.id}/rob`)
  } catch (e) { next(e) }
})

// GET /:id/rob/batch-progress.json
router.get('/:id/rob/batch-progress.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false })
    const job = batchJobsSvc.getActiveJob(db, project.id, ROB_BATCH_KIND)
    // 顺手返回当前 assessed 数
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`).get(project.id).c
    res.json({ ok: true, job, assessed_count: cnt })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ============================================================
// POST /:id/rob/run-deep-verify-batch — Opus 全文 Deep 重评中差类(rater_pass=2)
//   仅高级抽取用户可用。串行跑(避免 cgroup 压力)。
//   filter: 'middle_bad'(默认) / 'bad' / 'all'(只评 pass-1 已存在的)
// ============================================================
router.post('/:id/rob/run-deep-verify-batch', requireAdvancedExtraction, async (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

    const cur = batchJobsSvc.getActiveJob(db, project.id, ROB_DEEP_VERIFY_KIND)
    if (cur && cur.status === 'running') {
      req.session.flash = { type: 'error', message: '已有 Deep verification 任务在跑' }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    const filter = (req.body && req.body.filter) || 'middle_bad'
    const overwriteExisting = req.body?.overwrite_pass2 === '1'

    // 取 pass-1 + 按 valence filter
    const records = listIncludedRecordsForRob(db, project.id)
    const pass1Rows = listRobForProject(db, project.id)
    const pass1ByRid = new Map(pass1Rows.map((r) => [r.record_id, r]))
    const pass2Rows = listRobPass2ForProject(db, project.id)
    const pass2RidSet = new Set(pass2Rows.map((r) => r.record_id))

    const targets = []
    let skippedAlreadyDeep = 0, skippedPostRobExcluded = 0
    for (const r of records) {
      const p1 = pass1ByRid.get(r.id)
      if (!p1) continue   // 没 pass-1 就跳(应该先跑 Fast batch)
      // M26:post-RoB 已排除的不评 Deep(它们已经判方法学不适合,不需要再 verify)
      if (r.rob_excluded_at) { skippedPostRobExcluded++; continue }
      // M28:已 Deep 验证过的不再排队(无论 pass-2 是否还在 — 可能被 promote 顶替了)
      //   only overwriteExisting 时强制重跑
      if (!overwriteExisting) {
        if (pass2RidSet.has(r.id)) { skippedAlreadyDeep++; continue }
        if (r.last_rob_deep_verified_at) { skippedAlreadyDeep++; continue }
      }
      const v = ratingValenceSrv(p1.overall_rating, p1.tool)
      if (filter === 'middle_bad' && (v === 'middle' || v === 'bad' || v === 'unrated')) targets.push({ record: r, pass1: p1 })
      else if (filter === 'bad' && (v === 'bad' || v === 'unrated')) targets.push({ record: r, pass1: p1 })
      else if (filter === 'all') targets.push({ record: r, pass1: p1 })
    }

    if (targets.length === 0) {
      const msg = `没有需要 Deep verify 的论文(filter=${filter})— 已 Deep 验过 ${skippedAlreadyDeep} 篇,post-RoB 排除 ${skippedPostRobExcluded} 篇,要重跑勾选"覆盖已有 pass-2"`
      req.session.flash = { type: 'success', message: msg }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    const overlay = loadOverlay(project)
    const jobRow = batchJobsSvc.startJob(db, {
      projectId: project.id, userId: req.user.id, kind: ROB_DEEP_VERIFY_KIND,
      total: targets.length,
      initial: { filter, overwriteExisting, mode: 'deep_verify' },
    })
    const jobId = jobRow.id

    audit(db, req, {
      eventType: 'rob_deep_verify_started',
      userId: req.user.id, projectId: project.id,
      payload: { job_id: jobId, total: targets.length, filter, overwrite: overwriteExisting },
    })

    const userId = req.user.id
    setImmediate(async () => {
      let done = 0, failed = 0
      try {
        for (const t of targets) {
          batchJobsSvc.updateJobProgress(db, jobId, {
            current: { id: t.record.id, title: `Deep 重评:${(t.record.title || '').slice(0, 60)}(Opus + 全文 chunks)` },
          })
          let outcome
          try {
            outcome = await runRobForRecord({
              db, userId, project, record: t.record, overlay,
              toolOverride: t.pass1.tool,           // 用 pass-1 的 tool(用户可能手动改过)
              raterPass: 2,
              parentAssessmentId: t.pass1.id,
              reqLike: { user: { id: userId } },
            })
          } catch (e) {
            outcome = { status: 'error', error: e?.message || String(e) }
          }
          done += 1
          if (outcome.status !== 'success') failed += 1
          batchJobsSvc.updateJobProgress(db, jobId, { done, failed })
        }
      } finally {
        batchJobsSvc.finishJob(db, jobId, { status: 'finished' })
        try {
          audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
            eventType: 'rob_deep_verify_finished',
            userId, projectId: project.id,
            payload: { job_id: jobId, done, failed },
          })
        } catch {}
      }
    })

    req.session.flash = { type: 'success', message: `已启动 Deep verify:${targets.length} 篇(filter=${filter}),Opus + 全文 chunks,每篇 3-5 min,预计 ${Math.ceil(targets.length * 4 / 60)}-${Math.ceil(targets.length * 5 / 60)} 小时` }
    res.redirect(`/projects/${project.id}/rob`)
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Deep verify 启动失败:' + e.message }
    res.redirect(`/projects/${req.params.id}/rob`)
  }
})

router.get('/:id/rob/deep-verify-progress.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false })
    const job = batchJobsSvc.getActiveJob(db, project.id, ROB_DEEP_VERIFY_KIND)
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM rob_assessments WHERE project_id = ? AND rater_pass = 2`).get(project.id).c
    res.json({ ok: true, job, pass2_count: cnt })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ============================================================
// POST /:id/rob/:recordId/promote-pass2 — 把 Deep(pass-2)结果顶 Fast(pass-1)
//   删 pass-1 + UPDATE pass-2.rater_pass = 1。事务保证原子。
//   advanced 用户专享。
// ============================================================
router.post('/:id/rob/:recordId/promote-pass2', requireAdvancedExtraction, (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const ok = promotePass2ToPrimary(db, req.params.recordId)
    if (!ok) return res.status(404).json({ ok: false, error: 'no_pass2_to_promote' })
    audit(db, req, {
      eventType: 'rob_pass2_promoted',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId },
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ============================================================
// POST /:id/rob/:recordId/exclude-post-rob — 标记 Step 5 后 不进入 synthesis
//   reason 必填(预设 OR 自由文本)
// ============================================================
router.post('/:id/rob/:recordId/exclude-post-rob', requireAdvancedExtraction, express.urlencoded({ extended: false }), express.json({ limit: '10kb' }), (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const reason = String((req.body && (req.body.reason || req.body.reason_text)) || '').slice(0, 300).trim()
    if (!reason) return res.status(400).json({ ok: false, error: 'reason required' })

    const result = db.prepare(
      `UPDATE records SET rob_excluded_at = datetime('now', '+8 hours'), rob_excluded_reason = ?, rob_excluded_by_user_id = ?
        WHERE id = ? AND project_id = ?`
    ).run(reason, req.user.id, req.params.recordId, project.id)
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'record_not_found' })

    audit(db, req, {
      eventType: 'post_rob_excluded',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId, reason },
    })
    if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true })
    req.session.flash = { type: 'success', message: `已标记不纳入 synthesis(原因:${reason})` }
    res.redirect(`/projects/${project.id}/rob`)
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

router.post('/:id/rob/:recordId/unexclude-post-rob', requireAdvancedExtraction, (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const result = db.prepare(
      `UPDATE records SET rob_excluded_at = NULL, rob_excluded_reason = NULL, rob_excluded_by_user_id = NULL
        WHERE id = ? AND project_id = ?`
    ).run(req.params.recordId, project.id)
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'record_not_found' })

    audit(db, req, {
      eventType: 'post_rob_unexcluded',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId },
    })
    if (req.get('X-Requested-With') === 'fetch') return res.json({ ok: true })
    req.session.flash = { type: 'success', message: '已恢复纳入 synthesis' }
    res.redirect(`/projects/${project.id}/rob`)
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ============================================================
// POST /:id/rob/promote-pass2-bulk — 批量把 Deep(pass-2)结果顶 Fast(pass-1)
//   body.record_ids = ["rec_x","rec_y",...] 显式列表(默认前端传"所有分歧的")
//   body.mode = 'divergent_all' 也可以,后端自己算分歧列表(防前端漏)
//   advanced 用户专享。事务批量执行。
// ============================================================
router.post('/:id/rob/promote-pass2-bulk', requireAdvancedExtraction, express.json({ limit: '50kb' }), (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

    let recordIds = []
    const mode = (req.body && req.body.mode) || 'explicit'

    if (mode === 'divergent_all') {
      // 后端自己算所有 ⚠ 分歧的 records(有 pass-2 且 overall_rating 跟 pass-1 不同)
      const rows = db.prepare(
        `SELECT p1.record_id
           FROM rob_assessments p1
           JOIN rob_assessments p2 ON p2.record_id = p1.record_id AND p2.rater_pass = 2
          WHERE p1.project_id = ? AND p1.rater_pass = 1
            AND COALESCE(p1.overall_rating,'') != COALESCE(p2.overall_rating,'')`
      ).all(project.id)
      recordIds = rows.map((r) => r.record_id)
    } else {
      if (!Array.isArray(req.body?.record_ids)) {
        return res.status(400).json({ ok: false, error: 'record_ids required (array) or mode=divergent_all' })
      }
      recordIds = req.body.record_ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    }

    if (recordIds.length === 0) {
      return res.json({ ok: true, promoted: 0, message: '没有可提升的分歧条目' })
    }
    if (recordIds.length > 200) {
      return res.status(400).json({ ok: false, error: 'too many records in one batch (max 200)' })
    }

    // 事务批量
    let promoted = 0
    const failed = []
    const tx = db.transaction(() => {
      for (const rid of recordIds) {
        try {
          const ok = promotePass2ToPrimary(db, rid)
          if (ok) promoted++
          else failed.push(rid)
        } catch (e) {
          failed.push(rid)
        }
      }
    })
    tx()

    audit(db, req, {
      eventType: 'rob_pass2_promoted_bulk',
      userId: req.user.id, projectId: project.id,
      payload: { mode, attempted: recordIds.length, promoted, failed_count: failed.length },
    })

    res.json({ ok: true, promoted, failed_count: failed.length, failed_ids: failed.slice(0, 10) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ============================================================
//  Manual edit endpoints
// ============================================================

// 改某条记录用什么工具(覆盖自动路由)
router.post('/:id/rob/:recordId/edit-tool', requireAdvancedExtraction, async (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

    const tool = String(req.body?.tool || '').toLowerCase()
    if (!TOOL_META[tool]) return res.status(400).json({ ok: false, error: 'invalid_tool' })

    // 如果已有 assessment,改 tool 等于重评 — 先删旧的(用户得重新跑或手动填)
    deleteRobForRecord(db, req.params.recordId)
    audit(db, req, {
      eventType: 'rob_tool_changed',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId, new_tool: tool },
    })
    res.json({ ok: true, new_tool: tool, message: '工具已切换,旧评估已清除,请重新跑 AI 或手动填' })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 手动改单 domain 判断(filled_by=ai_edited)
router.post('/:id/rob/:recordId/edit-judgment', express.json({ limit: '300kb' }), (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

    const rob = getRobForRecord(db, req.params.recordId)
    if (!rob) return res.status(404).json({ ok: false, error: 'no_existing_assessment' })

    const { domain, judgment, rationale, evidence_quote, notes } = req.body || {}
    if (!domain) return res.status(400).json({ ok: false, error: 'missing_domain' })

    const meta = TOOL_META[rob.tool]
    if (!meta) return res.status(500).json({ ok: false, error: 'corrupt_tool' })
    if (judgment && !meta.judgment_enum.includes(judgment)) {
      return res.status(400).json({ ok: false, error: `invalid judgment for tool ${rob.tool}` })
    }

    let parsed = {}
    try { parsed = JSON.parse(rob.judgments_json || '{}') } catch {}
    if (!Array.isArray(parsed.judgments)) parsed.judgments = []
    const idx = parsed.judgments.findIndex((j) => j.domain === domain)
    if (idx < 0) return res.status(400).json({ ok: false, error: 'domain not in current judgments' })

    if (judgment) parsed.judgments[idx].judgment = judgment
    if (rationale != null) parsed.judgments[idx].rationale = String(rationale).slice(0, 600)
    if (evidence_quote != null) parsed.judgments[idx].evidence_quote = String(evidence_quote).slice(0, 400)

    // 重算 overall(本地 roll-up,LLM 不参与)— 复用 services/rob.js computeOverallRating
    const rollup = computeOverallRating(parsed.judgments, rob.tool)
    parsed.overall_rating = rollup.rating
    parsed.overall_rationale = rollup.rationale

    upsertRobAssessment(db, {
      projectId: project.id, recordId: req.params.recordId,
      tool: rob.tool, toolVersion: rob.tool_version,
      judgmentsJson: JSON.stringify(parsed),
      overallRating: rollup.rating, overallRationale: rollup.rationale,
      signalingAnswersJson: rob.signaling_answers_json,
      evidenceQuotesJson: rob.evidence_quotes_json,
      filledBy: 'ai_edited',
      modelUsed: rob.model_used,
      usageLogId: rob.usage_log_id,
      reviewedByUserId: req.user.id,
      notes: notes ?? rob.notes,
    })

    audit(db, req, {
      eventType: 'rob_judgment_edited',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId, tool: rob.tool, domain, new_judgment: judgment || '(rationale-only)' },
    })

    res.json({ ok: true, new_overall: rollup.rating, new_rationale: rollup.rationale })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 删某条 RoB(清状态以便重跑)
router.post('/:id/rob/:recordId/delete', requireAdvancedExtraction, (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const n = deleteRobForRecord(db, req.params.recordId)
    audit(db, req, {
      eventType: 'rob_deleted',
      userId: req.user.id, projectId: project.id,
      payload: { record_id: req.params.recordId, rows_deleted: n },
    })
    res.json({ ok: true, deleted: n })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ============================================================
//  Export
// ============================================================

// GET /:id/rob/export.json — 完整 JSON 导出
router.get('/:id/rob/export.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const rows = listRobForProject(db, project.id).map((r) => {
      let judg = null
      try { judg = JSON.parse(r.judgments_json) } catch {}
      return {
        record_id: r.record_id,
        tool: r.tool,
        tool_version: r.tool_version,
        overall_rating: r.overall_rating,
        overall_rationale: r.overall_rationale,
        judgments: judg?.judgments || [],
        filled_by: r.filled_by,
        model_used: r.model_used,
        assessed_at: r.updated_at,
      }
    })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="rob_${project.id}.json"`)
    res.send(JSON.stringify({ project_id: project.id, project_title: project.title, assessments: rows }, null, 2))
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// GET /:id/rob/export.xlsx — robvis-compatible traffic-light grid
router.get('/:id/rob/export.xlsx', async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

    const XLSX = (await import('xlsx')).default
    const rows = listRobForProject(db, project.id)
    const recordsMap = new Map(
      listIncludedRecordsForRob(db, project.id).map((r) => [r.id, r])
    )

    // 按 tool 分组,每个 tool 一个 sheet
    const byTool = { rob2: [], robins_i: [], nos: [], jbi_cs: [], mmat: [] }
    for (const r of rows) {
      if (byTool[r.tool]) byTool[r.tool].push(r)
    }

    const wb = XLSX.utils.book_new()
    for (const [tool, list] of Object.entries(byTool)) {
      if (list.length === 0) continue
      const meta = TOOL_META[tool]
      // robvis-style: rows = papers, cols = "Study" + domains + "Overall"
      const header = ['Study', 'Year', 'Tool version', ...meta.domains, 'Overall', 'Rationale']
      const data = [header]
      for (const r of list) {
        const rec = recordsMap.get(r.record_id) || {}
        let judg = null
        try { judg = JSON.parse(r.judgments_json) } catch {}
        const judgmentByDomain = new Map(
          (judg?.judgments || []).map((j) => [j.domain, j.judgment])
        )
        const row = [
          rec.authors_text ? `${rec.authors_text.split(/[,;]/)[0]} ${rec.year || ''}` : (rec.title || r.record_id).slice(0, 60),
          rec.year || '',
          r.tool_version,
          ...meta.domains.map((d) => judgmentByDomain.get(d) || ''),
          r.overall_rating || '',
          (r.overall_rationale || '').slice(0, 200),
        ]
        data.push(row)
      }
      const ws = XLSX.utils.aoa_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, meta.label.slice(0, 30))
    }

    if (Object.values(byTool).every((l) => l.length === 0)) {
      req.session.flash = { type: 'error', message: '还没跑过 RoB 评估,没东西可导出' }
      return res.redirect(`/projects/${project.id}/rob`)
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="rob_${project.id}.xlsx"`)
    res.send(buf)
  } catch (e) { next(e) }
})

export default router
