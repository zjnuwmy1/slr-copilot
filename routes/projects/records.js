/**
 * Phase 4 Agent I — Records 浏览(Zotero ingest 后的文献条目列表 + 详情 + PDF 下载)
 *
 * 挂载方式(由 server.js 汇总层完成):
 *   import projectRecordsRouter from './routes/projects/records.js'
 *   app.use('/projects', requireUser, projectRecordsRouter)
 *
 * 用 mergeParams 拿到 :id(= project_id),沿用 routes/projects/search.js 的模式。
 *
 * 路由清单:
 *   GET  /:id/records                                    列表(过滤 + 分页)
 *   GET  /:id/records/:recordId                          详情(metadata + abstract + 附件)
 *   GET  /:id/attachments/:attachmentId/download         下载 / 内联预览(校验归属 + 路径遍历防御)
 */

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { getProjectProgress } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

// ============================================================
// 配置
// ============================================================

// 上传根目录:storage_path 必须在这个目录下,防止路径遍历
// 与 DATA_DIR 保持一致(默认 /var/lib/slr),uploads 子目录
const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOADS_ROOT = path.resolve(path.join(DATA_DIR, 'uploads'))

const PAGE_SIZE = 50

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

function ownProjectOr404(db, projectId, userId) {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
  return parseProject(row)
}

// authors_json 解析:返回 [{surname, givenName, full}]
function parseAuthors(row) {
  if (!row) return []
  if (Array.isArray(row)) return row
  if (typeof row !== 'string') return []
  try {
    const x = JSON.parse(row)
    return Array.isArray(x) ? x : []
  } catch {
    return []
  }
}

// 给列表用:authors 缩成 "Wang G, Tang R, Xu M et al"
function shortAuthorList(authorsJson, authorsText, maxCount = 3) {
  if (authorsText && typeof authorsText === 'string') {
    const parts = authorsText.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > maxCount) {
      return parts.slice(0, maxCount).join(', ') + ' et al.'
    }
    return parts.join(', ')
  }
  const authors = parseAuthors(authorsJson)
  if (authors.length === 0) return ''
  const names = authors.map((a) => a.full || `${a.surname || ''} ${a.givenName || ''}`.trim()).filter(Boolean)
  if (names.length > maxCount) {
    return names.slice(0, maxCount).join(', ') + ' et al.'
  }
  return names.join(', ')
}

// 把单个 record row 整理成 view-ready 对象
function shapeRecord(row) {
  if (!row) return null
  return {
    ...row,
    authors_list: parseAuthors(row.authors_json),
    authors_short: shortAuthorList(row.authors_json, row.authors_text, 3),
    keywords_list: parseJsonArrayField(row.keywords_json),
    has_doi: !!(row.doi && String(row.doi).trim()),
    has_notes: !!(row.notes && String(row.notes).trim()),
    is_duplicate: !!row.duplicate_of_record_id,
  }
}

// 解析查询字符串
function parseFilters(query) {
  const f = {
    has_pdf: query.has_pdf === '1' || query.has_pdf === 'on' || query.has_pdf === 'true',
    has_doi: query.has_doi === '1' || query.has_doi === 'on' || query.has_doi === 'true',
    // 默认隐藏重复(query 未传 = 选中;显式 ='0' 才显示)
    hide_duplicates: query.hide_duplicates !== '0',
    year_from: null,
    year_to: null,
    q: '',
  }
  if (query.year_from) {
    const n = parseInt(query.year_from, 10)
    if (Number.isFinite(n) && n > 0 && n < 9999) f.year_from = n
  }
  if (query.year_to) {
    const n = parseInt(query.year_to, 10)
    if (Number.isFinite(n) && n > 0 && n < 9999) f.year_to = n
  }
  if (query.q) {
    f.q = String(query.q).slice(0, 200).trim()
  }
  return f
}

// 列表 SQL builder(参数化)
function buildListQuery(projectId, filters, page) {
  const where = ['r.project_id = ?']
  const params = [projectId]

  if (filters.hide_duplicates) {
    where.push('r.duplicate_of_record_id IS NULL')
  }
  if (filters.has_pdf) {
    where.push('r.has_pdf = 1')
  }
  if (filters.has_doi) {
    where.push("r.doi IS NOT NULL AND r.doi != ''")
  }
  if (filters.year_from != null) {
    where.push('r.year >= ?')
    params.push(filters.year_from)
  }
  if (filters.year_to != null) {
    where.push('r.year <= ?')
    params.push(filters.year_to)
  }
  if (filters.q) {
    // 跨 title / authors_text / journal / doi 搜
    where.push(`(
      r.title LIKE ? OR
      r.authors_text LIKE ? OR
      r.journal LIKE ? OR
      r.doi LIKE ?
    )`)
    const like = `%${filters.q}%`
    params.push(like, like, like, like)
  }

  const whereSql = where.join(' AND ')
  const offset = (page - 1) * PAGE_SIZE

  const listSql = `
    SELECT r.*,
      (SELECT COUNT(*) FROM attachments WHERE record_id = r.id AND attachment_kind = 'pdf') AS pdf_count,
      (SELECT COUNT(*) FROM attachments WHERE record_id = r.id) AS total_attachments
    FROM records r
    WHERE ${whereSql}
    ORDER BY (r.year IS NULL), r.year DESC, r.title
    LIMIT ? OFFSET ?
  `
  const countSql = `SELECT COUNT(*) AS n FROM records r WHERE ${whereSql}`

  return {
    listSql,
    listParams: [...params, PAGE_SIZE, offset],
    countSql,
    countParams: [...params],
  }
}

function getStats(db, projectId) {
  // 统计 — 不受过滤影响(展示项目全貌)
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN has_pdf = 1 THEN 1 ELSE 0 END) AS with_pdf,
        SUM(CASE WHEN doi IS NOT NULL AND doi != '' THEN 1 ELSE 0 END) AS with_doi,
        SUM(CASE WHEN duplicate_of_record_id IS NOT NULL THEN 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN abstract IS NULL OR abstract = '' THEN 1 ELSE 0 END) AS missing_abstract
      FROM records
      WHERE project_id = ?`
    )
    .get(projectId) || {}
  return {
    total: row.total || 0,
    with_pdf: row.with_pdf || 0,
    with_doi: row.with_doi || 0,
    duplicates: row.duplicates || 0,
    missing_abstract: row.missing_abstract || 0,
  }
}

// 构造翻页 URL,保留过滤参数
function buildPageHref(basePath, query, page) {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.has_pdf) params.set('has_pdf', '1')
  if (query.has_doi) params.set('has_doi', '1')
  if (query.hide_duplicates === '0') params.set('hide_duplicates', '0')
  if (query.year_from) params.set('year_from', String(query.year_from))
  if (query.year_to) params.set('year_to', String(query.year_to))
  params.set('page', String(page))
  return `${basePath}?${params.toString()}`
}

// ============================================================
// GET /projects/:id/records — 列表
// ============================================================
router.get('/:id/records', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const filters = parseFilters(req.query)
  let page = parseInt(req.query.page, 10)
  if (!Number.isFinite(page) || page < 1) page = 1

  const { listSql, listParams, countSql, countParams } = buildListQuery(
    project.id,
    filters,
    page
  )

  const totalFiltered = (db.prepare(countSql).get(...countParams) || {}).n || 0
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE))
  if (page > totalPages) page = totalPages
  // 如果 page 被修正,重新算 offset
  const safeParams = [...listParams]
  safeParams[safeParams.length - 1] = (page - 1) * PAGE_SIZE

  const rows = db.prepare(listSql).all(...safeParams).map(shapeRecord)
  const stats = getStats(db, project.id)

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[records:list] getProjectProgress failed:', e.message)
  }

  // 年份范围(给 UI 显示用)
  const yearRange = db
    .prepare(
      'SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM records WHERE project_id = ? AND year IS NOT NULL'
    )
    .get(project.id) || {}

  res.render('projects/records/list', {
    title: `文献条目 · ${project.title}`,
    project,
    progress,
    currentStep: 'screening',
    stepLabel: '3. 筛选(Screening)',
    records: rows,
    stats,
    filters,
    rawQuery: req.query,
    page,
    pageSize: PAGE_SIZE,
    totalFiltered,
    totalPages,
    yearRange: {
      min_year: yearRange.min_year || null,
      max_year: yearRange.max_year || null,
    },
    pageHref: (p) => buildPageHref(`/projects/${project.id}/records`, req.query, p),
  })
})

// ============================================================
// GET /projects/:id/records/:recordId — 详情
// ============================================================
router.get('/:id/records/:recordId', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const row = db
    .prepare('SELECT * FROM records WHERE id = ? AND project_id = ?')
    .get(req.params.recordId, project.id)
  if (!row) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '文献条目不存在' })
  }
  const record = shapeRecord(row)

  const attachments = db
    .prepare(
      `SELECT id, record_id, attachment_kind, filename, size_bytes, mime_type, created_at
       FROM attachments
       WHERE record_id = ?
       ORDER BY
         CASE attachment_kind WHEN 'pdf' THEN 0 WHEN 'html' THEN 1 WHEN 'snapshot' THEN 2 ELSE 3 END,
         filename`
    )
    .all(record.id)

  // 重复组:展示同组的其他条目(同 group_id 或被合并到本条 / 本条合并到的主条)
  let duplicateGroup = []
  if (record.duplicate_group_id) {
    duplicateGroup = db
      .prepare(
        `SELECT id, title, year, journal, doi, duplicate_of_record_id
         FROM records
         WHERE project_id = ? AND duplicate_group_id = ? AND id != ?
         ORDER BY (duplicate_of_record_id IS NULL) DESC, title
         LIMIT 20`
      )
      .all(project.id, record.duplicate_group_id, record.id)
  }
  // 如果本条是副本,把它的主记录也带上
  let mergedInto = null
  if (record.duplicate_of_record_id) {
    mergedInto = db
      .prepare(
        `SELECT id, title, year, journal, doi
         FROM records
         WHERE id = ? AND project_id = ?`
      )
      .get(record.duplicate_of_record_id, project.id)
  }

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[records:detail] getProjectProgress failed:', e.message)
  }

  res.render('projects/records/detail', {
    title: `${record.title} · ${project.title}`,
    project,
    progress,
    currentStep: 'screening',
    stepLabel: '3. 筛选(Screening)',
    record,
    attachments,
    duplicateGroup,
    mergedInto,
  })
})

// ============================================================
// GET /projects/:id/attachments/:attachmentId/download
// ============================================================
router.get('/:id/attachments/:attachmentId/download', (req, res) => {
  const db = req.app.locals.db
  // 不用 ownProjectOr404 渲染 404 页 — 这里直接 JOIN 校验归属
  const projectId = req.params.id
  const attachmentId = req.params.attachmentId

  // 先校验项目归属(避免泄露存在性)
  const projectRow = db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, req.user.id)
  if (!projectRow) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const row = db
    .prepare(
      `SELECT a.id, a.storage_path, a.filename, a.mime_type, a.attachment_kind, a.size_bytes
       FROM attachments a
       JOIN records r ON r.id = a.record_id
       WHERE a.id = ? AND r.project_id = ?`
    )
    .get(attachmentId, projectId)

  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '附件不存在或无权访问' })
  }

  if (!row.storage_path) {
    return res.status(500).render('error', { title: 'Server Error', message: '附件路径缺失' })
  }

  // 路径遍历防御:必须在 UPLOADS_ROOT 下
  const absolute = path.resolve(row.storage_path)
  // 用 path.relative + startsWith 双保险
  const rel = path.relative(UPLOADS_ROOT, absolute)
  const isInside =
    absolute === UPLOADS_ROOT ||
    (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (!isInside) {
    console.error('[records:download] path outside uploads root', {
      attachmentId,
      storage_path: row.storage_path,
      absolute,
      uploads_root: UPLOADS_ROOT,
    })
    return res.status(403).render('error', { title: 'Forbidden', message: '附件路径非法' })
  }

  // 文件是否实际存在
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile()) {
      return res.status(404).render('error', { title: 'Not Found', message: '附件文件不存在' })
    }
  } catch (e) {
    console.error('[records:download] statSync failed:', e.message)
    return res.status(404).render('error', { title: 'Not Found', message: '附件文件不存在' })
  }

  const mime = row.mime_type || (row.attachment_kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
  const filename = row.filename || `attachment-${row.id}`

  // PDF 内联预览友好,其余下载
  const disposition = row.attachment_kind === 'pdf' || mime === 'application/pdf'
    ? 'inline'
    : 'attachment'

  // 文件名里有非 ASCII 用 RFC 5987 编码 fallback
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_')
  const encoded = encodeURIComponent(filename)

  res.setHeader('Content-Type', mime)
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
  )
  // 长缓存关闭(用户可能换文件)
  res.setHeader('Cache-Control', 'private, no-cache')

  res.sendFile(absolute, (err) => {
    if (err) {
      console.error('[records:download] sendFile failed:', err.message)
      if (!res.headersSent) {
        res.status(500).render('error', { title: 'Server Error', message: '附件读取失败' })
      }
    }
  })
})

export default router
