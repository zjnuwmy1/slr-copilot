/**
 * Step 7 · 证据强度(Certainty)— GRADE + CERQual 双轨主题级 rollup + outcome 级 drill-down
 *
 * 主路由(主题级,新 M30):
 *   GET  /:id/certainty                          主页(主题大卡 + outcome drill-down)
 *   POST /:id/certainty/run-themes               异步跑全主题 rollup(setImmediate + lock + status polling)
 *   GET  /:id/certainty/run/status.json          5s 轮询
 *   POST /:id/certainty/optimize-overlay         Opus 一次性生成项目专用 overlay
 *   GET  /:id/certainty/optimize-overlay/status.json
 *   POST /:id/certainty/iterate-theme/:themeId   用户编辑后单主题重评
 *
 * 兼容路由(outcome 级 drill-down,保留原行为 + 加英文硬约束 + 去截断 + 改 resolveStepModel):
 *   POST /:id/certainty/ai-suggest/:themeId      给 theme 提议 1..3 个 outcome 评估
 *   POST /:id/certainty/manual-add/:themeId      人工新增空白 outcome
 *   POST /:id/certainty/:assessmentId/edit       编辑 outcome
 *   POST /:id/certainty/:assessmentId/override   override final certainty
 *   POST /:id/certainty/:assessmentId/delete     删 outcome
 *
 * 导出:
 *   GET  /:id/certainty/sof.md / .csv            outcome 级 SoF(原有)
 *   GET  /:id/certainty/evidence-profile.md/.csv 新:主题级 GRADE Evidence Profile
 *   GET  /:id/certainty/summary-findings.md      新:主题级 body_of_evidence + implications
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  GRADE_SYSTEM,
  GRADE_SYSTEM_VERSION,
  buildGradeUserPrompt,
  normalizeGradeOutput,
  normalizeOutcomesLangAudit,
} from '../../services/prompts/grade.js'
import {
  CERTAINTY_THEME_LEVEL_SYSTEM,
  CERTAINTY_OUTCOME_LEVEL_SYSTEM,
  OPTIMIZE_CERTAINTY_OVERLAY_SYSTEM,
  CERTAINTY_SYSTEM_VERSION,
  buildThemeRollupUserPrompt,
  buildOptimizeCertaintyOverlayUserPrompt,
  parseThemeRollupOutput,
  parseCertaintyOverlayOutput,
} from '../../services/prompts/certainty.js'
import {
  CERTAINTY_LEVELS,
  DOWNGRADE_ENUM,
  PUB_BIAS_ENUM,
  UPGRADE_LARGE_EFFECT_ENUM,
  UPGRADE_PLAUSIBLE_CONF_ENUM,
  IMPORTANCE_ENUM,
  DOMAIN_META,
  GRADE_LABELS,
  computeFinalCertainty,
  listAssessmentsForProject,
  getAssessment,
  buildSoFRows,
  renderSoFMarkdown,
} from '../../services/grade.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'
import {
  buildCertaintyInputs,
  classifyThemeForGrading,
  loadAllThemesWithMeta,
  loadSynthesisMetaForCertainty,
  loadAllThemeCertainty,
  indexLatestCertaintyByTheme,
  loadCertaintyOverlay,
  tokenizeBudgetForCertainty,
} from '../../services/certainty-helpers.js'
import { loadApprovedProtocolFull, computeCertaintyUpstreamFingerprint, formatPaperProfile, listFinalSearchQueries, buildSynthesisInputs } from '../../services/synthesis-helpers.js'

const router = express.Router({ mergeParams: true })

function ownProjectOr404(db, projectId, userId) {
  const r = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)
  return r || null
}

function loadThemesForProject(db, projectId) {
  return db
    .prepare(`
      SELECT id, name, description, supporting_record_ids,
             consistent_findings, conflicting_findings, evidence_gaps,
             evidence_strength, display_order
      FROM themes WHERE project_id = ?
      ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC
    `)
    .all(projectId)
    .map((t) => ({
      ...t,
      supporting_record_ids: tryParseArr(t.supporting_record_ids),
      consistent_findings:   tryParseArr(t.consistent_findings),
      conflicting_findings:  tryParseArr(t.conflicting_findings),
      evidence_gaps:         tryParseArr(t.evidence_gaps),
    }))
}

function tryParseArr(v) {
  if (!v) return []
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : [] } catch { return [] }
}

// ──────────────────────────────────────────────────────────────
// GET /:id/certainty  — 主题级 rollup + outcome 级 drill-down
// ──────────────────────────────────────────────────────────────
router.get('/:id/certainty', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  // 主题(含 Step 6 v2 全字段 + grading_framework label)
  const themesWithMeta = loadAllThemesWithMeta(db, project.id)
  // 保留旧 themes 形状给现有 EJS 兼容(分配字段同名,新字段也带上)
  const themes = themesWithMeta

  // 主题级 certainty(M30 新表)
  const themeCertaintyRows = loadAllThemeCertainty(db, project.id)
  const themeCertaintyByTheme = indexLatestCertaintyByTheme(themeCertaintyRows)
  const themeCertaintyMap = {}
  for (const [tid, tc] of themeCertaintyByTheme.entries()) themeCertaintyMap[tid] = tc

  // outcome 级 assessments(原有)
  const assessments = listAssessmentsForProject(db, project.id)
  const assessmentsByTheme = {}
  for (const a of assessments) {
    if (!assessmentsByTheme[a.theme_id]) assessmentsByTheme[a.theme_id] = []
    assessmentsByTheme[a.theme_id].push(a)
  }

  // 协议 + synthesis_meta
  const protocolFull = loadApprovedProtocolFull(db, project.id)
  const synthesisMeta = loadSynthesisMetaForCertainty(db, project.id)

  // Overlay + in-flight state(M30)
  const overlay = loadCertaintyOverlay(project)
  const overlayAtVersion = project.certainty_master_prompt_at_version || null
  const overlayLockStarted = project.certainty_master_prompt_optimize_started_at || null
  const overlayInFlight = !!(overlayLockStarted && (Date.now() - new Date(overlayLockStarted + ' UTC').getTime() < 15 * 60 * 1000))
  // overlay stale = 协议升级 OR 通用 prompt 升级(M30+ system_version 检测)
  const overlayAtSystemVersion = overlay?.system_version || null
  const overlayStaleByProtocol = !!(overlay && protocolFull && overlayAtVersion != null && protocolFull.version > overlayAtVersion)
  const overlayStaleByPrompt = !!(overlay && overlayAtSystemVersion && overlayAtSystemVersion !== CERTAINTY_SYSTEM_VERSION)
  // 兼容:overlay 无 system_version 字段(老数据)→ 视为 stale by prompt
  const overlayStaleNoVersion = !!(overlay && !overlayAtSystemVersion)
  const overlayStale = overlayStaleByProtocol || overlayStaleByPrompt || overlayStaleNoVersion
  const overlayStaleReason = overlayStaleByProtocol ? 'protocol_upgraded'
    : (overlayStaleByPrompt ? 'system_prompt_upgraded'
    : (overlayStaleNoVersion ? 'old_overlay_no_version' : null))

  // Run state(M30 主题级 rollup 异步)
  const certRunStarted = project.certainty_run_started_at || null
  const certRunStatus = project.certainty_run_status || null
  const certRunFinished = project.certainty_run_finished_at || null
  const certRunError = project.certainty_run_error || null
  let certRunMeta = null
  try { certRunMeta = project.certainty_run_meta ? JSON.parse(project.certainty_run_meta) : null } catch {}
  const certRunInFlight = !!(
    certRunStatus === 'running' && certRunStarted &&
    (Date.now() - new Date(certRunStarted + ' UTC').getTime() < 75 * 60 * 1000)
  )

  // M30+ 上游指纹检测(防重复跑)
  let certUpstreamUnchanged = false
  let certCurrentFingerprint = null
  let certLastFingerprint = null
  try {
    const fpC = computeCertaintyUpstreamFingerprint(db, project.id)
    certCurrentFingerprint = fpC.fingerprint
    if (certRunStatus === 'success' && certRunMeta?.upstream_fingerprint) {
      certLastFingerprint = certRunMeta.upstream_fingerprint
      certUpstreamUnchanged = (certLastFingerprint === certCurrentFingerprint)
    }
  } catch { /* ignore */ }

  // Framework split 统计
  const frameworkSplit = { grade: 0, cerqual: 0, hybrid: 0 }
  for (const t of themesWithMeta) frameworkSplit[t.grading_framework] = (frameworkSplit[t.grading_framework] || 0) + 1

  const progress = getProjectProgress(db, project.id)
  const stepItems = getChecklistItems(db, project.id).filter((c) => c.workflow_step === 'certainty')

  res.render('projects/certainty', {
    title: project.title + ' · 证据强度',
    project,
    themes,                         // alias
    themesWithMeta,                 // 新:含 grading_framework
    themeCertaintyMap,              // 新:theme_id → latest theme_certainty row
    assessments,
    assessmentsByTheme,
    protocolFull,                   // 新
    synthesisMeta,                  // 新
    overlay,                        // 新
    overlayAtVersion,
    overlayInFlight,
    overlayLockStarted,
    overlayStale,
    overlayStaleReason,                     // 'protocol_upgraded' | 'system_prompt_upgraded' | 'old_overlay_no_version' | null
    currentSystemVersion: CERTAINTY_SYSTEM_VERSION,
    certRunInFlight,                // 新
    certRunStarted,
    certRunStatus,
    certRunFinished,
    certRunError,
    certRunMeta,
    frameworkSplit,                 // 新 {grade, cerqual, hybrid}
    // M30+ 防重复跑
    certUpstreamUnchanged,
    certCurrentFingerprint,
    certLastFingerprint,
    progress,
    stepItems,
    currentStep: 'certainty',
    stepLabel: '7. 证据确定性评级',
    constants: {
      CERTAINTY_LEVELS,
      DOWNGRADE_ENUM,
      PUB_BIAS_ENUM,
      UPGRADE_LARGE_EFFECT_ENUM,
      UPGRADE_PLAUSIBLE_CONF_ENUM,
      IMPORTANCE_ENUM,
      DOMAIN_META,
      GRADE_LABELS,
    },
  })
})

// ──────────────────────────────────────────────────────────────
// POST /:id/certainty/ai-suggest/:themeId
// ──────────────────────────────────────────────────────────────
router.post('/:id/certainty/ai-suggest/:themeId', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) return res.status(kind === 'error' ? 400 : 200).json({ ok: kind !== 'error', message, ...(extra || {}) })
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/certainty#theme-${req.params.themeId}`)
  }

  const theme = db
    .prepare('SELECT * FROM themes WHERE id = ? AND project_id = ?')
    .get(req.params.themeId, project.id)
  if (!theme) {
    return flashOrJson('error', '主题不存在')
  }
  theme.consistent_findings  = tryParseArr(theme.consistent_findings)
  theme.conflicting_findings = tryParseArr(theme.conflicting_findings)
  theme.evidence_gaps        = tryParseArr(theme.evidence_gaps)

  // 拉 evidence_points + 关联 records(M30:去 LIMIT 50,大主题完整喂)
  const evidencePoints = db
    .prepare(`
      SELECT record_id, finding, evidence_type, strength
      FROM evidence_points
      WHERE project_id = ? AND theme_id = ?
    `)
    .all(project.id, theme.id)

  // M31+:取 supporting_record_ids ∪ evidence_points.record_ids 并集(防漏)
  //   evidence_points 只覆盖被 LLM 写进具体 finding 的 paper;supporting_record_ids 是该主题完整 paper 列表。
  //   旧版只用 evidence_points → 漏掉没 specific finding 的 supporting papers,LLM 看不到完整证据池。
  const supportingIds = tryParseArr(theme.supporting_record_ids)
  const recordIds = [...new Set([...evidencePoints.map((e) => e.record_id), ...supportingIds])]

  // M30+ 升级:用 buildSynthesisInputs 拿完整 paper profiles(matrix 完整 + RoB rationale + screening)
  //   取代老的 minimal recordSummaries 查询(只 title + study_type + sample_size 2 字段)
  let paperProfiles = new Map()
  let robByRid = new Map()
  let recordSummaries = []   // 兼容老 buildGradeUserPrompt 签名
  if (recordIds.length) {
    try {
      // 拉这批 records 的完整数据
      const placeholders = recordIds.map(() => '?').join(',')
      const records = db.prepare(
        `SELECT r.id, r.title, r.year, r.journal, r.authors_text, r.doi, r.abstract
           FROM records r
          WHERE r.id IN (${placeholders}) AND r.rob_excluded_at IS NULL`
      ).all(...recordIds)
      const isAdvanced = !!(req.user?.advanced_extraction_enabled || req.user?.is_super_admin)
      const synth = buildSynthesisInputs(db, project.id, records, { includePdfChunks: isAdvanced })
      for (const p of synth.papers || []) {
        if (p?.record?.id) {
          paperProfiles.set(p.record.id, p)
          if (p.robData) robByRid.set(p.record.id, p.robData)
        }
      }
      // 兜底 recordSummaries(在 paperProfiles 为空时使用)
      recordSummaries = records.map((r) => ({
        id: r.id, title: r.title, year: r.year,
        study_type: paperProfiles.get(r.id)?.matrixData?.fields?.study_design || null,
        sample_size: paperProfiles.get(r.id)?.matrixData?.fields?.sample_size || null,
      }))
    } catch (e) {
      console.error('[certainty/ai-suggest] buildSynthesisInputs failed:', e?.message)
    }
  }

  // 本地 RoB → GRADE risk_of_bias 维度建议(Cochrane handbook 思路)
  //   多数低 RoB → not_serious;有相当比例 serious/critical → serious;majority bad → very_serious
  let suggestedRobDowngrade = null
  try {
    let rp = theme.rob_profile
    if (rp && typeof rp === 'string') rp = JSON.parse(rp)
    if (rp && typeof rp === 'object') {
      const total = (rp.good || 0) + (rp.middle || 0) + (rp.bad || 0)
      if (total > 0) {
        const badRatio = (rp.bad || 0) / total
        const midPlus = ((rp.middle || 0) + (rp.bad || 0)) / total
        let level, rationale
        if (badRatio >= 0.5) {
          level = 'very_serious'
          rationale = `多数论文 RoB 差(${rp.bad}/${total},${Math.round(badRatio*100)}%)→ 降 2 级`
        } else if (badRatio >= 0.2 || midPlus >= 0.5) {
          level = 'serious'
          rationale = `部分论文 RoB 高(差 ${rp.bad}/${total} · 中 ${rp.middle}/${total})→ 降 1 级`
        } else {
          level = 'not_serious'
          rationale = `多数论文 RoB 好(${rp.good}/${total},${Math.round((1-midPlus)*100)}% 低偏倚)→ 不降`
        }
        suggestedRobDowngrade = { level, rationale }
      }
    }
  } catch { /* ignore */ }

  // M30+ 升级:paperProfiles + formatPaperProfile 提供完整 matrix + RoB rationale + screening
  //   M31+:沿用 certainty overlay(主题级 overlay 也包含 outcome 级 naming + indirectness 锚点)
  //         + 注入 protocol 给 indirectness 判断
  const overlayObjForGrade = loadCertaintyOverlay(project)
  const overlayTextForGrade = overlayObjForGrade && (overlayObjForGrade.overlay_text || overlayObjForGrade.text || '')
  const protocolForGrade = loadApprovedProtocolFull(db, project.id)
  const userPrompt = buildGradeUserPrompt({
    theme, evidencePoints, recordSummaries, paperProfiles, formatPaperProfile,
    robByRid, suggestedRobDowngrade,
    overlay: overlayTextForGrade,
    protocol: protocolForGrade,
  })

  // ─────────────────────────────────────────────────────────────
  // M31:per-theme 原子 lock + setImmediate 后台跑 + 心跳 + status.json
  // ─────────────────────────────────────────────────────────────
  const lockAcquired = db.prepare(
    `UPDATE themes
        SET outcome_run_started_at = datetime('now', '+8 hours'),
            outcome_run_finished_at = NULL,
            outcome_run_status = 'running',
            outcome_run_error = NULL,
            outcome_run_meta = NULL
      WHERE id = ? AND project_id = ?
        AND (outcome_run_status IS NULL
             OR outcome_run_status != 'running'
             OR outcome_run_started_at IS NULL
             OR outcome_run_started_at < datetime('now','-20 minutes'))`
  ).run(theme.id, project.id).changes > 0
  if (!lockAcquired) {
    return flashOrJson('error', '该主题的 AI 评估正在进行中(20 min 内),请等待或刷新查看进度', { error_code: 'in_flight' })
  }

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id
  const themeId = theme.id
  const themeName = theme.name

  const themeAudit = (eventType, payload) => {
    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType, userId, projectId, payload,
      })
    } catch {}
  }
  const finishThemeRun = (status, errorMessage, meta) => {
    try {
      db.prepare(
        `UPDATE themes
            SET outcome_run_status = ?,
                outcome_run_finished_at = datetime('now', '+8 hours'),
                outcome_run_error = ?,
                outcome_run_meta = ?
          WHERE id = ?`
      ).run(status, errorMessage ? String(errorMessage).slice(0, 500) : null,
            meta ? JSON.stringify(meta) : null, themeId)
    } catch (e) { console.error('[certainty/ai-suggest BG] finishThemeRun update failed:', e) }
  }
  // 💓 心跳 every 30s
  const heartbeatStart = Date.now()
  const writeHeartbeat = () => {
    try {
      db.prepare(
        `UPDATE themes
            SET outcome_run_meta = ?
          WHERE id = ? AND outcome_run_status = 'running'`
      ).run(JSON.stringify({
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - heartbeatStart) / 1000),
        theme_name: themeName,
      }), themeId)
    } catch { /* ignore */ }
  }
  writeHeartbeat()
  const hbInterval = setInterval(writeHeartbeat, 30_000)
  const finishWithHb = (status, errorMessage, meta) => {
    clearInterval(hbInterval)
    finishThemeRun(status, errorMessage, meta)
  }

  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'certainty',
        projectId,
        system: GRADE_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        maxTokens: 6144,
        timeoutMs: 900_000,    // 15 min(outcome 级单主题 ~3-8 min,留余量)
      })
    } catch (e) {
      console.error('[certainty/ai-suggest BG] runLlm threw:', e)
      themeAudit('grade_ai_failed', { theme_id: themeId, reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 300) })
      finishWithHb('failed', `runLlm 异常:${(e?.message || e).slice(0, 200)}`, null)
      return
    }
    if (!result.ok) {
      themeAudit('grade_ai_failed', { theme_id: themeId, error: result.error, status: result.status, usage_log_id: result.usageLogId })
      finishWithHb('failed', `${result.status} — ${(result.error || '').slice(0, 200)}`, { usage_log_id: result.usageLogId, model: result.model })
      return
    }
    const outcomes = normalizeGradeOutput(result.data)
    if (outcomes.length === 0) {
      themeAudit('grade_ai_empty', { theme_id: themeId, usage_log_id: result.usageLogId })
      finishWithHb('failed', `LLM 返空 / 无法解析(usage log #${result.usageLogId})`, { usage_log_id: result.usageLogId, model: result.model })
      return
    }
    // 语言抽检 — 非 ASCII >10% 标 warning(不 reject)
    const langWarning = normalizeOutcomesLangAudit(outcomes)
    if (langWarning) {
      themeAudit('grade_ai_lang_warning', { theme_id: themeId, warning: langWarning, usage_log_id: result.usageLogId })
    }

    // 写库
    const insert = db.prepare(`
      INSERT INTO grade_assessments
        (id, project_id, theme_id, outcome_label, outcome_description, importance,
         starting_certainty, risk_of_bias, inconsistency, indirectness, imprecision, publication_bias,
         rationales, large_effect, dose_response, plausible_confounding,
         summary_of_findings, effect_size_text, num_studies, num_participants,
         generated_by, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)
      ON CONFLICT(theme_id, outcome_label) DO UPDATE SET
        outcome_description = excluded.outcome_description,
        importance = excluded.importance,
        starting_certainty = excluded.starting_certainty,
        risk_of_bias = excluded.risk_of_bias,
        inconsistency = excluded.inconsistency,
        indirectness = excluded.indirectness,
        imprecision = excluded.imprecision,
        publication_bias = excluded.publication_bias,
        rationales = excluded.rationales,
        large_effect = excluded.large_effect,
        dose_response = excluded.dose_response,
        plausible_confounding = excluded.plausible_confounding,
        summary_of_findings = excluded.summary_of_findings,
        effect_size_text = excluded.effect_size_text,
        num_studies = excluded.num_studies,
        num_participants = excluded.num_participants,
        generated_by = 'ai',
        model = excluded.model,
        updated_at = datetime('now', '+8 hours')
    `)
    try {
      const tx = db.transaction(() => {
        for (const o of outcomes) {
          insert.run(
            randomId('grade'),
            projectId,
            themeId,
            o.outcome_label,
            o.outcome_description,
            o.importance,
            o.starting_certainty,
            o.risk_of_bias,
            o.inconsistency,
            o.indirectness,
            o.imprecision,
            o.publication_bias,
            JSON.stringify(o.rationales),
            o.large_effect,
            o.dose_response,
            o.plausible_confounding,
            o.summary_of_findings,
            o.effect_size_text,
            o.num_studies,
            o.num_participants,
            result.model,
          )
        }
      })
      tx()
    } catch (e) {
      console.error('[certainty/ai-suggest BG] db write failed:', e)
      themeAudit('grade_ai_failed', { theme_id: themeId, reason: 'db_write_error', error: e.message?.slice(0, 200) })
      finishWithHb('failed', `入库失败:${(e.message || '').slice(0, 200)}`, { usage_log_id: result.usageLogId })
      return
    }

    themeAudit('grade_ai_assessed', { theme_id: themeId, outcomes_count: outcomes.length, model: result.model, duration_ms: result.durationMs, lang_warning: langWarning })
    finishWithHb('success', null, {
      outcomes_count: outcomes.length,
      model: result.model,
      duration_ms: result.durationMs,
      usage_log_id: result.usageLogId,
      lang_warning: langWarning,
      used_overlay: !!overlayTextForGrade,
      grade_system_version: GRADE_SYSTEM_VERSION,
    })
  })

  // 立刻响应
  const startMessage = `已启动 AI outcome 评估("${themeName}",~5-10 min,可关页面后台继续)`
  if (wantsJson) {
    return res.json({ ok: true, message: startMessage, in_flight: true, theme_id: theme.id })
  }
  req.session.flash = { type: 'success', message: startMessage }
  res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
})

// ──────────────────────────────────────────────────────────────
// GET /:id/certainty/ai-suggest/:themeId/status.json — 前端轮询
// ──────────────────────────────────────────────────────────────
router.get('/:id/certainty/ai-suggest/:themeId/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const t = db.prepare(
    `SELECT id, outcome_run_started_at, outcome_run_finished_at, outcome_run_status, outcome_run_error, outcome_run_meta
       FROM themes WHERE id = ? AND project_id = ?`
  ).get(req.params.themeId, project.id)
  if (!t) return res.status(404).json({ ok: false, error: 'theme_not_found' })
  const lockStarted = t.outcome_run_started_at
  const status = t.outcome_run_status
  const elapsedS = lockStarted
    ? Math.max(0, Math.floor((Date.now() - new Date(lockStarted + ' UTC').getTime()) / 1000))
    : 0
  const inFlight = !!(status === 'running' && lockStarted && elapsedS < 20 * 60)
  let meta = null
  try { meta = t.outcome_run_meta ? JSON.parse(t.outcome_run_meta) : null } catch {}
  let heartbeatAgoS = null, heartbeatAt = null
  if (meta?.last_heartbeat_at) {
    heartbeatAt = meta.last_heartbeat_at
    const hbMs = Date.parse(meta.last_heartbeat_at)
    if (isFinite(hbMs)) heartbeatAgoS = Math.max(0, Math.floor((Date.now() - hbMs) / 1000))
  }
  res.json({
    ok: true,
    in_flight: inFlight,
    started_at: lockStarted,
    finished_at: t.outcome_run_finished_at,
    status,
    error: t.outcome_run_error || null,
    elapsed_s: elapsedS,
    heartbeat_at: heartbeatAt,
    heartbeat_ago_s: heartbeatAgoS,
    meta,
  })
})

// ──────────────────────────────────────────────────────────────
// POST /:id/certainty/manual-add/:themeId — 人工新增空白 outcome
// ──────────────────────────────────────────────────────────────
router.post('/:id/certainty/manual-add/:themeId', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const theme = db
    .prepare('SELECT id FROM themes WHERE id = ? AND project_id = ?')
    .get(req.params.themeId, project.id)
  if (!theme) {
    req.session.flash = { type: 'error', message: '主题不存在' }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  const label = String(req.body.outcome_label || '').trim()
  if (!label) {
    req.session.flash = { type: 'error', message: '结局名称必填' }
    return res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
  }

  const id = randomId('grade')
  try {
    db.prepare(`
      INSERT INTO grade_assessments
        (id, project_id, theme_id, outcome_label, importance, starting_certainty, generated_by)
      VALUES (?, ?, ?, ?, 'critical', 'high', 'user')
    `).run(id, project.id, theme.id, label.slice(0, 200))
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      req.session.flash = { type: 'error', message: '该主题下已存在同名 outcome' }
    } else {
      req.session.flash = { type: 'error', message: '新增失败:' + e.message.slice(0, 100) }
    }
    return res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
  }

  audit(db, req, {
    eventType: 'grade_outcome_added',
    userId: req.user.id,
    projectId: project.id,
    payload: { theme_id: theme.id, outcome_label: label, assessment_id: id },
  })
  req.session.flash = { type: 'success', message: `已新增结局"${label}",请填写评估。` }
  res.redirect(`/projects/${project.id}/certainty#grade-${id}`)
})

// ──────────────────────────────────────────────────────────────
// POST /:id/certainty/:assessmentId/edit
// ──────────────────────────────────────────────────────────────
router.post('/:id/certainty/:assessmentId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const old = getAssessment(db, { projectId: project.id, assessmentId: req.params.assessmentId })
  if (!old) {
    req.session.flash = { type: 'error', message: '评估记录不存在' }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  const b = req.body || {}
  const pick = (allowed, v, fallback) => (allowed.includes(v) ? v : fallback)

  const next = {
    outcome_label:        String(b.outcome_label || old.outcome_label).trim().slice(0, 200),
    outcome_description:  String(b.outcome_description || '').trim().slice(0, 500) || null,
    importance:           pick(IMPORTANCE_ENUM, b.importance, old.importance),
    starting_certainty:   pick(CERTAINTY_LEVELS, b.starting_certainty, old.starting_certainty),
    risk_of_bias:         pick(DOWNGRADE_ENUM, b.risk_of_bias, old.risk_of_bias),
    inconsistency:        pick(DOWNGRADE_ENUM, b.inconsistency, old.inconsistency),
    indirectness:         pick(DOWNGRADE_ENUM, b.indirectness, old.indirectness),
    imprecision:          pick(DOWNGRADE_ENUM, b.imprecision, old.imprecision),
    publication_bias:     pick(PUB_BIAS_ENUM, b.publication_bias, old.publication_bias),
    large_effect:         pick(UPGRADE_LARGE_EFFECT_ENUM, b.large_effect, old.large_effect),
    dose_response:        b.dose_response ? 1 : 0,
    plausible_confounding: pick(UPGRADE_PLAUSIBLE_CONF_ENUM, b.plausible_confounding, old.plausible_confounding),
    summary_of_findings:  String(b.summary_of_findings || '').slice(0, 500) || null,
    effect_size_text:     String(b.effect_size_text || '').slice(0, 200) || null,
    num_studies:          b.num_studies ? parseInt(b.num_studies) || null : null,
    num_participants:     b.num_participants ? parseInt(b.num_participants) || null : null,
    rationales: {
      risk_of_bias:     String(b['rationales.risk_of_bias'] || old.rationales?.risk_of_bias || '').slice(0, 300),
      inconsistency:    String(b['rationales.inconsistency'] || old.rationales?.inconsistency || '').slice(0, 300),
      indirectness:     String(b['rationales.indirectness'] || old.rationales?.indirectness || '').slice(0, 300),
      imprecision:      String(b['rationales.imprecision'] || old.rationales?.imprecision || '').slice(0, 300),
      publication_bias: String(b['rationales.publication_bias'] || old.rationales?.publication_bias || '').slice(0, 300),
    },
  }

  db.prepare(`
    UPDATE grade_assessments SET
      outcome_label = ?, outcome_description = ?, importance = ?,
      starting_certainty = ?,
      risk_of_bias = ?, inconsistency = ?, indirectness = ?, imprecision = ?, publication_bias = ?,
      large_effect = ?, dose_response = ?, plausible_confounding = ?,
      summary_of_findings = ?, effect_size_text = ?, num_studies = ?, num_participants = ?,
      rationales = ?,
      generated_by = CASE WHEN generated_by = 'ai' THEN 'ai_edited' ELSE generated_by END,
      updated_at = datetime('now', '+8 hours')
    WHERE id = ? AND project_id = ?
  `).run(
    next.outcome_label,
    next.outcome_description,
    next.importance,
    next.starting_certainty,
    next.risk_of_bias,
    next.inconsistency,
    next.indirectness,
    next.imprecision,
    next.publication_bias,
    next.large_effect,
    next.dose_response,
    next.plausible_confounding,
    next.summary_of_findings,
    next.effect_size_text,
    next.num_studies,
    next.num_participants,
    JSON.stringify(next.rationales),
    req.params.assessmentId,
    project.id,
  )

  audit(db, req, {
    eventType: 'grade_edited',
    userId: req.user.id,
    projectId: project.id,
    payload: { assessment_id: req.params.assessmentId, outcome_label: next.outcome_label },
  })

  req.session.flash = { type: 'success', message: 'GRADE 评估已保存。' }
  res.redirect(`/projects/${project.id}/certainty#grade-${req.params.assessmentId}`)
})

// ──────────────────────────────────────────────────────────────
// POST /:id/certainty/:assessmentId/override
// ──────────────────────────────────────────────────────────────
router.post('/:id/certainty/:assessmentId/override', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const enable = req.body.override === '1' || req.body.override === 'on'
  const finalLevel = String(req.body.final_certainty || '').trim()
  if (enable && !CERTAINTY_LEVELS.includes(finalLevel)) {
    req.session.flash = { type: 'error', message: '请选择有效的最终等级' }
    return res.redirect(`/projects/${project.id}/certainty#grade-${req.params.assessmentId}`)
  }

  db.prepare(`
    UPDATE grade_assessments
    SET final_certainty = ?, final_manual_override = ?, updated_at = datetime('now', '+8 hours')
    WHERE id = ? AND project_id = ?
  `).run(enable ? finalLevel : null, enable ? 1 : 0, req.params.assessmentId, project.id)

  audit(db, req, {
    eventType: 'grade_override',
    userId: req.user.id,
    projectId: project.id,
    payload: { assessment_id: req.params.assessmentId, override: enable, final: enable ? finalLevel : null },
  })

  req.session.flash = { type: 'success', message: enable ? `已锁定最终等级 = ${finalLevel}` : '已取消人工锁定,改用自动计算。' }
  res.redirect(`/projects/${project.id}/certainty#grade-${req.params.assessmentId}`)
})

// ──────────────────────────────────────────────────────────────
// POST /:id/certainty/:assessmentId/delete
// ──────────────────────────────────────────────────────────────
router.post('/:id/certainty/:assessmentId/delete', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const r = db
    .prepare('DELETE FROM grade_assessments WHERE id = ? AND project_id = ?')
    .run(req.params.assessmentId, project.id)

  audit(db, req, {
    eventType: 'grade_deleted',
    userId: req.user.id,
    projectId: project.id,
    payload: { assessment_id: req.params.assessmentId, rows: r.changes },
  })

  req.session.flash = { type: 'success', message: '已删除该 outcome 评估。' }
  res.redirect(`/projects/${project.id}/certainty`)
})

// ──────────────────────────────────────────────────────────────
// GET /:id/certainty/sof.md
// ──────────────────────────────────────────────────────────────
router.get('/:id/certainty/sof.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const md = renderSoFMarkdown(db, project.id)
  audit(db, req, {
    eventType: 'grade_sof_exported',
    userId: req.user.id,
    projectId: project.id,
    payload: { bytes: md.length },
  })
  const fname = (project.title || 'project').replace(/[^a-zA-Z0-9-_]/g, '_')
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fname}-summary-of-findings.md"`)
  res.send(md || '## Summary of Findings\n\n_(暂无评估)_\n')
})

// ──────────────────────────────────────────────────────────────
// GET /:id/certainty/sof.csv
// ──────────────────────────────────────────────────────────────
router.get('/:id/certainty/sof.csv', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const rows = buildSoFRows(db, project.id)
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = []
  lines.push(['outcome', 'theme', 'importance', 'num_studies', 'num_participants', 'effect_size', 'certainty', 'summary'].join(','))
  for (const r of rows) {
    lines.push([r.outcome, r.theme, r.importance, r.num_studies, r.num_participants, r.effect_size, r.certainty, r.summary].map(esc).join(','))
  }
  audit(db, req, {
    eventType: 'grade_sof_exported_csv',
    userId: req.user.id,
    projectId: project.id,
    payload: { rows: rows.length },
  })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="summary-of-findings.csv"`)
  res.send('﻿' + lines.join('\n') + '\n')  // BOM for Excel
})

// ============================================================
// M30 主题级 rollup —— POST /:id/certainty/run-themes(异步,镜像 synthesis /run)
// ============================================================
router.post('/:id/certainty/run-themes', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) return res.status(kind === 'error' ? 400 : 200).json({ ok: kind !== 'error', message, ...(extra || {}) })
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  // 校验主题存在
  const themes = loadAllThemesWithMeta(db, project.id)
  if (!themes.length) {
    return flashOrJson('error', '该项目还没有主题(请先到 Step 6 生成主题聚类)')
  }

  // 取 include 论文(去 dup + post-RoB filter)— 跟 synthesis /run 同一 query
  let includedRecords = []
  try {
    includedRecords = db.prepare(
      `SELECT r.id, r.title, r.year, r.journal, r.authors_text, r.doi, r.abstract
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

  // 聚合 Step 1-6 数据
  //   M30+ 升级:高级用户(advanced_extraction_enabled)→ 加载 PDF chunks 给 matrix 稀疏 paper 兜底
  //   普通用户没 PDF 上传权限 → paper_chunks 也无数据,无影响
  const isAdvanced = !!(req.user?.advanced_extraction_enabled || req.user?.is_super_admin)
  const inputs = buildCertaintyInputs(db, project.id, includedRecords, { includePdfChunks: isAdvanced })
  if (!inputs.protocol) {
    return flashOrJson('error', '协议还没批复 / 先到 Step 1 审批')
  }
  if (!inputs.themes.length) {
    return flashOrJson('error', '没有主题可评(先到 Step 6 生成)')
  }

  const budget = tokenizeBudgetForCertainty(inputs)
  if (!budget.fitsSingleCall) {
    return flashOrJson('error', `主题 / 论文量过大(估 ${(budget.inputTokensEst / 1000).toFixed(0)}K tokens > 700K),Phase 2 才支持分批`)
  }

  // M30+ 上游指纹防重复跑(themes / overlay / matrix / RoB / 协议 任一变化都允许重跑)
  const force = req.body?.force === '1' || req.body?.force === 'on' || req.query?.force === '1'
  const fp = computeCertaintyUpstreamFingerprint(db, project.id)
  if (!force && project.certainty_run_status === 'success' && project.certainty_run_meta) {
    try {
      const prevMeta = JSON.parse(project.certainty_run_meta)
      if (prevMeta?.upstream_fingerprint === fp.fingerprint) {
        return flashOrJson('error',
          '上游数据(协议 / themes / matrix / RoB / overlay)自上次成功以来未变化 — 重跑会得到几乎相同结果。如需强制,加 force=1。',
          { error_code: 'upstream_unchanged', upstream_fingerprint: fp.fingerprint, parts: fp.parts })
      }
    } catch { /* ignore */ }
  }

  // 原子 lock(60 min stale,跟 timeout 留余量)
  const lockAcquired = db.prepare(
    `UPDATE projects
        SET certainty_run_started_at = datetime('now', '+8 hours'),
            certainty_run_finished_at = NULL,
            certainty_run_status = 'running',
            certainty_run_error = NULL,
            certainty_run_meta = NULL
      WHERE id = ?
        AND (certainty_run_status IS NULL
             OR certainty_run_status != 'running'
             OR certainty_run_started_at IS NULL
             OR certainty_run_started_at < datetime('now','-75 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    return flashOrJson('error', '另一次主题级 certainty 评估正在进行中(60 min 内),请等待或刷新页面查看进度', { error_code: 'in_flight' })
  }
  const upstreamFingerprint = fp.fingerprint
  const upstreamParts = fp.parts

  // Overlay
  const overlayObj = loadCertaintyOverlay(project)
  const overlayText = overlayObj && (overlayObj.overlay_text || overlayObj.text || '')

  // 构造 user prompt(M30+ 升级:加 formatPaperProfile 全画像 + final queries)
  const finalQueries = listFinalSearchQueries(db, project.id)
  const userPrompt = buildThemeRollupUserPrompt({
    protocol: inputs.protocol,
    themes: inputs.themes,
    papersByRid: inputs.papersByRid,
    evidenceByTheme: inputs.evidenceByTheme,
    synthesisMeta: inputs.synthesisMeta,
    finalQueries,
    formatPaperProfile,
    overlay: overlayText,
  })

  // 上下文捕获(不能在 setImmediate 闭包里访问 req)
  const projectId = project.id
  const userId = req.user.id
  const themeIds = new Set(inputs.themes.map((t) => t.id))
  const stats = inputs.stats

  const certAudit = (eventType, payload) => {
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
            SET certainty_run_status = ?,
                certainty_run_finished_at = datetime('now', '+8 hours'),
                certainty_run_error = ?,
                certainty_run_meta = ?
          WHERE id = ?`
      ).run(status, errorMessage ? String(errorMessage).slice(0, 500) : null,
            meta ? JSON.stringify(meta) : null, projectId)
    } catch (e) { console.error('[certainty/run-themes] finishRun update failed:', e) }
  }

  // 💓 Heartbeat — 每 30s 在 certainty_run_meta 写一次 last_heartbeat_at,
  //   证明后台 setImmediate 闭包还活着(LLM call 还在 await,没崩没卡死)
  //   前端 status.json 拿这个时间戳,UI 显示"💓 X 秒前更新"。
  //   设计权衡:不加 schema 列,完全用现有 meta JSON;finishRun 时会覆盖。
  const heartbeatStart = Date.now()
  const writeHeartbeat = () => {
    try {
      db.prepare(
        `UPDATE projects
            SET certainty_run_meta = ?
          WHERE id = ? AND certainty_run_status = 'running'`
      ).run(JSON.stringify({
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - heartbeatStart) / 1000),
        themes_count: themeIds.size,
        papers_count: stats.papers_n,
      }), projectId)
    } catch (e) { /* 失败不阻塞 */ }
  }
  // 立刻写一次,然后 30s 一次
  writeHeartbeat()
  const heartbeatInterval = setInterval(writeHeartbeat, 30_000)
  // finishRun 时清掉(JS unref 也行,这里显式 clear 更稳)
  const finishRunWithHb = (status, errorMessage, meta) => {
    clearInterval(heartbeatInterval)
    finishRun(status, errorMessage, meta)
  }

  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'certainty',
        projectId,
        system: CERTAINTY_THEME_LEVEL_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        maxTokens: 16000,
        timeoutMs: 3300_000,    // 55 min(冗余:input 1.3MB + ultrathink,完整 paper profile 比 synthesis 重)
      })
    } catch (e) {
      console.error('[certainty/run-themes BG] runLlm threw:', e)
      certAudit('certainty_run_failed', { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 300) })
      finishRunWithHb('failed', `runLlm 异常:${e?.message || e}`, null)
      return
    }

    if (!result.ok) {
      certAudit('certainty_run_failed', {
        status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId,
      })
      finishRunWithHb('failed', `${result.status} — ${result.error || ''}`, { usage_log_id: result.usageLogId, model: result.model })
      return
    }

    const parsed = parseThemeRollupOutput(result.data || null, { themeIds })
    // 英文输出抽检 warning(不 reject;LLM 偶尔守不住,但要留 audit + UI 可见)
    if (parsed.langWarning) {
      certAudit('certainty_run_lang_warning', { warning: parsed.langWarning, usage_log_id: result.usageLogId })
    }
    if (!parsed.ok || !parsed.themes.length) {
      certAudit('certainty_run_failed', {
        reason: result.data ? 'parse_empty' : 'json_parse_failed',
        errors: parsed.errors, model: result.model, usage_log_id: result.usageLogId,
      })
      if (result.data && result.usageLogId && result.text) {
        try {
          const sep = '\n<<<<<<<< SECTION_DIVIDER >>>>>>>>\n'
          const blob = [
            'meta:',
            '  reason=parse_empty_theme_rollup',
            `  parse_errors=${(parsed.errors || []).slice(0, 5).join(' | ')}`,
            `  raw_text_length=${result.text.length}`,
            sep,
            'RAW_TEXT_BEGIN',
            result.text.slice(0, 8000),
            'RAW_TEXT_END',
          ].join('\n')
          db.prepare(`UPDATE usage_logs SET status = 'parse_failed', error_message = ? WHERE id = ?`).run(blob, result.usageLogId)
        } catch {}
      }
      finishRunWithHb('failed', `LLM 输出没有有效主题评估(usage log #${result.usageLogId})`,
                { usage_log_id: result.usageLogId, model: result.model })
      return
    }

    // 写入 theme_certainty(累积式 — 同 theme 旧记录保留为旧 iteration_n,新写 iteration_n+1)
    // M31+:同时清除该项目所有 grade_assessments(outcome 级)— 因为评估前提变了,旧 outcome 失效
    //   用户语义:重跑主题级 = "评估基础刷新" → 旧的 outcome 应该一并丢,引导重新提议
    //   UI 文案在 confirm 里已经警告用户
    let clearedOutcomes = 0
    const writeTx = db.transaction(() => {
      const delRes = db.prepare(`DELETE FROM grade_assessments WHERE project_id = ?`).run(projectId)
      clearedOutcomes = delRes.changes || 0
      // 顺便清主题表的 outcome_run_meta(避免显示旧的"上次成功摘要")
      db.prepare(
        `UPDATE themes
            SET outcome_run_status = NULL,
                outcome_run_started_at = NULL,
                outcome_run_finished_at = NULL,
                outcome_run_error = NULL,
                outcome_run_meta = NULL
          WHERE project_id = ?`
      ).run(projectId)
      for (const ta of parsed.themes) {
        // 找 max iteration_n + 1
        const prev = db.prepare(
          `SELECT MAX(iteration_n) AS mx FROM theme_certainty WHERE project_id = ? AND theme_id = ?`
        ).get(projectId, ta.theme_id)
        const iter = (prev?.mx || 0) + 1
        db.prepare(
          `INSERT INTO theme_certainty
             (id, project_id, theme_id, grading_framework,
              grade_risk_of_bias, grade_inconsistency, grade_indirectness, grade_imprecision, grade_publication_bias,
              grade_large_effect, grade_dose_response, grade_plausible_confounding, grade_rationales,
              cerqual_methodological_limitations, cerqual_relevance, cerqual_coherence, cerqual_adequacy_of_data, cerqual_rationales,
              overall_certainty, body_of_evidence_summary, implications_for_practice, implications_for_research,
              generated_by, model_used, usage_log_id, iteration_n)
           VALUES (?, ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   'ai', ?, ?, ?)`
        ).run(
          randomId('tcr'),
          projectId,
          ta.theme_id,
          ta.grading_framework,
          ta.grade?.risk_of_bias || null,
          ta.grade?.inconsistency || null,
          ta.grade?.indirectness || null,
          ta.grade?.imprecision || null,
          ta.grade?.publication_bias || null,
          ta.grade?.large_effect || null,
          ta.grade?.dose_response || 0,
          ta.grade?.plausible_confounding || null,
          ta.grade ? JSON.stringify(ta.grade.rationales || {}) : null,
          ta.cerqual?.methodological_limitations || null,
          ta.cerqual?.relevance || null,
          ta.cerqual?.coherence || null,
          ta.cerqual?.adequacy_of_data || null,
          ta.cerqual ? JSON.stringify(ta.cerqual.rationales || {}) : null,
          ta.overall_certainty,
          ta.body_of_evidence_summary || null,
          ta.implications_for_practice || null,
          ta.implications_for_research || null,
          result.model,
          result.usageLogId || null,
          iter,
        )
      }
    })
    try {
      writeTx()
    } catch (e) {
      console.error('[certainty/run-themes BG] db write failed:', e)
      certAudit('certainty_run_failed', { reason: 'db_write_error', error: e.message?.slice(0, 200) })
      finishRunWithHb('failed', `入库失败:${(e.message || '').slice(0, 200)}`,
                { usage_log_id: result.usageLogId, model: result.model })
      return
    }

    const frameworkSplit = { grade: 0, cerqual: 0, hybrid: 0 }
    for (const t of parsed.themes) frameworkSplit[t.grading_framework] = (frameworkSplit[t.grading_framework] || 0) + 1

    certAudit('certainty_run_success', {
      themes_count: parsed.themes.length,
      papers_count: stats.papers_n,
      with_matrix: stats.with_matrix,
      with_rob: stats.with_rob,
      evidence_points_count: stats.evidence_n,
      framework_split: frameworkSplit,
      cross_theme_count: parsed.cross_theme_observations.length,
      model: result.model,
      duration_ms: result.durationMs,
      cleared_outcomes: clearedOutcomes,    // M31+:本次清的旧 outcome 数
    })
    finishRunWithHb('success', null, {
      themes_count: parsed.themes.length,
      papers_count: stats.papers_n,
      framework_split: frameworkSplit,
      model: result.model,
      duration_ms: result.durationMs,
      usage_log_id: result.usageLogId,
      upstream_fingerprint: upstreamFingerprint,
      upstream_parts: upstreamParts,
      lang_warning: parsed.langWarning || null,
      cleared_outcomes: clearedOutcomes,
    })
  })

  const startMessage = `已启动主题级 certainty 评估(Opus 4.8 + ultrathink, ~20-40 分钟)。${inputs.themes.length} 主题 · ${stats.papers_n} 论文 · framework split ${JSON.stringify(inputs.stats.framework_split)}。完成后页面会自动刷新,可以关闭页面。`
  if (wantsJson) {
    return res.json({ ok: true, message: startMessage, in_flight: true, started_at: new Date().toISOString() })
  }
  req.session.flash = { type: 'success', message: startMessage }
  res.redirect(`/projects/${project.id}/certainty`)
})

// ============================================================
// GET /:id/certainty/run/status.json
// ============================================================
router.get('/:id/certainty/run/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.certainty_run_started_at
  const status = project.certainty_run_status
  const elapsedS = lockStarted
    ? Math.max(0, Math.floor((Date.now() - new Date(lockStarted + ' UTC').getTime()) / 1000))
    : 0
  const inFlight = !!(status === 'running' && lockStarted && elapsedS < 60 * 60)
  let meta = null
  try { meta = project.certainty_run_meta ? JSON.parse(project.certainty_run_meta) : null } catch {}

  // 心跳:meta.last_heartbeat_at(setImmediate 后台每 30s 写一次)
  //   前端判:无心跳 OR 心跳停 > 90s → UI 显示 ⚠ 可能卡住
  let heartbeatAgoS = null
  let heartbeatAt = null
  if (meta?.last_heartbeat_at) {
    heartbeatAt = meta.last_heartbeat_at
    const hbMs = Date.parse(meta.last_heartbeat_at)
    if (isFinite(hbMs)) heartbeatAgoS = Math.max(0, Math.floor((Date.now() - hbMs) / 1000))
  }
  res.json({
    ok: true,
    in_flight: inFlight,
    started_at: lockStarted,
    finished_at: project.certainty_run_finished_at,
    status: status,
    error: project.certainty_run_error || null,
    elapsed_s: elapsedS,
    heartbeat_at: heartbeatAt,
    heartbeat_ago_s: heartbeatAgoS,
    meta,
  })
})

// ============================================================
// POST /:id/certainty/optimize-overlay — Opus 一次性生成项目专用 overlay
// ============================================================
router.post('/:id/certainty/optimize-overlay', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const protocol = loadApprovedProtocolFull(db, project.id)
  if (!protocol) {
    req.session.flash = { type: 'error', message: '协议还没批复' }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  // 协议版本门 + system_version 门
  //   只在"协议没升级 AND 通用 prompt 没升级"时拒绝
  //   任一升级 → 允许重生成
  const optimizedVer = project.certainty_master_prompt_at_version
  let existingOverlayObj = null
  try { existingOverlayObj = project.certainty_master_prompt_overlay ? JSON.parse(project.certainty_master_prompt_overlay) : null } catch {}
  const sameProtocol = (optimizedVer != null && protocol.version <= optimizedVer)
  const samePromptVersion = (existingOverlayObj?.system_version === CERTAINTY_SYSTEM_VERSION)
  if (sameProtocol && samePromptVersion) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: 'already_optimized', protocol_version: protocol.version, optimized_at_version: optimizedVer, system_version: CERTAINTY_SYSTEM_VERSION })
    }
    req.session.flash = { type: 'error', message: `已基于协议 v${optimizedVer} + 通用 prompt ${CERTAINTY_SYSTEM_VERSION} 生成 — 协议或通用 prompt 升级后才能重生成` }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  const lockAcquired = db.prepare(
    `UPDATE projects SET certainty_master_prompt_optimize_started_at = datetime('now', '+8 hours')
       WHERE id = ?
         AND (certainty_master_prompt_optimize_started_at IS NULL
              OR certainty_master_prompt_optimize_started_at < datetime('now','-15 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    if (req.get('X-Requested-With') === 'fetch') return res.status(409).json({ ok: false, error_code: 'in_flight' })
    req.session.flash = { type: 'error', message: '另一个 overlay 生成请求正在进行(15 min 内)' }
    return res.redirect(`/projects/${project.id}/certainty`)
  }

  const themes = loadAllThemesWithMeta(db, project.id)
  const synthesisMeta = loadSynthesisMetaForCertainty(db, project.id)

  // 取代表性 3-4 篇 include 论文样本(对照 synthesis overlay)
  let samplePapers = []
  try {
    const sampleRecords = db.prepare(
      `SELECT r.id, r.title, r.year, r.journal, r.authors_text
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
          AND r.rob_excluded_at IS NULL
        ORDER BY r.year DESC LIMIT 4`
    ).all(project.id)
    const isAdvanced = !!(req.user?.advanced_extraction_enabled || req.user?.is_super_admin)
    const inputs = buildCertaintyInputs(db, project.id, sampleRecords, { includePdfChunks: isAdvanced })
    samplePapers = (sampleRecords || []).map((r) => inputs.papersByRid?.get(r.id)).filter((p) => p && p.matrixData).slice(0, 4)
  } catch { /* ignore */ }

  const userPrompt = buildOptimizeCertaintyOverlayUserPrompt({ protocol, themes, synthesisMeta, samplePapers })

  // 后台跑(Opus + ultrathink ~5-8 min)
  setImmediate(async () => {
    const projectId = project.id
    const userId = req.user.id
    const ovAudit = (eventType, payload) => {
      try {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType, userId, projectId, payload,
        })
      } catch {}
    }
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'certainty_optimize_overlay',
        projectId,
        system: OPTIMIZE_CERTAINTY_OVERLAY_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        maxTokens: 8000,
        timeoutMs: 480_000,    // 8 min
      })
    } catch (e) {
      console.error('[certainty/optimize-overlay] runLlm threw:', e)
      try {
        db.prepare(`UPDATE projects SET certainty_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(projectId)
        ovAudit('certainty_optimize_overlay_failed', { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 200) })
      } catch {}
      return
    }

    if (!result.ok) {
      try {
        db.prepare(`UPDATE projects SET certainty_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(projectId)
        ovAudit('certainty_optimize_overlay_failed', { status: result.status, error: (result.error || '').slice(0, 200), model: result.model, usage_log_id: result.usageLogId })
      } catch {}
      return
    }

    const parsed = parseCertaintyOverlayOutput(result.data)
    if (!parsed.ok) {
      try {
        db.prepare(`UPDATE projects SET certainty_master_prompt_optimize_started_at = NULL WHERE id = ?`).run(projectId)
        ovAudit('certainty_optimize_overlay_failed', { reason: 'parse_failed', error: parsed.error, model: result.model, usage_log_id: result.usageLogId })
      } catch {}
      return
    }

    try {
      db.prepare(
        `UPDATE projects SET
            certainty_master_prompt_overlay = ?,
            certainty_master_prompt_at_version = ?,
            certainty_master_prompt_optimize_started_at = NULL,
            updated_at = datetime('now', '+8 hours')
          WHERE id = ?`
      ).run(
        JSON.stringify({ overlay_text: parsed.overlay_text, system_version: CERTAINTY_SYSTEM_VERSION }),
        protocol.version,
        projectId,
      )
      ovAudit('certainty_optimize_overlay_success', {
        overlay_chars: parsed.overlay_text.length, at_version: protocol.version,
        model: result.model, usage_log_id: result.usageLogId,
      })
    } catch (e) {
      console.error('[certainty/optimize-overlay] write failed:', e)
    }
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动 certainty overlay 生成,5-8 分钟' })
  }
  req.session.flash = { type: 'success', message: '已启动 certainty overlay 生成(Opus 4.8 + ultrathink, 5-8 分钟),完成后页面会刷新显示' }
  res.redirect(`/projects/${project.id}/certainty`)
})

// ============================================================
// GET /:id/certainty/optimize-overlay/status.json
// ============================================================
router.get('/:id/certainty/optimize-overlay/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.certainty_master_prompt_optimize_started_at
  const inFlight = !!(lockStarted && (Date.now() - new Date(lockStarted + ' UTC').getTime() < 15 * 60 * 1000))
  const hasFresh = !!(project.certainty_master_prompt_overlay && project.certainty_master_prompt_at_version)
  res.json({
    ok: true,
    in_flight: inFlight,
    has_fresh: hasFresh,
    at_version: project.certainty_master_prompt_at_version,
    started_at: lockStarted,
  })
})

// ============================================================
// 新导出:GRADE Evidence Profile + Summary Findings(主题级)
// ============================================================
function frameworkLabel(f) { return ({ grade: 'GRADE', cerqual: 'CERQual', hybrid: 'GRADE+CERQual' })[f] || f || '?' }

router.get('/:id/certainty/evidence-profile.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const themes = loadAllThemesWithMeta(db, project.id)
  const rows = loadAllThemeCertainty(db, project.id)
  const byTheme = indexLatestCertaintyByTheme(rows)

  const lines = []
  lines.push(`# GRADE Evidence Profile — ${project.title || ''}`)
  lines.push('')
  lines.push('| # | Theme | Framework | N papers | study_design_mix | rob_profile | GRADE: RoB / Incons / Indir / Imprec / PubBias | CERQual: MethLim / Rel / Coh / Adeq | Overall Certainty |')
  lines.push('|---|-------|-----------|----------|------------------|-------------|-----------------------------------------------|-------------------------------------|-------------------|')
  themes.forEach((t, i) => {
    const tc = byTheme.get(t.id)
    const gradeCells = tc?.grading_framework === 'grade' || tc?.grading_framework === 'hybrid'
      ? `${tc.grade_risk_of_bias || '—'} / ${tc.grade_inconsistency || '—'} / ${tc.grade_indirectness || '—'} / ${tc.grade_imprecision || '—'} / ${tc.grade_publication_bias || '—'}`
      : '—'
    const cerCells = tc?.grading_framework === 'cerqual' || tc?.grading_framework === 'hybrid'
      ? `${tc.cerqual_methodological_limitations || '—'} / ${tc.cerqual_relevance || '—'} / ${tc.cerqual_coherence || '—'} / ${tc.cerqual_adequacy_of_data || '—'}`
      : '—'
    lines.push(`| ${i + 1} | ${(t.name || '').replace(/\|/g, '\\|').slice(0, 80)} | ${frameworkLabel(tc?.grading_framework || t.grading_framework)} | ${(t.supporting_record_ids || []).length} | ${JSON.stringify(t.study_design_mix || {})} | ${JSON.stringify(t.rob_profile || {})} | ${gradeCells} | ${cerCells} | **${tc?.overall_certainty || '—'}** |`)
  })
  lines.push('')
  lines.push('## Per-theme rationales')
  lines.push('')
  themes.forEach((t, i) => {
    const tc = byTheme.get(t.id)
    lines.push(`### Theme ${i + 1}: ${t.name}`)
    lines.push(`- Framework: ${frameworkLabel(tc?.grading_framework || t.grading_framework)}`)
    lines.push(`- Overall certainty: **${tc?.overall_certainty || 'not assessed'}**`)
    if (tc?.grade_rationales) {
      let g = tc.grade_rationales
      if (typeof g === 'string') try { g = JSON.parse(g) } catch { g = {} }
      lines.push('- GRADE rationales:')
      if (g?.risk_of_bias)     lines.push(`  - Risk of bias: ${g.risk_of_bias}`)
      if (g?.inconsistency)    lines.push(`  - Inconsistency: ${g.inconsistency}`)
      if (g?.indirectness)     lines.push(`  - Indirectness: ${g.indirectness}`)
      if (g?.imprecision)      lines.push(`  - Imprecision: ${g.imprecision}`)
      if (g?.publication_bias) lines.push(`  - Publication bias: ${g.publication_bias}`)
    }
    if (tc?.cerqual_rationales) {
      let c = tc.cerqual_rationales
      if (typeof c === 'string') try { c = JSON.parse(c) } catch { c = {} }
      lines.push('- CERQual rationales:')
      if (c?.methodological_limitations) lines.push(`  - Methodological limitations: ${c.methodological_limitations}`)
      if (c?.relevance)                  lines.push(`  - Relevance: ${c.relevance}`)
      if (c?.coherence)                  lines.push(`  - Coherence: ${c.coherence}`)
      if (c?.adequacy_of_data)           lines.push(`  - Adequacy of data: ${c.adequacy_of_data}`)
    }
    lines.push('')
  })

  audit(db, req, { eventType: 'certainty_evidence_profile_exported', userId: req.user.id, projectId: project.id, payload: { themes: themes.length } })
  const fname = (project.title || 'project').replace(/[^a-zA-Z0-9-_]/g, '_')
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fname}-evidence-profile.md"`)
  res.send(lines.join('\n') + '\n')
})

router.get('/:id/certainty/evidence-profile.csv', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const themes = loadAllThemesWithMeta(db, project.id)
  const rows = loadAllThemeCertainty(db, project.id)
  const byTheme = indexLatestCertaintyByTheme(rows)
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

  const out = []
  out.push([
    'theme_idx','theme_name','framework','n_papers','study_design_mix','rob_profile',
    'grade_rob','grade_incons','grade_indir','grade_imprec','grade_pubbias','grade_large_effect','grade_dose_resp','grade_plaus_conf',
    'cerqual_methlim','cerqual_relevance','cerqual_coherence','cerqual_adequacy',
    'overall_certainty','body_of_evidence_summary','implications_for_practice','implications_for_research'
  ].join(','))
  themes.forEach((t, i) => {
    const tc = byTheme.get(t.id) || {}
    out.push([
      i + 1, t.name, frameworkLabel(tc.grading_framework || t.grading_framework),
      (t.supporting_record_ids || []).length, JSON.stringify(t.study_design_mix || {}), JSON.stringify(t.rob_profile || {}),
      tc.grade_risk_of_bias, tc.grade_inconsistency, tc.grade_indirectness, tc.grade_imprecision, tc.grade_publication_bias,
      tc.grade_large_effect, tc.grade_dose_response, tc.grade_plausible_confounding,
      tc.cerqual_methodological_limitations, tc.cerqual_relevance, tc.cerqual_coherence, tc.cerqual_adequacy_of_data,
      tc.overall_certainty, tc.body_of_evidence_summary, tc.implications_for_practice, tc.implications_for_research,
    ].map(esc).join(','))
  })
  audit(db, req, { eventType: 'certainty_evidence_profile_exported_csv', userId: req.user.id, projectId: project.id, payload: { rows: themes.length } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="evidence-profile.csv"`)
  res.send('﻿' + out.join('\n') + '\n')
})

router.get('/:id/certainty/summary-findings.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const themes = loadAllThemesWithMeta(db, project.id)
  const rows = loadAllThemeCertainty(db, project.id)
  const byTheme = indexLatestCertaintyByTheme(rows)

  const lines = []
  lines.push(`# Summary of Findings — ${project.title || ''}`)
  lines.push('')
  lines.push('_(Per-theme body-of-evidence narrative + practice / research implications. Paste directly into Discussion / Conclusion.)_')
  lines.push('')
  themes.forEach((t, i) => {
    const tc = byTheme.get(t.id)
    lines.push(`## Theme ${i + 1}: ${t.name}`)
    lines.push(`- **Framework**: ${frameworkLabel(tc?.grading_framework || t.grading_framework)}`)
    lines.push(`- **Overall certainty**: **${tc?.overall_certainty || 'not assessed'}**`)
    lines.push(`- **N supporting papers**: ${(t.supporting_record_ids || []).length}`)
    if (tc?.body_of_evidence_summary) {
      lines.push('')
      lines.push('### Body of evidence')
      lines.push(tc.body_of_evidence_summary)
    }
    if (tc?.implications_for_practice) {
      lines.push('')
      lines.push('### Implications for practice')
      lines.push(tc.implications_for_practice)
    }
    if (tc?.implications_for_research) {
      lines.push('')
      lines.push('### Implications for research')
      lines.push(tc.implications_for_research)
    }
    lines.push('')
  })
  audit(db, req, { eventType: 'certainty_summary_findings_exported', userId: req.user.id, projectId: project.id, payload: { themes: themes.length } })
  const fname = (project.title || 'project').replace(/[^a-zA-Z0-9-_]/g, '_')
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fname}-summary-findings.md"`)
  res.send(lines.join('\n') + '\n')
})

export default router
