/**
 * Phase 6 Agent O — 综述初稿编辑器(章节起草 + PRISMA flow + 整文导出)
 *
 * 挂载点(由 routes/projects/index.js 中转挂载):
 *   projectsRouter.use('/', reportRouter)   // 内部 path: /:id/report/*
 *
 * 路由清单:
 *   GET  /:id/report                            综述编辑器页(PRISMA flow + 9 section 卡片)
 *   POST /:id/report/generate-section           跑 LLM 写单个章节 → 写 draft_sections
 *   POST /:id/report/generate-all               顺序跑全部章节(后台,setImmediate)
 *   POST /:id/report/section/:sectionId/edit    人工编辑某章节
 *   GET  /:id/report/progress.json              全章节生成进度
 *   GET  /:id/report/export.md                  完整 Markdown 导出
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import { exportReferencesSection } from '../../services/reference-export.js'
import {
  getSectionSystem,
  SECTION_ORDER,
  SECTION_LABELS,
  buildSectionUserPrompt,
  normalizeSectionOutput,
} from '../../services/prompts/drafting.js'
import {
  computePrismaFlow,
  renderPrismaMermaid,
  renderPrismaTextSummary,
} from '../../services/prisma-flow.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

// 当前 generate-all 后台任务状态(内存,进程重启后丢失,只用于 UI 进度展示)
// 不放 DB 以免和并发其他写入打架。
const inFlightJobs = new Map()  // projectId → { startedAt, completed: [section], current: section|null, errors: [{section,msg}], done: bool }

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
  if (!row) return null
  return {
    ...row,
    research_questions: parseJsonArrayField(row.research_questions),
    inclusion_criteria: parseJsonArrayField(row.inclusion_criteria),
    exclusion_criteria: parseJsonArrayField(row.exclusion_criteria),
  }
}

function listThemes(db, projectId) {
  const rows = db
    .prepare(
      `SELECT * FROM themes
       WHERE project_id = ?
       ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    )
    .all(projectId)
  return rows.map((row) => ({
    ...row,
    supporting_record_ids: parseJsonArrayField(row.supporting_record_ids),
    consistent_findings: parseJsonArrayField(row.consistent_findings),
    conflicting_findings: parseJsonArrayField(row.conflicting_findings),
    evidence_gaps: parseJsonArrayField(row.evidence_gaps),
  }))
}

function listEvidencePoints(db, projectId) {
  return db
    .prepare(
      `SELECT id, record_id, theme_id, finding, evidence_type, strength, section, page
       FROM evidence_points WHERE project_id = ? ORDER BY created_at ASC`
    )
    .all(projectId)
}

function listSearchStrategies(db, projectId) {
  return db
    .prepare(
      `SELECT id, database_name, query_type, query_text, result_count, version
       FROM search_strategies
       WHERE project_id = ?
       ORDER BY version DESC, database_name ASC, query_type ASC`
    )
    .all(projectId)
}

function listIncludedRecords(db, projectId) {
  // 用于:1) References 章节;2) citation_map 校验集合;3) prompt 里的"可引用论文列表"
  try {
    return db.prepare(`
      SELECT DISTINCT r.*
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
      WHERE r.project_id = ?
        AND (e.human_verified = 1 OR sd.human_decision = 'include')
      ORDER BY r.year DESC, r.title ASC
    `).all(projectId)
  } catch {
    return []
  }
}

function shortRecordLabel(r) {
  const first = (() => {
    try {
      const arr = JSON.parse(r.authors_json || '[]')
      if (Array.isArray(arr) && arr.length) {
        return arr[0].surname || arr[0].family || arr[0].full || ''
      }
    } catch {}
    if (r.authors_text) return r.authors_text.split(/[,;]/)[0].trim()
    return ''
  })()
  return `${first || '?'} ${r.year || 'n.d.'} — ${(r.title || '').slice(0, 80)}`
}

/**
 * 列出 draft_sections 的最新版(每个 section_name 一行)。
 */
function listLatestSections(db, projectId) {
  const rows = db.prepare(`
    SELECT ds.*
    FROM draft_sections ds
    JOIN (
      SELECT section_name, MAX(version) AS max_v
      FROM draft_sections
      WHERE project_id = ?
      GROUP BY section_name
    ) m ON m.section_name = ds.section_name AND m.max_v = ds.version
    WHERE ds.project_id = ?
  `).all(projectId, projectId)
  const map = {}
  for (const r of rows) {
    map[r.section_name] = {
      ...r,
      citation_map: parseJsonArrayField(r.citation_map),
    }
  }
  return map
}

function getMaxSectionVersion(db, projectId, sectionName) {
  const r = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM draft_sections WHERE project_id = ? AND section_name = ?`
  ).get(projectId, sectionName)
  return r?.v || 0
}

// ============================================================
// GET /:id/report
// ============================================================
router.get('/:id/report', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const prismaCounts = computePrismaFlow(db, project.id)
  const mermaid = renderPrismaMermaid(prismaCounts)
  const themes = listThemes(db, project.id)
  const sections = listLatestSections(db, project.id)
  const job = inFlightJobs.get(project.id) || null

  const progress = (() => { try { return getProjectProgress(db, project.id) } catch { return null } })()
  const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'report')

  // 9 个 section 卡片(包含 references)
  const sectionList = [...SECTION_ORDER, 'references'].map((s) => {
    const row = sections[s] || null
    return {
      section_name: s,
      label: SECTION_LABELS[s] || s,
      has_content: !!(row && row.content_markdown),
      content_preview: row && row.content_markdown ? row.content_markdown.slice(0, 200) : '',
      content_markdown: row?.content_markdown || '',
      version: row?.version || 0,
      user_edited: !!row?.user_edited,
      citation_count: row?.citation_map?.length || 0,
      updated_at: row?.updated_at || null,
      section_id: row?.id || null,
    }
  })

  res.render('projects/report', {
    title: `综述初稿 · ${project.title}`,
    project,
    progress,
    currentStep: 'report',
    stepLabel: '8. 报告(Report)',
    stepItems,
    prismaCounts,
    prismaMermaid: mermaid,
    themes,
    sections,
    sectionList,
    job,
  })
})

// ============================================================
// POST /:id/report/generate-section
// ============================================================
router.post('/:id/report/generate-section', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const section = String(req.body.section || '').trim()
  if (!SECTION_ORDER.includes(section) && section !== 'references') {
    req.session.flash = { type: 'error', message: `未知章节: ${section}` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // References 章节走非 LLM 路径
  if (section === 'references') {
    const included = listIncludedRecords(db, project.id)
    const md = exportReferencesSection(included, { style: 'apa' })
    persistSection(db, project.id, 'references', md, [], null, 'apa')
    audit(db, req, {
      eventType: 'report_section_generated',
      userId: req.user.id,
      projectId: project.id,
      payload: { section: 'references', record_count: included.length, source: 'reference-export' },
    })
    req.session.flash = { type: 'success', message: `References 章节已生成(${included.length} 篇,APA 风格)` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const result = await generateSectionLlm(db, { project, userId: req.user.id, section })
  if (result.ok) {
    audit(db, req, {
      eventType: 'report_section_generated',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        section,
        model: result.model,
        duration_ms: result.durationMs,
        citation_count: result.citationMapCount,
        citation_issues: result.citationIssues.slice(0, 5),
      },
    })
    req.session.flash = {
      type: 'success',
      message: `${SECTION_LABELS[section]} 已生成(${result.model}, ${result.durationMs}ms${result.citationIssues.length ? `, ${result.citationIssues.length} 条引用警告` : ''})`,
    }
  } else {
    audit(db, req, {
      eventType: 'report_section_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { section, status: result.status, error: (result.error || '').slice(0, 300) },
    })
    req.session.flash = {
      type: 'error',
      message: `${SECTION_LABELS[section]} 生成失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
    }
  }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// POST /:id/report/generate-all  — 顺序后台跑全部章节
// ============================================================
router.post('/:id/report/generate-all', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const existing = inFlightJobs.get(project.id)
  if (existing && !existing.done) {
    req.session.flash = { type: 'error', message: '已有正在进行的全文生成任务,请等其完成' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const job = {
    startedAt: new Date().toISOString(),
    sections: [...SECTION_ORDER, 'references'],
    completed: [],
    current: null,
    errors: [],
    done: false,
  }
  inFlightJobs.set(project.id, job)

  // 把 req.user.id 拷出来,后台没 req 上下文
  const userId = req.user.id

  setImmediate(async () => {
    try {
      for (const section of job.sections) {
        job.current = section
        if (section === 'references') {
          try {
            const included = listIncludedRecords(db, project.id)
            const md = exportReferencesSection(included, { style: 'apa' })
            persistSection(db, project.id, 'references', md, [], null, 'apa')
            job.completed.push(section)
          } catch (e) {
            job.errors.push({ section, msg: e.message || String(e) })
          }
          continue
        }

        try {
          const r = await generateSectionLlm(db, { project, userId, section })
          if (r.ok) {
            job.completed.push(section)
          } else {
            job.errors.push({ section, msg: `${r.status}: ${(r.error || '').slice(0, 200)}` })
          }
        } catch (e) {
          job.errors.push({ section, msg: e.message || String(e) })
        }
      }
    } finally {
      job.current = null
      job.done = true
      job.finishedAt = new Date().toISOString()
      audit(db, null, {
        eventType: 'report_generate_all_done',
        userId,
        projectId: project.id,
        payload: {
          completed: job.completed.length,
          errors: job.errors.length,
          error_sections: job.errors.map((e) => e.section),
        },
      })
    }
  })

  audit(db, req, {
    eventType: 'report_generate_all_started',
    userId: req.user.id,
    projectId: project.id,
    payload: { sections: job.sections },
  })
  req.session.flash = { type: 'success', message: '已开始顺序生成全部章节,可在本页轮询进度。' }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// POST /:id/report/section/:sectionId/edit
// ============================================================
router.post('/:id/report/section/:sectionId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const row = db.prepare(
    `SELECT * FROM draft_sections WHERE id = ? AND project_id = ?`
  ).get(req.params.sectionId, project.id)
  if (!row) {
    req.session.flash = { type: 'error', message: '章节不存在' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const content = String(req.body.content_markdown || '').trim()
  if (!content) {
    req.session.flash = { type: 'error', message: '内容不能为空' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 新建一个 version,而不是原地改
  const version = getMaxSectionVersion(db, project.id, row.section_name) + 1
  const newId = randomId('ds')
  db.prepare(
    `INSERT INTO draft_sections
       (id, project_id, section_name, content_markdown, citation_map, model, prompt_version, user_edited, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    newId,
    project.id,
    row.section_name,
    content,
    row.citation_map || '[]',
    row.model,
    row.prompt_version,
    version,
  )
  audit(db, req, {
    eventType: 'report_section_edited',
    userId: req.user.id,
    projectId: project.id,
    payload: { section: row.section_name, from_version: row.version, to_version: version },
  })
  req.session.flash = { type: 'success', message: `${SECTION_LABELS[row.section_name] || row.section_name} 已保存(v${version})` }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// GET /:id/report/progress.json
// ============================================================
router.get('/:id/report/progress.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })

  const job = inFlightJobs.get(project.id) || null
  const sections = listLatestSections(db, project.id)
  const status = {}
  for (const s of [...SECTION_ORDER, 'references']) {
    status[s] = {
      has_content: !!(sections[s] && sections[s].content_markdown),
      version: sections[s]?.version || 0,
      user_edited: !!sections[s]?.user_edited,
      updated_at: sections[s]?.updated_at || null,
    }
  }

  res.json({
    job,
    sections: status,
  })
})

// ============================================================
// GET /:id/report/export.md  — 完整 Markdown 导出
// ============================================================
router.get('/:id/report/export.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const prismaCounts = computePrismaFlow(db, project.id)
  const sections = listLatestSections(db, project.id)
  const included = listIncludedRecords(db, project.id)

  const parts = []
  parts.push(`<!-- Generated by SLR Copilot — ${new Date().toISOString()} -->`)
  parts.push(`<!-- Project: ${project.title} (${project.id}) -->`)
  parts.push('')

  // Title
  if (sections.title?.content_markdown) {
    parts.push(sections.title.content_markdown)
  } else {
    parts.push(`# ${project.title}`)
  }
  parts.push('')

  // Abstract
  if (sections.abstract?.content_markdown) {
    parts.push(sections.abstract.content_markdown)
    parts.push('')
  }

  // Introduction
  if (sections.introduction?.content_markdown) {
    parts.push(sections.introduction.content_markdown)
    parts.push('')
  }

  // Methods + PRISMA flow
  if (sections.methods?.content_markdown) {
    parts.push(sections.methods.content_markdown)
    parts.push('')
  }
  // PRISMA flow:Mermaid 块 + 文字表
  parts.push('### PRISMA Flow Diagram')
  parts.push('')
  parts.push('```mermaid')
  parts.push(renderPrismaMermaid(prismaCounts).trim())
  parts.push('```')
  parts.push('')
  parts.push(renderPrismaTextSummary(prismaCounts))
  parts.push('')

  // Results
  if (sections.results?.content_markdown) {
    parts.push(sections.results.content_markdown)
    parts.push('')
  }

  // Discussion
  if (sections.discussion?.content_markdown) {
    parts.push(sections.discussion.content_markdown)
    parts.push('')
  }

  // Limitations
  if (sections.limitations?.content_markdown) {
    parts.push(sections.limitations.content_markdown)
    parts.push('')
  }

  // Conclusion
  if (sections.conclusion?.content_markdown) {
    parts.push(sections.conclusion.content_markdown)
    parts.push('')
  }

  // References — 始终 by reference-export(忽略 draft_sections 里手编的版本)
  parts.push(exportReferencesSection(included, { style: 'apa' }))
  parts.push('')

  const md = parts.join('\n')

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="review-${project.id}.md"`)
  res.send(md)
})

// ============================================================
// 共用:跑一个章节的 LLM 调用 + 入库
// ============================================================
async function generateSectionLlm(db, { project, userId, section }) {
  const system = getSectionSystem(section)
  if (!system) {
    return { ok: false, status: 'config_error', error: `unknown section: ${section}` }
  }

  // 准备上下文
  const protocol = getApprovedProtocol(db, project.id)
  const themes = listThemes(db, project.id)
  const evidencePoints = listEvidencePoints(db, project.id)
  const searchStrategies = listSearchStrategies(db, project.id)
  const included = listIncludedRecords(db, project.id)
  const prismaCounts = computePrismaFlow(db, project.id)

  const citableRecords = included.map((r) => ({
    record_id: r.id,
    short_label: shortRecordLabel(r),
  }))
  const knownRecordIds = new Set(citableRecords.map((r) => r.record_id))

  const userPrompt = buildSectionUserPrompt({
    section,
    project,
    protocol,
    themes,
    evidencePoints,
    prismaCounts,
    citableRecords,
    searchStrategies,
  })

  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'drafting',
      projectId: project.id,
      system,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 8192,
      timeoutMs: 480_000,
    })
  } catch (e) {
    return { ok: false, status: 'error', error: e?.message || String(e) }
  }

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, usageLogId: result.usageLogId }
  }

  const normalized = normalizeSectionOutput(result.data || null, { knownRecordIds })
  if (!normalized.content_markdown) {
    // 同样补 raw 原文到 usage_log
    if (result.data && result.usageLogId && result.text) {
      try {
        const blob = `meta:\n  reason=empty_content\n  section=${section}\n\nRAW_TEXT_BEGIN\n${result.text.slice(0, 8000)}\nRAW_TEXT_END`
        db.prepare(`UPDATE usage_logs SET status = 'parse_failed', error_message = ? WHERE id = ?`)
          .run(blob, result.usageLogId)
      } catch {}
    }
    return { ok: false, status: 'parse_failed', error: 'content_markdown empty', usageLogId: result.usageLogId }
  }

  // 持久化:写新 version
  try {
    persistSection(
      db,
      project.id,
      section,
      normalized.content_markdown,
      normalized.citation_map,
      result.model,
      'drafting_v1',
    )
  } catch (e) {
    return { ok: false, status: 'error', error: 'db_write: ' + (e.message || String(e)) }
  }

  return {
    ok: true,
    status: 'success',
    model: result.model,
    durationMs: result.durationMs,
    citationMapCount: normalized.citation_map.length,
    citationIssues: normalized.citation_issues,
  }
}

function persistSection(db, projectId, section, contentMarkdown, citationMap, model, promptVersion) {
  const version = getMaxSectionVersion(db, projectId, section) + 1
  const id = randomId('ds')
  db.prepare(
    `INSERT INTO draft_sections
       (id, project_id, section_name, content_markdown, citation_map, model, prompt_version, user_edited, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    projectId,
    section,
    contentMarkdown,
    JSON.stringify(citationMap || []),
    model,
    promptVersion,
    version,
  )
  return { id, version }
}

export default router
