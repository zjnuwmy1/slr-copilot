/**
 * Phase 9 · Agent U — CSV 导入路由(WoS / Scopus / PubMed)
 *
 * 挂载点(server.js 由调用方接入):/projects/:id/import/csv
 *
 * 路由(使用 mergeParams,从父 :id 拿 projectId,全部要求 requireUser):
 *   POST /                单文件 multipart (.csv ≤ 50MB) → utf-8 解码 → ingestCsv
 *                         成功 → flash success + redirect 到 /projects/:id/records
 *                         失败(unknown format / 空文件等)→ flash error + redirect 回 /projects/:id/zotero
 *
 * server.js mount 代码(请加在 zotero router 同区段):
 *   import projectImportCsvRouter from './routes/projects/import-csv.js'
 *   app.use('/projects/:id/import/csv', requireUser, projectImportCsvRouter)
 */

import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { ingestCsv } from '../../services/csv-ingest.js'
import { audit } from '../../services/audit.js'

const router = express.Router({ mergeParams: true })

const MAX_CSV_BYTES = 50 * 1024 * 1024 // 50 MB

// CSV 用 multer disk storage(临时目录),处理完删文件;
// 避免 memoryStorage 在 50MB 大小下一次性占住堆。
const TMP_ROOT = path.join(os.tmpdir(), 'slr-csv-uploads')
try { fs.mkdirSync(TMP_ROOT, { recursive: true }) } catch { /* ignore */ }

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) { cb(null, TMP_ROOT) },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.csv'
      cb(null, `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    // 接受 .csv / .tsv / .txt(WoS 的 tab-separated 有时是 .txt)
    if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
      return cb(null, true)
    }
    cb(new Error('只接受 .csv / .tsv / .txt 文件(WoS / Scopus / PubMed 导出)'))
  },
})

function ownProjectOr404(db, projectId, userId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)
}

function cleanupTmp(file) {
  if (!file || !file.path) return
  try { fs.unlinkSync(file.path) } catch { /* ignore */ }
}

// ---------- POST /  ----------
router.post(
  '/',
  (req, res, next) => {
    // 校验项目归属
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    // 上传 CSV 必须先锁定检索方案(PRISMA 报告需要 source-of-truth 的查询快照)
    if (!project.search_locked_at) {
      req.session.flash = {
        type: 'error',
        message: '请先在「检索式」页锁定最终方案(标明每个库实际用了什么检索式 + 命中数 + 日期)再上传 CSV。',
      }
      return res.redirect(`/projects/${project.id}/search`)
    }
    req._project = project
    next()
  },
  (req, res, next) => {
    upload.single('csv_file')(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: 'CSV 上传失败:' + (err.message || String(err)) }
        return res.redirect(`/projects/${req.params.id}/zotero`)
      }
      next()
    })
  },
  (req, res, next) => {
    try {
      const db = req.app.locals.db
      const project = req._project
      const file = req.file
      if (!file) {
        req.session.flash = { type: 'error', message: '请选择一个 .csv 文件' }
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      let csvText
      try {
        csvText = fs.readFileSync(file.path, 'utf8')
      } catch (e) {
        cleanupTmp(file)
        req.session.flash = { type: 'error', message: '读取 CSV 失败:' + (e.message || String(e)) }
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      let summary
      try {
        summary = ingestCsv(db, {
          projectId: project.id,
          userId: req.user.id,
          csvText,
          sourceFilename: file.originalname || null,
        })
      } catch (e) {
        cleanupTmp(file)
        req.session.flash = { type: 'error', message: 'CSV 解析或入库失败:' + (e.message || String(e)) }
        return res.redirect(`/projects/${project.id}/zotero`)
      } finally {
        cleanupTmp(file)
      }

      // 识别失败 → 不写库,flash error
      if (summary.format === 'unknown') {
        req.session.flash = {
          type: 'error',
          message:
            '无法识别 CSV 格式。请确保是 WoS / Scopus / PubMed 的原始导出文件(首行包含字段表头)。' +
            (summary.errors && summary.errors.length ? ' 细节:' + summary.errors.join('; ') : ''),
        }
        // 即使识别失败也记一行 audit,便于排查
        audit(db, req, {
          eventType: 'csv_import_failed',
          userId: req.user.id,
          projectId: project.id,
          payload: {
            source_filename: file.originalname || null,
            size_bytes: file.size || null,
            reason: 'unknown_format',
            errors: summary.errors || [],
          },
        })
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      audit(db, req, {
        eventType: 'csv_imported',
        userId: req.user.id,
        projectId: project.id,
        payload: {
          format: summary.format,
          source_filename: file.originalname || null,
          size_bytes: file.size || null,
          total_parsed: summary.total_parsed,
          total_inserted: summary.total_inserted,
          total_duplicates: summary.total_duplicates,
          errors: summary.errors || [],
        },
      })

      req.session.flash = {
        type: 'success',
        message:
          `CSV 导入成功(${summary.format.toUpperCase()}):` +
          `共解析 ${summary.total_parsed} 条,入库 ${summary.total_inserted} 条,` +
          `跳过重复 ${summary.total_duplicates} 条。`,
      }
      // 跳到文献列表
      res.redirect(`/projects/${project.id}/records`)
    } catch (e) {
      next(e)
    }
  },
)

export default router
