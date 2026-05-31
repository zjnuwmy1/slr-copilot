/**
 * Phase 5 Agent N — 全文结构化抽取(Extraction)
 *
 * 挂载点(server.js 需追加):
 *   app.use('/projects', requireUser, extractionRouter)
 *   ↑ 必须挂在 projectsRouter 之前,否则 projectsRouter 里的
 *     占位 GET /:id/extraction 会先匹配。
 *
 * 路由清单:
 *   GET  /projects/:id/extraction                       列表 + 一键批量
 *   POST /projects/:id/extraction/run-one/:recordId     单条 AI 抽取
 *   POST /projects/:id/extraction/run-batch             批量(后台 setImmediate)
 *   GET  /projects/:id/extraction/progress.json         批量进度 JSON
 *   GET  /projects/:id/extraction/:recordId/review      单条审阅页
 *   POST /projects/:id/extraction/:recordId/verify      人工标记已审
 *   POST /projects/:id/extraction/:recordId/edit        人工编辑字段
 *   GET  /projects/:id/extraction/export.json           项目全量导出
 *
 * 依赖关系:
 *   - 必须 record.has_pdf=1
 *   - 必须 screening_decisions.human_decision = 'include'(stage='title_abstract' 或 'full_text')
 *   - 优先消费 paper_chunks(Agent L 写入);没有则用 abstract 兜底并标 partial
 *   - 写入 extractions 表
 *   - Phase 6 Agent O 的 synthesis 会读 extractions.extracted_json
 */

import express from 'express'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm } from '../../services/llm.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import {
  EXTRACTION_SYSTEM,
  EXTRACTION_SCHEMA_VERSION,
  EXTRACTION_PROMPT_VERSION,
  buildExtractionUserPrompt,
  normalizeExtractionOutput,
} from '../../services/prompts/extraction.js'
import { getProjectProgress } from '../../services/prisma.js'
import { getChecklistItems } from '../../services/prisma.js'

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
      try { const x = JSON.parse(row.concept_groups || '[]'); return Array.isArray(x) ? x : [] }
      catch { return [] }
    })(),
    clarification_questions: parseJsonArrayField(row.clarification_questions),
  }
}

function ownProjectOr404(db, projectId, userId) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)
  return parseProject(row)
}

function getApprovedProtocol(db, projectId) {
  const row = db.prepare(
    `SELECT * FROM protocols
     WHERE project_id = ? AND approved_by_user = 1
     ORDER BY version DESC LIMIT 1`
  ).get(projectId)
  return parseProtocol(row)
}

function getRecord(db, projectId, recordId) {
  return db.prepare(
    'SELECT * FROM records WHERE id = ? AND project_id = ?'
  ).get(recordId, projectId)
}

/**
 * 列出"符合条件的 records":screening = include + has_pdf。
 * 同时 LEFT JOIN extractions 给出当前抽取状态。
 *
 * status 计算:
 *   verified      → extractions.human_verified = 1
 *   needs_check   → has manual_check items 且未审验
 *   extracted     → 已写 extractions(JSON 非空)
 *   failed        → 跑过但失败(extracted_json 为 null 或为 {"error": ...})
 *   not_extracted → 还没跑过
 */
function listEligibleRecords(db, projectId) {
  const rows = db.prepare(`
    SELECT
      r.id, r.title, r.authors_text, r.year, r.journal, r.doi, r.has_pdf,
      sd.human_decision AS screen_decision,
      sd.stage AS screen_stage,
      e.id AS extraction_id,
      e.extracted_json AS extraction_json,
      e.human_verified,
      e.requires_manual_check,
      e.model AS extraction_model,
      e.updated_at AS extraction_updated_at,
      (SELECT COUNT(*) FROM paper_chunks pc WHERE pc.record_id = r.id) AS chunk_count
    FROM records r
    INNER JOIN screening_decisions sd
       ON sd.record_id = r.id
      AND sd.project_id = r.project_id
      AND sd.human_decision = 'include'
    LEFT JOIN extractions e
       ON e.record_id = r.id AND e.project_id = r.project_id
    WHERE r.project_id = ?
      AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
    GROUP BY r.id
    ORDER BY r.year DESC, r.title ASC
  `).all(projectId)

  return rows.map((r) => {
    const manualCheck = parseJsonArrayField(r.requires_manual_check)
    let status, statusReason
    if (!r.extraction_id) {
      status = 'not_extracted'
      statusReason = null
    } else if (!r.extraction_json) {
      status = 'failed'
      statusReason = 'no_json_stored'
    } else {
      // 是否有"failed" sentinel
      let parsed
      try { parsed = JSON.parse(r.extraction_json) } catch { parsed = null }
      if (!parsed || parsed.__failed) {
        status = 'failed'
        statusReason = parsed?.__failed || 'invalid_json'
      } else if (r.human_verified) {
        status = 'verified'
      } else if (manualCheck.length > 0) {
        status = 'needs_check'
      } else {
        status = 'extracted'
      }
    }
    return {
      id: r.id,
      title: r.title,
      authors_text: r.authors_text,
      year: r.year,
      journal: r.journal,
      doi: r.doi,
      has_pdf: !!r.has_pdf,
      chunk_count: r.chunk_count || 0,
      screen_decision: r.screen_decision,
      screen_stage: r.screen_stage,
      status,
      status_reason: statusReason,
      manual_check_count: manualCheck.length,
      extraction_model: r.extraction_model,
      extraction_updated_at: r.extraction_updated_at,
    }
  })
}

function computeStats(records) {
  const stats = { total: 0, extracted: 0, verified: 0, pending: 0, needs_check: 0, failed: 0, not_extracted: 0 }
  for (const r of records) {
    stats.total++
    stats[r.status]++
    if (r.status === 'not_extracted' || r.status === 'failed') stats.pending++
  }
  // "已抽取" 包含 extracted / needs_check / verified
  stats.extracted = stats.extracted + stats.verified + stats.needs_check
  return stats
}

function loadChunks(db, recordId) {
  return db.prepare(`
    SELECT id, section_type, heading, page_start, page_end, chunk_index, text, token_count
    FROM paper_chunks
    WHERE record_id = ?
    ORDER BY chunk_index ASC, page_start ASC
  `).all(recordId)
}

// ============================================================
// 单条抽取的核心:返回 { status, normalized?, error?, model?, usageLogId?, partial? }
// 给单条接口和批量接口共用,不依赖 req/res。
// ============================================================
async function runExtractionForRecord({ db, userId, project, record, protocol, reqLike }) {
  if (!record) return { status: 'error', error: 'record_not_found' }
  if (!record.has_pdf) return { status: 'error', error: 'no_pdf' }

  // 取 chunks(可能为空 → 兜底 abstract)
  const chunks = loadChunks(db, record.id)
  const partial = chunks.length === 0
  if (partial && !record.abstract) {
    return { status: 'error', error: 'no_chunks_and_no_abstract' }
  }

  const validChunkIds = new Set(chunks.map((c) => c.id))

  const prompt = buildExtractionUserPrompt({
    record,
    chunks,
    researchQuestions: protocol?.research_questions || [],
    partial,
  })

  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'extraction',
      projectId: project.id,
      system: EXTRACTION_SYSTEM,
      prompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 8192,
      timeoutMs: 240_000,
    })
  } catch (e) {
    return {
      status: 'error',
      error: `runLlm_threw: ${(e?.message || String(e)).slice(0, 200)}`,
    }
  }

  if (!result.ok) {
    // 失败也写 extractions(用 __failed sentinel),方便列表显示
    writeFailedExtraction(db, {
      project, record,
      reason: `${result.status}:${(result.error || '').slice(0, 300)}`,
      model: result.model,
      usageLogId: result.usageLogId,
    })
    audit(db, reqLike, {
      eventType: 'extraction_ai_failed',
      userId, projectId: project.id,
      payload: {
        record_id: record.id,
        status: result.status,
        error: (result.error || '').slice(0, 300),
        usage_log_id: result.usageLogId,
        partial,
      },
    })
    return {
      status: 'failed',
      error: result.error,
      llmStatus: result.status,
      model: result.model,
      usageLogId: result.usageLogId,
    }
  }

  // normalize
  const normalized = normalizeExtractionOutput(result.data, validChunkIds)

  // partial 模式追加一条 manual check
  if (partial && !normalized.requires_manual_check.includes('only_abstract_available_no_fulltext')) {
    normalized.requires_manual_check.unshift('only_abstract_available_no_fulltext')
  }

  // 视为"成功但实质为空":metadata 全 null + findings 0 条 + intervention 空
  const isEmpty = (
    normalized.key_findings.length === 0 &&
    !normalized.intervention_or_focus &&
    normalized.outcomes_or_themes.length === 0 &&
    !normalized.study_characteristics.population &&
    !normalized.study_characteristics.methods
  )
  if (isEmpty) {
    writeFailedExtraction(db, {
      project, record,
      reason: result.data ? 'normalized_empty' : 'json_parse_failed',
      model: result.model,
      usageLogId: result.usageLogId,
    })
    audit(db, reqLike, {
      eventType: 'extraction_ai_failed',
      userId, projectId: project.id,
      payload: {
        record_id: record.id,
        reason: result.data ? 'normalized_empty' : 'json_parse_failed',
        usage_log_id: result.usageLogId,
        model: result.model,
        partial,
      },
    })
    // 把 raw_text 前 2000 字符存回 usage_logs(模仿 protocol.js 的做法)
    if (result.usageLogId && result.text) {
      try {
        const blob = [
          'meta:',
          `  reason=${result.data ? 'normalized_empty' : 'json_parse_failed'}`,
          `  record_id=${record.id}`,
          `  raw_text_length=${result.text.length}`,
          '\n<<<<<<<< SECTION_DIVIDER >>>>>>>>\n',
          'RAW_TEXT_BEGIN',
          result.text.slice(0, 2000),
          `RAW_TEXT_END_${result.text.length > 2000 ? 'truncated_at_2000' : 'full'}`,
        ].join('\n')
        db.prepare(`UPDATE usage_logs SET status='parse_failed', error_message=? WHERE id=?`)
          .run(blob, result.usageLogId)
      } catch {}
    }
    return {
      status: 'failed',
      error: result.data ? 'normalized_empty' : 'json_parse_failed',
      model: result.model,
      usageLogId: result.usageLogId,
    }
  }

  // 写入 extractions(UPSERT)
  upsertExtraction(db, {
    project, record,
    normalized,
    model: result.model,
    partial,
  })

  audit(db, reqLike, {
    eventType: 'extraction_ai_ran',
    userId, projectId: project.id,
    payload: {
      record_id: record.id,
      model: result.model,
      provider: result.provider,
      duration_ms: result.durationMs,
      partial,
      findings_count: normalized.key_findings.length,
      manual_check_count: normalized.requires_manual_check.length,
      usage_log_id: result.usageLogId,
    },
  })

  return {
    status: 'extracted',
    normalized,
    model: result.model,
    usageLogId: result.usageLogId,
    partial,
  }
}

function upsertExtraction(db, { project, record, normalized, model, partial }) {
  const json = JSON.stringify(normalized)
  const mc = JSON.stringify(normalized.requires_manual_check || [])
  const existing = db.prepare(
    'SELECT id FROM extractions WHERE record_id = ?'
  ).get(record.id)

  if (existing) {
    db.prepare(`
      UPDATE extractions
      SET extracted_json = ?, model = ?, prompt_version = ?, schema_version = ?,
          requires_manual_check = ?, human_verified = 0,
          updated_at = datetime('now', '+8 hours')
      WHERE id = ?
    `).run(json, model || null, EXTRACTION_PROMPT_VERSION + (partial ? '+partial' : ''),
           EXTRACTION_SCHEMA_VERSION, mc, existing.id)
  } else {
    db.prepare(`
      INSERT INTO extractions
        (id, record_id, project_id, schema_version, extracted_json, model,
         prompt_version, human_verified, requires_manual_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      randomId('ext'),
      record.id, project.id,
      EXTRACTION_SCHEMA_VERSION,
      json,
      model || null,
      EXTRACTION_PROMPT_VERSION + (partial ? '+partial' : ''),
      mc,
    )
  }
}

function writeFailedExtraction(db, { project, record, reason, model, usageLogId }) {
  const sentinel = JSON.stringify({ __failed: reason, __usage_log_id: usageLogId || null })
  const existing = db.prepare('SELECT id FROM extractions WHERE record_id = ?').get(record.id)
  if (existing) {
    db.prepare(`
      UPDATE extractions
      SET extracted_json = ?, model = ?, requires_manual_check = ?,
          human_verified = 0, updated_at = datetime('now', '+8 hours')
      WHERE id = ?
    `).run(sentinel, model || null, JSON.stringify([`extraction_failed:${reason.slice(0, 80)}`]), existing.id)
  } else {
    db.prepare(`
      INSERT INTO extractions
        (id, record_id, project_id, schema_version, extracted_json, model,
         prompt_version, human_verified, requires_manual_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      randomId('ext'),
      record.id, project.id,
      EXTRACTION_SCHEMA_VERSION,
      sentinel,
      model || null,
      EXTRACTION_PROMPT_VERSION,
      JSON.stringify([`extraction_failed:${reason.slice(0, 80)}`]),
    )
  }
}

// ============================================================
// 批量任务的内存状态(单进程,重启丢失,Phase 5 接受)
// ============================================================
const batchJobs = new Map()  // projectId → { total, done, failed, current, startedAt, lastRecordId, status }

function getBatchJob(projectId) {
  return batchJobs.get(projectId) || null
}

function setBatchJob(projectId, patch) {
  const existing = batchJobs.get(projectId) || {}
  const merged = { ...existing, ...patch }
  batchJobs.set(projectId, merged)
  return merged
}

function clearBatchJob(projectId) {
  batchJobs.delete(projectId)
}

// ============================================================
// GET /:id/extraction — 列表页
// ============================================================
router.get('/:id/extraction', (req, res) => {
  // 新版 Step 4 统一在 /matrix(两条路径殊途同归)。
  // 旧的 /extraction 页面只在显式 ?legacy=1 时展示,作为老 extractions 数据浏览入口。
  if (req.query.legacy !== '1') {
    return res.redirect(`/projects/${req.params.id}/matrix`)
  }
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

  const records = listEligibleRecords(db, project.id)
  const stats = computeStats(records)

  // 过滤
  const filterStatus = String(req.query.status || '').trim()
  let filtered = records
  if (['verified', 'extracted', 'not_extracted', 'needs_check', 'failed'].includes(filterStatus)) {
    if (filterStatus === 'extracted') {
      // 包含 extracted / needs_check / verified
      filtered = records.filter((r) => ['extracted', 'needs_check', 'verified'].includes(r.status))
    } else {
      filtered = records.filter((r) => r.status === filterStatus)
    }
  }

  let progress = null
  try { progress = getProjectProgress(db, project.id) } catch {}

  const job = getBatchJob(project.id)
  const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'extraction')

  // 帮 UI 展示 PDF 覆盖率 → 引导用户回 /zotero/upload 上传缺失 PDF
  const withPdf = records.filter((r) => r.has_pdf).length
  const noPdf = records.length - withPdf

  res.render('projects/extraction', {
    title: `抽取 · ${project.title}`,
    project,
    stepLabel: '4. 文献矩阵(历史数据)',
    progress,
    currentStep: 'extraction',
    records: filtered,
    allRecordCount: records.length,
    stats,
    pdfStats: { withPdf, noPdf, total: records.length },
    filterStatus,
    batchJob: job,
    stepItems,
  })
})

// ============================================================
// POST /:id/extraction/run-one/:recordId
// ============================================================
router.post('/:id/extraction/run-one/:recordId', requireAdvancedExtraction, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  const record = getRecord(db, project.id, req.params.recordId)
  if (!record) {
    req.session.flash = { type: 'error', message: '记录不存在' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  // 校验 screening 决定
  const sd = db.prepare(
    `SELECT human_decision FROM screening_decisions
     WHERE record_id = ? AND project_id = ?
       AND human_decision = 'include'
     LIMIT 1`
  ).get(record.id, project.id)
  if (!sd) {
    req.session.flash = { type: 'error', message: '该记录未通过筛选,不能进入抽取' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }
  if (!record.has_pdf) {
    req.session.flash = { type: 'error', message: '该记录没有 PDF,无法抽取' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  const protocol = getApprovedProtocol(db, project.id)

  const r = await runExtractionForRecord({
    db, userId: req.user.id, project, record, protocol, reqLike: req,
  })

  if (r.status === 'extracted') {
    req.session.flash = {
      type: 'success',
      message: `抽取完成(${r.normalized.key_findings.length} 条 finding${r.partial ? ',兜底仅 abstract' : ''})`,
    }
    return res.redirect(`/projects/${project.id}/extraction/${record.id}/review`)
  }
  req.session.flash = {
    type: 'error',
    message: `抽取失败:${(r.error || r.llmStatus || 'unknown').slice(0, 200)}`,
  }
  res.redirect(`/projects/${project.id}/extraction`)
})

// ============================================================
// POST /:id/extraction/run-batch — 后台跑全部 pending
// ============================================================
router.post('/:id/extraction/run-batch', requireAdvancedExtraction, (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  // 已有 running job?
  const existing = getBatchJob(project.id)
  if (existing && existing.status === 'running') {
    req.session.flash = { type: 'info', message: `已有批量任务在跑(${existing.done}/${existing.total})` }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  const records = listEligibleRecords(db, project.id)
  const pending = records.filter((r) => r.has_pdf && (r.status === 'not_extracted' || r.status === 'failed'))

  if (pending.length === 0) {
    req.session.flash = { type: 'info', message: '没有可抽取的记录(全部已抽 / 无 PDF / 未通过筛选)' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  const protocol = getApprovedProtocol(db, project.id)
  const userId = req.user.id

  setBatchJob(project.id, {
    total: pending.length, done: 0, failed: 0,
    current: null, startedAt: new Date().toISOString(),
    lastRecordId: null, status: 'running',
    finishedAt: null,
  })

  audit(db, req, {
    eventType: 'extraction_batch_started',
    userId, projectId: project.id,
    payload: { total: pending.length },
  })

  // 后台串行(避免 quota 爆 + provider rate-limit)
  const reqLike = {
    ip: req.ip,
    get: (h) => req.get(h),
  }
  setImmediate(async () => {
    for (const r of pending) {
      const job = getBatchJob(project.id)
      if (!job || job.status === 'cancelled') break
      setBatchJob(project.id, { current: { record_id: r.id, title: r.title } })

      const rec = getRecord(db, project.id, r.id)
      if (!rec) {
        setBatchJob(project.id, {
          failed: (job.failed || 0) + 1,
          lastRecordId: r.id,
        })
        continue
      }

      try {
        const outcome = await runExtractionForRecord({
          db, userId, project, record: rec, protocol, reqLike,
        })
        const cur = getBatchJob(project.id)
        if (!cur) break
        if (outcome.status === 'extracted') {
          setBatchJob(project.id, {
            done: cur.done + 1,
            lastRecordId: r.id,
            current: null,
          })
        } else {
          setBatchJob(project.id, {
            done: cur.done + 1,
            failed: cur.failed + 1,
            lastRecordId: r.id,
            current: null,
          })
        }
      } catch (e) {
        const cur = getBatchJob(project.id)
        if (cur) {
          setBatchJob(project.id, {
            done: cur.done + 1,
            failed: cur.failed + 1,
            lastRecordId: r.id,
            current: null,
          })
        }
        console.error('[extraction/batch] item failed:', r.id, e?.message)
      }
    }
    const final = getBatchJob(project.id)
    if (final) {
      setBatchJob(project.id, {
        status: 'finished',
        finishedAt: new Date().toISOString(),
        current: null,
      })
    }
    audit(db, reqLike, {
      eventType: 'extraction_batch_finished',
      userId, projectId: project.id,
      payload: {
        total: final?.total || pending.length,
        done: final?.done || 0,
        failed: final?.failed || 0,
      },
    })
    // 30 分钟后清空(让用户能刷新看到结果)
    setTimeout(() => {
      const t = getBatchJob(project.id)
      if (t && t.status !== 'running') clearBatchJob(project.id)
    }, 30 * 60_000).unref?.()
  })

  req.session.flash = { type: 'success', message: `已开始批量抽取 ${pending.length} 条,刷新页面查看进度` }
  res.redirect(`/projects/${project.id}/extraction`)
})

// ============================================================
// GET /:id/extraction/progress.json
// ============================================================
router.get('/:id/extraction/progress.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })
  const job = getBatchJob(project.id)
  res.json({ job: job || null })
})

// ============================================================
// GET /:id/extraction/export.json — 项目全量导出
// ============================================================
router.get('/:id/extraction/export.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })

  const rows = db.prepare(`
    SELECT r.id AS record_id, r.title, r.authors_text, r.year, r.journal, r.doi,
           e.id AS extraction_id, e.schema_version, e.model, e.prompt_version,
           e.human_verified, e.human_notes, e.extracted_json,
           e.requires_manual_check, e.created_at, e.updated_at
    FROM extractions e
    INNER JOIN records r ON r.id = e.record_id
    WHERE e.project_id = ?
    ORDER BY r.year DESC, r.title ASC
  `).all(project.id)

  const out = rows.map((row) => {
    let extraction = null
    try { extraction = JSON.parse(row.extracted_json || '{}') } catch { extraction = null }
    return {
      record: {
        id: row.record_id, title: row.title, authors: row.authors_text,
        year: row.year, journal: row.journal, doi: row.doi,
      },
      extraction_id: row.extraction_id,
      schema_version: row.schema_version,
      model: row.model,
      prompt_version: row.prompt_version,
      human_verified: !!row.human_verified,
      human_notes: row.human_notes,
      extraction,
      requires_manual_check: parseJsonArrayField(row.requires_manual_check),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  })

  audit(db, req, {
    eventType: 'extraction_exported',
    userId: req.user.id, projectId: project.id,
    payload: { count: out.length },
  })

  res.setHeader('Content-Disposition', `attachment; filename="extractions-${project.id}.json"`)
  res.json({
    project_id: project.id,
    project_title: project.title,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    count: out.length,
    extractions: out,
  })
})

// ============================================================
// GET /:id/extraction/:recordId/review — 单条审阅页
// ============================================================
router.get('/:id/extraction/:recordId/review', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  const record = getRecord(db, project.id, req.params.recordId)
  if (!record) return res.status(404).render('error', { title: 'Not Found', message: '记录不存在' })

  const extRow = db.prepare(
    'SELECT * FROM extractions WHERE record_id = ? AND project_id = ?'
  ).get(record.id, project.id)

  let extraction = null
  let isFailedJson = false
  let failureReason = null
  if (extRow && extRow.extracted_json) {
    try {
      extraction = JSON.parse(extRow.extracted_json)
      if (extraction && extraction.__failed) {
        isFailedJson = true
        failureReason = extraction.__failed
        extraction = null
      }
    } catch {
      isFailedJson = true
      failureReason = 'invalid_json_in_db'
    }
  }

  // chunks (供 supporting_location 反向链接)
  const chunks = loadChunks(db, record.id)
  const chunkMap = new Map(chunks.map((c) => [c.id, c]))

  let progress = null
  try { progress = getProjectProgress(db, project.id) } catch {}

  res.render('projects/extraction/review', {
    title: `审阅抽取 · ${record.title}`,
    project,
    record,
    extraction,
    isFailedJson,
    failureReason,
    extRow,
    chunks,
    chunkMap,
    progress,
    currentStep: 'extraction',
    stepLabel: '4. 文献矩阵(历史数据)',
  })
})

// ============================================================
// POST /:id/extraction/:recordId/verify — 人工标记已审
// ============================================================
router.post('/:id/extraction/:recordId/verify', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  const ext = db.prepare(
    'SELECT id, human_verified FROM extractions WHERE record_id = ? AND project_id = ?'
  ).get(req.params.recordId, project.id)
  if (!ext) {
    req.session.flash = { type: 'error', message: '尚未抽取,不能审验' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  const verified = req.body.unverify ? 0 : 1
  const humanNotes = String(req.body.human_notes || '').trim().slice(0, 5000) || null

  db.prepare(`
    UPDATE extractions
    SET human_verified = ?, human_notes = ?, updated_at = datetime('now', '+8 hours')
    WHERE id = ?
  `).run(verified, humanNotes, ext.id)

  audit(db, req, {
    eventType: 'extraction_verified',
    userId: req.user.id, projectId: project.id,
    payload: { record_id: req.params.recordId, verified: !!verified, has_notes: !!humanNotes },
  })

  req.session.flash = {
    type: 'success',
    message: verified ? '已标记为审验通过' : '已撤销审验',
  }
  res.redirect(`/projects/${project.id}/extraction/${req.params.recordId}/review`)
})

// ============================================================
// POST /:id/extraction/:recordId/edit — 人工编辑字段
//
// 表单格式约定(给前端):
//   form 提交一个隐藏字段 extraction_json,内容是当前完整 JSON 的字符串,
//   前端 JS 在提交前根据各字段输入更新这个 JSON。
//   这样后端不用解析 10+ 个字段名,简单可靠。
// ============================================================
router.post('/:id/extraction/:recordId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

  const ext = db.prepare(
    'SELECT * FROM extractions WHERE record_id = ? AND project_id = ?'
  ).get(req.params.recordId, project.id)
  if (!ext) {
    req.session.flash = { type: 'error', message: '尚未抽取,不能编辑' }
    return res.redirect(`/projects/${project.id}/extraction`)
  }

  const raw = String(req.body.extraction_json || '').trim()
  if (!raw) {
    req.session.flash = { type: 'error', message: '提交内容为空' }
    return res.redirect(`/projects/${project.id}/extraction/${req.params.recordId}/review`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    req.session.flash = { type: 'error', message: `JSON 解析失败:${e.message.slice(0, 200)}` }
    return res.redirect(`/projects/${project.id}/extraction/${req.params.recordId}/review`)
  }

  // 取已存在的 chunk_id 集合,校验编辑后的 supporting_location
  const chunks = loadChunks(db, req.params.recordId)
  const validChunkIds = new Set(chunks.map((c) => c.id))
  const normalized = normalizeExtractionOutput(parsed, validChunkIds)

  db.prepare(`
    UPDATE extractions
    SET extracted_json = ?,
        requires_manual_check = ?,
        prompt_version = COALESCE(prompt_version, ?) || ' +human_edited',
        updated_at = datetime('now', '+8 hours')
    WHERE id = ?
  `).run(
    JSON.stringify(normalized),
    JSON.stringify(normalized.requires_manual_check || []),
    EXTRACTION_PROMPT_VERSION,
    ext.id,
  )

  audit(db, req, {
    eventType: 'extraction_edited',
    userId: req.user.id, projectId: project.id,
    payload: {
      record_id: req.params.recordId,
      findings_count: normalized.key_findings.length,
      manual_check_count: normalized.requires_manual_check.length,
    },
  })

  req.session.flash = { type: 'success', message: '编辑已保存' }
  res.redirect(`/projects/${project.id}/extraction/${req.params.recordId}/review`)
})

export default router
