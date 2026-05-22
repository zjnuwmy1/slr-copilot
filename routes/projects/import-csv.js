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
  limits: { fileSize: MAX_CSV_BYTES, files: 10 },
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
    // 一次最多 10 个文件(每个 50 MB),WoS+Scopus+PubMed+IEEE 同时上传也够
    upload.array('csv_file', 10)(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: '上传失败:' + (err.message || String(err)) }
        return res.redirect(`/projects/${req.params.id}/zotero`)
      }
      next()
    })
  },
  async (req, res, next) => {
    const db = req.app.locals.db
    const project = req._project
    const files = req.files || []
    if (files.length === 0) {
      req.session.flash = { type: 'error', message: '请至少选择 1 个 .csv / .xlsx / .xls 文件' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }

    // 逐文件处理 — 文件之间不互相阻断;失败的文件单独记录到 perFile.errors
    const perFile = [] // { filename, format, parsed, inserted, mergedSameDb, mergedCrossDb, error? }
    for (const file of files) {
      const ext = path.extname(file.originalname || '').toLowerCase()
      const isExcel = EXCEL_EXTS.includes(ext)
      let csvText = null
      try {
        if (isExcel) {
          csvText = await excelFileToCsvText(file.path)
        } else {
          csvText = fs.readFileSync(file.path, 'utf8')
        }
      } catch (e) {
        cleanupTmp(file)
        perFile.push({
          filename: file.originalname || '(unknown)',
          format: 'unknown',
          parsed: 0, inserted: 0, mergedSameDb: 0, mergedCrossDb: 0,
          error: (isExcel ? 'Excel 解析失败:' : '读取失败:') + (e.message || String(e)),
        })
        continue
      }

      try {
        const summary = ingestCsv(db, {
          projectId: project.id,
          userId: req.user.id,
          csvText,
          sourceFilename: file.originalname || null,
        })
        perFile.push({
          filename: file.originalname || '(unknown)',
          format: summary.format,
          parsed: summary.total_parsed,
          inserted: summary.total_inserted,
          mergedSameDb: summary.total_merged_same_db || 0,
          mergedCrossDb: summary.total_merged_cross_db || 0,
          error: summary.format === 'unknown'
            ? '无法识别格式(请确保是 WoS / Scopus / PubMed 原始导出)'
            : (summary.errors?.length ? summary.errors.join('; ') : null),
        })
        audit(db, req, {
          eventType: summary.format === 'unknown' ? 'csv_import_failed' : 'csv_imported',
          userId: req.user.id,
          projectId: project.id,
          payload: {
            format: summary.format,
            source_filename: file.originalname || null,
            size_bytes: file.size || null,
            total_parsed: summary.total_parsed,
            total_inserted: summary.total_inserted,
            total_merged_same_db: summary.total_merged_same_db,
            total_merged_cross_db: summary.total_merged_cross_db,
            errors: summary.errors || [],
          },
        })
      } catch (e) {
        perFile.push({
          filename: file.originalname || '(unknown)',
          format: 'unknown',
          parsed: 0, inserted: 0, mergedSameDb: 0, mergedCrossDb: 0,
          error: '入库失败:' + (e.message || String(e)),
        })
        audit(db, req, {
          eventType: 'csv_import_failed',
          userId: req.user.id,
          projectId: project.id,
          payload: {
            source_filename: file.originalname || null,
            size_bytes: file.size || null,
            reason: 'exception',
            error: (e.message || String(e)).slice(0, 300),
          },
        })
      } finally {
        cleanupTmp(file)
      }
    }

    // 汇总 flash
    const totalInserted = perFile.reduce((s, f) => s + f.inserted, 0)
    const totalMergedSame = perFile.reduce((s, f) => s + f.mergedSameDb, 0)
    const totalMergedCross = perFile.reduce((s, f) => s + f.mergedCrossDb, 0)
    const failed = perFile.filter((f) => f.error)
    const perFileSummary = perFile
      .map((f) => {
        if (f.error) return `${f.filename}: ✗ ${f.error.slice(0, 60)}`
        return `${f.filename} → ${f.format} (新增 ${f.inserted}${f.mergedCrossDb ? ', 跨库合并 ' + f.mergedCrossDb : ''}${f.mergedSameDb ? ', 同库重复 ' + f.mergedSameDb : ''})`
      })
      .join(' · ')

    req.session.flash = {
      type: failed.length === perFile.length ? 'error' : (failed.length ? 'error' : 'success'),
      message:
        `处理 ${perFile.length} 个文件:共新增 ${totalInserted} 条,` +
        `跨库合并 ${totalMergedCross} 条(同一论文跨多库收录,已合并 source_databases),` +
        `同库重复 ${totalMergedSame} 条。详情:${perFileSummary}`,
    }

    res.redirect(`/projects/${project.id}/records`)
  },
)

export default router
