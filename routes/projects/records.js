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
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { getProjectProgress } from '../../services/prisma.js'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import { getSetting } from '../../services/settings.js'
import { ensureRoomForUpload as quotaEnsureRoomForUpload, formatBytes as quotaFormatBytes, createReservation, releaseReservation } from '../../services/storage-quota.js'
import { formatAllStyles, normalizeRecord } from '../../services/citation-format.js'
import {
  exportBibTeX,
  exportRIS,
  exportCslJson,
  exportReferencesSection,
} from '../../services/reference-export.js'
import { fetchByDoi } from '../../services/crossref.js'
import {
  countDerivedRows,
  hasDerivedData,
  estimateDiskUsage,
  clearDerivedData,
  formatBytes as formatResetBytes,
} from '../../services/reset-on-protocol-change.js'

const router = express.Router({ mergeParams: true })

// ============================================================
// 配置
// ============================================================

// 上传根目录:storage_path 必须在以下任一目录下,防止路径遍历。
// 历史上只允许 uploads/(Zotero 包),但 mergeZoteroIntoSystem 把 PDF 拷到 PDF_ROOT
// (/var/lib/slr/pdfs/),如果只校验 uploads/ 那预览/下载会报"路径非法"。
// 现在允许两个根 + 用户手动上传也走 PDF_ROOT。
const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOADS_ROOT = path.resolve(path.join(DATA_DIR, 'uploads'))
const PDF_ROOT = path.resolve(process.env.SLR_PDF_ROOT || path.join(DATA_DIR, 'pdfs'))
const ALLOWED_ROOTS = [UPLOADS_ROOT, PDF_ROOT]

function isInsideAllowedRoots(absolute) {
  return ALLOWED_ROOTS.some((root) => {
    if (absolute === root) return true
    const rel = path.relative(root, absolute)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

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
  let sourceDbs = []
  if (row.source_databases) {
    try {
      const parsed = JSON.parse(row.source_databases)
      if (Array.isArray(parsed)) {
        sourceDbs = parsed
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().toLowerCase())
      }
    } catch { /* ignore */ }
  }
  // 解析语言字段:WoS/Scopus 用分号 / 逗号 / 斜杠分隔多语言
  const langRaw = (row.language || '').trim()
  let langList = []
  if (langRaw) {
    langList = langRaw
      .split(/[;,\/、]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const lower = langList.map((l) => l.toLowerCase())
  const hasEnglish = lower.some((l) => l === 'english' || l === 'eng' || l === 'en')
  const hasOther = lower.some((l) => l && l !== 'english' && l !== 'eng' && l !== 'en' && l !== 'unspecified' && l !== 'unknown')
  // 多语言:列表里既有英文也有别的语言(或仅有非英文)
  const isMultiLanguage = hasOther
  const isNonEnglishOnly = langList.length > 0 && !hasEnglish

  return {
    ...row,
    authors_list: parseAuthors(row.authors_json),
    authors_short: shortAuthorList(row.authors_json, row.authors_text, 3),
    keywords_list: parseJsonArrayField(row.keywords_json),
    source_databases_list: sourceDbs,
    language_list: langList,
    is_multi_language: isMultiLanguage,
    is_non_english_only: isNonEnglishOnly,
    has_doi: !!(row.doi && String(row.doi).trim()),
    has_notes: !!(row.notes && String(row.notes).trim()),
    is_duplicate: !!row.duplicate_of_record_id,
    // 筛选状态(从 LEFT JOIN screening_decisions 来,可能为 null)
    ai_suggestion:  row.ai_suggestion  || 'not_run',
    ai_reason:      row.ai_reason      || null,
    ai_confidence:  row.ai_confidence  != null ? row.ai_confidence : null,
    ai_model:       row.ai_model       || null,
    human_decision: row.human_decision || 'not_decided',
    human_reason:   row.human_reason   || null,
    ai_matched_inclusion: parseJsonArrayField(row.ai_matched_inclusion),
    ai_matched_exclusion: parseJsonArrayField(row.ai_matched_exclusion),
  }
}

// 解析查询字符串
function parseFilters(query) {
  const f = {
    has_pdf: query.has_pdf === '1' || query.has_pdf === 'on' || query.has_pdf === 'true',
    has_doi: query.has_doi === '1' || query.has_doi === 'on' || query.has_doi === 'true',
    // 默认隐藏重复(query 未传 = 选中;显式 ='0' 才显示)
    hide_duplicates: query.hide_duplicates !== '0',
    // 仅显示多语言 / 非英文(WoS LA= "包含英文" 漏出来的多语种论文)
    only_multi_language: query.only_multi_language === '1',
    only_non_english: query.only_non_english === '1',
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
  // 多语言:Language 字段非空 + 包含分隔符(';' / ',' / '/' / '、')即多语言
  if (filters.only_multi_language) {
    where.push(`(r.language IS NOT NULL AND r.language != '' AND
      (r.language LIKE '%;%' OR r.language LIKE '%,%' OR r.language LIKE '%/%' OR r.language LIKE '%、%'))`)
  }
  // 非英文:Language 字段非空 + 不含 english/eng/en token
  if (filters.only_non_english) {
    where.push(`(r.language IS NOT NULL AND r.language != ''
      AND LOWER(r.language) NOT LIKE '%english%'
      AND LOWER(r.language) NOT LIKE '%eng%'
      AND LOWER(r.language) NOT LIKE 'en;%'
      AND LOWER(r.language) != 'en')`)
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
      (SELECT COUNT(*) FROM attachments WHERE record_id = r.id) AS total_attachments,
      sd.id              AS sd_id,
      sd.ai_suggestion   AS ai_suggestion,
      sd.ai_reason       AS ai_reason,
      sd.ai_confidence   AS ai_confidence,
      sd.ai_model        AS ai_model,
      sd.ai_matched_inclusion AS ai_matched_inclusion,
      sd.ai_matched_exclusion AS ai_matched_exclusion,
      sd.human_decision  AS human_decision,
      sd.human_reason    AS human_reason,
      sd.ai_ran_at       AS ai_ran_at,
      sd.decided_at      AS decided_at
    FROM records r
    LEFT JOIN screening_decisions sd
      ON sd.record_id = r.id AND sd.stage = 'title_abstract'
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

/**
 * 筛选统计:AI 已建议 / 人工已决定 / 等等。只统计**非重复**条目,
 * 因为重复条目本来就不进 PRISMA flow,不需要逐条 AI。
 */
function getScreeningStats(db, projectId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(sd.ai_suggestion, 'not_run') != 'not_run' THEN 1 ELSE 0 END) AS ai_done,
         SUM(CASE WHEN sd.ai_suggestion = 'include'   THEN 1 ELSE 0 END) AS ai_include,
         SUM(CASE WHEN sd.ai_suggestion = 'exclude'   THEN 1 ELSE 0 END) AS ai_exclude,
         SUM(CASE WHEN sd.ai_suggestion = 'uncertain' THEN 1 ELSE 0 END) AS ai_uncertain,
         SUM(CASE WHEN COALESCE(sd.human_decision, 'not_decided') != 'not_decided' THEN 1 ELSE 0 END) AS human_done,
         SUM(CASE WHEN sd.human_decision = 'include'   THEN 1 ELSE 0 END) AS human_include,
         SUM(CASE WHEN sd.human_decision = 'exclude'   THEN 1 ELSE 0 END) AS human_exclude,
         SUM(CASE WHEN sd.human_decision = 'uncertain' THEN 1 ELSE 0 END) AS human_uncertain
       FROM records r
       LEFT JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ? AND r.duplicate_of_record_id IS NULL`
    )
    .get(projectId) || {}
  const total = row.total || 0
  const ai_done = row.ai_done || 0
  const human_done = row.human_done || 0
  return {
    total,
    ai_done,
    ai_pending: Math.max(0, total - ai_done),
    ai_include:   row.ai_include   || 0,
    ai_exclude:   row.ai_exclude   || 0,
    ai_uncertain: row.ai_uncertain || 0,
    human_done,
    human_pending: Math.max(0, total - human_done),
    human_include:   row.human_include   || 0,
    human_exclude:   row.human_exclude   || 0,
    human_uncertain: row.human_uncertain || 0,
  }
}

function getApprovedProtocolMeta(db, projectId) {
  return db
    .prepare(
      `SELECT version, approved_by_user FROM protocols
       WHERE project_id = ? AND approved_by_user = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(projectId) || null
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
  if (query.only_multi_language === '1') params.set('only_multi_language', '1')
  if (query.only_non_english === '1') params.set('only_non_english', '1')
  params.set('page', String(page))
  return `${basePath}?${params.toString()}`
}

// ============================================================
// 表单解析辅助:authors_text(每行一个作者)→ authors_json
// ============================================================

function parseAuthorsTextarea(raw) {
  if (!raw || typeof raw !== 'string') return { authors: [], text: '' }
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200)
  const authors = lines.map((line) => {
    // 支持 'Surname, Given' 或 'Given Surname' 或单独 surname
    if (line.includes(',')) {
      const [sur, given] = line.split(',').map((x) => x.trim())
      return { surname: sur || '', givenName: given || '', full: line }
    }
    // CJK:连续中日韩字符整段当 surname+given 不易拆,保留 full
    if (/[㐀-鿿]/.test(line)) {
      // 假设第一个字符是姓
      const first = Array.from(line)[0] || ''
      const rest = line.slice(first.length)
      return { surname: first, givenName: rest, full: line }
    }
    const parts = line.split(/\s+/)
    if (parts.length === 1) return { surname: parts[0], givenName: '', full: line }
    return {
      surname: parts[parts.length - 1],
      givenName: parts.slice(0, -1).join(' '),
      full: line,
    }
  })
  // 列表展示用:'Wang G, Tang R, Xu M'
  const text = authors
    .map((a) => {
      const sur = a.surname || ''
      const given = a.givenName || ''
      const initials = given
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => (p[0] || '').toUpperCase())
        .join('')
      if (/[㐀-鿿]/.test(sur + given)) return a.full
      return initials ? `${sur} ${initials}` : sur || a.full
    })
    .filter(Boolean)
    .join(', ')
  return { authors, text }
}

function parseKeywordsField(raw) {
  if (!raw || typeof raw !== 'string') return []
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100)
}

function normalizeTitleForDedup(title) {
  if (!title) return ''
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanDoi(raw) {
  if (!raw) return null
  const t = String(raw).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  return t || null
}

// 收集 form 字段(POST body)→ DB-shaped values。返回 { values, errors }
function collectRecordForm(body) {
  const errors = []
  const title = (body.title || '').trim()
  if (!title) errors.push('标题必填')
  if (title.length > 1000) errors.push('标题过长(>1000 字符)')

  const { authors, text: authorsText } = parseAuthorsTextarea(body.authors_text || '')

  let year = null
  if (body.year) {
    const n = parseInt(body.year, 10)
    if (Number.isFinite(n) && n >= 1500 && n <= 2200) year = n
    else if (String(body.year).trim()) errors.push('年份无效(1500-2200)')
  }

  const journal = (body.journal || '').trim().slice(0, 500) || null
  const publisher = (body.publisher || '').trim().slice(0, 500) || null
  const doi = cleanDoi(body.doi)
  const url = (body.url || '').trim().slice(0, 2000) || null
  const abstract = (body.abstract || '').trim().slice(0, 20000) || null
  const notes = (body.notes || '').trim().slice(0, 10000) || null
  const keywords = parseKeywordsField(body.keywords || '')
  const itemType = ['journalArticle', 'conferencePaper', 'bookSection', 'book', 'webpage', 'other']
    .includes(body.item_type) ? body.item_type : 'journalArticle'

  return {
    errors,
    values: {
      title,
      authors_json: JSON.stringify(authors),
      authors_text: authorsText || null,
      year,
      journal,
      publisher,
      doi,
      url,
      abstract,
      notes,
      keywords_json: JSON.stringify(keywords),
      item_type: itemType,
      normalized_title: normalizeTitleForDedup(title),
    },
    // 表单回显:把原始输入存一下,出错重渲染时用
    raw: {
      title,
      authors_text: body.authors_text || '',
      year: body.year || '',
      journal: journal || '',
      publisher: publisher || '',
      doi: doi || '',
      url: url || '',
      abstract: abstract || '',
      keywords: body.keywords || '',
      notes: notes || '',
      item_type: itemType,
    },
  }
}

// 给 view 准备一份回显用的对象(record 还没保存时也能用)
function recordFormDefaults() {
  return {
    title: '',
    authors_text: '',
    year: '',
    journal: '',
    publisher: '',
    doi: '',
    url: '',
    abstract: '',
    keywords: '',
    notes: '',
    item_type: 'journalArticle',
  }
}

function recordToFormShape(row) {
  if (!row) return recordFormDefaults()
  const authors = parseAuthors(row.authors_json)
  const authors_text = authors
    .map((a) => a.full || `${a.surname || ''} ${a.givenName || ''}`.trim())
    .filter(Boolean)
    .join('\n')
  const kws = parseJsonArrayField(row.keywords_json)
  return {
    title: row.title || '',
    authors_text,
    year: row.year || '',
    journal: row.journal || '',
    publisher: row.publisher || '',
    doi: row.doi || '',
    url: row.url || '',
    abstract: row.abstract || '',
    keywords: kws.join(', '),
    notes: row.notes || '',
    item_type: row.item_type || 'journalArticle',
  }
}

// 文件名安全化
function safeFilename(s, fallback = 'records') {
  const cleaned = String(s || '').replace(/[^\w一-鿿\-]+/g, '_').slice(0, 60)
  return cleaned || fallback
}

// 加载项目所有 records — 用于批量导出
function loadProjectRecordsForExport(db, projectId, ids /* nullable */) {
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    return db
      .prepare(
        `SELECT * FROM records
         WHERE project_id = ? AND id IN (${placeholders})
           AND duplicate_of_record_id IS NULL
         ORDER BY (year IS NULL), year DESC, title`
      )
      .all(projectId, ...ids)
  }
  return db
    .prepare(
      `SELECT * FROM records
       WHERE project_id = ? AND duplicate_of_record_id IS NULL
       ORDER BY (year IS NULL), year DESC, title`
    )
    .all(projectId)
}

function parseIdsQuery(q) {
  if (!q) return null
  const ids = String(q).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5000)
  return ids.length ? ids : null
}

// ============================================================
// GET /projects/:id/records — 列表
// ============================================================
//
// /:id/records → 永久跳到 /:id/screening(合并后 /records 不再独立渲染)。
// 透传所有 query string,保持过滤参数。下面的 _legacyListHandler 保留是
// 为了将来需要时可以回退,但不挂载在路由表上。
router.get('/:id/records', (req, res) => {
  const project = ownProjectOr404(req.app.locals.db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const qs = req.originalUrl.split('?')[1] || ''
  // 302(不要 301,免得浏览器缓存导致回滚困难)
  return res.redirect(qs ? `/projects/${project.id}/screening?${qs}` : `/projects/${project.id}/screening`)
})

// (legacy)旧 list handler — 不再被路由调用,保留作为参考实现
function _legacyListHandler(req, res) {
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
  const screeningStats = getScreeningStats(db, project.id)
  const approvedProtocol = getApprovedProtocolMeta(db, project.id)

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
    stepLabel: '3. 题录筛选',
    records: rows,
    stats,
    screeningStats,
    approvedProtocol,
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
}
// 上面的闭合 } 关闭 _legacyListHandler 函数;以前这里是 router.get 回调的 `})` —
// 改函数后只需要单个 } 即可。

// ============================================================
// 批量导出(放在 /:id/records/:recordId 之前 — 带扩展名,Express 不会误匹配)
// ============================================================

function sendExport(req, res, { mime, filenameExt, eventType, render }) {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const ids = parseIdsQuery(req.query.ids)
  const rows = loadProjectRecordsForExport(db, project.id, ids)
  const body = render(rows, project)
  const filename = `${safeFilename(project.title || 'records')}-records.${filenameExt}`

  audit(db, req, {
    eventType: 'record_exported',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      format: eventType,
      count: rows.length,
      bytes: Buffer.byteLength(body, 'utf8'),
      ids_subset: !!ids,
    },
  })

  res.setHeader('Content-Type', `${mime}; charset=utf-8`)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(body)
}

router.get('/:id/records.bib', (req, res) => {
  sendExport(req, res, {
    mime: 'application/x-bibtex',
    filenameExt: 'bib',
    eventType: 'bibtex',
    render: (rows, project) =>
      exportBibTeX(rows, { collectionName: project.title || 'slr' }),
  })
})

router.get('/:id/records.ris', (req, res) => {
  sendExport(req, res, {
    mime: 'application/x-research-info-systems',
    filenameExt: 'ris',
    eventType: 'ris',
    render: (rows) => exportRIS(rows),
  })
})

router.get('/:id/records.csl.json', (req, res) => {
  sendExport(req, res, {
    mime: 'application/vnd.citationstyles.csl+json',
    filenameExt: 'csl.json',
    eventType: 'csl_json',
    render: (rows) => exportCslJson(rows),
  })
})

router.get('/:id/records.refs.md', (req, res) => {
  const style = ['apa', 'ieee', 'gb_t_7714', 'chicago', 'mla'].includes(req.query.style)
    ? req.query.style
    : 'apa'
  sendExport(req, res, {
    mime: 'text/markdown',
    filenameExt: `${style}.md`,
    eventType: `markdown_${style}`,
    render: (rows) => exportReferencesSection(rows, { style }),
  })
})

// ============================================================
// GET  /:id/records/clear-pool  — 渲染确认页(列出待清空的内容)
// POST /:id/records/clear-pool  — confirm_phrase=CLEAR 才执行
//
// **必须在 /:id/records/:recordId 之前注册**,否则会被 :recordId 抢匹配。
// 与"协议重批自动清空"共用同一个 service(clearDerivedData),
// 这里是**用户主动手动清空**的入口(无需协议变更)。
// ============================================================
router.get('/:id/records/clear-pool', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const counts = countDerivedRows(db, project.id)
  const disk = estimateDiskUsage(db, project.id)
  const anyData = hasDerivedData(db, project.id)

  res.render('projects/records/clear-pool-confirm', {
    title: `清空论文池 · ${project.title}`,
    project,
    counts,
    diskBytes: disk.bytes,
    diskBytesFormatted: formatResetBytes(disk.bytes),
    diskFiles: disk.files,
    anyData,
  })
})

router.post('/:id/records/clear-pool', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const confirmed = String(req.body.confirm_clear || '').toLowerCase() === 'yes'
  // 大小写不敏感 + 去空白:防止 paste / 输入法 / 移动键盘等绕过前端 oninput 上传小写
  const confirmPhrase = String(req.body.confirm_phrase || '').trim().toUpperCase()
  if (!confirmed || confirmPhrase !== 'CLEAR') {
    req.session.flash = {
      type: 'error',
      message: '清空被拒:必须勾选确认且在框里逐字输入大写 CLEAR。',
    }
    return res.redirect(`/projects/${project.id}/records/clear-pool`)
  }

  if (!hasDerivedData(db, project.id)) {
    req.session.flash = { type: 'success', message: '当前论文池本来就是空的,无需清空。' }
    return res.redirect(`/projects/${project.id}/records`)
  }

  const summary = clearDerivedData(db, project.id, { actorUserId: req.user.id, req })
  if (summary.db_error) {
    req.session.flash = {
      type: 'error',
      message: `清空时数据库报错:${summary.db_error}。请联系管理员。`,
    }
    return res.redirect(`/projects/${project.id}/records`)
  }

  const c = summary.db_rows_deleted || {}
  const parts = []
  if (c.records)             parts.push(`${c.records} 篇论文`)
  if (c.attachments)         parts.push(`${c.attachments} 个附件`)
  if (c.screening_decisions) parts.push(`${c.screening_decisions} 个 AI 筛选`)
  if (c.extractions)         parts.push(`${c.extractions} 个抽取`)
  if (c.themes)              parts.push(`${c.themes} 个主题`)
  if (c.draft_sections)      parts.push(`${c.draft_sections} 个章节`)
  const dataParts = parts.length ? parts.join(' / ') : '0 项'
  req.session.flash = {
    type: 'success',
    message: `论文池已清空:${dataParts},以及 ${summary.files_removed} 个文件(${formatResetBytes(summary.bytes_removed)})。可以重新导入了。`,
  }
  res.redirect(`/projects/${project.id}/records`)
})

// ============================================================
// GET /projects/:id/records/new — 手动新增表单
// 必须在 /:id/records/:recordId 之前注册
// ============================================================
router.get('/:id/records/new', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch (e) {
    console.error('[records:new] getProjectProgress failed:', e.message)
  }

  res.render('projects/records/new', {
    title: `手动新增条目 · ${project.title}`,
    project,
    progress,
    currentStep: 'screening',
    stepLabel: '3. 题录筛选',
    formAction: `/projects/${project.id}/records`,
    cancelHref: `/projects/${project.id}/records`,
    form: recordFormDefaults(),
    errors: [],
    isEdit: false,
  })
})

// ============================================================
// POST /projects/:id/records/new/lookup-doi — AJAX DOI 元数据回填
// ============================================================
router.post('/:id/records/new/lookup-doi', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).json({ ok: false, error: 'project_not_found' })
  }
  const doi = cleanDoi(req.body?.doi)
  if (!doi) {
    return res.status(400).json({ ok: false, error: 'invalid_doi' })
  }
  try {
    const meta = await fetchByDoi(doi, { timeoutMs: 5000 })
    if (!meta) {
      return res.json({ ok: false, error: 'not_found' })
    }
    // 把 authors 转成 textarea 显示用
    const authors_text = meta.authors
      .map((a) => a.full || `${a.surname || ''} ${a.givenName || ''}`.trim())
      .filter(Boolean)
      .join('\n')
    return res.json({
      ok: true,
      data: {
        title: meta.title,
        authors_text,
        year: meta.year || '',
        journal: meta.journal || '',
        publisher: meta.publisher || '',
        doi: meta.doi,
        url: meta.url || '',
        abstract: meta.abstract || '',
        item_type: meta.item_type || 'journalArticle',
      },
    })
  } catch (e) {
    console.error('[records:lookup-doi]', e.message)
    return res.status(500).json({ ok: false, error: 'lookup_failed' })
  }
})

// ============================================================
// POST /projects/:id/records — 创建(手动,无 zotero_package_id,no_pdf)
// ============================================================
router.post('/:id/records', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res
      .status(404)
      .render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const { errors, values, raw } = collectRecordForm(req.body || {})
  if (errors.length) {
    let progress = null
    try {
      progress = getProjectProgress(db, project.id)
    } catch {}
    return res.status(400).render('projects/records/new', {
      title: `手动新增条目 · ${project.title}`,
      project,
      progress,
      currentStep: 'screening',
      stepLabel: '3. 题录筛选',
      formAction: `/projects/${project.id}/records`,
      cancelHref: `/projects/${project.id}/records`,
      form: raw,
      errors,
      isEdit: false,
    })
  }

  const id = randomId('rec')
  db.prepare(
    `INSERT INTO records (
       id, project_id, package_id, zotero_item_id, zotero_rdf_about,
       item_type, title, normalized_title,
       authors_json, authors_text, year, date_text,
       journal, publisher, doi, url, abstract, keywords_json, notes,
       has_pdf, duplicate_group_id, duplicate_of_record_id
     ) VALUES (?, ?, NULL, NULL, NULL,
               ?, ?, ?,
               ?, ?, ?, NULL,
               ?, ?, ?, ?, ?, ?, ?,
               0, NULL, NULL)`
  ).run(
    id, project.id,
    values.item_type, values.title, values.normalized_title,
    values.authors_json, values.authors_text, values.year,
    values.journal, values.publisher, values.doi, values.url, values.abstract,
    values.keywords_json, values.notes
  )

  audit(db, req, {
    eventType: 'record_created',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      record_id: id,
      title: values.title,
      doi: values.doi,
      source: 'manual',
    },
  })

  req.session.flash = { type: 'success', message: '已新增文献条目' }
  res.redirect(`/projects/${project.id}/records/${id}`)
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
      `SELECT id, record_id, attachment_kind, filename, size_bytes, mime_type, created_at, pdf_offloaded_at
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

  // 5 种 style 的引文字符串(详情页"复制为..."按钮用)
  let citations = null
  try {
    citations = formatAllStyles(record)
  } catch (e) {
    console.error('[records:detail] formatAllStyles failed:', e.message)
  }

  // 当前 screening 状态(给详情页的"人工决定"区用)
  let screening = null
  try {
    const sd = db.prepare(
      `SELECT id, ai_suggestion, ai_reason, ai_confidence, ai_model,
              ai_matched_inclusion, ai_matched_exclusion, ai_need_full_text, ai_ran_at,
              human_decision, human_reason, decided_at
       FROM screening_decisions
       WHERE record_id = ? AND stage = 'title_abstract'`
    ).get(record.id)
    if (sd) {
      const parseJ = (s) => {
        if (!s) return []
        try { const x = JSON.parse(s); return Array.isArray(x) ? x : [] } catch { return [] }
      }
      screening = {
        ...sd,
        ai_matched_inclusion: parseJ(sd.ai_matched_inclusion),
        ai_matched_exclusion: parseJ(sd.ai_matched_exclusion),
        ai_need_full_text:    parseJ(sd.ai_need_full_text),
        ai_suggestion:  sd.ai_suggestion  || 'not_run',
        human_decision: sd.human_decision || 'not_decided',
      }
    } else {
      screening = { ai_suggestion: 'not_run', human_decision: 'not_decided', ai_reason: null, human_reason: null, ai_matched_inclusion: [], ai_matched_exclusion: [], ai_need_full_text: [] }
    }
  } catch (e) {
    console.error('[records:detail] load screening failed:', e.message)
  }

  // 上 / 下一条(在同项目内的同 ORDER 中,方便详情页跳)
  // 用跟 /screening 一样的排序:未决定优先 → uncertain 优先 → 年份 → 标题
  let neighbors = null
  try {
    const allOrdered = db.prepare(
      `SELECT r.id
       FROM records r
       LEFT JOIN screening_decisions sd ON sd.record_id = r.id AND sd.stage = 'title_abstract'
       WHERE r.project_id = ? AND r.duplicate_of_record_id IS NULL
       ORDER BY
         CASE WHEN COALESCE(sd.human_decision, 'not_decided') = 'not_decided' THEN 0 ELSE 1 END,
         CASE WHEN sd.ai_suggestion = 'uncertain' THEN 0
              WHEN sd.ai_suggestion = 'include'   THEN 1
              WHEN sd.ai_suggestion = 'exclude'   THEN 2
              ELSE 3 END,
         (r.year IS NULL), r.year DESC, r.title`
    ).all(project.id)
    const idx = allOrdered.findIndex((x) => x.id === record.id)
    neighbors = {
      prev: idx > 0 ? allOrdered[idx - 1].id : null,
      next: idx >= 0 && idx < allOrdered.length - 1 ? allOrdered[idx + 1].id : null,
      pos: idx + 1,
      total: allOrdered.length,
    }
  } catch (e) { /* ignore */ }

  res.render('projects/records/detail', {
    title: `${record.title} · ${project.title}`,
    project,
    progress,
    currentStep: 'screening',
    stepLabel: '3. 题录筛选',
    record,
    attachments,
    duplicateGroup,
    mergedInto,
    citations,
    screening,
    neighbors,
    // 统一字节格式化函数(来自 services/storage-quota.js),避免视图层重复实现
    fmtBytes: quotaFormatBytes,
  })
})

// ============================================================
// GET /projects/:id/records/:recordId/edit — 编辑表单
// ============================================================
router.get('/:id/records/:recordId/edit', (req, res) => {
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

  let progress = null
  try {
    progress = getProjectProgress(db, project.id)
  } catch {}

  res.render('projects/records/edit', {
    title: `编辑条目 · ${row.title}`,
    project,
    progress,
    currentStep: 'screening',
    stepLabel: '3. 题录筛选',
    record: row,
    formAction: `/projects/${project.id}/records/${row.id}/update`,
    cancelHref: `/projects/${project.id}/records/${row.id}`,
    form: recordToFormShape(row),
    errors: [],
    isEdit: true,
  })
})

// ============================================================
// POST /projects/:id/records/:recordId/update — 更新
// ============================================================
router.post('/:id/records/:recordId/update', (req, res) => {
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

  const { errors, values, raw } = collectRecordForm(req.body || {})
  if (errors.length) {
    let progress = null
    try {
      progress = getProjectProgress(db, project.id)
    } catch {}
    return res.status(400).render('projects/records/edit', {
      title: `编辑条目 · ${row.title}`,
      project,
      progress,
      currentStep: 'screening',
      stepLabel: '3. 题录筛选',
      record: row,
      formAction: `/projects/${project.id}/records/${row.id}/update`,
      cancelHref: `/projects/${project.id}/records/${row.id}`,
      form: raw,
      errors,
      isEdit: true,
    })
  }

  db.prepare(
    `UPDATE records SET
       item_type = ?, title = ?, normalized_title = ?,
       authors_json = ?, authors_text = ?, year = ?,
       journal = ?, publisher = ?, doi = ?, url = ?, abstract = ?,
       keywords_json = ?, notes = ?
     WHERE id = ? AND project_id = ?`
  ).run(
    values.item_type, values.title, values.normalized_title,
    values.authors_json, values.authors_text, values.year,
    values.journal, values.publisher, values.doi, values.url, values.abstract,
    values.keywords_json, values.notes,
    row.id, project.id
  )

  audit(db, req, {
    eventType: 'record_updated',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      record_id: row.id,
      title: values.title,
      doi: values.doi,
    },
  })

  req.session.flash = { type: 'success', message: '已更新文献条目' }
  res.redirect(`/projects/${project.id}/records/${row.id}`)
})

// ============================================================
// POST /projects/:id/records/:recordId/upload-pdf
//   — 单篇 PDF 补传(仅 advanced_extraction_enabled 用户)
//   - multer 限单文件 ≤ 100 MB
//   - 走 storage-quota 预检
//   - 写到 /var/lib/slr/pdfs/<record_id>.pdf(若已有同名则覆盖)
//   - INSERT 或 REPLACE attachments 行 + UPDATE records.has_pdf=1
// ============================================================
const pdfStorageDir = path.resolve(DATA_DIR, 'pdfs')
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      try { fs.mkdirSync(pdfStorageDir, { recursive: true }) } catch {}
      cb(null, pdfStorageDir)
    },
    filename(req, _file, cb) {
      // 直接用 record_id.pdf — 同 record 只会有一份单篇补传 PDF
      cb(null, `${req.params.recordId}.pdf`)
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') return cb(null, true)
    cb(new Error('只接受 .pdf 文件'))
  },
})

router.post('/:id/records/:recordId/upload-pdf',
  requireAdvancedExtraction,
  (req, res, next) => {
    // 校验项目归属 + record 归属(在 multer 之前,避免任意人都能往 pdfs/ 写)
    const db = req.app.locals.db
    const project = ownProjectOr404(db, req.params.id, req.user.id)
    if (!project) {
      req.session.flash = { type: 'error', message: '项目不存在或无权访问' }
      return res.redirect(`/projects/${req.params.id}/records`)
    }
    const record = db.prepare(
      'SELECT id, title FROM records WHERE id = ? AND project_id = ?'
    ).get(req.params.recordId, project.id)
    if (!record) {
      req.session.flash = { type: 'error', message: '文献条目不存在' }
      return res.redirect(`/projects/${project.id}/records`)
    }
    req._project = project
    req._record  = record

    // 存储配额预检(Content-Length 估算)
    // B2.2:预检后立即占 reservation,响应结束时释放(成功时 attachments.size_bytes 取代,
    //       失败时直接释放)。
    const contentLength = Number(req.headers['content-length']) || 0
    if (contentLength > 0) {
      const check = quotaEnsureRoomForUpload(db, req.user, contentLength)
      if (!check.ok) {
        req.session.flash = {
          type: 'error',
          message: check.message + '(本次 ≈ ' + quotaFormatBytes(contentLength) + ')。请联系超级管理员提高配额。',
        }
        return res.redirect(`/projects/${project.id}/records/${record.id}`)
      }
      req._reservationId = createReservation(db, req.user.id, contentLength, 'pdf_upload')
      res.once('close', () => releaseReservation(req.app.locals.db, req._reservationId))
    }
    next()
  },
  (req, res, next) => {
    pdfUpload.single('pdf_file')(req, res, (err) => {
      if (err) {
        const recordId = req.params.recordId
        const code = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 100 MB 上限' : err.message
        req.session.flash = { type: 'error', message: '上传失败:' + code }
        return res.redirect(`/projects/${req.params.id}/records/${recordId}`)
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const db = req.app.locals.db
      const project = req._project
      const record = req._record
      const file = req.file
      if (!file || !file.path) {
        req.session.flash = { type: 'error', message: '没收到文件' }
        return res.redirect(`/projects/${project.id}/records/${record.id}`)
      }

      // ── B1.3 PDF magic-byte 校验 — 防 .txt 改名 .pdf 把 pdf-parse 弄崩 ──
      // 真正的 PDF 文件前 4-5 字节是 "%PDF-" (0x25 50 44 46 2D)
      try {
        const fd = fs.openSync(file.path, 'r')
        const head = Buffer.alloc(5)
        fs.readSync(fd, head, 0, 5, 0)
        fs.closeSync(fd)
        const sig = head.toString('latin1')
        if (!sig.startsWith('%PDF-')) {
          // 不是真 PDF — 立刻 unlink + reject + 不留磁盘垃圾
          try { fs.unlinkSync(file.path) } catch {}
          req.session.flash = {
            type: 'error',
            message: `上传被拒:文件内容不是有效的 PDF(开头是 "${sig.slice(0, 4).replace(/[\x00-\x1F]/g, '?')}",应为 "%PDF-")。请确认是真的 PDF 文件,不是改了扩展名的其他文件。`,
          }
          return res.redirect(`/projects/${project.id}/records/${record.id}`)
        }
      } catch (e) {
        try { fs.unlinkSync(file.path) } catch {}
        req.session.flash = { type: 'error', message: '读取上传文件失败:' + e.message }
        return res.redirect(`/projects/${project.id}/records/${record.id}`)
      }

      // 拿真实大小
      let sizeBytes = file.size || 0
      try { sizeBytes = fs.statSync(file.path).size } catch {}

      // 删旧 attachments(同 record 已有 kind=pdf 的全部清掉,storage_path 文件如果不是
      //   本次 path 也一并删掉,避免存储泄漏)
      const oldAtts = db.prepare(
        `SELECT id, storage_path FROM attachments
          WHERE record_id = ? AND attachment_kind = 'pdf'`
      ).all(record.id)
      for (const a of oldAtts) {
        if (a.storage_path && path.resolve(a.storage_path) !== path.resolve(file.path)) {
          try { fs.unlinkSync(a.storage_path) } catch {}
        }
        db.prepare(`DELETE FROM attachments WHERE id = ?`).run(a.id)
      }

      // 写新 attachments 行 + 标 has_pdf
      const attId = randomId('att')
      db.prepare(
        `INSERT INTO attachments
           (id, record_id, package_id, attachment_kind, filename, storage_path, size_bytes, mime_type)
         VALUES (?, ?, NULL, 'pdf', ?, ?, ?, 'application/pdf')`
      ).run(
        attId, record.id,
        file.originalname || `${record.id}.pdf`,
        file.path,
        sizeBytes,
      )
      // 同时清掉 pdf_status(之前用户可能标过"容缺",现在有真 PDF 了过时了)
      db.prepare(`UPDATE records SET has_pdf = 1, pdf_status = NULL WHERE id = ?`).run(record.id)

      audit(db, req, {
        eventType: 'record_pdf_uploaded',
        userId: req.user.id, actorUserId: req.user.id, projectId: project.id,
        payload: {
          record_id: record.id,
          title_snippet: (record.title || '').slice(0, 100),
          size_bytes: sizeBytes,
          filename: file.originalname,
          replaced_old: oldAtts.length,
        },
      })

      // 自动 chunk 新 PDF — 否则矩阵抽取会回退到只读摘要(历史 bug)。
      // setImmediate 异步,不阻塞响应。pdf-parse 通常 1-3 秒。
      const _attId = attId, _recordId = record.id, _projectId = project.id, _userId = req.user.id
      setImmediate(async () => {
        try {
          const { parsePdfAttachment } = await import('../../services/pdf-parse.js')
          const r = await parsePdfAttachment(db, { attachmentId: _attId, recordId: _recordId })
          if (r.requires_ocr) console.warn(`[records auto-chunk] requires OCR: ${_recordId}`)
          else if (r.total_chunks > 0) {
            console.log(`[records auto-chunk] ${_recordId}: ${r.total_chunks} chunks`)
            // 2026-05-31:chunk 成功 → 自动 offload PDF 源文件腾空间(pdf_auto_offload 开关默认 on)
            try {
              const auto = getSetting(db, 'pdf_auto_offload')
              if (auto == null || auto === 'on') {
                const { offloadRecordPdf } = await import('../../services/pdf-offload.js')
                const off = offloadRecordPdf(db, {
                  recordId: _recordId, reason: 'auto_after_upload_chunk',
                  req: { user: { id: _userId }, ip: '', get: () => '' },
                })
                if (off.offloaded_n > 0) console.log(`[records auto-offload] ${_recordId}: freed ${off.bytes_freed} bytes`)
              }
            } catch (e) { console.warn('[records auto-offload] failed for', _recordId, e.message) }
          }
        } catch (e) {
          console.error('[records auto-chunk] failed for', _recordId, e.message)
        }
      })

      req.session.flash = {
        type: 'success',
        message: `PDF 上传成功(${quotaFormatBytes(sizeBytes)})。${oldAtts.length ? '已替换原 PDF。' : ''}系统正在后台解析 PDF(~1-3 秒),完成后矩阵 AI 批量就能用全文了。`,
      }
      res.redirect(`/projects/${project.id}/records/${record.id}`)
    } catch (e) {
      next(e)
    }
  }
)

// ============================================================
// POST /projects/:id/records/:recordId/delete-pdf
//   — 删除单篇 PDF + 关联 paper_chunks(传错 PDF 回滚用)
//   - 找所有 attachment_kind='pdf' 的 attachments,unlink 物理文件
//   - 显式 DELETE paper_chunks WHERE attachment_id IN (...)(FK CASCADE 兜底)
//   - DELETE attachments
//   - UPDATE records SET has_pdf = 0, pdf_status = NULL(回容缺 triage 状态)
//   - audit log
// 2026-05-28 加:用户传错 PDF 后没法标"容缺"也没法纠正,这里给一个回滚出口
// ============================================================
router.post('/:id/records/:recordId/delete-pdf', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    req.session.flash = { type: 'error', message: '项目不存在或无权访问' }
    return res.redirect(`/projects/${req.params.id}/records`)
  }
  const record = db.prepare(
    'SELECT id, title FROM records WHERE id = ? AND project_id = ?'
  ).get(req.params.recordId, project.id)
  if (!record) {
    req.session.flash = { type: 'error', message: '文献条目不存在' }
    return res.redirect(`/projects/${project.id}/records`)
  }

  // 1) 找所有 PDF attachments
  const pdfAtts = db.prepare(
    `SELECT id, storage_path, filename, size_bytes
       FROM attachments
      WHERE record_id = ? AND attachment_kind = 'pdf'`
  ).all(record.id)

  if (pdfAtts.length === 0) {
    req.session.flash = { type: 'info', message: '这篇文献没有 PDF 可删' }
    return res.redirect(`/projects/${project.id}/records/${record.id}`)
  }

  // 2) 数一下要删的 chunks(给 audit + 用户提示)
  const attIds = pdfAtts.map((a) => a.id)
  const placeholders = attIds.map(() => '?').join(',')
  let chunkCount = 0
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM paper_chunks
        WHERE record_id = ? OR attachment_id IN (${placeholders})`
    ).get(record.id, ...attIds)
    chunkCount = row?.n || 0
  } catch (e) { console.warn('[delete-pdf] count chunks failed:', e.message) }

  // 3) 事务:删 chunks + attachments + reset records.has_pdf
  //    paper_chunks FK ON DELETE CASCADE 理论上会自动删,但显式 DELETE 兜底
  //    (有的 sqlite 启动时 foreign_keys=OFF 默认)
  const tx = db.transaction(() => {
    // 删 chunks(同时 by record_id 和 by attachment_id,任一命中都删)
    db.prepare(`DELETE FROM paper_chunks WHERE record_id = ?`).run(record.id)
    if (attIds.length) {
      db.prepare(
        `DELETE FROM paper_chunks WHERE attachment_id IN (${placeholders})`
      ).run(...attIds)
    }
    // 删 attachments 行
    for (const a of pdfAtts) {
      db.prepare(`DELETE FROM attachments WHERE id = ?`).run(a.id)
    }
    // reset records 状态
    db.prepare(
      `UPDATE records SET has_pdf = 0, pdf_status = NULL WHERE id = ?`
    ).run(record.id)
  })
  try { tx() } catch (e) {
    console.error('[delete-pdf] tx failed:', e)
    req.session.flash = { type: 'error', message: '删除失败:' + (e.message || String(e)).slice(0, 200) }
    return res.redirect(`/projects/${project.id}/records/${record.id}`)
  }

  // 4) 物理文件 unlink(事务外,失败不回滚 DB —— 物理文件作为 best-effort 清理)
  let unlinkedN = 0
  let bytesFreed = 0
  for (const a of pdfAtts) {
    if (!a.storage_path) continue
    try {
      if (fs.existsSync(a.storage_path)) {
        fs.unlinkSync(a.storage_path)
        unlinkedN++
        bytesFreed += (a.size_bytes || 0)
      }
    } catch (e) {
      console.warn('[delete-pdf] unlink failed:', a.storage_path, e.message)
    }
  }

  audit(db, req, {
    eventType: 'record_pdf_deleted',
    userId: req.user.id, actorUserId: req.user.id, projectId: project.id,
    payload: {
      record_id: record.id,
      title_snippet: (record.title || '').slice(0, 100),
      attachments_deleted: pdfAtts.length,
      files_unlinked: unlinkedN,
      bytes_freed: bytesFreed,
      chunks_deleted: chunkCount,
    },
  })

  req.session.flash = {
    type: 'success',
    message: `已删除 PDF(${pdfAtts.length} 个附件 / ${chunkCount} 个 chunks / 释放 ${quotaFormatBytes(bytesFreed)})。条目已回到"暂无 PDF"状态,可重传或标"容缺"。`,
  }
  res.redirect(`/projects/${project.id}/records/${record.id}`)
})

// ============================================================
// POST /projects/:id/records/:recordId/delete — 删除 + 级联清理附件文件
// ============================================================
router.post('/:id/records/:recordId/delete', (req, res) => {
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

  // 先查附件路径(为了删 record 后从磁盘清掉文件)
  const atts = db
    .prepare('SELECT id, storage_path FROM attachments WHERE record_id = ?')
    .all(row.id)

  // DB 删除:attachments 有 ON DELETE CASCADE,会自动清掉行
  // 同时清掉其他可能指向此 record 的副本记录的 duplicate_of_record_id
  // (避免悬空指针)
  const tx = db.transaction(() => {
    db.prepare('UPDATE records SET duplicate_of_record_id = NULL WHERE duplicate_of_record_id = ?')
      .run(row.id)
    db.prepare('DELETE FROM records WHERE id = ? AND project_id = ?').run(row.id, project.id)
  })
  tx()

  // 物理删除附件文件 — 容错,任何失败只日志
  let removed = 0
  for (const a of atts) {
    if (!a.storage_path) continue
    try {
      const abs = path.resolve(a.storage_path)
      if (!isInsideAllowedRoots(abs)) continue
      fs.unlinkSync(abs)
      removed++
    } catch (e) {
      console.warn('[records:delete] unlink failed:', a.storage_path, e.message)
    }
  }

  audit(db, req, {
    eventType: 'record_deleted',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      record_id: row.id,
      title: row.title,
      attachments_removed: removed,
      attachments_total: atts.length,
    },
  })

  req.session.flash = { type: 'success', message: '已删除文献条目' }
  res.redirect(`/projects/${project.id}/records`)
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
      `SELECT a.id, a.storage_path, a.filename, a.mime_type, a.attachment_kind, a.size_bytes, a.pdf_offloaded_at
       FROM attachments a
       JOIN records r ON r.id = a.record_id
       WHERE a.id = ? AND r.project_id = ?`
    )
    .get(attachmentId, projectId)

  if (!row) {
    return res.status(404).render('error', { title: 'Not Found', message: '附件不存在或无权访问' })
  }

  // 2026-05-31:PDF 源文件已 offload(chunk 后腾空间)— 友好提示而非 generic 404
  if (row.pdf_offloaded_at) {
    return res.status(410).render('error', {
      title: '源文件已清理',
      message: '此 PDF 已成功解析为全文 chunks,源文件已清理以腾出空间(不影响 AI 抽取 / 综述,它们读的是解析后的文本)。如需原始 PDF,请到该文献详情页重新上传。',
    })
  }

  if (!row.storage_path) {
    return res.status(500).render('error', { title: 'Server Error', message: '附件路径缺失' })
  }

  // 路径遍历防御:必须在 ALLOWED_ROOTS(uploads/ 或 pdfs/)之内
  const absolute = path.resolve(row.storage_path)
  if (!isInsideAllowedRoots(absolute)) {
    console.error('[records:download] path outside allowed roots', {
      attachmentId,
      storage_path: row.storage_path,
      absolute,
      allowed_roots: ALLOWED_ROOTS,
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
