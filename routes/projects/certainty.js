/**
 * Step 7 · 证据强度(Certainty)— GRADE 详细评估
 *
 * 路由:
 *   GET  /:id/certainty                          — 主页:所有 theme + GRADE outcomes 列表
 *   POST /:id/certainty/ai-suggest/:themeId      — 调 LLM 给 theme 提议 1..3 个 outcome 评估
 *   POST /:id/certainty/manual-add/:themeId      — 人工新增空白 outcome
 *   POST /:id/certainty/:assessmentId/edit       — 编辑某条 outcome 评估(domain / rationale / SoF)
 *   POST /:id/certainty/:assessmentId/override   — 切换/设置最终 certainty 的人工 override
 *   POST /:id/certainty/:assessmentId/delete     — 删除一条 outcome
 *   GET  /:id/certainty/sof.md                   — 导出 Summary of Findings 表(Markdown)
 *   GET  /:id/certainty/sof.csv                  — 导出 SoF(CSV,供 Excel)
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import {
  GRADE_SYSTEM,
  buildGradeUserPrompt,
  normalizeGradeOutput,
} from '../../services/prompts/grade.js'
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
// GET /:id/certainty
// ──────────────────────────────────────────────────────────────
router.get('/:id/certainty', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const themes = loadThemesForProject(db, project.id)
  const assessments = listAssessmentsForProject(db, project.id)
  const assessmentsByTheme = {}
  for (const a of assessments) {
    if (!assessmentsByTheme[a.theme_id]) assessmentsByTheme[a.theme_id] = []
    assessmentsByTheme[a.theme_id].push(a)
  }

  const progress = getProjectProgress(db, project.id)
  const stepItems = getChecklistItems(db, project.id).filter((c) => c.workflow_step === 'certainty')

  res.render('projects/certainty', {
    title: project.title + ' · 证据强度',
    project,
    themes,
    assessments,
    assessmentsByTheme,
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
router.post('/:id/certainty/ai-suggest/:themeId', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: '项目不存在', message: '' })

  const theme = db
    .prepare('SELECT * FROM themes WHERE id = ? AND project_id = ?')
    .get(req.params.themeId, project.id)
  if (!theme) {
    req.session.flash = { type: 'error', message: '主题不存在' }
    return res.redirect(`/projects/${project.id}/certainty`)
  }
  theme.consistent_findings  = tryParseArr(theme.consistent_findings)
  theme.conflicting_findings = tryParseArr(theme.conflicting_findings)
  theme.evidence_gaps        = tryParseArr(theme.evidence_gaps)

  // 拉 evidence_points + 关联 records 摘要
  const evidencePoints = db
    .prepare(`
      SELECT record_id, finding, evidence_type, strength
      FROM evidence_points
      WHERE project_id = ? AND theme_id = ?
      LIMIT 50
    `)
    .all(project.id, theme.id)

  const recordIds = [...new Set(evidencePoints.map((e) => e.record_id))]
  let recordSummaries = []
  if (recordIds.length) {
    const placeholders = recordIds.map(() => '?').join(',')
    recordSummaries = db
      .prepare(`
        SELECT r.id, r.title, r.year,
               json_extract(e.extracted_json, '$.study_characteristics.study_type') AS study_type,
               json_extract(e.extracted_json, '$.study_characteristics.sample_size') AS sample_size
        FROM records r
        LEFT JOIN extractions e ON e.record_id = r.id
        WHERE r.id IN (${placeholders})
      `)
      .all(...recordIds)
  }

  const userPrompt = buildGradeUserPrompt({ theme, evidencePoints, recordSummaries })

  const result = await runLlm(db, {
    userId: req.user.id,
    actionType: 'certainty',
    projectId: project.id,
    system: GRADE_SYSTEM,
    prompt: userPrompt,
    expectJson: true,
    model: 'heavy',
    maxTokens: 6144,
    timeoutMs: 360_000,
  })

  if (!result.ok) {
    audit(db, req, {
      eventType: 'grade_ai_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { theme_id: theme.id, error: result.error, status: result.status },
    })
    req.session.flash = { type: 'error', message: `AI 评估失败:${result.status} — ${result.error || ''}`.slice(0, 240) }
    return res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
  }

  const outcomes = normalizeGradeOutput(result.data)
  if (outcomes.length === 0) {
    audit(db, req, {
      eventType: 'grade_ai_empty',
      userId: req.user.id,
      projectId: project.id,
      payload: { theme_id: theme.id, usage_log_id: result.usageLogId },
    })
    req.session.flash = { type: 'error', message: `LLM 返回空 / 无法解析,详见 usage log #${result.usageLogId}` }
    return res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
  }

  // 逐条 INSERT
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
      updated_at = datetime('now')
  `)
  const tx = db.transaction(() => {
    for (const o of outcomes) {
      insert.run(
        randomId('grade'),
        project.id,
        theme.id,
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

  audit(db, req, {
    eventType: 'grade_ai_assessed',
    userId: req.user.id,
    projectId: project.id,
    payload: { theme_id: theme.id, outcomes_count: outcomes.length, model: result.model, duration_ms: result.durationMs },
  })

  req.session.flash = { type: 'success', message: `AI 已为主题"${theme.name}"生成 ${outcomes.length} 个 outcome 评估,请审阅。` }
  res.redirect(`/projects/${project.id}/certainty#theme-${theme.id}`)
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
      updated_at = datetime('now')
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
    SET final_certainty = ?, final_manual_override = ?, updated_at = datetime('now')
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

export default router
