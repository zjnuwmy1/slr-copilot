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
  buildSynthesisUserPrompt,
  normalizeSynthesisOutput,
} from '../../services/prompts/synthesis.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'

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
  return {
    ...row,
    supporting_record_ids: parseJsonArrayField(row.supporting_record_ids),
    consistent_findings: parseJsonArrayField(row.consistent_findings),
    conflicting_findings: parseJsonArrayField(row.conflicting_findings),
    evidence_gaps: parseJsonArrayField(row.evidence_gaps),
  }
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
  // 简化:用所有有 extractions 的 records,或 screening include 的 records
  let recordsForMatrix = []
  try {
    recordsForMatrix = db.prepare(`
      SELECT DISTINCT r.id, r.title, r.year, r.authors_text
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
      WHERE r.project_id = ?
        AND (e.human_verified = 1 OR sd.human_decision = 'include')
      ORDER BY r.year DESC, r.title ASC
    `).all(project.id)
  } catch {
    recordsForMatrix = []
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
  })
})

// ============================================================
// POST /:id/synthesis/run  — 跑 LLM 聚类
// ============================================================
router.post('/:id/synthesis/run', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const verified = listVerifiedExtractions(db, project.id)
  if (verified.length < MIN_VERIFIED_EXTRACTIONS) {
    req.session.flash = {
      type: 'error',
      message: `需要至少 ${MIN_VERIFIED_EXTRACTIONS} 篇已人工核实的抽取,当前只有 ${verified.length} 篇。请先去"抽取"步骤完成核实。`,
    }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // 准备 LLM 输入
  const protocol = getApprovedProtocol(db, project.id)
  const researchQuestions = protocol?.research_questions || []

  const extractionsForPrompt = verified.map((row) => {
    let extraction = null
    try {
      extraction = row.extracted_json ? JSON.parse(row.extracted_json) : null
    } catch {
      extraction = null
    }
    return {
      record_id: row.record_id,
      title: row.title,
      year: row.year,
      authors_text: row.authors_text,
      extraction,
    }
  }).filter((x) => x.extraction)  // 没解析出 extraction 的跳过

  if (extractionsForPrompt.length < MIN_VERIFIED_EXTRACTIONS) {
    req.session.flash = {
      type: 'error',
      message: `有 ${verified.length - extractionsForPrompt.length} 条 extraction JSON 解析失败,可解析的只有 ${extractionsForPrompt.length} 条,不足 ${MIN_VERIFIED_EXTRACTIONS}。`,
    }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  const userPrompt = buildSynthesisUserPrompt({
    researchQuestions,
    extractions: extractionsForPrompt,
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'synthesis',
      projectId: project.id,
      system: SYNTHESIS_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 12288,
      timeoutMs: 600_000,
    })
  } catch (e) {
    console.error('[synthesis/run] runLlm threw:', e)
    req.session.flash = {
      type: 'error',
      message: `聚类失败:${(e?.message || String(e)).slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  if (!result.ok) {
    audit(db, req, {
      eventType: 'synthesis_run_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId },
    })
    req.session.flash = {
      type: 'error',
      message: `聚类失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
    }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  const knownRecordIds = new Set(extractionsForPrompt.map((e) => e.record_id))
  const normalized = normalizeSynthesisOutput(result.data || null, { knownRecordIds })

  if (!normalized.themes.length) {
    // 标 parse_failed:llm.js 已写 raw text;补一条 audit
    audit(db, req, {
      eventType: 'synthesis_run_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        reason: result.data ? 'normalize_empty' : 'json_parse_failed',
        model: result.model,
        usage_log_id: result.usageLogId,
      },
    })
    if (result.data && result.usageLogId && result.text) {
      try {
        const sep = '\n<<<<<<<< SECTION_DIVIDER >>>>>>>>\n'
        const blob = [
          'meta:',
          '  reason=normalize_empty',
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
    req.session.flash = {
      type: 'error',
      message: `LLM 输出没有主题(usage log #${result.usageLogId})。请去 /admin/usage 查看原文,调整后重试。`,
    }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  // 入库:替换式 — 删旧 themes + evidence_points,写新的
  const writeTx = db.transaction(() => {
    db.prepare(`DELETE FROM evidence_points WHERE project_id = ?`).run(project.id)
    db.prepare(`DELETE FROM themes WHERE project_id = ?`).run(project.id)

    normalized.themes.forEach((t, idx) => {
      const themeId = randomId('theme')
      db.prepare(
        `INSERT INTO themes
           (id, project_id, name, description, supporting_record_ids,
            consistent_findings, conflicting_findings, evidence_gaps,
            evidence_strength, generated_by, model, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`
      ).run(
        themeId,
        project.id,
        t.name,
        t.description || null,
        JSON.stringify(t.supporting_record_ids),
        JSON.stringify(t.consistent_findings),
        JSON.stringify(t.conflicting_findings),
        JSON.stringify(t.evidence_gaps),
        t.evidence_strength,
        result.model,
        idx,
      )

      // 把 consistent_findings 作为初始 evidence_points 写入(每个 finding × 每个 supporting record)
      // 注意:这是粗略映射,真实场景下用户可以人工细化。
      for (const finding of t.consistent_findings) {
        for (const rid of t.supporting_record_ids) {
          const epId = randomId('ep')
          db.prepare(
            `INSERT INTO evidence_points
               (id, project_id, record_id, theme_id, finding, evidence_type, strength)
             VALUES (?, ?, ?, ?, ?, 'empirical', ?)`
          ).run(epId, project.id, rid, themeId, finding, t.evidence_strength)
        }
      }
    })

    // 项目状态推进
    db.prepare(`UPDATE projects SET status = 'synthesizing', updated_at = datetime('now') WHERE id = ?`).run(project.id)
  })

  try {
    writeTx()
  } catch (e) {
    console.error('[synthesis/run] db write failed:', e)
    audit(db, req, {
      eventType: 'synthesis_run_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { reason: 'db_write_error', error: e.message?.slice(0, 200) },
    })
    req.session.flash = { type: 'error', message: `入库失败:${(e.message || '').slice(0, 200)}` }
    return res.redirect(`/projects/${project.id}/synthesis`)
  }

  audit(db, req, {
    eventType: 'synthesis_run_success',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      themes_count: normalized.themes.length,
      model: result.model,
      duration_ms: result.durationMs,
    },
  })

  req.session.flash = {
    type: 'success',
    message: `聚类完成:${normalized.themes.length} 个主题(${result.model}, ${result.durationMs}ms)`,
  }
  res.redirect(`/projects/${project.id}/synthesis`)
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
     SET name = ?, description = ?, evidence_strength = ?, updated_at = datetime('now')
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
