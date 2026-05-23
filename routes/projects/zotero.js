/**
 * Phase 4 · Agent H — Zotero RDF 包上传与 ingest 触发路由
 *
 * 挂载点(由 server.js 在汇总层 mount):/projects/:id/zotero
 *
 * 路由(全部要求 requireUser;两个 admin-staging 端点额外要求 admin):
 *   GET  /                       入口页:无包则显示上传 + admin staging,有包则列最近包
 *   POST /upload                 multipart/form-data 上传 zip → 解压 → 创建 package row → 后台 ingest → 重定向 :packageId
 *   GET  /admin-staging          列 /var/lib/slr/uploads/staging/ 下的子目录
 *   POST /admin-staging          按 body.staging_dirname 创建 package row → 后台 ingest → 重定向 :packageId
 *   GET  /:packageId             manifest 页(轮询 state.json 显示状态)
 *   GET  /:packageId/state.json  状态 JSON 端点(前端 fetch 轮询)
 *
 * 实际 RDF 解析由 services/zotero-ingest.js (Agent G) 提供。本路由只触发,不解析。
 * 若 G 尚未合并,本文件 import 会在路由执行时 throw,捕获后落 status='failed';
 * upload / staging POST 路径本身仍能成功(包目录已写盘,row 已建)。
 */

import express from 'express'
import multer from 'multer'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import { getProjectProgress } from '../../services/prisma.js'
import {
  ensureRoomForUpload as quotaEnsureRoomForUpload,
  formatBytes as quotaFormatBytes,
  createReservation,
  releaseReservation,
} from '../../services/storage-quota.js'

const router = express.Router({ mergeParams: true })

// ---------- 配置 ----------
// 生产环境默认 /var/lib/slr/uploads,dev 可用 SLR_UPLOAD_ROOT 覆盖
const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
const STAGING_DIR = path.join(UPLOAD_ROOT, 'staging')
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 // 1 GB(单包硬上限,实际还受用户存储配额限制)

// 保证 root 存在,multer 写入前不会爆
function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    // 没权限时不要硬崩,让请求自然 500 — 部署期会先 mkdir/chown
    console.error('[zotero] mkdir failed:', dir, e.message)
  }
}
ensureDirSync(UPLOAD_ROOT)

// ---------- 工具 ----------
function ownProjectOr404(db, projectId, userId) {
  return db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
}

// 加载 Agent G 的 ingest 服务。延迟到调用点,避免本文件被 import 时就因为 G 未完成而崩。
async function loadIngest() {
  try {
    const mod = await import('../../services/zotero-ingest.js')
    if (typeof mod.ingestPackage !== 'function') {
      throw new Error('services/zotero-ingest.js does not export ingestPackage()')
    }
    return mod
  } catch (e) {
    throw new Error(`zotero-ingest service not available yet: ${e.message}`)
  }
}

// 加载二次匹配 + 合并服务。同样懒加载。
async function loadReconcileAndMerge() {
  const recon = await import('../../services/zotero-reconcile.js')
  const merge = await import('../../services/zotero-merge.js')
  if (typeof recon.reconcilePackage !== 'function') {
    throw new Error('services/zotero-reconcile.js does not export reconcilePackage()')
  }
  if (typeof merge.mergeZoteroIntoSystem !== 'function') {
    throw new Error('services/zotero-merge.js does not export mergeZoteroIntoSystem()')
  }
  return { reconcilePackage: recon.reconcilePackage, mergeZoteroIntoSystem: merge.mergeZoteroIntoSystem }
}

// ingest 跑完后,跟系统已 include 的 records 做二次匹配并把字段合并回去。
// 报告落到 zotero_packages.reconciliation_json。任一步失败只 warn,不影响包状态。
async function runReconcileAndMerge(db, { projectId, packageId, packageRootPath }) {
  try {
    const { parseZoteroRdf } = await import('../../services/zotero-ingest.js')
    if (typeof parseZoteroRdf !== 'function') {
      throw new Error('parseZoteroRdf not exported')
    }
    // 跟 ingestPackage 用一样的查找逻辑:优先用 DB 里 rdf_filename(可能含 "ai下载/ai下载.rdf"
    // 这种子目录路径),fallback 顶层扫,再 fallback 一层子目录扫。
    // 之前只扫顶层 → RDF 在子目录里时 early-return → 整个 reconciliation 跳过 → screening
    // include 的 records 永远 has_pdf=0,即使包里其实有 100 多个 PDF。
    let rdfName = null
    try {
      const row = db.prepare('SELECT rdf_filename FROM zotero_packages WHERE id = ?').get(packageId)
      if (row && row.rdf_filename) {
        const candidate = path.join(packageRootPath, row.rdf_filename)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) rdfName = row.rdf_filename
      }
    } catch {}
    if (!rdfName) {
      const entries = fs.readdirSync(packageRootPath)
      rdfName = entries.find((n) => n.toLowerCase().endsWith('.rdf')) || null
      if (!rdfName) {
        for (const n of entries) {
          const sub = path.join(packageRootPath, n)
          let st; try { st = fs.statSync(sub) } catch { continue }
          if (!st.isDirectory()) continue
          const inner = fs.readdirSync(sub)
          const m = inner.find((x) => x.toLowerCase().endsWith('.rdf'))
          if (m) { rdfName = path.join(n, m); break }
        }
      }
    }
    if (!rdfName) {
      console.warn('[zotero reconcile] no rdf in', packageRootPath)
      return
    }
    const rdfPath = path.join(packageRootPath, rdfName)
    const rdfText = fs.readFileSync(rdfPath, 'utf8')
    // Parser 的 packageRootPath 必须用 rdf 所在目录(z:path 是相对 rdf 的),
    // 不能直接传顶层 extractDir,否则 PDF 文件找不到。同 ingestPackage 的修复。
    const rdfDir = path.dirname(rdfPath)
    const parsed = parseZoteroRdf({ rdfText, packageRootPath: rdfDir })

    const { reconcilePackage, mergeZoteroIntoSystem } = await loadReconcileAndMerge()
    const report = reconcilePackage(db, {
      projectId,
      packageId,
      zoteroRecords: parsed.records || [],
    })
    const mergeResult = await mergeZoteroIntoSystem(db, projectId, report)

    // 落盘 — 不要把 PDF storage_path 之类的大字段全塞,保留必要字段
    const slim = {
      stats: report.stats,
      matched: report.matched.map((m) => ({
        system_record_id: m.system_record_id,
        match_type: m.match_type,
        score: m.score,
        zotero: {
          title: m.zotero_record?.title || '',
          doi: m.zotero_record?.doi || '',
          year: m.zotero_record?.year || null,
          authors_text: m.zotero_record?.authors_text || '',
          journal: m.zotero_record?.journal || '',
          has_pdf: !!m.zotero_record?.has_pdf,
        },
      })),
      extra_in_zotero: (report.extra_in_zotero || []).map((z) => ({
        title: z.title || '',
        doi: z.doi || '',
        year: z.year || null,
        authors_text: z.authors_text || '',
        journal: z.journal || '',
        has_pdf: !!z.has_pdf,
      })),
      extra_in_system: (report.extra_in_system || []).map((r) => ({
        id: r.id,
        title: r.title || '',
        doi: r.doi || '',
        year: r.year || null,
        authors_text: r.authors_text || '',
        journal: r.journal || '',
      })),
      merge: mergeResult,
      reconciled_at: new Date().toISOString(),
    }

    db.prepare(
      `UPDATE zotero_packages SET reconciliation_json = ? WHERE id = ?`
    ).run(JSON.stringify(slim), packageId)

    // 如果 merge 阶段有 PDF 拷贝失败,把错误摘要写到 zotero_packages.error_message
    // 让用户在包详情页第一时间看到(否则会"看起来成功了"但实际部分 PDF 没关联)
    const pdfErrors = (mergeResult && Array.isArray(mergeResult.pdf_errors)) ? mergeResult.pdf_errors : []
    if (pdfErrors.length > 0) {
      const sample = pdfErrors.slice(0, 3)
        .map((e) => `「${e.title}」 — ${e.reason}`)
        .join(' / ')
      const msg = `合并完成,但有 ${pdfErrors.length} 篇论文的 PDF 复制失败(已影响:0 篇有 PDF 但失败的不会被标 has_pdf,screening 决定不变):${sample}${pdfErrors.length > 3 ? ' ... 其余见 reconciliation_json.merge.pdf_errors' : ''}`
      try {
        db.prepare(
          `UPDATE zotero_packages
             SET error_message = COALESCE(error_message || E'\\n', '') || ?
           WHERE id = ?`
        ).run(msg.slice(0, 2000), packageId)
      } catch (e2) {
        console.error('[zotero reconcile] write pdf_errors to error_message failed:', e2.message)
      }
    }

    // 自动 chunk merge 后挂上 PDF 的 records — 避免历史 bug 重演(PDF 落盘但 chunks 永远空,
    // 导致 LLM 抽矩阵时只读摘要,完成度大幅打折)。
    // setImmediate 异步,不阻塞 reconcile 返回。每篇 pdf-parse ~1-3 秒,串行跑不打爆内存。
    setImmediate(async () => {
      try {
        const { parseProjectPdfs } = await import('../../services/pdf-parse.js')
        const r = await parseProjectPdfs(db, { projectId, force: false })
        console.log(`[zotero reconcile] auto-chunk done: parsed=${r.parsed} skipped=${r.skipped} ocr_required=${r.ocr_required} failed=${r.failed}`)
      } catch (e) {
        console.error('[zotero reconcile] auto-chunk failed:', e.message)
      }
    })
  } catch (e) {
    console.error('[zotero reconcile] failed', packageId, e)
  }
}

// 在后台异步触发 ingest,不阻塞 HTTP。失败时把 status 写回。
function triggerIngestInBackground(db, { projectId, userId, packageId, packageRootPath, rdfFilename }) {
  setImmediate(async () => {
    try {
      // 进入 parsing 状态
      db.prepare(
        `UPDATE zotero_packages SET status = 'parsing' WHERE id = ? AND status = 'uploaded'`
      ).run(packageId)

      const mod = await loadIngest()
      await mod.ingestPackage(db, {
        projectId,
        userId,
        packageId,
        packageRootPath,
        rdfFilename: rdfFilename || null,
      })

      // ingest 已把 status 推到 'ingested';二次匹配 + 合并只在成功 ingest 后跑
      const pkg = db
        .prepare(`SELECT status FROM zotero_packages WHERE id = ?`)
        .get(packageId)
      if (pkg && pkg.status === 'ingested') {
        await runReconcileAndMerge(db, { projectId, packageId, packageRootPath })
      }
    } catch (e) {
      console.error('[zotero ingest]', packageId, e)
      try {
        db.prepare(
          `UPDATE zotero_packages SET status = 'failed', error_message = ? WHERE id = ?`
        ).run(String(e?.message || e).slice(0, 1000), packageId)
      } catch (e2) {
        console.error('[zotero ingest] failed to update status=failed', e2.message)
      }
    }
  })
}

// 找一个目录下第一个 .rdf 文件(浅扫一层即可)
async function findRdfFilename(dir) {
  try {
    const names = await fsp.readdir(dir)
    for (const n of names) {
      if (n.toLowerCase().endsWith('.rdf')) return n
    }
    // 再扫一层:Zotero 有时把 RDF 放在 zip 内子目录里
    for (const n of names) {
      const sub = path.join(dir, n)
      let st
      try { st = await fsp.stat(sub) } catch { continue }
      if (st.isDirectory()) {
        const inner = await fsp.readdir(sub)
        for (const m of inner) {
          if (m.toLowerCase().endsWith('.rdf')) return path.join(n, m)
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

// 列 staging 子目录(只列有 .rdf 的)
async function listStagingDirs() {
  let entries
  try {
    entries = await fsp.readdir(STAGING_DIR, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const full = path.join(STAGING_DIR, ent.name)
    const rdfName = await findRdfFilename(full)
    if (!rdfName) continue
    // 统计文件数与大小
    let fileCount = 0
    let totalBytes = 0
    async function walk(d) {
      let items
      try { items = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const p = path.join(d, it.name)
        if (it.isDirectory()) {
          await walk(p)
        } else if (it.isFile()) {
          fileCount += 1
          try {
            const st = await fsp.stat(p)
            totalBytes += st.size
          } catch { /* skip */ }
        }
      }
    }
    await walk(full)
    out.push({
      dirname: ent.name,
      rdf_filename: rdfName,
      file_count: fileCount,
      size_bytes: totalBytes,
    })
  }
  // 新的在前
  out.sort((a, b) => b.dirname.localeCompare(a.dirname))
  return out
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

// 防路径遍历:确保 candidate 在 base 内
function isInside(base, candidate) {
  const baseR = path.resolve(base) + path.sep
  const candR = path.resolve(candidate) + path.sep
  return candR.startsWith(baseR)
}

// 解析 manifest JSON(zotero_packages.manifest 是 TEXT)
function parseManifest(row) {
  if (!row || !row.manifest) return null
  try {
    return JSON.parse(row.manifest)
  } catch {
    return null
  }
}

// ---------- multer ----------
//
// 把 zip 写到 UPLOAD_ROOT/<package_id>/upload.zip,再用 adm-zip 解压。
// package_id 在 multer destination 里就分配好,这样 path 一开始就稳定。
const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const packageId = req._packageId || (req._packageId = randomId('pkg'))
      const dir = path.join(UPLOAD_ROOT, packageId)
      ensureDirSync(dir)
      cb(null, dir)
    },
    filename(_req, file, cb) {
      // 统一命名为 upload.zip 或保留后缀:.zip / .rdf 都接受
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, ext === '.rdf' ? 'upload.rdf' : 'upload.zip')
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.zip') || name.endsWith('.rdf')) return cb(null, true)
    cb(new Error('只接受 .zip(Zotero 导出包)或 .rdf 文件'))
  },
})

// ---------- GET / 入口页 ----------
router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }

    const packages = db
      .prepare(
        `SELECT id, source_kind, source_filename, status, size_bytes, rdf_filename,
                total_records, total_with_pdf, total_with_doi, total_duplicates,
                created_at, parsed_at, ingested_at, error_message
         FROM zotero_packages
         WHERE project_id = ? AND user_id = ?
         ORDER BY created_at DESC`
      )
      .all(project.id, req.user.id)

    // 仅 admin 才能看 staging
    let stagingDirs = []
    let stagingError = null
    if (req.user.role === 'admin') {
      try {
        stagingDirs = await listStagingDirs()
      } catch (e) {
        stagingError = e.message
      }
    }

    // Step 4 = 文献矩阵(extraction step id),Zotero 包导入是路径 B 的 PDF 准备
    let progress = { stepStatus: {}, prismaProgress: { donePct: 0, done: 0, total: 42 } }
    try { progress = getProjectProgress(db, project.id) } catch {}
    res.render('projects/zotero', {
      title: project.title + ' · Zotero 导入',
      project,
      currentStep: 'extraction',
      stepLabel: '4. 文献矩阵 · Zotero 导入',
      progress,
      packages,
      stagingDirs,
      stagingError,
      maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
      formatBytes,
    })
  } catch (e) {
    next(e)
  }
})

// ---------- POST /upload ----------
router.post(
  '/upload',
  requireAdvancedExtraction,    // ← 高级功能,仅超管开通的用户可上传 PDF/Zotero 包
  (req, res, next) => {
    // 在 multer 跑之前先校验项目归属(否则任意人都能往 UPLOAD_ROOT 写)
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    req._project = project

    // 存储配额预检 —— 用 Content-Length 估算(multer 还没读完 body 时唯一能拿到的体积线索)
    // B2.2:预检通过后立即 createReservation 占住这段配额,防并发上传超额。
    //       下游 next handler 在 success/error 路径上都必须 releaseReservation,
    //       30 分钟后自动过期是兜底。
    const contentLength = Number(req.headers['content-length']) || 0
    if (contentLength > 0) {
      const check = quotaEnsureRoomForUpload(db, req.user, contentLength)
      if (!check.ok) {
        req.session.flash = {
          type: 'error',
          message: check.message + '(本次 ≈ ' + quotaFormatBytes(contentLength) + ')。请联系超级管理员提高配额,或先删除旧的 zotero 包腾出空间。',
        }
        return res.redirect(`/projects/${req.params.id}/zotero`)
      }
      req._reservationId = createReservation(db, req.user.id, contentLength, 'zotero_upload')
    }
    next()
  },
  (req, res, next) => {
    upload.single('package_file')(req, res, (err) => {
      if (err) {
        // multer / fileFilter 错误:释放 reservation,文件没落盘也不计入
        releaseReservation(req.app.locals.db, req._reservationId)
        req.session.flash = { type: 'error', message: '上传失败:' + (err.message || String(err)) }
        return res.redirect(`/projects/${req.params.id}/zotero`)
      }
      next()
    })
  },
  async (req, res, next) => {
    // B2.2:无论成功/失败/客户端断开,响应结束时释放 reservation。
    //       成功路径下,zotero_packages 的真实 size_bytes 已经入库进入正式占用;
    //       释放 reservation 把"双重计数"消除,storageUsedByUser 总额刚好正确。
    //       失败路径下,文件已经被 cleanup,reservation 释放后用户立刻能重传。
    res.once('close', () => releaseReservation(req.app.locals.db, req._reservationId))
    try {
      const db = req.app.locals.db
      const project = req._project
      const file = req.file
      if (!file) {
        req.session.flash = { type: 'error', message: '请选择一个 .zip 或 .rdf 文件' }
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      const packageId = req._packageId
      const packageDir = path.join(UPLOAD_ROOT, packageId)
      const extractDir = path.join(packageDir, 'extracted')

      let rdfFilename = null
      const lower = (file.originalname || '').toLowerCase()
      if (lower.endsWith('.zip')) {
        // 解压到 extracted/ — 防 zip-slip(条目名含 ../ 写出 extractDir)
        await fsp.mkdir(extractDir, { recursive: true })
        try {
          const zip = new AdmZip(file.path)
          const safeRoot = path.resolve(extractDir)
          for (const entry of zip.getEntries()) {
            const entryName = entry.entryName
            // 拒绝绝对路径 / 反斜线分隔(Windows 风格)/ 把 ".." 作为 path 段(注意不是含 ".." 子串)。
            //   早先版本用 `entryName.includes('..')` 太严:Zotero 的标题→文件名容易生出
            //   "Arti..pdf" / "Title... Sub.pdf" 这种合法名,被误判拒绝。
            //   真正的 zip-slip 是 path 中出现独立的 ".." 段(`a/../b`),而不是文件名里两个点。
            //   段级检查 + 后面的"双保险"resolve check,两道防线已足够。
            const segments = entryName.split(/[/\\]/)
            if (segments.includes('..') ||
                entryName.startsWith('/') || entryName.startsWith('\\') ||
                /^[a-zA-Z]:/.test(entryName)) {
              throw new Error(`zip 条目路径不安全:${entryName.slice(0, 80)}`)
            }
            const dest = path.resolve(extractDir, entryName)
            // 双保险:解析后的绝对路径必须仍在 extractDir 内
            if (dest !== safeRoot && !dest.startsWith(safeRoot + path.sep)) {
              throw new Error(`zip 条目逃逸:${entryName.slice(0, 80)}`)
            }
            if (entry.isDirectory) {
              await fsp.mkdir(dest, { recursive: true })
            } else {
              await fsp.mkdir(path.dirname(dest), { recursive: true })
              await fsp.writeFile(dest, entry.getData())
            }
          }
        } catch (e) {
          req.session.flash = { type: 'error', message: 'ZIP 解压失败:' + (e.message || String(e)) }
          // 清理已写入但损坏的解压目录,避免占盘(zip-slip 防御后的部分写入也清掉)
          try { await fsp.rm(extractDir, { recursive: true, force: true }) } catch {}
          try { await fsp.rm(file.path, { force: true }) } catch {}
          // 写一行 failed 包,便于排查
          db.prepare(
            `INSERT INTO zotero_packages
               (id, project_id, user_id, source_kind, source_filename, storage_path,
                size_bytes, rdf_filename, status, error_message)
             VALUES (?, ?, ?, 'web_upload', ?, ?, ?, NULL, 'failed', ?)`
          ).run(
            packageId, project.id, req.user.id,
            file.originalname || null,
            extractDir,
            file.size || null,
            String(e.message || e).slice(0, 1000),
          )
          return res.redirect(`/projects/${project.id}/zotero`)
        }
        rdfFilename = await findRdfFilename(extractDir)
      } else {
        // 单个 .rdf:把它"伪装"成 extracted/ 里的一个文件
        try {
          await fsp.mkdir(extractDir, { recursive: true })
          const dest = path.join(extractDir, path.basename(file.originalname || 'library.rdf'))
          await fsp.rename(file.path, dest)
          rdfFilename = path.basename(dest)
        } catch (e) {
          // B1.4:.rdf 处理失败也清理孤儿,同时写 failed 行让用户能看到错
          try { await fsp.rm(extractDir, { recursive: true, force: true }) } catch {}
          try { await fsp.rm(file.path, { force: true }) } catch {}
          db.prepare(
            `INSERT INTO zotero_packages
               (id, project_id, user_id, source_kind, source_filename, storage_path,
                size_bytes, rdf_filename, status, error_message)
             VALUES (?, ?, ?, 'web_upload', ?, ?, ?, NULL, 'failed', ?)`
          ).run(
            packageId, project.id, req.user.id,
            file.originalname || null,
            extractDir,
            file.size || null,
            ('.rdf 处理失败:' + (e.message || String(e))).slice(0, 1000),
          )
          req.session.flash = { type: 'error', message: '.rdf 处理失败:' + (e.message || String(e)) }
          return res.redirect(`/projects/${project.id}/zotero`)
        }
      }

      // 插行
      db.prepare(
        `INSERT INTO zotero_packages
           (id, project_id, user_id, source_kind, source_filename, storage_path,
            size_bytes, rdf_filename, status)
         VALUES (?, ?, ?, 'web_upload', ?, ?, ?, ?, 'uploaded')`
      ).run(
        packageId, project.id, req.user.id,
        file.originalname || null,
        extractDir,
        file.size || null,
        rdfFilename,
      )

      audit(db, req, {
        eventType: 'zotero_package_uploaded',
        userId: req.user.id,
        projectId: project.id,
        payload: {
          package_id: packageId,
          source_filename: file.originalname,
          size_bytes: file.size,
          rdf_filename: rdfFilename,
        },
      })

      // 后台触发 ingest
      triggerIngestInBackground(db, {
        projectId: project.id,
        userId: req.user.id,
        packageId,
        packageRootPath: extractDir,
        rdfFilename,
      })

      req.session.flash = {
        type: 'success',
        message: '上传成功,正在解析,请稍候(页面会自动刷新状态)。',
      }
      res.redirect(`/projects/${project.id}/zotero/${packageId}`)
    } catch (e) {
      next(e)
    }
  }
)

// ---------- GET /admin-staging ----------
router.get('/admin-staging', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { title: 'Forbidden', message: '需要管理员权限' })
    }
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    const stagingDirs = await listStagingDirs()
    res.json({ ok: true, staging_dir: STAGING_DIR, dirs: stagingDirs })
  } catch (e) {
    next(e)
  }
})

// ---------- POST /admin-staging ----------
router.post('/admin-staging', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { title: 'Forbidden', message: '需要管理员权限' })
    }
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }

    const dirname = String(req.body?.staging_dirname || '').trim()
    if (!dirname) {
      req.session.flash = { type: 'error', message: '缺少 staging_dirname' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }
    // 防止 ../ 跳出
    if (dirname.includes('/') || dirname.includes('\\') || dirname === '..' || dirname.startsWith('.')) {
      req.session.flash = { type: 'error', message: '非法目录名' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }

    const fullPath = path.join(STAGING_DIR, dirname)
    if (!isInside(STAGING_DIR, fullPath)) {
      req.session.flash = { type: 'error', message: '目录越权' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }

    let st
    try {
      st = await fsp.stat(fullPath)
    } catch {
      req.session.flash = { type: 'error', message: 'staging 目录不存在:' + dirname }
      return res.redirect(`/projects/${project.id}/zotero`)
    }
    if (!st.isDirectory()) {
      req.session.flash = { type: 'error', message: 'staging 不是目录' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }

    const rdfFilename = await findRdfFilename(fullPath)
    if (!rdfFilename) {
      req.session.flash = { type: 'error', message: 'staging 目录内没有 .rdf 文件' }
      return res.redirect(`/projects/${project.id}/zotero`)
    }

    // 估算大小
    let totalBytes = 0
    async function walk(d) {
      let items
      try { items = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const p = path.join(d, it.name)
        if (it.isDirectory()) await walk(p)
        else if (it.isFile()) {
          try { totalBytes += (await fsp.stat(p)).size } catch { /* skip */ }
        }
      }
    }
    await walk(fullPath)

    const packageId = randomId('pkg')
    db.prepare(
      `INSERT INTO zotero_packages
         (id, project_id, user_id, source_kind, source_filename, storage_path,
          size_bytes, rdf_filename, status)
       VALUES (?, ?, ?, 'admin_staging', ?, ?, ?, ?, 'uploaded')`
    ).run(
      packageId, project.id, req.user.id,
      dirname, fullPath, totalBytes, rdfFilename,
    )

    audit(db, req, {
      eventType: 'zotero_package_imported_from_staging',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        package_id: packageId,
        staging_dirname: dirname,
        size_bytes: totalBytes,
        rdf_filename: rdfFilename,
      },
    })

    triggerIngestInBackground(db, {
      projectId: project.id,
      userId: req.user.id,
      packageId,
      packageRootPath: fullPath,
      rdfFilename,
    })

    req.session.flash = {
      type: 'success',
      message: `已从 staging 导入 ${dirname},正在解析…`,
    }
    res.redirect(`/projects/${project.id}/zotero/${packageId}`)
  } catch (e) {
    next(e)
  }
})

// ---------- GET /:packageId  manifest 页 ----------
router.get('/:packageId', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    const pkg = db
      .prepare(
        `SELECT * FROM zotero_packages
         WHERE id = ? AND project_id = ? AND user_id = ?`
      )
      .get(req.params.packageId, project.id, req.user.id)
    if (!pkg) {
      return res.status(404).render('error', { title: 'Not Found', message: '上传包不存在' })
    }
    const manifest = parseManifest(pkg)
    let reconciliation = null
    if (pkg.reconciliation_json) {
      try {
        reconciliation = JSON.parse(pkg.reconciliation_json)
      } catch (e) {
        console.error('[zotero] parse reconciliation_json failed:', pkg.id, e.message)
      }
    }

    let progress = { stepStatus: {}, prismaProgress: { donePct: 0, done: 0, total: 42 } }
    try { progress = getProjectProgress(db, project.id) } catch {}
    res.render('projects/zotero/manifest', {
      title: project.title + ' · Zotero 解析',
      project,
      currentStep: 'extraction',
      stepLabel: '4. 文献矩阵 · Zotero 解析',
      progress,
      pkg,
      manifest,
      reconciliation,
      formatBytes,
    })
  } catch (e) {
    next(e)
  }
})

// ---------- GET /:packageId/state.json  轮询 ----------
router.get('/:packageId/state.json', (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) return res.status(404).json({ error: 'not_found' })
    const pkg = db
      .prepare(
        `SELECT id, status, total_records, total_with_pdf, total_with_doi, total_duplicates,
                error_message, created_at, parsed_at, ingested_at,
                reconciliation_json
         FROM zotero_packages
         WHERE id = ? AND project_id = ? AND user_id = ?`
      )
      .get(req.params.packageId, project.id, req.user.id)
    if (!pkg) return res.status(404).json({ error: 'not_found' })
    // 只暴露 reconciliation 是否已就绪 + 关键 stats(避免轮询每秒拉大 JSON)
    let reconciliation_ready = false
    let reconciliation_stats = null
    if (pkg.reconciliation_json) {
      try {
        const r = JSON.parse(pkg.reconciliation_json)
        reconciliation_ready = true
        reconciliation_stats = r.stats || null
      } catch {
        // ignore
      }
    }
    delete pkg.reconciliation_json
    res.json({ ...pkg, reconciliation_ready, reconciliation_stats })
  } catch (e) {
    next(e)
  }
})

// ---------- POST /:packageId/delete  ----------
// 删除整个 zotero 包 — 文件 + DB 行 + 关联 attachments。
// records 行不动(records 可能来自多个源:CSV / 其他 Zotero 包 / 手动新增,
// 删一个包不应级联删 records;只清掉本包贡献的 PDF 链接)。
router.post('/:packageId/delete', async (req, res, next) => {
  try {
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    const pkg = db.prepare(
      `SELECT id, storage_path, source_filename, status FROM zotero_packages
       WHERE id = ? AND project_id = ? AND user_id = ?`
    ).get(req.params.packageId, project.id, req.user.id)
    if (!pkg) {
      return res.status(404).render('error', { title: 'Not Found', message: '上传包不存在' })
    }

    // 1. 先把本包的 attachments(以及对应 records 的 has_pdf)处理掉。
    //    attachments.package_id = pkg.id → 删 attachments 行;
    //    对应 records.has_pdf 若不再有任何 attachment 则归 0。
    const affectedRecordIds = db.prepare(
      `SELECT DISTINCT record_id FROM attachments WHERE package_id = ?`
    ).all(pkg.id).map((r) => r.record_id)

    db.prepare(`DELETE FROM attachments WHERE package_id = ?`).run(pkg.id)

    // 重新评估每条受影响 record 的 has_pdf
    if (affectedRecordIds.length > 0) {
      const recheck = db.prepare(
        `UPDATE records SET has_pdf =
           CASE WHEN EXISTS (SELECT 1 FROM attachments WHERE record_id = records.id AND attachment_kind = 'pdf')
                THEN 1 ELSE 0 END
         WHERE id = ?`
      )
      const tx = db.transaction((ids) => { for (const id of ids) recheck.run(id) })
      tx(affectedRecordIds)
    }

    // 2. 清盘 — 用 ingest 那边一样的安全清理(限制 UPLOAD_ROOT 之内)
    if (pkg.storage_path) {
      const resolved = path.resolve(pkg.storage_path)
      const resolvedUploadRoot = path.resolve(UPLOAD_ROOT)
      if (resolved.startsWith(resolvedUploadRoot + path.sep) && resolved !== resolvedUploadRoot) {
        // storage_path 一般是 .../pkg_xxx/extracted/,清掉上一级 pkg_xxx
        const parent = path.dirname(resolved)
        const target = (parent.startsWith(resolvedUploadRoot + path.sep) && parent !== resolvedUploadRoot)
          ? parent
          : resolved
        try { fs.rmSync(target, { recursive: true, force: true }) }
        catch (e) { console.error('[zotero delete] rm failed:', target, e.message) }
      }
    }

    // 3. 删 DB 行
    db.prepare(`DELETE FROM zotero_packages WHERE id = ?`).run(pkg.id)

    audit(db, req, {
      eventType: 'zotero_package_deleted',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        package_id: pkg.id,
        source_filename: pkg.source_filename || null,
        previous_status: pkg.status,
        attachments_removed: affectedRecordIds.length,
      },
    })

    req.session.flash = {
      type: 'success',
      message: `已删除 Zotero 包「${pkg.source_filename || pkg.id}」` +
        (affectedRecordIds.length > 0 ? `(同时清掉了 ${affectedRecordIds.length} 个 record 的 PDF 关联)` : ''),
    }
    res.redirect(`/projects/${project.id}/zotero`)
  } catch (e) {
    next(e)
  }
})

export default router
