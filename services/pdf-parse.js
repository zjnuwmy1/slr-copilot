/**
 * PDF 解析服务(Phase 5 Agent L)
 * ------------------------------------------------------------
 * 给 M(初筛)/ N(抽取)用。
 *
 * 流程:
 *   1) 根据 attachment_id / record_id 找到 PDF 路径(attachments.storage_path,
 *      已经是绝对路径;若是相对路径则拼 SLR_UPLOAD_ROOT)
 *   2) pdf-parse 读全文 → 切 section(启发式正则)→ 切 chunk(≤1500 字)
 *   3) 事务包写 paper_chunks(先 DELETE WHERE record_id=? AND attachment_id=?)
 *
 * 公开入口:
 *   parsePdfAttachment(db, { attachmentId, recordId })       一篇
 *   parseProjectPdfs(db, { projectId, onProgress })          全项目
 *   getChunksForRecord(db, recordId)                         给 M/N 拉数据
 *   getSectionText(db, recordId, sectionType)                给 M/N 喂 LLM
 *
 * "已解析"标志:paper_chunks 里存在 record_id=? 的行即视为已解析。
 *
 * chunk_index 策略:在同一篇 record 内全局单调递增(跨 section 不重置)。
 *
 * 扫描版 PDF 容错:全文 < 100 字符 → 不写 chunks,标 requires_ocr=true。
 * 损坏 PDF:catch 后写入 errors 数组,不中断批量。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomId } from './crypto.js'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
const MAX_CHUNK_CHARS = 1500
const MIN_TEXT_FOR_PARSE = 100

// ---------- Section header 启发式 ----------
// 顺序很重要(更精确的放前面);每条匹配整个行(已经 trim 过)。
// 'other' 当 fallback。
//
// 注:pdf-parse 抽出的文本里章节标题 有时是独立一行(例如 "Introduction\n"),
// 有时跟正文同一行(例如 "Abstract—Vision systems...", "1. Introduction The recent ...")。
// 两种我们都试 — 但 "inline" 模式要求 header 在行首且后跟正文。
const SECTION_PATTERNS = [
  // abstract — 独立行 或 行首 "Abstract—..." / "Abstract:..." 接正文
  { type: 'abstract', re: /^(abstract|摘\s*要)\s*[:.—–\-。]?\s*$/i },
  { type: 'abstract', re: /^a\s*b\s*s\s*t\s*r\s*a\s*c\s*t\s*$/i },
  { type: 'abstract', re: /^abstract\s*[—–\-:]\s*\S/i, inline: true },
  // references / bibliography(放前面,避免被 introduction 的 1. 抢)
  { type: 'references', re: /^(references?|bibliography|参\s*考\s*文\s*献)\s*$/i },
  { type: 'references', re: /^(\d+\.?|\[?\d+\]?\.?)\s*(references?|bibliography)\s*$/i },
  // introduction / background
  { type: 'introduction', re: /^(1\.?\s*|i\.\s+|chapter\s+1\s*[:.]?\s*)?(introduction|background)\s*$/i },
  { type: 'introduction', re: /^1\s+(introduction|background)\s*$/i },
  { type: 'introduction', re: /^(1\.|1\s)\s*introduction\s+\S/i, inline: true },
  // methods / methodology
  { type: 'methods', re: /^(2\.?\s*|ii\.\s+)?(methods?|methodology|materials?\s+and\s+methods?|experimental\s+(setup|design|methods?)|approach|proposed\s+method)\s*$/i },
  { type: 'methods', re: /^2\s+(methods?|methodology|approach)\s*$/i },
  // results / findings
  { type: 'results', re: /^(3\.?\s*|iii\.\s+)?(results?|findings?|experiments?|evaluation|experimental\s+results?)\s*$/i },
  { type: 'results', re: /^3\s+(results?|findings?|experiments?)\s*$/i },
  // discussion
  { type: 'discussion', re: /^(4\.?\s*|iv\.\s+)?(discussion|general\s+discussion)\s*$/i },
  { type: 'discussion', re: /^4\s+discussion\s*$/i },
  // conclusion / summary
  { type: 'conclusion', re: /^(5\.?\s*|v\.\s+)?(conclusions?|summary|concluding\s+remarks?|final\s+remarks?)\s*$/i },
  { type: 'conclusion', re: /^5\s+(conclusions?|summary)\s*$/i },
]

const SECTION_TYPES = [
  'abstract',
  'introduction',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'references',
  'other',
]

/**
 * 判断一行是否是 section header。
 * 启发式:
 *   - 独立 header 行:整行 < 80 字符,匹配 SECTION_PATTERNS 里非 inline 的 re。
 *   - inline header(标了 inline:true):允许行更长(可能跟正文同一行),只看行首。
 * 返回 section_type 或 null。
 */
function classifySectionHeader(line) {
  const s = line.trim()
  if (!s) return null
  for (const p of SECTION_PATTERNS) {
    if (p.inline) {
      // inline 模式不限制长度,只要求行首匹配
      if (p.re.test(s)) return p.type
    } else {
      // 独立 header 行 — 严格短
      if (s.length <= 80 && p.re.test(s)) return p.type
    }
  }
  return null
}

/**
 * 把一行如 "Abstract—Vision systems..." / "1. Introduction The recent..." 拆成
 * { heading: 'Abstract—', body: 'Vision systems...' }。找不到分割点返回 null。
 */
function splitInlineHeader(line) {
  const s = line.trim()
  // 形如 "Abstract<sep><rest>"
  let m = s.match(/^(abstract\s*[—–\-:])\s*(\S.*)$/i)
  if (m) return { heading: m[1].trim(), body: m[2] }
  // 形如 "1. Introduction <rest>" / "1 Introduction <rest>"
  m = s.match(/^(\d+\.?\s+(?:introduction|background|methods?|methodology|results?|discussion|conclusions?))\s+(\S.*)$/i)
  if (m) return { heading: m[1].trim(), body: m[2] }
  return null
}

/**
 * 把 PDF 全文切成 [{ section_type, heading, text }, ...]。
 *
 * 逐行扫描,遇到 section header 就切一段。
 *   - 独立 header 行:整行视作 heading,不进 text。
 *   - inline header 行:把这一行拆成 heading + body,heading 作为段标题,body 进 text。
 * 第一段(没命中过 header 之前的内容)归 'other'。
 */
function splitIntoSections(fullText) {
  const lines = fullText.split('\n')
  const sections = []
  let cur = { section_type: 'other', heading: '', lines: [] }
  const flush = () => {
    const text = cur.lines.join('\n').trim()
    if (text.length > 0) {
      sections.push({
        section_type: cur.section_type,
        heading: cur.heading,
        text,
      })
    }
  }
  for (const line of lines) {
    const hit = classifySectionHeader(line)
    if (hit) {
      flush()
      // 尝试拆 inline header — 若拆到 body,把 body 当作新段第一行
      const inline = splitInlineHeader(line)
      if (inline) {
        cur = { section_type: hit, heading: inline.heading, lines: [inline.body] }
      } else {
        cur = { section_type: hit, heading: line.trim(), lines: [] }
      }
    } else {
      cur.lines.push(line)
    }
  }
  flush()
  return sections
}

/**
 * 把一段文本切成 ≤ MAX_CHUNK_CHARS 的 chunk,优先在段落边界(连续两个换行)切,
 * 退而求其次在单换行 / 句号切。
 */
function chunkText(text, maxLen = MAX_CHUNK_CHARS) {
  if (!text) return []
  if (text.length <= maxLen) return [text]

  const out = []
  // 先按双换行(段落)切
  const paras = text.split(/\n\s*\n/)
  let buf = ''
  for (const p of paras) {
    const para = p.trim()
    if (!para) continue
    if (para.length > maxLen) {
      // 段太长 → 先 flush 当前 buf,再把 para 再细切
      if (buf) {
        out.push(buf)
        buf = ''
      }
      // 在单换行 / 句号位置切
      let remaining = para
      while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf('\n', maxLen)
        if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('. ', maxLen)
        if (cut < maxLen * 0.3) cut = maxLen // 实在没合适边界就硬切
        out.push(remaining.slice(0, cut).trim())
        remaining = remaining.slice(cut).trim()
      }
      if (remaining) buf = remaining
      continue
    }
    // 段落能整段塞进 buf?
    if (buf.length + para.length + 2 <= maxLen) {
      buf = buf ? buf + '\n\n' + para : para
    } else {
      if (buf) out.push(buf)
      buf = para
    }
  }
  if (buf) out.push(buf)
  return out.map((c) => c.trim()).filter((c) => c.length > 0)
}

/** 粗略 token 估算:中英混合 ~4 字符/token */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4)
}

/** 把 attachments.storage_path 解析成绝对路径 */
function resolveStoragePath(storagePath) {
  if (!storagePath) return ''
  if (path.isAbsolute(storagePath)) return storagePath
  return path.join(UPLOAD_ROOT, storagePath)
}

// ---------- 主入口 ----------

/**
 * 解析一个 attachment(PDF)并写入 paper_chunks。
 * idempotent:同 record_id + attachment_id 重跑会先 DELETE 再 INSERT。
 *
 * @param {object} db better-sqlite3
 * @param {{ attachmentId:string, recordId?:string }} opts
 *   recordId 可选 — 不传会从 attachments 行取
 * @returns {Promise<{
 *   record_id:string, attachment_id:string,
 *   page_count:number, total_chunks:number,
 *   sections: Record<string, number>,
 *   text_length:number,
 *   requires_ocr?:boolean,
 *   skipped?:boolean,
 *   errors: string[]
 * }>}
 */
export async function parsePdfAttachment(db, { attachmentId, recordId }) {
  if (!attachmentId) throw new Error('attachmentId required')
  const errors = []

  const att = db
    .prepare(
      `SELECT id, record_id, attachment_kind, storage_path, filename FROM attachments WHERE id = ?`,
    )
    .get(attachmentId)
  if (!att) throw new Error(`attachment not found: ${attachmentId}`)
  if (att.attachment_kind !== 'pdf') {
    return {
      record_id: att.record_id,
      attachment_id: att.id,
      page_count: 0,
      total_chunks: 0,
      sections: {},
      text_length: 0,
      skipped: true,
      errors: [`not a pdf: kind=${att.attachment_kind}`],
    }
  }
  const recId = recordId || att.record_id

  const absPath = resolveStoragePath(att.storage_path)
  if (!fs.existsSync(absPath)) {
    return {
      record_id: recId,
      attachment_id: att.id,
      page_count: 0,
      total_chunks: 0,
      sections: {},
      text_length: 0,
      skipped: true,
      errors: [`file missing: ${absPath}`],
    }
  }

  let pdfData
  try {
    const buffer = fs.readFileSync(absPath)
    pdfData = await pdfParse(buffer)
  } catch (e) {
    return {
      record_id: recId,
      attachment_id: att.id,
      page_count: 0,
      total_chunks: 0,
      sections: {},
      text_length: 0,
      errors: [`pdf-parse failed: ${e.message}`],
    }
  }

  const fullText = (pdfData.text || '').trim()
  const pageCount = pdfData.numpages || 0

  if (fullText.length < MIN_TEXT_FOR_PARSE) {
    return {
      record_id: recId,
      attachment_id: att.id,
      page_count: pageCount,
      total_chunks: 0,
      sections: {},
      text_length: fullText.length,
      requires_ocr: true,
      errors: [`text too short (${fullText.length} chars) — likely scanned PDF, requires OCR`],
    }
  }

  const sections = splitIntoSections(fullText)
  // 组装要写入的 chunks
  const rows = []
  let chunkIndex = 0
  const sectionCounts = {}
  for (const sec of sections) {
    const pieces = chunkText(sec.text, MAX_CHUNK_CHARS)
    for (const piece of pieces) {
      rows.push({
        id: randomId('chk'),
        record_id: recId,
        attachment_id: att.id,
        section_type: sec.section_type,
        heading: sec.heading || null,
        page_start: null,
        page_end: null,
        chunk_index: chunkIndex,
        text: piece,
        token_count: estimateTokens(piece),
      })
      chunkIndex++
      sectionCounts[sec.section_type] = (sectionCounts[sec.section_type] || 0) + 1
    }
  }

  // idempotent write
  const del = db.prepare(`DELETE FROM paper_chunks WHERE record_id = ? AND attachment_id = ?`)
  const ins = db.prepare(`
    INSERT INTO paper_chunks (
      id, record_id, attachment_id, section_type, heading,
      page_start, page_end, chunk_index, text, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    del.run(recId, att.id)
    for (const r of rows) {
      ins.run(
        r.id,
        r.record_id,
        r.attachment_id,
        r.section_type,
        r.heading,
        r.page_start,
        r.page_end,
        r.chunk_index,
        r.text,
        r.token_count,
      )
    }
  })
  tx()

  return {
    record_id: recId,
    attachment_id: att.id,
    page_count: pageCount,
    total_chunks: rows.length,
    sections: sectionCounts,
    text_length: fullText.length,
    errors,
  }
}

/**
 * 批量解析:扫项目下所有 has_pdf 的 records 的第一个 PDF attachment。
 * 串行(每篇 5-15s,100 篇 15-25 分钟),onProgress 可选。
 *
 * @param {object} db
 * @param {{ projectId:string, onProgress?: (idx:number, total:number, recordId:string) => void, force?:boolean }} opts
 *   force=true:即使已存在 chunks 也重跑;默认 false 会跳过。
 * @returns {Promise<{
 *   project_id:string,
 *   total:number, parsed:number, skipped:number, ocr_required:number, failed:number,
 *   per_record: Array<{record_id:string, total_chunks:number, sections:object, errors:string[]}>,
 * }>}
 */
export async function parseProjectPdfs(db, { projectId, onProgress, force = false }) {
  if (!projectId) throw new Error('projectId required')

  // 取每条 record 第一个 pdf attachment
  const rows = db
    .prepare(
      `SELECT a.id AS attachment_id, a.record_id, a.storage_path, a.filename
       FROM attachments a
       JOIN records r ON r.id = a.record_id
       WHERE r.project_id = ?
         AND a.attachment_kind = 'pdf'
         AND (r.duplicate_of_record_id IS NULL)
       ORDER BY r.created_at ASC, a.created_at ASC`,
    )
    .all(projectId)

  // 按 record_id 去重(每条 record 只跑一次,取第一条 attachment)
  const seen = new Set()
  const todo = []
  for (const r of rows) {
    if (seen.has(r.record_id)) continue
    seen.add(r.record_id)
    todo.push(r)
  }

  const total = todo.length
  let parsed = 0
  let skipped = 0
  let ocrRequired = 0
  let failed = 0
  const perRecord = []

  const hasChunks = db.prepare(`SELECT COUNT(*) AS c FROM paper_chunks WHERE record_id = ?`)

  for (let i = 0; i < todo.length; i++) {
    const r = todo[i]
    if (typeof onProgress === 'function') {
      try {
        onProgress(i, total, r.record_id)
      } catch {
        /* ignore */
      }
    }
    // 跳过已解析(除非 force)
    if (!force) {
      const c = hasChunks.get(r.record_id)?.c || 0
      if (c > 0) {
        skipped++
        perRecord.push({ record_id: r.record_id, total_chunks: c, sections: {}, errors: ['skipped: already parsed'] })
        continue
      }
    }

    try {
      const res = await parsePdfAttachment(db, { attachmentId: r.attachment_id, recordId: r.record_id })
      if (res.requires_ocr) {
        ocrRequired++
      } else if (res.total_chunks > 0) {
        parsed++
      } else {
        failed++
      }
      perRecord.push({
        record_id: r.record_id,
        total_chunks: res.total_chunks,
        sections: res.sections,
        errors: res.errors,
      })
    } catch (e) {
      failed++
      perRecord.push({
        record_id: r.record_id,
        total_chunks: 0,
        sections: {},
        errors: [`exception: ${e.message}`],
      })
    }
  }

  if (typeof onProgress === 'function') {
    try {
      onProgress(total, total, null)
    } catch {
      /* ignore */
    }
  }

  return {
    project_id: projectId,
    total,
    parsed,
    skipped,
    ocr_required: ocrRequired,
    failed,
    per_record: perRecord,
  }
}

/**
 * 查询 record 的所有 chunks,按 chunk_index 升序。
 */
export function getChunksForRecord(db, recordId) {
  if (!recordId) return []
  return db
    .prepare(
      `SELECT id, record_id, attachment_id, section_type, heading,
              page_start, page_end, chunk_index, text, token_count
       FROM paper_chunks
       WHERE record_id = ?
       ORDER BY chunk_index ASC`,
    )
    .all(recordId)
}

/**
 * 查询 record 某 section 的合并文本(同 section 内多个 chunk 用 '\n\n' 串)。
 * 没有匹配返回 ''。
 */
export function getSectionText(db, recordId, sectionType) {
  if (!recordId || !sectionType) return ''
  const rows = db
    .prepare(
      `SELECT text FROM paper_chunks
       WHERE record_id = ? AND section_type = ?
       ORDER BY chunk_index ASC`,
    )
    .all(recordId, sectionType)
  return rows.map((r) => r.text).join('\n\n').trim()
}

// 暴露常量给测试 / 调用方
export const PDF_PARSE_CONSTANTS = {
  MAX_CHUNK_CHARS,
  MIN_TEXT_FOR_PARSE,
  SECTION_TYPES,
}
