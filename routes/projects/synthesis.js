/**
 * Phase 6 Agent O — 主题聚类 + Evidence Matrix
 *
 * 挂载点(由 routes/projects/index.js 中转挂载):
 *   projectsRouter.use('/', synthesisRouter)   // 内部 path: /:id/synthesis/*
 *
 * 路由清单:
 *   GET  /:id/synthesis                         Evidence Matrix 页
 *   POST /:id/synthesis/run                     跑 LLM 聚类 → 写 themes + evidence_points
 *   POST /:id/synthesis/themes/:themeId/edit    人工编辑主题名/描述/强度
 *   POST /:id/synthesis/themes/:themeId/delete  删主题(连带 evidence_points.theme_id 置 NULL)
 *   GET  /:id/synthesis/matrix.csv              导出 records × themes 矩阵
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  SYNTHESIS_SYSTEM,
  OPTIMIZE_SYNTHESIS_OVERLAY_SYSTEM,
  SYNTHESIS_SYSTEM_VERSION,
  buildSynthesisUserPromptV2,
  buildOptimizeSynthesisOverlayUserPrompt,
  parseSynthesisOutputV2,
  parseSynthesisOverlayOutput,
} from '../../services/prompts/synthesis.js'
import {
  buildSynthesisInputs,
  formatPaperProfile,
  computeRobProfileForTheme,
  computeStudyDesignMix,
  computeProtocolCoverage,
  tokenizeBudget,
  loadApprovedProtocolFull,
  computeUpstreamFingerprint,
} from '../../services/synthesis-helpers.js'
import { ratingToValence } from '../../services/rob-helpers.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'

const router = express.Router({ mergeParams: true })

const MIN_VERIFIED_EXTRACTIONS = 5

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

function parseTheme(row) {
  if (!row) return null
  // 新字段(M25)— consistent_findings 在 v2 可能存对象数组(每个 {finding, supporting_records, ...})
  //   但 SQLite 行里都是 JSON 字符串,parseJsonArrayField 拿出来后保留原结构
  return {
    ...row,
    supporting_record_ids: parseJsonArrayField(row.supporting_record_ids),
    consistent_findings: parseJsonArrayField(row.consistent_findings),
    conflicting_findings: parseJsonArrayField(row.conflicting_findings),
    evidence_gaps: parseJsonArrayField(row.evidence_gaps),
    // M25 新字段(老 themes 行可能 null)
    maps_to_research_questions: parseJsonArrayField(row.maps_to_research_questions),
    maps_to_pico_concepts: parseJsonArrayField(row.maps_to_pico_concepts),
    study_design_mix: row.study_design_mix ? (() => { try { return JSON.parse(row.study_design_mix) } catch { return {} } })() : {},
    rob_profile: row.rob_profile ? (() => { try { return JSON.parse(row.rob_profile) } catch { return {} } })() : {},
    methodological_note: row.methodological_note || null,
    iteration_n: row.iteration_n || 1,
    parent_theme_id: row.parent_theme_id || null,
  }
}

function loadSynthesisMeta(db, projectId) {
  const row = db.prepare(`SELECT * FROM synthesis_meta WHERE project_id = ?`).get(projectId)
  if (!row) return null
  return {
    ...row,
    cross_cutting_observations: row.cross_cutting_observations ? (() => { try { return JSON.parse(row.cross_cutting_observations) } catch { return [] } })() : [],
    protocol_coverage: row.protocol_coverage ? (() => { try { return JSON.parse(row.protocol_coverage) } catch { return {} } })() : {},
  }
}

function loadOverlay(project) {
  if (!project?.synthesis_master_prompt_overlay) return null
  try { return JSON.parse(project.synthesis_master_prompt_overlay) } catch { return null }
}

function ownProjectOr404(db, projectId, userId) {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
  return parseProject(row)
}

function listThemes(db, projectId) {
  const rows = db
    .prepare(
      `SELECT * FROM themes
       WHERE project_id = ?
       ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    )
    .all(projectId)
  return rows.map(parseTheme)
}

function listEvidencePoints(db, projectId) {
  return db
    .prepare(
      `SELECT * FROM evidence_points WHERE project_id = ? ORDER BY created_at ASC`
    )
    .all(projectId)
}

function listVerifiedExtractions(db, projectId) {
  // 同时从两个源拉:
  //   ① 老的 extractions 表 (human_verified=1)
  //   ② 新的 literature_matrix 表 (filled_by='ai' 或 'user' 都算 — 用户已经填了就视作有效)
  // 同 record 时 extractions 优先(避免重复)。
  const fromExt = db.prepare(`
    SELECT
      'extraction' AS data_source,
      e.id AS extraction_id,
      e.record_id,
      e.extracted_json,
      1 AS human_verified,
      r.title, r.year, r.authors_text
    FROM extractions e
    LEFT JOIN records r ON r.id = e.record_id
    WHERE e.project_id = ? AND e.human_verified = 1
  `).all(projectId)

  const fromMatrix = db.prepare(`
    SELECT
      'matrix' AS data_source,
      m.id AS extraction_id,
      m.record_id,
      m.fields AS extracted_json,
      CASE WHEN m.filled_by = 'user' OR m.filled_by = 'ai_edited' THEN 1 ELSE 0 END AS human_verified,
      r.title, r.year, r.authors_text
    FROM literature_matrix m
    LEFT JOIN records r ON r.id = m.record_id
    WHERE m.project_id = ?
      AND m.fields IS NOT NULL
      AND m.fields != '{}'
      AND m.completeness >= 0.2
  `).all(projectId)

  const seen = new Set(fromExt.map((r) => r.record_id))
  const merged = [...fromExt, ...fromMatrix.filter((r) => !seen.has(r.record_id))]
  return merged.sort((a, b) => {
    if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0)
    return String(a.title || '').localeCompare(String(b.title || ''))
  })
}

function getApprovedProtocol(db, projectId) {
  const row = db
    .prepare(
      `SELECT * FROM protocols
       WHERE project_id = ? AND approved_by_user = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(projectId)
  if (!row) return null
  return {
    ...row,
    research_questions: parseJsonArrayField(row.research_questions),
    inclusion_criteria: parseJsonArrayField(row.inclusion_criteria),
    exclusion_criteria: parseJsonArrayField(row.exclusion_criteria),
  }
}

// ============================================================
// GET /:id/synthesis  — Evidence Matrix 页
// ============================================================
router.get('/:id/synthesis', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const themes = listThemes(db, project.id)
  const evidencePoints = listEvidencePoints(db, project.id)

  // 前置检查:两个源都算 — extractions(human_verified=1)+ literature_matrix(有内容)
  let verifiedCount = 0
  try {
    verifiedCount = listVerifiedExtractions(db, project.id).length
  } catch { verifiedCount = 0 }

  // 全部已纳入(records JOIN screening or extractions)— 用于矩阵的行
  //   过滤掉 M26 post-RoB excluded 论文(rob_excluded_at IS NULL)
  let recordsForMatrix = []
  try {
    recordsForMatrix = db.prepare(`
      SELECT DISTINCT r.id, r.title, r.year, r.authors_text
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
      WHERE r.project_id = ?
        AND (e.human_verified = 1 OR sd.human_decision = 'include')
        AND r.rob_excluded_at IS NULL
      ORDER BY r.year DESC, r.title ASC
    `).all(project.id)
  } catch {
    recordsForMatrix = []
  }

  // 给每篇 record 附 RoB valence(用于网络图染色,跟 Step 5 RoB 页面一致)
  //   ratingToValence 从 services/rob-helpers.js 共享 import(M30 起统一)
  try {
    const robRows = db.prepare(
      `SELECT record_id, tool, overall_rating FROM rob_assessments
        WHERE project_id = ? AND rater_pass = 1`
    ).all(project.id)
    const valenceByRid = new Map()
    for (const r of robRows) valenceByRid.set(r.record_id, ratingToValence(r.overall_rating, r.tool))
    for (const r of recordsForMatrix) r.robValence = valenceByRid.get(r.id) || 'unrated'
  } catch {
    for (const r of recordsForMatrix) r.robValence = 'unrated'
  }

  // 矩阵:row=record,col=theme,cell=该 record 在该 theme 下的 evidence_points 数量
  const cellCounts = {}     // key = `${recordId}|${themeId}` → number
  const cellStrength = {}   // key 同上 → 'strong'|'moderate'|'weak'|'unclear'
  for (const ep of evidencePoints) {
    if (!ep.record_id || !ep.theme_id) continue
    const key = ep.record_id + '|' + ep.theme_id
    cellCounts[key] = (cellCounts[key] || 0) + 1
    // 取强度最高的(优先级:strong > moderate > weak > unclear)
    const prio = { strong: 4, moderate: 3, weak: 2, unclear: 1, null: 0 }
    const cur = cellStrength[key]
    if (!cur || (prio[ep.strength] || 0) > (prio[cur] || 0)) {
      cellStrength[key] = ep.strength
    }
  }
  // 也要兼容 themes.supporting_record_ids:即使没有具体的 evidence_point,
  // 只要 theme 把这篇论文列为 supporting,就在矩阵里标个 "✓"
  for (const t of themes) {
    for (const rid of t.supporting_record_ids || []) {
      const key = rid + '|' + t.id
      if (!cellCounts[key]) {
        cellCounts[key] = 0
        cellStrength[key] = cellStrength[key] || t.evidence_strength || 'unclear'
      }
    }
  }

  const progress = (() => { try { return getProjectProgress(db, project.id) } catch { return null } })()
  const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'synthesis')

  // ---- M25 新增:协议 / overlay / 元信息 / 数据可用性预检 ----
  const protocolFull = loadApprovedProtocolFull(db, project.id)
  const synthesisMeta = loadSynthesisMeta(db, project.id)
  const overlay = loadOverlay(project)
  const overlayAtVersion = project.synthesis_master_prompt_at_version || null
  const overlayLockStarted = project.synthesis_master_prompt_optimize_started_at || null
  const overlayInFlight = !!(overlayLockStarted && (Date.now() - new Date(overlayLockStarted + ' UTC').getTime() < 15 * 60 * 1000))
  // overlay stale = 协议升级 OR 通用 prompt 升级 OR overlay 无 system_version 字段(老数据)
  const overlayAtSystemVersion = overlay?.system_version || null
  const overlayStaleByProtocol = !!(overlay && protocolFull && overlayAtVersion != null && protocolFull.version > overlayAtVersion)
  const overlayStaleByPrompt = !!(overlay && overlayAtSystemVersion && overlayAtSystemVersion !== SYNTHESIS_SYSTEM_VERSION)
  const overlayStaleNoVersion = !!(overlay && !overlayAtSystemVersion)
  const overlayStale = overlayStaleByProtocol || overlayStaleByPrompt || overlayStaleNoVersion
  const overlayStaleReason = overlayStaleByProtocol ? 'protocol_upgraded'
    : (overlayStaleByPrompt ? 'system_prompt_upgraded'
    : (overlayStaleNoVersion ? 'old_overlay_no_version' : null))
  const protocolApproved = !!protocolFull

  // 数据可用性预检 — 让 UI 显示有多少 include 论文 + 多少有 matrix + 多少有 RoB
  //   注:include 计数是 raw(没扣 post-RoB),postRobExcluded 单算显示给用户
  let includeCount = 0, matrixCoverage = 0, robCoverage = 0, postRobExcluded = 0
  try {
    const incRow = db.prepare(
      `SELECT COUNT(*) AS c FROM screening_decisions sd JOIN records r ON r.id=sd.record_id
        WHERE sd.project_id=? AND sd.stage='title_abstract' AND sd.human_decision='include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id='')`).get(project.id)
    includeCount = incRow?.c || 0
    const matRow = db.prepare(
      `SELECT COUNT(DISTINCT lm.record_id) AS c FROM literature_matrix lm
         JOIN records r ON r.id = lm.record_id
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE lm.project_id=? AND sd.human_decision='include' AND sd.stage='title_abstract'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id='') AND r.rob_excluded_at IS NULL`).get(project.id)
    matrixCoverage = matRow?.c || 0
    const robRow = db.prepare(
      `SELECT COUNT(DISTINCT ra.record_id) AS c FROM rob_assessments ra
         JOIN records r ON r.id = ra.record_id
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE ra.project_id=? AND ra.rater_pass=1 AND sd.human_decision='include' AND sd.stage='title_abstract'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id='') AND r.rob_excluded_at IS NULL`).get(project.id)
    robCoverage = robRow?.c || 0
    // post-RoB excluded count(单独显示)
    const exRow = db.prepare(
      `SELECT COUNT(*) AS c FROM records r JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id=? AND sd.stage='title_abstract' AND sd.human_decision='include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id='') AND r.rob_excluded_at IS NOT NULL`).get(project.id)
    postRobExcluded = exRow?.c || 0
  } catch { /* ignore — tables may not exist on older DBs */ }

  // 可纳入 Synthesis 实际样本 = Step 3 include - post-RoB 排除
  //   matrix/rob coverage 分母也用这个,才会显示 117/117=100% 而不是 117/121=97%
  const effectiveSynthesisCount = Math.max(0, includeCount - postRobExcluded)

  // M29:synthesis run 异步状态
  const synthRunStarted = project.synthesis_run_started_at || null
  const synthRunStatus = project.synthesis_run_status || null
  const synthRunFinished = project.synthesis_run_finished_at || null
  const synthRunError = project.synthesis_run_error || null
  let synthRunMeta = null
  try { synthRunMeta = project.synthesis_run_meta ? JSON.parse(project.synthesis_run_meta) : null } catch {}
  const synthRunInFlight = !!(
    synthRunStatus === 'running' && synthRunStarted &&
    (Date.now() - new Date(synthRunStarted + ' UTC').getTime() < 30 * 60 * 1000)
  )

  // M30+:上游指纹防重复跑检测
  //   currentFp = 当前数据库状态;prevFp = 上次成功时存的;两者相等 → 上游没变,UI 提示
  let upstreamUnchanged = false
  let currentFingerprint = null
  let lastFingerprint = null
  try {
    const fp = computeUpstreamFingerprint(db, project.id, 'synthesis')
    currentFingerprint = fp.fingerprint
    if (synthRunStatus === 'success' && synthRunMeta?.upstream_fingerprint) {
      lastFingerprint = synthRunMeta.upstream_fingerprint
      upstreamUnchanged = (lastFingerprint === currentFingerprint)
    }
  } catch { /* ignore */ }

  res.render('projects/synthesis', {
    title: `综合 · ${project.title}`,
    project,
    progress,
    currentStep: 'synthesis',
    stepLabel: '6. 主题综合',
    stepItems,
    themes,
    evidencePoints,
    recordsForMatrix,
    cellCounts,
    cellStrength,
    verifiedCount,
    minVerified: MIN_VERIFIED_EXTRACTIONS,
    // M25 新增
    protocolFull,
    synthesisMeta,
    overlay,
    overlayAtVersion,
    overlayStale,
    overlayInFlight,
    overlayLockStarted,
    protocolApproved,
    includeCount,
    matrixCoverage,
    robCoverage,
    postRobExcluded,
    effectiveSynthesisCount,
    // M29 异步聚类状态
    synthRunInFlight,
    synthRunStarted,
    synthRunStatus,
    synthRunFinished,
    synthRunError,
    synthRunMeta,
    // M30+ 防重复跑
    upstreamUnchanged,
    currentFingerprint,
    lastFingerprint,
  })
})

// ============================================================
// POST /:id/synthesis/run  — 跑 LLM 聚类(v2:接入 Step 1-5 数据)
//
// 异步模式(M29):前端轮询 status.json 看进度。
//   1) 同步:校验数据(include 数 / 协议 / matrix 覆盖 / token 预算)+ 原子 lock
//   2) setImmediate 后台:跑 runLlm → parse → 入库 → 清 lock 写 meta
//   3) 立刻 redirect + flash;前端 5s 轮询 status.json,完成自动 reload
// ============================================================
router.post('/:id/synthesis/run', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) return res.status(kind === 'error' ? 400 : 200).json({ ok: kind !== 'error', message, ...(extra || {}) })
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // v2 数据路径 — Step 3 include 论文(去 dup)+ M26 post-RoB filter(剔除"全文阅读后判方法学不适合"的)
  let includedRecords = []
  try {
    includedRecords = db.prepare(
      `SELECT r.id, r.title, r.year, r.journal, r.authors_text, r.doi
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ?
          AND sd.stage = 'title_abstract'
          AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
          AND r.rob_excluded_at IS NULL
        ORDER BY r.year DESC, r.created_at ASC`
    ).all(project.id)
  } catch (e) {
    return flashOrJson('error', '取 include 论文失败:' + e.message)
  }

  if (includedRecords.length < MIN_VERIFIED_EXTRACTIONS) {
    return flashOrJson('error', `需要至少 ${MIN_VERIFIED_EXTRACTIONS} 篇 include 论文,当前只有 ${includedRecords.length} 篇。先去 Step 3 标 include。`)
  }

  // 聚合 Step 1-5 数据
  const inputs = buildSynthesisInputs(db, project.id, includedRecords)
  if (!inputs.protocol) {
    return flashOrJson('error', '协议还没批复,先到 Step 1 审批协议')
  }
  if (inputs.stats.withMatrix < Math.min(5, includedRecords.length * 0.5)) {
    return flashOrJson('error', `Step 4 matrix 数据覆盖太低(${inputs.stats.withMatrix}/${includedRecords.length})— 先到 Step 4 跑 AI 批量抽取`)
  }

  // Token 预算检查
  const budget = tokenizeBudget(inputs.papers)
  if (!budget.fitsSingleCall) {
    return flashOrJson('error', `论文数过多(估 ${(budget.inputTokensEst / 1000).toFixed(0)}K tokens > 700K),Phase 2 才支持分批。当前请先减少 include 数或精简协议。`)
  }

  // 取 overlay(可选)
  const overlay = loadOverlay(project)
  const overlayText = overlay && (overlay.overlay_text || overlay.text || '')

  const userPrompt = buildSynthesisUserPromptV2({
    protocol: inputs.protocol,
    finalQueries: inputs.finalQueries,
    papers: inputs.papers,
    overlay: overlayText,
    languageHint: 'en',   // 硬约束:对齐 Step 4 matrix 强制英文(最终成稿英文)
    formatPaperProfile,
  })

  // 上游指纹防重复跑(M30+):上次 success + 上游没变 → 拒绝(可 ?force=1 / body.force=1 绕过)
  const force = req.body?.force === '1' || req.body?.force === 'on' || req.query?.force === '1'
  const fp = computeUpstreamFingerprint(db, project.id, 'synthesis')
  if (!force && project.synthesis_run_status === 'success' && project.synthesis_run_meta) {
    try {
      const prevMeta = JSON.parse(project.synthesis_run_meta)
      if (prevMeta?.upstream_fingerprint === fp.fingerprint) {
        return flashOrJson('error',
          '上游数据(协议 / include 集 / matrix / RoB / overlay)自上次成功以来未变化 — 重跑会得到几乎相同结果,且烧 token。如需强制重跑,加 force=1 参数。',
          { error_code: 'upstream_unchanged', upstream_fingerprint: fp.fingerprint, parts: fp.parts })
      }
    } catch { /* ignore parse error → 允许重跑 */ }
  }

  // 原子 in-flight lock(60 min stale → 比 LLM timeout 45min 多 15 min 余量)
  //   注:Opus + ultrathink + 117 篇综合 ~25-40 分钟,15min timeout 实测不够
  const lockAcquired = db.prepare(
    `UPDATE projects
        SET synthesis_run_started_at = datetime('now', '+8 hours'),
            synthesis_run_finished_at = NULL,
            synthesis_run_status = 'running',
            synthesis_run_error = NULL,
            synthesis_run_meta = NULL
      WHERE id = ?
        AND (synthesis_run_status IS NULL
             OR synthesis_run_status != 'running'
             OR synthesis_run_started_at IS NULL
             OR synthesis_run_started_at < datetime('now','-60 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    return flashOrJson('error', '另一个聚类正在进行中(60 min 内),请等待完成或刷新页面查看进度', { error_code: 'in_flight' })
  }
  // 把指纹存进闭包,success 时写入 synthesis_run_meta(下次比对用)
  const upstreamFingerprint = fp.fingerprint
  const upstreamParts = fp.parts

  // 捕获上下文给后台用(不能在 setImmediate 闭包里继续访问 req)
  const projectId = project.id
  const userId = req.user.id
  const includedCount = includedRecords.length
  const matrixCount = inputs.stats.withMatrix
  const robCount = inputs.stats.withRob
  const screeningCount = inputs.stats.withScreening
  const tokensEst = budget.inputTokensEst
  const synthAudit = (eventType, payload) => {
    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType, userId, projectId, payload,
      })
    } catch {}
  }
  const finishRun = (status, errorMessage, meta) => {
    try {
      db.prepare(
        `UPDATE projects
            SET synthesis_run_status = ?,
                synthesis_run_finished_at = datetime('now', '+8 hours'),
                synthesis_run_error = ?,
                synthesis_run_meta = ?
          WHERE id = ?`
      ).run(status, errorMessage ? String(errorMessage).slice(0, 500) : null,
            meta ? JSON.stringify(meta) : null, projectId)
    } catch (e) { console.error('[synthesis/run] finishRun update failed:', e) }
  }

  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'synthesis',
        projectId,
        system: SYNTHESIS_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        expectShape: 'object',   // P0.3:期望 themes 对象;错误形状 → data=null → 走 json_parse_failed 兜底
        maxTokens: 16000,
        // 45 分钟 — Opus 4.8 + ultrathink + 117 篇 + matrix + RoB + 协议 + overlay
        //   实测前一次 15 min 不够(thinking 还没出 token)。45 min 给充足余量。
        //   lock stale 设 60 min(timeout + 15 min 余量)。
        timeoutMs: 2700_000,
      })
    } catch (e) {
      console.error('[synthesis/run BG] runLlm threw:', e)
      synthAudit('synthesis_run_failed', { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 300) })
      finishRun('failed', `runLlm 异常:${e?.message || e}`, null)
      return
    }

    if (!result.ok) {
      synthAudit('synthesis_run_failed', {
        status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId,
      })
      finishRun('failed', `${result.status} — ${result.error || ''}`, { usage_log_id: result.usageLogId, model: result.model })
      return
    }

    const knownRecordIds = new Set(includedRecords.map((r) => r.id))
    const parsed = parseSynthesisOutputV2(result.data || null, { knownRecordIds, protocol: inputs.protocol })

    // Truncation 检测:正常 LLM 输出应以 { 开头(SYNTHESIS_SYSTEM 已硬约束)。
    //   如果不以 { 开头但末尾有完整闭合,说明前面被截了(envelope / API 端截断,
    //   不是 LLM 的锅)。给用户清晰错误,而不是误导性的 "no themes"。
    const rawText = result.text || ''
    const trimmedRaw = rawText.trim()
    const startsClean = /^[\{\[]/.test(trimmedRaw)
    const looksTruncated = !startsClean && trimmedRaw.length > 100 &&
                            (/\}\s*```?\s*$/.test(trimmedRaw) || /```\s*$/.test(trimmedRaw))

    if (!parsed.ok || !parsed.themes.length) {
      const failureReason = looksTruncated
        ? 'output_truncated_at_start'   // 新:envelope / Anthropic 端截断
        : (result.data ? 'parse_empty' : 'json_parse_failed')
      synthAudit('synthesis_run_failed', {
        reason: failureReason,
        errors: parsed.errors, model: result.model, usage_log_id: result.usageLogId,
        text_length: rawText.length,
        starts_with: trimmedRaw.slice(0, 50),
      })
      if (result.data && result.usageLogId && result.text) {
        try {
          const sep = '\n<<<<<<<< SECTION_DIVIDER >>>>>>>>\n'
          const blob = [
            'meta:',
            '  reason=parse_empty_v2',
            `  parse_errors=${(parsed.errors || []).slice(0, 5).join(' | ')}`,
            `  raw_text_length=${result.text.length}`,
            sep,
            'RAW_TEXT_BEGIN',
            result.text.slice(0, 8000),
            'RAW_TEXT_END',
          ].join('\n')
          db.prepare(`UPDATE usage_logs SET status = 'parse_failed', error_message = ? WHERE id = ?`)
            .run(blob, result.usageLogId)
        } catch {}
      }
      const userMessage = looksTruncated
        ? `LLM 输出前段被截断(开头不是 "{",拿到 ${rawText.length} 字符)— Anthropic envelope / OAuth 端 truncation bug。已存完整 stdout 到 /tmp/claude_cli_dump_*。usage log #${result.usageLogId}`
        : `LLM 输出没有主题(usage log #${result.usageLogId}):${(parsed.errors || []).slice(0, 2).join('; ')}`
      finishRun('failed', userMessage, { usage_log_id: result.usageLogId, model: result.model, reason: failureReason, text_length: rawText.length })
      return
    }

    // 本地补全 rob_profile + study_design_mix(LLM 输出可能不准,本地用真实数据覆盖)
    const matrixByRid = new Map()
    const robByRid = new Map()
    for (const p of inputs.papers) {
      if (p.matrixData) matrixByRid.set(p.record.id, p.matrixData)
      if (p.robData) robByRid.set(p.record.id, p.robData)
    }

    const writeTx = db.transaction(() => {
      db.prepare(`DELETE FROM evidence_points WHERE project_id = ?`).run(projectId)
      db.prepare(`DELETE FROM themes WHERE project_id = ?`).run(projectId)
      db.prepare(`DELETE FROM synthesis_meta WHERE project_id = ?`).run(projectId)

      parsed.themes.forEach((t, idx) => {
        const themeId = randomId('theme')
        const robProfile = computeRobProfileForTheme(t.supporting_record_ids, robByRid)
        const studyDesignMix = computeStudyDesignMix(t.supporting_record_ids, matrixByRid)

        db.prepare(
          `INSERT INTO themes
             (id, project_id, name, description, supporting_record_ids,
              consistent_findings, conflicting_findings, evidence_gaps,
              evidence_strength, generated_by, model, display_order,
              maps_to_research_questions, maps_to_pico_concepts,
              study_design_mix, rob_profile, methodological_note, iteration_n)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?,
                   ?, ?, ?, ?, ?, 1)`
        ).run(
          themeId,
          projectId,
          t.name,
          t.description || null,
          JSON.stringify(t.supporting_record_ids),
          JSON.stringify(t.consistent_findings),
          JSON.stringify(t.conflicting_findings),
          JSON.stringify(t.evidence_gaps),
          t.evidence_strength,
          result.model,
          idx,
          JSON.stringify(t.maps_to_research_questions),
          JSON.stringify(t.maps_to_pico_concepts),
          JSON.stringify(studyDesignMix),
          JSON.stringify(robProfile),
          t.methodological_note || null,
        )

        for (const f of t.consistent_findings) {
          const findingText = typeof f === 'string' ? f : (f.finding || '')
          const supports = typeof f === 'string' ? t.supporting_record_ids :
                            (Array.isArray(f.supporting_records) && f.supporting_records.length ? f.supporting_records : t.supporting_record_ids)
          if (!findingText) continue
          for (const rid of supports) {
            if (!knownRecordIds.has(rid)) continue
            const epId = randomId('ep')
            db.prepare(
              `INSERT INTO evidence_points
                 (id, project_id, record_id, theme_id, finding, evidence_type, strength)
               VALUES (?, ?, ?, ?, ?, 'empirical', ?)`
            ).run(epId, projectId, rid, themeId, findingText, t.evidence_strength)
          }
        }
      })

      const coverage = computeProtocolCoverage(parsed.themes, inputs.protocol)
      const protocolCoverageJson = JSON.stringify({
        coveredBy: coverage.coveredBy,
        uncovered: coverage.uncovered,
        raw: parsed.protocol_coverage,
      })
      db.prepare(
        `INSERT INTO synthesis_meta (project_id, cross_cutting_observations, protocol_coverage, generated_at, model_used, usage_log_id, iteration_n)
         VALUES (?, ?, ?, datetime('now', '+8 hours'), ?, ?, 1)`
      ).run(
        projectId,
        JSON.stringify(parsed.cross_cutting_observations),
        protocolCoverageJson,
        result.model,
        result.usageLogId,
      )

      db.prepare(`UPDATE projects SET status = 'synthesizing', updated_at = datetime('now', '+8 hours') WHERE id = ?`).run(projectId)
    })

    try {
      writeTx()
    } catch (e) {
      console.error('[synthesis/run BG] db write failed:', e)
      synthAudit('synthesis_run_failed', { reason: 'db_write_error', error: e.message?.slice(0, 200) })
      finishRun('failed', `入库失败:${(e.message || '').slice(0, 200)}`,
                { usage_log_id: result.usageLogId, model: result.model })
      return
    }

    synthAudit('synthesis_run_success', {
      themes_count: parsed.themes.length,
      papers_count: includedCount,
      with_matrix: matrixCount,
      with_rob: robCount,
      with_screening: screeningCount,
      model: result.model,
      duration_ms: result.durationMs,
      input_tokens_est: tokensEst,
    })
    finishRun('success', null, {
      themes_count: parsed.themes.length,
      papers_count: includedCount,
      with_matrix: matrixCount,
      with_rob: robCount,
      model: result.model,
      duration_ms: result.durationMs,
      usage_log_id: result.usageLogId,
      upstream_fingerprint: upstreamFingerprint,    // M30+ 防重复跑
      upstream_parts: upstreamParts,
    })
  })

  // 立刻响应 — 前端 5s 轮询 status.json
  const startMessage = `已启动主题聚类(Opus 4.8 + ultrathink, ~20-40 分钟)。${includedCount} 篇 · matrix ${matrixCount} · RoB ${robCount}。完成后页面会自动刷新,可以关闭页面。`
  if (wantsJson) {
    return res.json({ ok: true, message: startMessage, in_flight: true, started_at: new Date().toISOString() })
  }
  req.session.flash = { type: 'success', message: startMessage }
  res.redirect(`/projects/${project.id}/synthesis`)
})

// ============================================================
// GET /:id/synthesis/run/status.json  — 前端轮询聚类状态
// ============================================================
router.get('/:id/synthesis/run/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.synthesis_run_started_at
  const status = project.synthesis_run_status
  const elapsedS = lockStarted
    ? Math.max(0, Math.floor((Date.now() - new Date(lockStarted + ' UTC').getTime()) / 1000))
    : 0
  // in-flight = status==running AND 在 30 min 内(过期视为 abort)
  const inFlight = !!(status === 'running' && lockStarted && elapsedS < 30 * 60)
  let meta = null
  try { meta = project.synthesis_run_meta ? JSON.parse(project.synthesis_run_meta) : null } catch {}
  res.json({
    ok: true,
    in_flight: inFlight,
    started_at: lockStarted,
    finished_at: project.synthesis_run_finished_at,
    status: status,
    error: project.synthesis_run_error || null,
    elapsed_s: elapsedS,
    meta,
  })
})

// ============================================================
// POST /:id/synthesis/optimize-overlay  — Opus 一次性生成项目专用聚类指引
//   原子 in-flight lock(15 min stale)+ 协议版本门(同协议同版本只能跑一次)
//   完全镜像 matrix/rob 的 optimize 模式。
// ============================================================
router.post('/:id/synthesis/optimize-overlay', requireAdvancedExtraction, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const protocol = loadApprovedProtocolFull(db, project.id)
  if (!protocol) {
    req.session.flash = { type: 'error', message: '协议还没批复' }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // 协议版本 + 通用 prompt system_version 双门:都没升级才拒绝
  const optimizedVer = project.synthesis_master_prompt_at_version
  let existingOverlayObj = null
  try { existingOverlayObj = project.synthesis_master_prompt_overlay ? JSON.parse(project.synthesis_master_prompt_overlay) : null } catch {}
  const sameProtocol = (optimizedVer != null && protocol.version <= optimizedVer)
  const samePromptVersion = (existingOverlayObj?.system_version === SYNTHESIS_SYSTEM_VERSION)
  if (sameProtocol && samePromptVersion) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: 'already_optimized', protocol_version: protocol.version, optimized_at_version: optimizedVer, system_version: SYNTHESIS_SYSTEM_VERSION })
    }
    req.session.flash = { type: 'error', message: `已基于协议 v${optimizedVer} + 通用 prompt ${SYNTHESIS_SYSTEM_VERSION} 生成 — 协议或通用 prompt 升级后才能重生成` }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // 原子 lock(只在 lock 为空或过 15 min 时拿到)
  const lockAcquired = db.prepare(
    `UPDATE projects SET synthesis_master_prompt_optimize_started_at = datetime('now', '+8 hours')
       WHERE id = ?
         AND (synthesis_master_prompt_optimize_started_at IS NULL
              OR synthesis_master_prompt_optimize_started_at < datetime('now','-15 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: 'in_flight' })
    }
    req.session.flash = { type: 'error', message: '另一个 overlay 生成请求正在进行(15 min 内)' }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // 取代表性 3-4 篇 include 论文样本
  let samplePapers = []
  try {
    const sampleRecords = db.prepare(
      `SELECT r.id, r.title, r.year, r.journal, r.authors_text
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
        ORDER BY r.year DESC LIMIT 4`
    ).all(project.id)
    const inputs = buildSynthesisInputs(db, project.id, sampleRecords)
    samplePapers = inputs.papers.filter((p) => p.matrixData).slice(0, 4)
  } catch { /* ignore */ }

  // 用户可选的 seed themes hint
  const seedThemesHint = String((req.body && req.body.seed_themes_hint) || '').slice(0, 500)

  const userPrompt = buildOptimizeSynthesisOverlayUserPrompt({ protocol, samplePapers, seedThemesHint })

  // 后台跑(因 Opus + ultrathink 要 5-8 min,不能 await 在同步 HTTP request 里)
  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId: req.user.id,
        actionType: 'synthesis_optimize_overlay',
        projectId: project.id,
        system: OPTIMIZE_SYNTHESIS_OVERLAY_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        maxTokens: 8000,
        timeoutMs: 480_000,
      })
    } catch (e) {
      console.error('[synthesis/optimize-overlay] runLlm threw:', e)
      try {
        db.prepare(`UPDATE projects SET synthesis_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(project.id)
        audit(db, { user: { id: req.user.id }, ip: '', get: () => '' }, {
          eventType: 'synthesis_optimize_overlay_failed',
          userId: req.user.id, projectId: project.id,
          payload: { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 200) },
        })
      } catch {}
      return
    }

    if (!result.ok) {
      try {
        db.prepare(`UPDATE projects SET synthesis_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(project.id)
        audit(db, { user: { id: req.user.id }, ip: '', get: () => '' }, {
          eventType: 'synthesis_optimize_overlay_failed',
          userId: req.user.id, projectId: project.id,
          payload: { status: result.status, error: (result.error || '').slice(0, 200), model: result.model, usage_log_id: result.usageLogId },
        })
      } catch {}
      return
    }

    const parsed = parseSynthesisOverlayOutput(result.data)
    if (!parsed.ok) {
      try {
        db.prepare(`UPDATE projects SET synthesis_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(project.id)
        audit(db, { user: { id: req.user.id }, ip: '', get: () => '' }, {
          eventType: 'synthesis_optimize_overlay_failed',
          userId: req.user.id, projectId: project.id,
          payload: { reason: 'parse_failed', error: parsed.error, model: result.model, usage_log_id: result.usageLogId },
        })
      } catch {}
      return
    }

    // 成功 — 写 overlay + at_version + 清 lock
    try {
      db.prepare(
        `UPDATE projects SET
            synthesis_master_prompt_overlay = ?,
            synthesis_master_prompt_at_version = ?,
            synthesis_master_prompt_optimize_started_at = NULL,
            updated_at = datetime('now', '+8 hours')
          WHERE id = ?`
      ).run(
        JSON.stringify({ overlay_text: parsed.overlay_text, system_version: SYNTHESIS_SYSTEM_VERSION }),
        protocol.version,
        project.id,
      )
      audit(db, { user: { id: req.user.id }, ip: '', get: () => '' }, {
        eventType: 'synthesis_optimize_overlay_success',
        userId: req.user.id, projectId: project.id,
        payload: { overlay_chars: parsed.overlay_text.length, at_version: protocol.version, model: result.model, usage_log_id: result.usageLogId },
      })
    } catch (e) {
      console.error('[synthesis/optimize-overlay] write failed:', e)
    }
  })

  // 立刻响应 — 前端轮询 status.json
  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动 overlay 生成,5-8 分钟' })
  }
  req.session.flash = { type: 'success', message: '已启动 overlay 生成(Opus 4.8 + ultrathink, 5-8 分钟),完成后页面会刷新显示' }
  res.redirect(`/projects/${project.id}/synthesis`)
})

router.get('/:id/synthesis/optimize-overlay/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.synthesis_master_prompt_optimize_started_at
  const inFlight = !!(lockStarted && (Date.now() - new Date(lockStarted + ' UTC').getTime() < 15 * 60 * 1000))
  const hasFresh = !!(project.synthesis_master_prompt_overlay && project.synthesis_master_prompt_at_version)
  res.json({
    ok: true,
    in_flight: inFlight,
    has_fresh: hasFresh,
    at_version: project.synthesis_master_prompt_at_version,
    started_at: lockStarted,
  })
})

// ============================================================
// POST /:id/synthesis/themes/:themeId/edit
// ============================================================
router.post('/:id/synthesis/themes/:themeId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const theme = db.prepare(
    `SELECT * FROM themes WHERE id = ? AND project_id = ?`
  ).get(req.params.themeId, project.id)
  if (!theme) {
    req.session.flash = { type: 'error', message: '主题不存在' }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  const name = String(req.body.name || '').trim()
  const description = String(req.body.description || '').trim()
  const strengthRaw = String(req.body.evidence_strength || '').trim().toLowerCase()
  const strength = ['strong', 'moderate', 'weak', 'unclear'].includes(strengthRaw) ? strengthRaw : theme.evidence_strength

  if (!name) {
    req.session.flash = { type: 'error', message: '主题名不能为空' }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  db.prepare(
    `UPDATE themes
     SET name = ?, description = ?, evidence_strength = ?, updated_at = datetime('now', '+8 hours')
     WHERE id = ? AND project_id = ?`
  ).run(name, description || null, strength, theme.id, project.id)

  audit(db, req, {
    eventType: 'synthesis_theme_edited',
    userId: req.user.id,
    projectId: project.id,
    payload: { theme_id: theme.id, from_name: theme.name, to_name: name },
  })
  req.session.flash = { type: 'success', message: `主题"${name}"已更新` }
  res.redirect(`/projects/${project.id}/synthesis`)
})

// ============================================================
// POST /:id/synthesis/themes/:themeId/delete
// ============================================================
router.post('/:id/synthesis/themes/:themeId/delete', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const theme = db.prepare(
    `SELECT * FROM themes WHERE id = ? AND project_id = ?`
  ).get(req.params.themeId, project.id)
  if (!theme) {
    req.session.flash = { type: 'error', message: '主题不存在' }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  db.transaction(() => {
    // evidence_points.theme_id ON DELETE SET NULL 已声明,但显式 update 更清楚
    db.prepare(`UPDATE evidence_points SET theme_id = NULL WHERE theme_id = ? AND project_id = ?`)
      .run(theme.id, project.id)
    db.prepare(`DELETE FROM themes WHERE id = ? AND project_id = ?`).run(theme.id, project.id)
  })()

  audit(db, req, {
    eventType: 'synthesis_theme_deleted',
    userId: req.user.id,
    projectId: project.id,
    payload: { theme_id: theme.id, theme_name: theme.name },
  })
  req.session.flash = { type: 'success', message: `主题"${theme.name}"已删除` }
  res.redirect(`/projects/${project.id}/synthesis`)
})

// ============================================================
// GET /:id/synthesis/matrix.csv  — 导出矩阵
// ============================================================
router.get('/:id/synthesis/matrix.csv', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).type('text/plain').send('not found')
  }

  const themes = listThemes(db, project.id)
  const evidencePoints = listEvidencePoints(db, project.id)

  let records = []
  try {
    records = db.prepare(`
      SELECT DISTINCT r.id, r.title, r.year, r.authors_text
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
      WHERE r.project_id = ?
        AND (e.human_verified = 1 OR sd.human_decision = 'include')
      ORDER BY r.year DESC, r.title ASC
    `).all(project.id)
  } catch { records = [] }

  // 单元格 = 该 record 在该 theme 下的 finding 数量
  const cellCount = {}
  for (const ep of evidencePoints) {
    if (!ep.record_id || !ep.theme_id) continue
    const key = ep.record_id + '|' + ep.theme_id
    cellCount[key] = (cellCount[key] || 0) + 1
  }
  for (const t of themes) {
    for (const rid of t.supporting_record_ids || []) {
      const key = rid + '|' + t.id
      if (cellCount[key] == null) cellCount[key] = 0
    }
  }

  // CSV 序列化
  const esc = (s) => {
    if (s == null) return ''
    const v = String(s)
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
    return v
  }

  const lines = []
  const header = ['record_id', 'title', 'year', 'authors', ...themes.map((t) => t.name + ' (' + (t.evidence_strength || '-') + ')')]
  lines.push(header.map(esc).join(','))

  for (const r of records) {
    const row = [r.id, r.title || '', r.year || '', r.authors_text || '']
    for (const t of themes) {
      const key = r.id + '|' + t.id
      row.push(cellCount[key] != null ? String(cellCount[key]) : '')
    }
    lines.push(row.map(esc).join(','))
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="evidence-matrix-${project.id}.csv"`)
  res.send('﻿' + lines.join('\n'))  // BOM 让 Excel 直接认 UTF-8
})

export default router
