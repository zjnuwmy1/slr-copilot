/**
 * Phase 9 Agent V — 文献矩阵(替代/补充 Agent N 的 LLM JSON extraction)
 *
 * 挂载点(server.js 需追加):
 *   import projectMatrixRouter from './routes/projects/matrix.js'
 *   app.use('/projects', requireUser, projectMatrixRouter)
 *   ↑ 必须挂在 projectsRouter 之前,否则 projectsRouter 的占位
 *     GET /:id/matrix 会先匹配。建议挂在 extraction router 旁边。
 *
 * 路由清单:
 *   GET  /projects/:id/matrix                      列表网格 + inline 编辑
 *   GET  /projects/:id/matrix/template.xlsx        下载 XLSX 模板(已填 metadata)
 *   POST /projects/:id/matrix/upload-xlsx          上传填好的 XLSX(multer + xlsx.read)
 *   POST /projects/:id/matrix/:recordId/save       inline 编辑某行的若干字段
 *   POST /projects/:id/matrix/columns/add          加自定义列
 *   POST /projects/:id/matrix/columns/:colId/delete 删自定义列
 *
 * 仅对 screening human_decision='include' 的 records 显示。
 *
 * 第一次访问 GET /matrix 时懒 seed 默认 13 列(INSERT OR IGNORE 幂等)。
 */

import express from 'express'
import multer from 'multer'
import { audit } from '../../services/audit.js'
import { getProjectProgress } from '../../services/prisma.js'
import { runLlm } from '../../services/llm.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import * as batchJobsSvc from '../../services/batch-jobs.js'
import { parsePdfAttachment, parseProjectPdfs } from '../../services/pdf-parse.js'

const MATRIX_BATCH_KIND = 'matrix_extraction'
const MATRIX_PARSE_PDFS_KIND = 'matrix_parse_pdfs'
import {
  seedColumnsForProject,
  listColumns,
  listIncludedRecords,
  getMatrixForRecord,
  upsertMatrixRow,
  buildXlsxTemplate,
  importXlsxBuffer,
  addCustomColumn,
  deleteCustomColumn,
  buildMasterExtractionPrompt,
  refreshDefaultColumnPrompts,
  SUGGEST_COLUMNS_SYSTEM,
  buildSuggestColumnsPrompt,
  normalizeSuggestColumns,
  applyColumnRewrites,
  buildAutomatedMasterPrompt,
  buildPaperTextFromChunks,
  parseMatrixBatchOutput,
  MATRIX_BATCH_SYSTEM,
  OPTIMIZE_PROMPT_SYSTEM,
  buildOptimizePromptUserPrompt,
  normalizeOptimizePromptOutput,
} from '../../services/literature-matrix.js'

// 取当前已审批的协议(version 最大的那条);没审批返回 null
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

const router = express.Router({ mergeParams: true })

// XLSX 上传:内存里解析,不落盘
const MAX_XLSX_BYTES = 10 * 1024 * 1024 // 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_XLSX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return cb(null, true)
    cb(new Error('只接受 .xlsx 文件'))
  },
})

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

// ============================================================
// GET /:id/matrix — 列表网格页
// ============================================================
router.get('/:id/matrix', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

    // 懒 seed 默认列
    try { seedColumnsForProject(db, project.id) } catch (e) {
      console.error('[matrix] seedColumnsForProject failed:', e.message)
    }

    const columns = listColumns(db, project.id)
    const records = listIncludedRecords(db, project.id)

    // 给每条 record 把当前的 matrix.fields 取出来
    const rows = records.map((r) => {
      const m = getMatrixForRecord(db, project.id, r.id)
      return {
        record: r,
        fields: m?.fields || {},
        completeness: m?.completeness || 0,
        updated_at: m?.updated_at || null,
        filled_by: m?.filled_by || 'user',
      }
    })

    let progress = null
    try { progress = getProjectProgress(db, project.id) } catch {}

    // AI 定制按钮状态 — 让前端拿到锁定信息
    const approved = loadApprovedProtocol(db, project.id)
    const customizedVer = project.matrix_ai_customized_at_version || null
    const aiCustomize = {
      protocolApproved: !!approved,
      protocolVersion: approved ? approved.version : null,
      customizedAtVersion: customizedVer,
      // 是否允许点击:协议已审批 + (没定制过 OR 协议版本已经超过上次定制版本)
      locked: !!approved && customizedVer != null && approved.version <= customizedVer,
    }

    // 一键优化总 prompt 状态 — 锁有三态:
    //   1. locked = 该协议版本已优化(*_at_version 已写)
    //   2. inFlight = 上次点击还没完成(started_at 在 15 min 内)— 防止刷新后又能点
    //   3. idle = 可点
    const optimizedVer = project.matrix_master_prompt_at_version || null
    let inFlightSeconds = null
    if (project.matrix_master_prompt_optimize_started_at) {
      try {
        const startedMs = Date.parse(project.matrix_master_prompt_optimize_started_at + ' UTC')
        if (Number.isFinite(startedMs)) {
          const elapsed = Math.round((Date.now() - startedMs) / 1000)
          if (elapsed >= 0 && elapsed < 15 * 60) inFlightSeconds = elapsed
        }
      } catch {}
    }
    const optimizePrompt = {
      hasOptimized: !!(project.matrix_master_prompt_batch || project.matrix_master_prompt_copy),
      optimizedAtVersion: optimizedVer,
      locked: !!approved && optimizedVer != null && approved.version <= optimizedVer,
      inFlight: inFlightSeconds != null,
      inFlightSeconds,
    }

    // AI 批量任务进度(走持久化表,服务重启不丢)
    const batchJob = getMatrixBatchJob(db, project.id)
    // 候选数 — 三档:
    //   pdfCount        全文 PDF (has_pdf=1)            → 默认批量跑
    //   unavailableCount 容缺(用户已确认找不到)         → 勾"容缺原文"才跑
    //   pendingCount    暂无(用户还没审过)             → 永不跑,用户去 Step 3 triage
    const batchTargetCount = (() => {
      try { return listBatchTargets(db, project.id, { allowAbstractOnly: false }).length } catch { return 0 }
    })()
    const batchTargetCountAll = (() => {
      try { return listBatchTargets(db, project.id, { allowAbstractOnly: true }).length } catch { return 0 }
    })()
    const unavailableTargetCount = batchTargetCountAll - batchTargetCount  // 容缺数
    // 还差多少未审 (pending) — 所有 include + 非重复 - 全文 - 容缺
    const pendingTargetCount = (() => {
      try {
        const totalInclude = db.prepare(`
          SELECT COUNT(*) AS c FROM records r
            INNER JOIN screening_decisions sd ON sd.record_id=r.id AND sd.project_id=r.project_id AND sd.human_decision='include'
          WHERE r.project_id = ?
            AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
        `).get(project.id).c
        return Math.max(0, totalInclude - batchTargetCountAll)
      } catch { return 0 }
    })()
    // 向后兼容:noPdfTargetCount 之前是"所有无 PDF"(容缺 + 暂无),保持算法一致
    const noPdfTargetCount = unavailableTargetCount + pendingTargetCount
    // 已 AI 抽过(避免重复烧 LLM,UI 也能展示)
    const alreadyAiCount = (() => {
      try {
        return db.prepare(
          `SELECT COUNT(*) AS c FROM literature_matrix WHERE project_id = ? AND filled_by = 'ai'`
        ).get(project.id).c
      } catch { return 0 }
    })()
    // 是否有 advanced 权限(批量按钮要灰掉)
    const canAdvanced = !!(req.user && (req.user.advanced_extraction_enabled || req.user.is_super_admin))

    // PDF chunk 状态 — Step 4 完成度的核心瓶颈是"PDF 有但 chunks 没",会让 LLM 只能读摘要。
    //   这里统计当前 include 论文里:多少有 PDF、多少已 chunk、多少待 chunk、多少根本没 PDF。
    //   UI 拿这些渲染状态条 + "解析 PDF 出 chunks" 按钮 + 跑批量前 gate 提示。
    let chunkStatus = { include_total: 0, with_pdf: 0, with_chunks: 0, no_pdf: 0, pending_chunk: 0 }
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS include_total,
          SUM(CASE WHEN r.has_pdf = 1 THEN 1 ELSE 0 END) AS with_pdf,
          SUM(CASE WHEN r.has_pdf = 1 AND EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.record_id = r.id) THEN 1 ELSE 0 END) AS with_chunks
        FROM records r
        INNER JOIN screening_decisions sd ON sd.record_id = r.id AND sd.project_id = r.project_id AND sd.human_decision = 'include'
        WHERE r.project_id = ?
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(project.id)
      chunkStatus.include_total = row.include_total || 0
      chunkStatus.with_pdf      = row.with_pdf || 0
      chunkStatus.with_chunks   = row.with_chunks || 0
      chunkStatus.no_pdf        = chunkStatus.include_total - chunkStatus.with_pdf
      chunkStatus.pending_chunk = chunkStatus.with_pdf - chunkStatus.with_chunks
    } catch (e) { console.error('[matrix] chunk status query failed:', e.message) }

    // 解析 PDF 后台任务的当前状态(如有)
    const parsePdfsJob = batchJobsSvc.getActiveJob(db, project.id, MATRIX_PARSE_PDFS_KIND)

    res.render('projects/matrix', {
      title: `文献矩阵 · ${project.title}`,
      project,
      stepLabel: '4. 文献矩阵',
      currentStep: 'extraction',
      progress,
      columns,
      rows,
      maxUploadMb: Math.round(MAX_XLSX_BYTES / 1024 / 1024),
      aiCustomize,
      optimizePrompt,
      chunkStatus,
      parsePdfsJob,
      batchJob,
      batchTargetCount,
      batchTargetCountAll,
      noPdfTargetCount,
      unavailableTargetCount,
      pendingTargetCount,
      alreadyAiCount,
      canAdvanced,
    })
  } catch (e) {
    next(e)
  }
})

// ============================================================
// GET /:id/matrix/template.xlsx — 下载模板
// ============================================================
router.get('/:id/matrix/template.xlsx', async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

    try { seedColumnsForProject(db, project.id) } catch {}

    const buf = await buildXlsxTemplate(db, project.id, project)
    // Content-Disposition 不能含非 ASCII 字符(Node 强制 ERR_INVALID_CHAR);
    // 用 RFC 5987:filename="<ASCII fallback>"; filename*=UTF-8''<encoded>
    const fname = `matrix_${(project.title || 'project').replace(/\s+/g, '_').slice(0, 40)}.xlsx`
    const asciiFallback = fname.replace(/[^\x20-\x7E]/g, '_')
    const encoded = encodeURIComponent(fname)
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
    )
    res.send(buf)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// POST /:id/matrix/upload-xlsx — 上传填好的 XLSX
// ============================================================
router.post('/:id/matrix/upload-xlsx',
  (req, res, next) => {
    // 上传前校验项目归属
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    req._project = project
    next()
  },
  (req, res, next) => {
    upload.single('xlsx_file')(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: '上传失败:' + (err.message || String(err)) }
        return res.redirect(`/projects/${req.params.id}/matrix`)
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const db = req.app.locals.db
      const project = req._project
      const file = req.file
      if (!file || !file.buffer || file.buffer.length === 0) {
        req.session.flash = { type: 'error', message: '没收到文件' }
        return res.redirect(`/projects/${project.id}/matrix`)
      }

      const result = await importXlsxBuffer(db, project.id, file.buffer)

      audit(db, req, {
        eventType: 'matrix_xlsx_imported',
        userId: req.user.id,
        projectId: project.id,
        payload: {
          filename: file.originalname,
          processed: result.processed,
          skipped: result.skipped,
          errors_sample: result.errors.slice(0, 3),
        },
      })

      const msg = `已导入 ${result.processed} 行,跳过 ${result.skipped} 行` +
        (result.errors.length ? `;问题:${result.errors.slice(0, 3).join('; ')}` : '')
      req.session.flash = {
        type: result.errors.length && result.processed === 0 ? 'error' : 'success',
        message: msg,
      }
      res.redirect(`/projects/${project.id}/matrix`)
    } catch (e) {
      next(e)
    }
  }
)

// ============================================================
// POST /:id/matrix/:recordId/save — inline 编辑(JSON body 或 form)
//   body: { fields: { key: value, ... } }  支持 fetch JSON 提交
// ============================================================
router.post('/:id/matrix/:recordId/save', express.json({ limit: '500kb' }), (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ error: 'not_found' })

    const recordId = String(req.params.recordId || '').trim()
    if (!recordId) return res.status(400).json({ error: 'missing_record_id' })

    // 校验 record 属于本项目且 included
    const included = listIncludedRecords(db, project.id).some((r) => r.id === recordId)
    if (!included) return res.status(403).json({ error: 'record_not_included' })

    const body = req.body || {}
    const fields = (body.fields && typeof body.fields === 'object') ? body.fields : null
    if (!fields) return res.status(400).json({ error: 'missing_fields' })

    // filled_by: 标 user(inline 编辑就是用户操作)
    const result = upsertMatrixRow(db, {
      projectId: project.id,
      recordId,
      fields,
      filledBy: 'user',
    })

    audit(db, req, {
      eventType: 'matrix_row_saved',
      userId: req.user.id,
      projectId: project.id,
      payload: { record_id: recordId, keys: Object.keys(fields) },
    })

    res.json({
      ok: true,
      completeness: result.completeness,
      fields: result.fields,
    })
  } catch (e) {
    next(e)
  }
})

// ============================================================
// POST /:id/matrix/columns/add — 加自定义列
// ============================================================
router.post('/:id/matrix/columns/add', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

    const body = req.body || {}
    const key = String(body.key || '').trim()
    const label = String(body.label || '').trim()
    const description = String(body.description || '').trim() || null
    const promptTpl = String(body.ai_prompt_template || '').trim() || null
    const isQuant = body.is_quantitative === '1' || body.is_quantitative === 'on' || body.is_quantitative === true

    if (!key || !label) {
      req.session.flash = { type: 'error', message: '列 key 和显示名必填' }
      return res.redirect(`/projects/${project.id}/matrix`)
    }

    try {
      const added = addCustomColumn(db, project.id, {
        key, label, description,
        ai_prompt_template: promptTpl,
        is_quantitative: isQuant,
      })
      audit(db, req, {
        eventType: 'matrix_column_added',
        userId: req.user.id,
        projectId: project.id,
        payload: { col_id: added.id, key: added.key },
      })
      req.session.flash = { type: 'success', message: `已加列「${label}」` }
    } catch (e) {
      req.session.flash = { type: 'error', message: '加列失败:' + e.message }
    }

    res.redirect(`/projects/${project.id}/matrix`)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// POST /:id/matrix/columns/:colId/delete — 删自定义列(默认列拒绝)
// ============================================================
router.post('/:id/matrix/columns/:colId/delete', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

    const colId = String(req.params.colId || '').trim()
    try {
      const result = deleteCustomColumn(db, project.id, colId)
      audit(db, req, {
        eventType: 'matrix_column_deleted',
        userId: req.user.id,
        projectId: project.id,
        payload: { col_id: colId, key: result.key },
      })
      req.session.flash = { type: 'success', message: '已删除列' }
    } catch (e) {
      req.session.flash = { type: 'error', message: '删列失败:' + e.message }
    }

    res.redirect(`/projects/${project.id}/matrix`)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// GET /:id/matrix/master-prompt.txt — 一次性总 prompt 文本下载
//   用户:复制 → 粘贴到自己的 AI(Claude/ChatGPT)→ 附论文 → 得 JSON
// ============================================================
router.get('/:id/matrix/master-prompt.txt', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    try { seedColumnsForProject(db, project.id) } catch {}
    const text = buildMasterExtractionPrompt(db, project.id, project)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(text)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// POST /:id/matrix/refresh-default-prompts — 把已 seed 的 is_default 列
//   的 description + ai_prompt_template 强制刷到 DEFAULT_MATRIX_COLUMNS 最新版。
//   用户自定义列不动。
// ============================================================
router.post('/:id/matrix/refresh-default-prompts', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    // seed 一次保证新增列(已 seed 项目缺少的新 key)也写入
    try { seedColumnsForProject(db, project.id) } catch {}
    const { updated } = refreshDefaultColumnPrompts(db, project.id)
    audit(db, req, {
      eventType: 'matrix_default_prompts_refreshed',
      userId: req.user.id, projectId: project.id,
      payload: { updated },
    })
    req.session.flash = { type: 'success', message: `已把 ${updated} 个默认列的 prompt 刷新到最新版(自定义列不动)。` }
    res.redirect(`/projects/${project.id}/matrix`)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// POST /:id/matrix/suggest-columns — AI 根据协议反推专属列建议
//   返回 JSON,前端弹 modal,用户复选后 POST /columns/add 一一加入。
// ============================================================
router.post('/:id/matrix/suggest-columns', async (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

    // 协议必须已审批
    const protocol = loadApprovedProtocol(db, project.id)
    if (!protocol) {
      return res.status(400).json({
        ok: false,
        error: '请先审批协议(才能让 AI 知道你研究的是什么)',
      })
    }

    // 协议版本门:每个 protocol.version 只能跑一次。重新审批协议(version 自增)解锁。
    const customizedVer = project.matrix_ai_customized_at_version || null
    if (customizedVer != null && protocol.version <= customizedVer) {
      return res.status(409).json({
        ok: false,
        error_code: 'already_customized',
        error: `本协议(v${protocol.version})已在第 v${customizedVer} 版做过 AI 定制。如需再来一次,请回到 Step 1 修改并重新审批协议(version 会自增),即可重新点击。`,
        protocol_version: protocol.version,
        customized_at_version: customizedVer,
      })
    }

    try { seedColumnsForProject(db, project.id) } catch {}
    const existingCols = listColumns(db, project.id)
    const existingKeys = existingCols.map((c) => c.key)
    const defaultKeys = existingCols.filter((c) => c.is_default).map((c) => c.key)

    const userPrompt = buildSuggestColumnsPrompt({
      project, protocol, existingColumns: existingCols, existingKeys,
    })

    const result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'matrix_suggest_columns',
      projectId: project.id,
      system: SUGGEST_COLUMNS_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      // 不写死 model — 让 resolveStepModel 跟着用户的 preset 走。
      // performance=opus-4-7 / balanced=sonnet-4-6 / economy=haiku-4-5
      maxTokens: 3000,
      // 8 分钟 safety net:Opus 4.7 + think_hard 偶尔会跑到 5-6 分钟。
      timeoutMs: 480_000,
    })

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: `AI 调用失败:${result.status} ${(result.error || '').slice(0, 200)}` })
    }

    const norm = normalizeSuggestColumns(result.data || null, { existingKeys, defaultKeys })

    // 把 rewrites 的当前值一起回传,前端可对比展示
    const currentByKey = new Map(existingCols.map((c) => [c.key, c]))
    const rewritesWithCurrent = norm.rewrites.map((rw) => {
      const cur = currentByKey.get(rw.key)
      return {
        ...rw,
        current_label: cur ? cur.label : null,
        current_description: cur ? cur.description : null,
        current_ai_prompt_template: cur ? cur.ai_prompt_template : null,
      }
    })

    audit(db, req, {
      eventType: 'matrix_suggest_columns',
      userId: req.user.id, projectId: project.id,
      payload: {
        suggestions: norm.suggestions.length,
        rewrites: norm.rewrites.length,
        model: result.model,
        protocol_version: protocol.version,
      },
    })
    res.json({
      ok: true,
      suggestions: norm.suggestions,
      rewrites: rewritesWithCurrent,
      overall_reasoning: norm.overall_reasoning,
      protocol_version: protocol.version,
      model: result.model,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error: ' + (e?.message || '').slice(0, 200) })
  }
})

// ============================================================
// GET /:id/matrix/optimize-master-prompt/status.json — 轻量轮询端点
//   返回当前优化状态;前端在 fetch 等不到响应时(超 5 分钟浏览器可能 abort)
//   也能通过轮询拿到真实结果。
// ============================================================
router.get('/:id/matrix/optimize-master-prompt/status.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const protocol = loadApprovedProtocol(db, project.id)
    const row = db.prepare(
      `SELECT matrix_master_prompt_at_version,
              length(matrix_master_prompt_batch) AS batch_len,
              length(matrix_master_prompt_copy)  AS copy_len,
              matrix_master_prompt_optimize_started_at AS started_at,
              CAST((julianday('now') - julianday(matrix_master_prompt_optimize_started_at)) * 86400 AS INTEGER) AS elapsed_seconds
         FROM projects WHERE id = ?`
    ).get(project.id) || {}
    // in_flight:started_at 非空且未超 15 分钟(超 15 分钟视为崩溃孤儿)
    const inFlight = !!(row.started_at && row.elapsed_seconds != null && row.elapsed_seconds < 15 * 60)
    res.json({
      ok: true,
      protocol_version: protocol ? protocol.version : null,
      optimized_at_version: row.matrix_master_prompt_at_version || null,
      batch_len: row.batch_len || 0,
      copy_len:  row.copy_len  || 0,
      has_fresh: !!(protocol && row.matrix_master_prompt_at_version === protocol.version),
      in_flight: inFlight,
      started_at: row.started_at || null,
      elapsed_seconds: inFlight ? row.elapsed_seconds : null,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: (e.message || String(e)).slice(0, 200) })
  }
})

// ============================================================
// POST /:id/matrix/optimize-master-prompt — 让 LLM 优化总 prompt(批量 + 复制版)
//   每个协议版本只能跑一次,跟 suggest-columns 用同一个版本门
//   写入:projects.matrix_master_prompt_{batch,copy} + _at_version
// ============================================================
router.post('/:id/matrix/optimize-master-prompt', requireAdvancedExtraction, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const protocol = loadApprovedProtocol(db, project.id)
  if (!protocol) {
    return res.status(400).json({ ok: false, error: '请先审批协议' })
  }

  // 协议版本门
  const optimizedVer = project.matrix_master_prompt_at_version || null
  if (optimizedVer != null && protocol.version <= optimizedVer) {
    return res.status(409).json({
      ok: false,
      error_code: 'already_optimized',
      error: `本协议(v${protocol.version})已优化过总 prompt(在第 v${optimizedVer} 版)。重新审批协议后可再次优化。`,
      protocol_version: protocol.version,
      optimized_at_version: optimizedVer,
    })
  }

  const includeCount = db.prepare(
    `SELECT COUNT(*) AS c FROM screening_decisions
     WHERE project_id = ? AND stage = 'title_abstract' AND human_decision = 'include'`
  ).get(project.id).c
  if (includeCount < 2) {
    return res.status(400).json({
      ok: false,
      error: `优化总 prompt 需要至少 2 篇已 include 的论文作为样本(当前 ${includeCount})。先去 Step 3 标记几篇 include。`,
    })
  }

  // ─────────────────────────────────────────────────────────────
  // In-flight 锁:原子 acquire。
  //   WHERE 条件:started_at IS NULL OR 已超 15 分钟(视为崩溃孤儿)
  //   changes() === 0 → 别人已经在跑,返 409
  // ─────────────────────────────────────────────────────────────
  const lockResult = db.prepare(
    `UPDATE projects
        SET matrix_master_prompt_optimize_started_at = datetime('now')
      WHERE id = ?
        AND (matrix_master_prompt_optimize_started_at IS NULL
             OR matrix_master_prompt_optimize_started_at < datetime('now', '-15 minutes'))`
  ).run(project.id)

  if (lockResult.changes === 0) {
    const row = db.prepare(
      `SELECT matrix_master_prompt_optimize_started_at AS started FROM projects WHERE id = ?`
    ).get(project.id)
    return res.status(409).json({
      ok: false,
      error_code: 'already_running',
      error: `已有一次优化任务在跑(${row?.started || '?'} 开始,Opus 4.7 + 高推理通常 5-8 分钟)。等它跑完,或 15 分钟后视为崩溃自动解锁。`,
      started_at: row?.started || null,
    })
  }

  // ── 锁拿到了,接下来跑 LLM。无论成功失败都要 release(set started_at = NULL) ──
  const releaseLock = () => {
    try {
      db.prepare(
        `UPDATE projects SET matrix_master_prompt_optimize_started_at = NULL WHERE id = ?`
      ).run(project.id)
    } catch (e) { console.error('[matrix optimize] release lock failed:', e.message) }
  }

  try {
    const userPrompt = buildOptimizePromptUserPrompt(db, project.id, project, protocol)

    const result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'matrix_optimize_master_prompt',
      projectId: project.id,
      system: OPTIMIZE_PROMPT_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      maxTokens: 8000,
      timeoutMs: 480_000,
    })

    if (!result.ok) {
      releaseLock()
      return res.status(502).json({
        ok: false,
        error: `AI 调用失败:${result.status} ${(result.error || '').slice(0, 200)}`,
      })
    }

    const norm = normalizeOptimizePromptOutput(result.data || null)
    if (!norm) {
      releaseLock()
      return res.status(502).json({
        ok: false,
        error: 'AI 输出格式不达标(batch_prompt < 500 chars 或 copy_prompt < 300 chars)',
      })
    }

    // 一并写:结果 + 释放锁
    db.prepare(
      `UPDATE projects
          SET matrix_master_prompt_batch = ?,
              matrix_master_prompt_copy = ?,
              matrix_master_prompt_at_version = ?,
              matrix_master_prompt_optimize_started_at = NULL
        WHERE id = ?`
    ).run(norm.batch_prompt, norm.copy_prompt, protocol.version, project.id)

    audit(db, req, {
      eventType: 'matrix_optimize_master_prompt',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        protocol_version: protocol.version,
        batch_len: norm.batch_prompt.length,
        copy_len: norm.copy_prompt.length,
        rationale: norm.rationale,
      },
    })

    res.json({
      ok: true,
      protocol_version: protocol.version,
      batch_prompt_length: norm.batch_prompt.length,
      copy_prompt_length: norm.copy_prompt.length,
      rationale: norm.rationale,
    })
  } catch (e) {
    console.error('[matrix optimize-master-prompt]', e)
    releaseLock()
    res.status(500).json({ ok: false, error: (e.message || String(e)).slice(0, 200) })
  }
})

// ============================================================
// POST /:id/matrix/columns/batch-add — 从 suggest-columns modal 一次批量加
//   body: suggestions JSON 数组(已通过 normalizeSuggestColumns,前端往 input 里塞)
// ============================================================
router.post('/:id/matrix/columns/batch-add', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

    let suggestions = []
    let rewrites = []
    try { suggestions = JSON.parse(req.body.suggestions_json || '[]') } catch { suggestions = [] }
    try { rewrites = JSON.parse(req.body.rewrites_json || '[]') } catch { rewrites = [] }
    if (!Array.isArray(suggestions)) suggestions = []
    if (!Array.isArray(rewrites)) rewrites = []

    if (suggestions.length === 0 && rewrites.length === 0) {
      req.session.flash = { type: 'error', message: '没有选中的列改动' }
      return res.redirect(`/projects/${project.id}/matrix`)
    }

    // 1) 改写默认列
    let rewriteUpdated = 0
    try {
      const r = applyColumnRewrites(db, project.id, rewrites)
      rewriteUpdated = r.updated
    } catch (e) {
      // rewrites 失败不阻塞 suggestions
      console.error('[matrix] applyColumnRewrites failed:', e.message)
    }

    // 2) 新增建议列
    let added = 0
    const failed = []
    for (const s of suggestions) {
      try {
        addCustomColumn(db, project.id, {
          key: s.key,
          label: s.label,
          description: s.description,
          ai_prompt_template: s.ai_prompt_template,
          is_quantitative: !!s.is_quantitative,
        })
        added += 1
      } catch (e) {
        failed.push(`${s.label || s.key}:${e.message}`)
      }
    }

    // 3) 记录"本协议版本已 AI 定制过" — 锁按钮
    try {
      const protocol = loadApprovedProtocol(db, project.id)
      if (protocol) {
        db.prepare(
          `UPDATE projects SET matrix_ai_customized_at_version = ? WHERE id = ?`
        ).run(protocol.version, project.id)
      }
    } catch (e) {
      console.error('[matrix] update matrix_ai_customized_at_version failed:', e.message)
    }

    audit(db, req, {
      eventType: 'matrix_columns_batch_added',
      userId: req.user.id, projectId: project.id,
      payload: {
        added,
        rewrites_updated: rewriteUpdated,
        failed: failed.length,
        source: 'ai_suggest',
      },
    })

    const parts = []
    if (rewriteUpdated > 0) parts.push(`已重写 ${rewriteUpdated} 列`)
    if (added > 0) parts.push(`已新增 ${added} 列`)
    if (failed.length) parts.push(`${failed.length} 失败:` + failed.slice(0, 3).join(' / '))
    if (parts.length === 0) parts.push('未应用任何改动')

    // 链式 UX:列改动成功 → 提示用户去做总 prompt 优化(下一步天然衔接)
    const didAnyChange = added > 0 || rewriteUpdated > 0
    if (didAnyChange) {
      const optProject = db.prepare('SELECT matrix_master_prompt_at_version FROM projects WHERE id = ?').get(project.id)
      const promptVersion = optProject?.matrix_master_prompt_at_version || null
      const protocolAgain = loadApprovedProtocol(db, project.id)
      const promptStale = !promptVersion || (protocolAgain && promptVersion < protocolAgain.version)
      if (promptStale) {
        parts.push('👉 下一步:点 ⚙️ 让 AI 用新列优化总 prompt(Opus 4.7 ultrathink,质量决定批量抽取效果)')
      }
    }

    req.session.flash = {
      type: didAnyChange ? 'success' : 'error',
      message: parts.join(' · '),
    }
    res.redirect(`/projects/${project.id}/matrix`)
  } catch (e) {
    next(e)
  }
})

// ============================================================
// AI 批量抽取(Step 4 自动路径)
//   - 串行跑 include + has_pdf 的 records
//   - 每篇调 1 次 LLM(master prompt 一次出全列 JSON),结果写 literature_matrix
//   - 前置:必须 advanced_extraction_enabled + 协议已审批 + 已经 AI 定制过列
// ============================================================

// 持久化 job tracker — 走 services/batch-jobs.js + batch_jobs 表,服务重启不丢
// 兼容旧调用名 getMatrixBatchJob → getActiveJob(_, _, 'matrix_extraction')
function getMatrixBatchJob(db, projectId) {
  return batchJobsSvc.getActiveJob(db, projectId, MATRIX_BATCH_KIND)
}

// 列出 include 的 records(批量目标)
//   - allowAbstractOnly=false(默认):只要 has_pdf=1 的
//   - allowAbstractOnly=true:也包含没传 PDF 的(走"容缺原文"模式,LLM 看到提示后只用 abstract)
function listBatchTargets(db, projectId, { allowAbstractOnly = false } = {}) {
  // 三档资格:
  //   1. has_pdf=1                              → 永远入选(有真原文)
  //   2. has_pdf=0 + pdf_status='unavailable'   → 容缺,只在 allowAbstractOnly=true 入选(用摘要跑)
  //   3. has_pdf=0 + pdf_status=null/'pending'  → 暂无,无论如何不入选 — 用户还没确认,先去 triage
  //
  // 之前 allowAbstractOnly=true 会把"暂无"也拉进来,导致用户没审过的论文也用摘要跑了
  // → 浪费 LLM tokens + 用户可能后续才补到 PDF → 应只对"已确认找不到"的容缺批量。
  const pdfFilter = allowAbstractOnly
    ? "(r.has_pdf = 1 OR r.pdf_status = 'unavailable')"
    : 'r.has_pdf = 1'
  return db.prepare(`
    SELECT r.id, r.title, r.authors_text, r.year, r.journal, r.doi, r.abstract, r.has_pdf, r.pdf_status
      FROM records r
     INNER JOIN screening_decisions sd
        ON sd.record_id = r.id
       AND sd.project_id = r.project_id
       AND sd.human_decision = 'include'
     WHERE r.project_id = ?
       AND ${pdfFilter}
       AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
     ORDER BY r.has_pdf DESC, r.year DESC, r.title ASC
  `).all(projectId)
}

// 单条抽取核心(给单条 + 批量复用)
//   - allowAbstractOnly=true 时:不强制 has_pdf,允许仅基于标题+摘要抽取(LLM 收到 'abstract_only' 模式提示后不会编造)
async function runMatrixExtractionForRecord({ db, userId, project, record, reqLike, allowAbstractOnly = false }) {
  if (!record) return { status: 'error', error: 'record_not_found' }
  if (!record.has_pdf && !allowAbstractOnly) return { status: 'error', error: 'no_pdf' }

  const columns = listColumns(db, project.id)
  if (!columns.length) return { status: 'error', error: 'no_columns' }

  // 论文文本:chunks 优先,abstract 兜底
  const paperPack = buildPaperTextFromChunks(db, record.id, record)
  if (!paperPack.text) return { status: 'error', error: 'no_paper_text' }

  const prompt = buildAutomatedMasterPrompt(db, project.id, project, record, paperPack.text, {
    paperSource: paperPack.source,  // 'chunks' | 'abstract_only' | 'none'
  })

  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'matrix_run_batch',
      projectId: project.id,
      system: MATRIX_BATCH_SYSTEM,
      prompt,
      expectJson: true,
      maxTokens: 8192,
      timeoutMs: 480_000,
    })
  } catch (e) {
    return { status: 'error', error: `runLlm_threw: ${(e?.message || String(e)).slice(0, 200)}` }
  }

  if (!result.ok) {
    audit(db, reqLike, {
      eventType: 'matrix_batch_ai_failed',
      userId, projectId: project.id,
      payload: {
        record_id: record.id,
        status: result.status,
        error: (result.error || '').slice(0, 300),
        usage_log_id: result.usageLogId,
        model: result.model,
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

  const parsed = parseMatrixBatchOutput(result.data, columns)
  if (parsed.kept === 0) {
    audit(db, reqLike, {
      eventType: 'matrix_batch_ai_empty',
      userId, projectId: project.id,
      payload: { record_id: record.id, model: result.model, raw_keys: parsed.skipped.unknown_keys.slice(0, 5) },
    })
    return { status: 'failed', error: 'llm_returned_no_valid_fields', model: result.model }
  }

  upsertMatrixRow(db, {
    projectId: project.id,
    recordId: record.id,
    fields: parsed.fields,
    filledBy: 'ai',
  })

  audit(db, reqLike, {
    eventType: 'matrix_batch_ai_success',
    userId, projectId: project.id,
    payload: {
      record_id: record.id,
      model: result.model,
      kept: parsed.kept,
      unknown_keys: parsed.skipped.unknown_keys.length,
      paper_source: paperPack.source,
      paper_truncated: paperPack.truncated,
    },
  })

  return { status: 'success', kept: parsed.kept, model: result.model }
}

// POST /:id/matrix/run-one-ai/:recordId
router.post('/:id/matrix/run-one-ai/:recordId', requireAdvancedExtraction, async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
    const protocol = loadApprovedProtocol(db, project.id)
    if (!protocol) return res.status(400).json({ ok: false, error: '请先审批协议' })
    if (!project.matrix_ai_customized_at_version) {
      return res.status(400).json({ ok: false, error: '请先点 🎯 让 AI 定制矩阵列,再跑批量抽取' })
    }

    const record = db.prepare('SELECT * FROM records WHERE id = ? AND project_id = ?')
      .get(req.params.recordId, project.id)
    if (!record) return res.status(404).json({ ok: false, error: 'record_not_found' })

    const allowAbstractOnly = req.body && (req.body.allow_abstract_only === '1' || req.body.allow_abstract_only === 'on')
    const out = await runMatrixExtractionForRecord({
      db, userId: req.user.id, project, record, reqLike: req, allowAbstractOnly,
    })
    res.json({ ok: out.status === 'success', ...out })
  } catch (e) {
    next(e)
  }
})

// B2.4 — POST /:id/matrix/batch-dismiss/:jobId — 把 can_retry 清掉,不再显示重启按钮。
//        用户自己点"忽略"按钮触发(比如错误已经在别处处理过)。
router.post('/:id/matrix/batch-dismiss/:jobId', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  batchJobsSvc.dismissJob(db, req.params.jobId)
  res.redirect(`/projects/${project.id}/matrix`)
})

// POST /:id/matrix/run-batch-ai
router.post('/:id/matrix/run-batch-ai', requireAdvancedExtraction, async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })

    // 已在跑就拒
    const cur = getMatrixBatchJob(db, project.id)
    if (cur && cur.status === 'running') {
      req.session.flash = { type: 'error', message: '已有批量任务在跑,完成后再来' }
      return res.redirect(`/projects/${project.id}/matrix`)
    }

    const protocol = loadApprovedProtocol(db, project.id)
    if (!protocol) {
      req.session.flash = { type: 'error', message: '请先审批协议' }
      return res.redirect(`/projects/${project.id}/matrix`)
    }
    if (!project.matrix_ai_customized_at_version) {
      req.session.flash = { type: 'error', message: '请先点 🎯 让 AI 定制本项目矩阵列,确认列定义和 prompt 后再跑批量' }
      return res.redirect(`/projects/${project.id}/matrix`)
    }

    const allowAbstractOnly = req.body && (req.body.allow_abstract_only === '1' || req.body.allow_abstract_only === 'on')
    const skipAlreadyExtracted = !(req.body && req.body.force_rerun === '1')   // 默认 skip 已 AI 抽过的,避免重复烧 LLM
    // 跑批量前 gate:有 has_pdf=1 但 0 chunks 的论文 → LLM 会 fall back 到 abstract-only,完成度差。
    //   除非用户显式勾"已知会回退到只读摘要,继续跑"(skip_chunk_check),否则拒绝并提示先解析 PDF。
    const acceptedFallback = !!(req.body && (req.body.skip_chunk_check === '1' || req.body.skip_chunk_check === 'on'))
    if (!acceptedFallback) {
      const chunkGate = db.prepare(`
        SELECT COUNT(*) AS pending
          FROM records r
          INNER JOIN screening_decisions sd ON sd.record_id=r.id AND sd.project_id=r.project_id AND sd.human_decision='include'
         WHERE r.project_id = ?
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
           AND r.has_pdf = 1
           AND NOT EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.record_id = r.id)
      `).get(project.id)
      const pending = chunkGate?.pending || 0
      if (pending > 0) {
        req.session.flash = {
          type: 'error',
          message: `⚠ 有 ${pending} 篇 include 论文有 PDF 但还没解析成 chunks → LLM 会回退到只读摘要(完成度差很多)。请先在矩阵页点 ⚛ 解析 PDF 出 chunks,跑完后再启动批量。如果坚持现在跑(只用摘要),请在表单加 skip_chunk_check=1 重提交。`,
        }
        return res.redirect(`/projects/${project.id}/matrix`)
      }
    }

    let targets = listBatchTargets(db, project.id, { allowAbstractOnly })
    if (skipAlreadyExtracted) {
      const alreadyAi = new Set(
        db.prepare(
          `SELECT record_id FROM literature_matrix WHERE project_id = ? AND filled_by = 'ai'`
        ).all(project.id).map((r) => r.record_id)
      )
      targets = targets.filter((r) => !alreadyAi.has(r.id))
    }

    if (targets.length === 0) {
      req.session.flash = {
        type: 'error',
        message: skipAlreadyExtracted
          ? '没有可跑的新论文(所有 include 论文都已 AI 抽过;勾"强制重跑"或换论文)'
          : '没有 include 的论文可以跑',
      }
      return res.redirect(`/projects/${project.id}/matrix`)
    }

    const pdfCount = targets.filter((r) => r.has_pdf).length
    const abstractOnlyCount = targets.length - pdfCount

    let jobRow
    try {
      jobRow = batchJobsSvc.startJob(db, {
        projectId: project.id,
        userId: req.user.id,
        kind: MATRIX_BATCH_KIND,
        total: targets.length,
        initial: { pdfCount, abstractOnlyCount, allowAbstractOnly },
      })
    } catch (e) {
      req.session.flash = { type: 'error', message: '启动失败:' + e.message }
      return res.redirect(`/projects/${project.id}/matrix`)
    }
    const jobId = jobRow.id

    audit(db, req, {
      eventType: 'matrix_batch_ai_started',
      userId: req.user.id, projectId: project.id,
      payload: { job_id: jobId, total: targets.length, pdf: pdfCount, abstract_only: abstractOnlyCount, allow_abstract_only: allowAbstractOnly },
    })

    // 后台串行跑(setImmediate 出栈)。每次循环都把进度写库,服务重启不丢。
    const userId = req.user.id
    setImmediate(async () => {
      let done = 0, failed = 0
      try {
        for (const r of targets) {
          batchJobsSvc.updateJobProgress(db, jobId, {
            current: { id: r.id, title: r.title, has_pdf: !!r.has_pdf },
          })
          let outcome
          try {
            outcome = await runMatrixExtractionForRecord({
              db, userId, project, record: r, reqLike: { user: { id: userId } },
              allowAbstractOnly,
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
      }
    })

    const flashMsg = abstractOnlyCount > 0
      ? `已启动批量:${targets.length} 篇(${pdfCount} 全文 + ${abstractOnlyCount} 仅摘要),每篇 1-3 分钟`
      : `已启动批量:${targets.length} 篇,每篇 1-3 分钟`
    req.session.flash = { type: 'success', message: flashMsg }
    res.redirect(`/projects/${project.id}/matrix`)
  } catch (e) {
    next(e)
  }
})

// GET /:id/matrix/batch-progress.json — 前端轮询
router.get('/:id/matrix/batch-progress.json', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false })
    const job = getMatrixBatchJob(db, project.id)
    res.json({ ok: true, job })
  } catch (e) { next(e) }
})

// ============================================================
// POST /:id/matrix/parse-pdfs — 解析所有 include 论文的 PDF 出 paper_chunks
//   核心:Step 4 完成度的最大杀手是"PDF 物理存在但从未被 chunk" → LLM 只能读摘要。
//   这个 endpoint 把 services/pdf-parse.js 的 parseProjectPdfs 包成 batch_job(可断电恢复 + UI 轮询)。
//   每篇 PDF pdf-parse ~1-3 秒,121 篇约 3-6 分钟。完全跑完后用户应该立刻去重新生成总 prompt + 重跑批量。
// ============================================================
router.post('/:id/matrix/parse-pdfs', requireAdvancedExtraction, (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const existing = batchJobsSvc.getActiveJob(db, project.id, MATRIX_PARSE_PDFS_KIND)
  if (existing && existing.status === 'running') {
    return res.status(409).json({
      ok: false, error_code: 'already_running',
      error: '已有一次 PDF 解析任务在跑,等它完成或失败后再触发',
      job: existing,
    })
  }

  // force 参数:true → 重 parse 已有 chunks 的(覆盖)。默认 false 走增量(skipped 已有 chunks 的)。
  const force = req.body?.force === '1' || req.body?.force === true || req.query?.force === '1'

  // 算 todo 总数(给 progress bar 一个上限估算)— 跟 parseProjectPdfs 一样的 query 逻辑
  const todoCount = db.prepare(`
    SELECT COUNT(DISTINCT a.record_id) AS c
      FROM attachments a
      JOIN records r ON r.id = a.record_id
     WHERE r.project_id = ?
       AND a.attachment_kind = 'pdf'
       AND (r.duplicate_of_record_id IS NULL)
  `).get(project.id).c || 0

  if (todoCount === 0) {
    return res.status(400).json({
      ok: false,
      error: '没有任何 PDF attachment 可解析(确认 include 论文有 PDF + Zotero 包已 merge)',
    })
  }

  let jobRow
  try {
    jobRow = batchJobsSvc.startJob(db, {
      projectId: project.id,
      userId: req.user.id,
      kind: MATRIX_PARSE_PDFS_KIND,
      total: todoCount,
      initial: { parsed: 0, skipped: 0, ocr_required: 0, failed: 0, force },
    })
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message })
  }

  audit(db, req, {
    eventType: 'matrix_parse_pdfs_started',
    userId: req.user.id, projectId: project.id,
    payload: { job_id: jobRow.id, todo: todoCount, force },
  })

  const jobId = jobRow.id
  setImmediate(async () => {
    let parsed = 0, skipped = 0, ocr_required = 0, failed = 0
    try {
      // parseProjectPdfs 内部已经做 force/skip 逻辑 — 我们只是在 onProgress 回调里更新 batch_job 进度
      const result = await parseProjectPdfs(db, {
        projectId: project.id,
        force,
        onProgress: (i, total, currentRecordId) => {
          // i 是当前正在处理的索引(0-based);total 是 todo 数
          try {
            batchJobsSvc.updateJobProgress(db, jobId, {
              done: i,
              failed,
              current: currentRecordId ? { id: currentRecordId, title: '' } : null,
              parsed, skipped, ocr_required,
            })
          } catch {}
        },
      })
      parsed = result.parsed || 0
      skipped = result.skipped || 0
      ocr_required = result.ocr_required || 0
      failed = result.failed || 0
      // 最终一次性写入完成态计数
      batchJobsSvc.updateJobProgress(db, jobId, {
        done: parsed + skipped + ocr_required + failed,
        failed,
        parsed, skipped, ocr_required,
        current: null,
      })
    } catch (e) {
      console.error('[matrix parse-pdfs job]', e)
      try { batchJobsSvc.updateJobProgress(db, jobId, { failed: failed + 1 }) } catch {}
    } finally {
      batchJobsSvc.finishJob(db, jobId, { status: 'finished' })
      try {
        audit(db, { user: { id: req.user.id }, ip: req.ip, get: () => '' }, {
          eventType: 'matrix_parse_pdfs_finished',
          userId: req.user.id, projectId: project.id,
          payload: { job_id: jobId, parsed, skipped, ocr_required, failed },
        })
      } catch {}
    }
  })

  res.status(202).json({
    ok: true,
    job_id: jobId,
    todo: todoCount,
    message: `已启动 PDF 解析:${todoCount} 篇,每篇 1-3 秒,大概 ${Math.ceil(todoCount / 30)}-${Math.ceil(todoCount / 15)} 分钟`,
  })
})

// GET /:id/matrix/parse-pdfs/status.json — 前端轮询
router.get('/:id/matrix/parse-pdfs/status.json', (req, res) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ ok: false })
    const job = batchJobsSvc.getActiveJob(db, project.id, MATRIX_PARSE_PDFS_KIND)
    // 顺手返当前 chunk 覆盖率,UI 可以实时刷新进度条
    const row = db.prepare(`
      SELECT
        COUNT(*) AS include_total,
        SUM(CASE WHEN r.has_pdf = 1 THEN 1 ELSE 0 END) AS with_pdf,
        SUM(CASE WHEN r.has_pdf = 1 AND EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.record_id = r.id) THEN 1 ELSE 0 END) AS with_chunks
      FROM records r
      INNER JOIN screening_decisions sd ON sd.record_id = r.id AND sd.project_id = r.project_id AND sd.human_decision = 'include'
      WHERE r.project_id = ?
        AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
    `).get(project.id) || {}
    res.json({
      ok: true,
      job,
      include_total: row.include_total || 0,
      with_pdf: row.with_pdf || 0,
      with_chunks: row.with_chunks || 0,
      pending_chunk: (row.with_pdf || 0) - (row.with_chunks || 0),
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

export default router
