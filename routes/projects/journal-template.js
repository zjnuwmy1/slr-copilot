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
  backfillAbstractFormat,
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

  // 优化打磨包(M32-g):extract in-flight state
  const extStarted = project.journal_template_extract_started_at
  const extStatus = project.journal_template_extract_status
  const extElapsed = extStarted
    ? Math.max(0, Math.floor((Date.now() - new Date(extStarted + ' UTC').getTime()) / 1000))
    : 0
  const extractInFlight = !!(extStatus === 'running' && extStarted && extElapsed < 15 * 60)

  res.render('projects/journal-template', {
    title: `目标期刊模板 · ${project.title}`,
    project,
    template,
    progress,
    currentStep: 'report',
    stepLabel: '8. 综述初稿 · 目标期刊模板',
    stepItems,
    maxUploadMb: Math.round(MAX_TEMPLATE_PDF_BYTES / 1024 / 1024),
    // M32-g
    extractInFlight,
    extractStatus: extStatus,
    extractStarted: extStarted,
    extractFinished: project.journal_template_extract_finished_at,
    extractError: project.journal_template_extract_error,
    extractPendingFilename: project.journal_template_extract_pending_filename,
    extractElapsedS: extElapsed,
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

    // ──────────────────────────────────────────────────────────────
    // 优化打磨包(M32-g):异步抽取 — 之前同步 await runLlm,大 PDF + Opus 常 30-90s
    // 超 nginx 60s 就"卡住"。改 setImmediate 后台跑 + status.json 轮询。
    //
    // 原子 lock:UPDATE WHERE journal_template_extract_status IS NULL OR != 'running'
    //          OR started_at < now-15min。lock 拿到才 setImmediate。
    // ──────────────────────────────────────────────────────────────
    const projectId = project.id
    const userId = req.user.id

    const lockAcquired = db.prepare(
      `UPDATE projects SET
          journal_template_extract_started_at = datetime('now', '+8 hours'),
          journal_template_extract_finished_at = NULL,
          journal_template_extract_status = 'running',
          journal_template_extract_error = NULL,
          journal_template_extract_pending_pdf_path = ?,
          journal_template_extract_pending_filename = ?
         WHERE id = ?
           AND (journal_template_extract_status IS NULL
                OR journal_template_extract_status != 'running'
                OR journal_template_extract_started_at IS NULL
                OR journal_template_extract_started_at < datetime('now','-15 minutes'))`
    ).run(file.path, file.originalname, projectId).changes > 0

    if (!lockAcquired) {
      try { await fsp.unlink(file.path) } catch {}
      req.session.flash = {
        type: 'error',
        message: '另一个模板抽取请求正在进行(15 min 内)— 等当前完成或刷新页面看进度',
      }
      return res.redirect(`/projects/${projectId}/journal-template`)
    }

    // 立即响应,让用户看到进度卡
    if (req.get('X-Requested-With') === 'fetch') {
      res.json({ ok: true, message: '已开始抽取(后台 LLM,通常 30s-2min,可关页面)' })
    } else {
      req.session.flash = {
        type: 'success',
        message: '✓ PDF 已上传,正在后台抽取章节结构(Opus 4.8,30s-2min,完成后页面自动刷新)',
      }
      res.redirect(`/projects/${projectId}/journal-template`)
    }

    // 后台跑(setImmediate — 不阻塞 res)
    setImmediate(async () => {
      const finishExtract = (status, errorMsg) => {
        try {
          db.prepare(
            `UPDATE projects SET
                journal_template_extract_status = ?,
                journal_template_extract_finished_at = datetime('now', '+8 hours'),
                journal_template_extract_error = ?,
                journal_template_extract_pending_pdf_path = NULL,
                journal_template_extract_pending_filename = NULL
               WHERE id = ?`
          ).run(status, errorMsg ? String(errorMsg).slice(0, 1000) : null, projectId)
        } catch (e) {
          console.error('[journal-template] finishExtract update failed:', e)
        }
      }
      const bgAudit = (eventType, payload) => {
        try {
          audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
            eventType, userId, projectId, payload,
          })
        } catch {}
      }

      let result
      try {
        result = await extractJournalTemplate(db, {
          projectId,
          userId,
          pdfPath: file.path,
          pdfFilename: file.originalname,
        })
      } catch (e) {
        console.error('[journal-template/upload BG] extract threw:', e)
        finishExtract('failed', e?.message || String(e))
        bgAudit('journal_template_extract_failed', { reason: 'extract_threw', error: (e?.message || String(e)).slice(0, 300) })
        return
      }

      if (!result.ok) {
        finishExtract('failed', `${result.status}: ${(result.error || '').slice(0, 300)}`)
        bgAudit('journal_template_extract_failed', {
          status: result.status, error: (result.error || '').slice(0, 300), usage_log_id: result.usageLogId,
        })
        return
      }

      // 成功:删旧 PDF + audit + finish
      if (result.replaced_existing && result.old_pdf_path && result.old_pdf_path !== file.path) {
        try {
          if (isInsideDataDir(result.old_pdf_path) && fs.existsSync(result.old_pdf_path)) {
            fs.unlinkSync(result.old_pdf_path)
          }
        } catch (e) {
          console.error('[journal-template BG] failed to delete old pdf:', result.old_pdf_path, e.message)
        }
      }

      bgAudit('journal_template_extracted', {
        journal_name: result.template?.journal_name,
        article_title: result.template?.article_title,
        section_count: result.template?.extracted_structure?.sections?.length || 0,
        model: result.model,
        duration_ms: result.durationMs,
        usage_log_id: result.usageLogId,
      })
      finishExtract('success', null)
    })
  }
)

// ────────────────────────────────────────────────────────────
// GET /:id/journal-template/extract/status.json — 优化打磨包(M32-g)
// 前端 5s 轮询;后台抽取完成后页面自动 reload。
// ────────────────────────────────────────────────────────────
router.get('/:id/journal-template/extract/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const started = project.journal_template_extract_started_at
  const status = project.journal_template_extract_status
  const finished = project.journal_template_extract_finished_at
  const error = project.journal_template_extract_error
  const elapsedS = started
    ? Math.max(0, Math.floor((Date.now() - new Date(started + ' UTC').getTime()) / 1000))
    : 0
  // 15 min 容忍窗口(Opus 4.8 + 大 PDF 最坏 5-8 min,留余量)
  const inFlight = !!(status === 'running' && started && elapsedS < 15 * 60)

  res.json({
    ok: true,
    in_flight: inFlight,
    status,
    started_at: started,
    finished_at: finished,
    error,
    elapsed_s: elapsedS,
    pending_filename: project.journal_template_extract_pending_filename || null,
  })
})

// ────────────────────────────────────────────────────────────
// 2026-05-25 P2-9: POST /:id/journal-template/backfill-abstract-format
// 老项目当年抽期刊模板没 abstract_format 字段 → 加一个"重抽 abstract_format"
// 单字段补抽路由。一次 Sonnet 调用,几秒回。drafter 后续 abstract 段就能
// 按目标期刊真实习惯(单段 / structured headings)输出。
// ────────────────────────────────────────────────────────────
router.post('/:id/journal-template/backfill-abstract-format', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      return res.status(404).json({ ok: false, error: 'not_found' })
    }
    req.session.flash = { type: 'error', message: '项目不存在或无权访问' }
    return res.redirect('/projects')
  }

  const force = String(req.body?.force || req.query?.force || '') === '1'

  let result
  try {
    result = await backfillAbstractFormat(db, {
      projectId: project.id,
      userId: req.user.id,
      force,
    })
  } catch (e) {
    audit(db, req, {
      eventType: 'journal_template_backfill_abstract_format_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { error: e?.message || String(e) },
    })
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      return res.status(500).json({ ok: false, status: 'exception', error: e?.message || String(e) })
    }
    req.session.flash = { type: 'error', message: '补抽 abstract_format 失败:' + (e?.message || '') }
    return res.redirect(`/projects/${project.id}/journal-template`)
  }

  audit(db, req, {
    eventType: result.ok
      ? 'journal_template_backfill_abstract_format_ok'
      : 'journal_template_backfill_abstract_format_failed',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      status: result.status,
      replaced: !!result.replaced,
      shape: result.abstract_format?.shape || null,
      error: result.error || null,
      usage_log_id: result.usageLogId || null,
    },
  })

  if (req.xhr || (req.headers.accept || '').includes('json')) {
    return res.status(result.ok ? 200 : 400).json(result)
  }

  if (result.ok) {
    req.session.flash = {
      type: 'success',
      message: result.status === 'already_filled'
        ? 'abstract_format 已存在,无需补抽(传 force=1 强制重抽)'
        : `abstract_format 已补抽:shape = ${result.abstract_format?.shape || '?'}`,
    }
  } else {
    req.session.flash = { type: 'error', message: '补抽失败:' + (result.error || result.status) }
  }
  res.redirect(`/projects/${project.id}/journal-template`)
})

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
