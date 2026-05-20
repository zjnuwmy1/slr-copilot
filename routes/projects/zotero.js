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

const router = express.Router({ mergeParams: true })

// ---------- 配置 ----------
// 生产环境默认 /var/lib/slr/uploads,dev 可用 SLR_UPLOAD_ROOT 覆盖
const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
const STAGING_DIR = path.join(UPLOAD_ROOT, 'staging')
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

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
    return mod.ingestPackage
  } catch (e) {
    throw new Error(`zotero-ingest service not available yet: ${e.message}`)
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

      const ingestPackage = await loadIngest()
      await ingestPackage(db, {
        projectId,
        userId,
        packageId,
        packageRootPath,
        rdfFilename: rdfFilename || null,
      })
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

    res.render('projects/zotero', {
      title: project.title + ' · Zotero 导入',
      project,
      currentStep: 'screening',
      stepLabel: '3. 筛选 — Zotero 数据准备',
      progress: req.app.locals.progressFor
        ? req.app.locals.progressFor(db, project.id)
        : { stepStatus: {}, prismaProgress: { donePct: 0, done: 0, total: 42 } },
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
  (req, res, next) => {
    // 在 multer 跑之前先校验项目归属(否则任意人都能往 UPLOAD_ROOT 写)
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
    }
    req._project = project
    next()
  },
  (req, res, next) => {
    upload.single('package_file')(req, res, (err) => {
      if (err) {
        // multer / fileFilter 错误
        req.session.flash = { type: 'error', message: '上传失败:' + (err.message || String(err)) }
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
        req.session.flash = { type: 'error', message: '请选择一个 .zip 或 .rdf 文件' }
        return res.redirect(`/projects/${project.id}/zotero`)
      }

      const packageId = req._packageId
      const packageDir = path.join(UPLOAD_ROOT, packageId)
      const extractDir = path.join(packageDir, 'extracted')

      let rdfFilename = null
      const lower = (file.originalname || '').toLowerCase()
      if (lower.endsWith('.zip')) {
        // 解压到 extracted/
        await fsp.mkdir(extractDir, { recursive: true })
        try {
          const zip = new AdmZip(file.path)
          zip.extractAllTo(extractDir, /* overwrite */ true)
        } catch (e) {
          req.session.flash = { type: 'error', message: 'ZIP 解压失败:' + (e.message || String(e)) }
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
        await fsp.mkdir(extractDir, { recursive: true })
        const dest = path.join(extractDir, path.basename(file.originalname || 'library.rdf'))
        await fsp.rename(file.path, dest)
        rdfFilename = path.basename(dest)
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

    res.render('projects/zotero/manifest', {
      title: project.title + ' · Zotero 解析',
      project,
      currentStep: 'screening',
      stepLabel: '3. 筛选 — Zotero 解析结果',
      progress: { stepStatus: {}, prismaProgress: { donePct: 0, done: 0, total: 42 } },
      pkg,
      manifest,
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
                error_message, created_at, parsed_at, ingested_at
         FROM zotero_packages
         WHERE id = ? AND project_id = ? AND user_id = ?`
      )
      .get(req.params.packageId, project.id, req.user.id)
    if (!pkg) return res.status(404).json({ error: 'not_found' })
    res.json(pkg)
  } catch (e) {
    next(e)
  }
})

export default router
