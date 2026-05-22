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

// xlsx 是 CommonJS,要 default unwrap;懒加载以便 multer fast-path 不付 cost
let XLSX_CACHED = null
async function getXLSX() {
  if (XLSX_CACHED) return XLSX_CACHED
  const mod = await import('xlsx')
  XLSX_CACHED = mod.default || mod
  return XLSX_CACHED
}

const router = express.Router({ mergeParams: true })

const MAX_CSV_BYTES = 50 * 1024 * 1024 // 50 MB

// CSV 用 multer disk storage(临时目录),处理完删文件;
// 避免 memoryStorage 在 50MB 大小下一次性占住堆。
const TMP_ROOT = path.join(os.tmpdir(), 'slr-csv-uploads')
try { fs.mkdirSync(TMP_ROOT, { recursive: true }) } catch { /* ignore */ }

// 接受的后缀:文本类 + Excel 类
const TEXT_EXTS = ['.csv', '.tsv', '.txt']
const EXCEL_EXTS = ['.xlsx', '.xls']
const ALL_EXTS = [...TEXT_EXTS, ...EXCEL_EXTS]

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) { cb(null, TMP_ROOT) },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.csv'
      cb(null, `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (ALL_EXTS.some((e) => name.endsWith(e))) return cb(null, true)
    cb(new Error('只接受 .csv / .tsv / .txt / .xlsx / .xls 文件(WoS / Scopus / PubMed 导出)'))
  },
})

/**
 * 把 .xlsx / .xls 解码成"等价 CSV 文本",直接喂进 ingestCsv 的现有 pipeline。
 * 选第一个 sheet;若 sheet 为空 → 抛错。
 * 用 RFC4180 CSV 输出,detectFormat 能识别(WoS 表头列名相同)。
 */
async function excelFileToCsvText(filePath) {
  const XLSX = await getXLSX()
  const wb = XLSX.readFile(filePath, { cellDates: false, cellText: false })
  const sheetNames = wb.SheetNames || []
  if (sheetNames.length === 0) {
    throw new Error('Excel 文件没有任何 sheet')
  }
  // WoS Export-to-Excel 第一个 sheet 名常是 "savedrecs",但我们不依赖名字
  const sheet = wb.Sheets[sheetNames[0]]
  if (!sheet) throw new Error(`Excel sheet "${sheetNames[0]}" 读取失败`)
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n', forceQuotes: false })
  if (!csv || !csv.trim()) {
    throw new Error('Excel 第一个 sheet 是空的')
  }
  return csv
}

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
  async (req, res, next) => {
    try {
      const db = req.app.locals.db
      const project = req._project
      const file = req.file
      if (!file) {
        req.session.flash = { type: 'error', message: '请选择一个 .csv / .xlsx / .xls 文件' }
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      const ext = path.extname(file.originalname || '').toLowerCase()
      const isExcel = EXCEL_EXTS.includes(ext)

      let csvText
      try {
        if (isExcel) {
          // WoS / Scopus 现在常导出 .xlsx — 转成 CSV 文本喂进同一个 pipeline
          csvText = await excelFileToCsvText(file.path)
        } else {
          csvText = fs.readFileSync(file.path, 'utf8')
        }
      } catch (e) {
        cleanupTmp(file)
        req.session.flash = {
          type: 'error',
          message: (isExcel ? 'Excel 解析失败:' : '读取文件失败:') + (e.message || String(e)),
        }
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
        req.session.flash = {
          type: 'error',
          message: (isExcel ? 'Excel→CSV 入库失败:' : 'CSV 解析或入库失败:') + (e.message || String(e)),
        }
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
