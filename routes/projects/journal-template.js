/**
 * Phase 9 Agent W — 目标期刊模板上传与提取
 *
 * 挂载点(server.js):app.use('/projects', requireUser, projectJournalTemplateRouter)
 *
 * 路由清单:
 *   GET  /:id/journal-template            模板管理页(显示已上传 或 上传表单)
 *   POST /:id/journal-template/upload     multer 接 PDF(≤30MB) → 落 DATA_DIR/uploads/journal-templates/<project>/ → extractJournalTemplate
 *   POST /:id/journal-template/clear      删模板 row + PDF 文件
 *
 * 失败时:friendly flash + 不写脏数据(extract 失败时即使 PDF 已落盘,DB 行也不写;
 *         路由侧保留 PDF 文件让用户手动重试,或自己 clear 后重传)。
 */

import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { audit } from '../../services/audit.js'
import {
  extractJournalTemplate,
  getJournalTemplate,
  deleteJournalTemplate,
  JOURNAL_TEMPLATE_ROOT,
  MAX_TEMPLATE_PDF_BYTES,
} from '../../services/journal-template.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/var/lib/slr')

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    console.error('[journal-template] mkdir failed:', dir, e.message)
  }
}
ensureDirSync(JOURNAL_TEMPLATE_ROOT)

function ownProjectOr404(db, projectId, userId) {
  return db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
}

/** 路径 safety:确保 candidate 落在 DATA_DIR 内 */
function isInsideDataDir(candidate) {
  const c = path.resolve(candidate)
  return c === DATA_DIR || c.startsWith(DATA_DIR + path.sep)
}

// ────────────────────────────────────────────────────────────
// multer:project-scoped 目录,文件名保留原 basename 但清洗
// ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const projectId = req.params.id
      if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
        return cb(new Error('invalid project id'))
      }
      const dir = path.join(JOURNAL_TEMPLATE_ROOT, projectId)
      if (!isInsideDataDir(dir)) {
        return cb(new Error('refused: outside DATA_DIR'))
      }
      ensureDirSync(dir)
      cb(null, dir)
    },
    filename(_req, file, cb) {
      // 清洗:保留 .pdf 后缀,文件名只允许字母数字 / 中文 / _ / - / .,过滤 ../ 等
      const orig = (file.originalname || 'template.pdf').toString()
      const ext = path.extname(orig).toLowerCase()
      const base = path
        .basename(orig, ext)
        .replace(/[^\p{L}\p{N}_\- ]+/gu, '_')
        .slice(0, 80) || 'template'
      // 加时间戳前缀避免重名覆盖
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      cb(null, `${ts}__${base}${ext || '.pdf'}`)
    },
  }),
  limits: { fileSize: MAX_TEMPLATE_PDF_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.pdf')) return cb(null, true)
    cb(new Error('只接受 .pdf 文件'))
  },
})

// ────────────────────────────────────────────────────────────
// GET /:id/journal-template
// ────────────────────────────────────────────────────────────
router.get('/:id/journal-template', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const template = getJournalTemplate(db, project.id)
  const progress = (() => {
    try { return getProjectProgress(db, project.id) } catch { return null }
  })()
  const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'report')

  res.render('projects/journal-template', {
    title: `目标期刊模板 · ${project.title}`,
    project,
    template,
    progress,
    currentStep: 'report',
    stepLabel: '8. 报告(Report)· 目标期刊模板',
    stepItems,
    maxUploadMb: Math.round(MAX_TEMPLATE_PDF_BYTES / 1024 / 1024),
  })
})

// ────────────────────────────────────────────────────────────
// POST /:id/journal-template/upload
// ────────────────────────────────────────────────────────────
router.post(
  '/:id/journal-template/upload',
  (req, res, next) => {
    // 在 multer 跑之前校验项目归属
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    req._project = project
    next()
  },
  (req, res, next) => {
    upload.single('template_pdf')(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: '上传失败:' + (err.message || String(err)) }
        return res.redirect(`/projects/${req.params.id}/journal-template`)
      }
      next()
    })
  },
  async (req, res) => {
    const db = req.app.locals.db
    const project = req._project
    const file = req.file
    if (!file) {
      req.session.flash = { type: 'error', message: '请选择一个 .pdf 文件' }
      return res.redirect(`/projects/${project.id}/journal-template`)
    }

    // 路径 safety 再校验一次(防 multer 配置被绕过)
    if (!isInsideDataDir(file.path)) {
      try { await fsp.unlink(file.path) } catch {}
      req.session.flash = { type: 'error', message: '上传路径异常,已拒绝' }
      return res.redirect(`/projects/${project.id}/journal-template`)
    }

    audit(db, req, {
      eventType: 'journal_template_uploaded',
      userId: req.user.id,
      projectId: project.id,
      payload: { filename: file.originalname, size: file.size, stored_path: file.path },
    })

    // 跑 LLM 抽结构(同步,5-15s)
    const result = await extractJournalTemplate(db, {
      projectId: project.id,
      userId: req.user.id,
      pdfPath: file.path,
      pdfFilename: file.originalname,
    })

    if (!result.ok) {
      audit(db, req, {
        eventType: 'journal_template_extract_failed',
        userId: req.user.id,
        projectId: project.id,
        payload: { status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId },
      })
      // 失败时:留着 PDF 文件,但不写 DB 行 — 用户可在 /journal-template 看到 flash,
      // 然后自己 clear 再重传(或换一篇 PDF)
      req.session.flash = {
        type: 'error',
        message: `模板提取失败:${result.status} — ${(result.error || '').slice(0, 200)}`,
      }
      return res.redirect(`/projects/${project.id}/journal-template`)
    }

    // 成功:如果替换了旧模板,把旧 PDF 删掉
    if (result.replaced_existing && result.old_pdf_path && result.old_pdf_path !== file.path) {
      try {
        if (isInsideDataDir(result.old_pdf_path) && fs.existsSync(result.old_pdf_path)) {
          fs.unlinkSync(result.old_pdf_path)
        }
      } catch (e) {
        console.error('[journal-template] failed to delete old pdf:', result.old_pdf_path, e.message)
      }
    }

    audit(db, req, {
      eventType: 'journal_template_extracted',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        journal_name: result.template?.journal_name,
        article_title: result.template?.article_title,
        section_count: result.template?.extracted_structure?.sections?.length || 0,
        model: result.model,
        duration_ms: result.durationMs,
        usage_log_id: result.usageLogId,
      },
    })

    const sectionCount = result.template?.extracted_structure?.sections?.length || 0
    req.session.flash = {
      type: 'success',
      message: `期刊模板已提取(${sectionCount} 个章节,${result.model}, ${result.durationMs}ms)。`,
    }
    res.redirect(`/projects/${project.id}/journal-template`)
  }
)

// ────────────────────────────────────────────────────────────
// POST /:id/journal-template/clear
// ────────────────────────────────────────────────────────────
router.post('/:id/journal-template/clear', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    req.session.flash = { type: 'error', message: '项目不存在或无权访问' }
    return res.redirect('/projects')
  }

  const r = deleteJournalTemplate(db, project.id)
  if (!r.ok) {
    req.session.flash = { type: 'error', message: '清除失败:' + (r.error || '') }
    return res.redirect(`/projects/${project.id}/journal-template`)
  }

  // 删 PDF 文件(若存在 且 在 DATA_DIR 内)
  let fileRemoved = false
  if (r.deleted && r.source_pdf_path) {
    try {
      if (isInsideDataDir(r.source_pdf_path) && fs.existsSync(r.source_pdf_path)) {
        await fsp.unlink(r.source_pdf_path)
        fileRemoved = true
      }
    } catch (e) {
      console.error('[journal-template] failed to delete pdf:', r.source_pdf_path, e.message)
    }
  }

  audit(db, req, {
    eventType: 'journal_template_cleared',
    userId: req.user.id,
    projectId: project.id,
    payload: { deleted: r.deleted, file_removed: fileRemoved },
  })

  req.session.flash = {
    type: 'success',
    message: r.deleted ? '期刊模板已清除' : '当前项目本来就没有模板',
  }
  res.redirect(`/projects/${project.id}/journal-template`)
})

export default router
