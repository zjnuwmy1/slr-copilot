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
} from '../../services/literature-matrix.js'

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

    res.render('projects/matrix', {
      title: `文献矩阵 · ${project.title}`,
      project,
      stepLabel: '4. 文献矩阵',
      currentStep: 'extraction',
      progress,
      columns,
      rows,
      maxUploadMb: Math.round(MAX_XLSX_BYTES / 1024 / 1024),
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

    const buf = await buildXlsxTemplate(db, project.id)
    const safeTitle = (project.title || 'project').replace(/[^\w\-一-龥]+/g, '_').slice(0, 40)
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="matrix_${safeTitle}.xlsx"`
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

export default router
