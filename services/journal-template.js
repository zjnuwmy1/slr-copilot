/**
 * services/journal-template.js — Phase 9 Agent W
 * ------------------------------------------------------------
 * 目标期刊模板:用户上传一篇"我想投这本期刊"的代表性 PDF,平台抽出
 * 结构(各 section 字数 / key moves / voice register / figure 类型 / 引用密度等),
 * 存到 target_journal_templates,后续 drafting 时把这些约束注入 system prompt。
 *
 * 设计要点:
 *   - 每个 project 只允许 1 个模板(schema UNIQUE(project_id))
 *   - 上传 → parse PDF 全文 → 一次 heavy LLM → JSON normalize → upsert
 *   - 失败时不写脏数据(parse 失败 / LLM 失败 / normalize 后 sections 为空)
 *   - 调 drafting 之前,通过 buildSectionStyleHint() 把每章节相关约束拼成中文提示尾巴
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomId } from './crypto.js'
import { runLlm } from './llm.js'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const DATA_DIR = process.env.DATA_DIR || '/var/lib/slr'
const UPLOAD_ROOT = process.env.SLR_UPLOAD_ROOT || path.join(DATA_DIR, 'uploads')
export const JOURNAL_TEMPLATE_ROOT = path.join(UPLOAD_ROOT, 'journal-templates')

/** 单 PDF 大小上限:30 MB */
export const MAX_TEMPLATE_PDF_BYTES = 30 * 1024 * 1024

/** 给 LLM 的 system message — JSON schema 明确 */
export const STRUCTURE_SYSTEM = `你是学术写作分析师,精通期刊论文结构与方法学综述写作风格。
任务:用户上传了一篇他想投的目标期刊的代表性论文 PDF 全文,
请把这篇论文的结构抽出来,作为"系统综述模板"的基准,供后续 AI 生成本次综述各章节时参考字数 / 写作 moves / 风格。

输出严格 JSON,不要前后加解释、不要 Markdown 代码围栏:

{
  "journal_name": "期刊名(从首页 / running title / DOI 上下文判断,无法判断则 '' )",
  "article_title": "文章标题(尽量完整)",
  "sections": [
    {
      "name": "Introduction",
      "word_count_estimate": 800,
      "subsection_count": 0,
      "has_figure": false,
      "has_table": false,
      "key_moves": ["建立问题重要性", "界定范围", "提出研究问题"],
      "notes": "用 1-2 句话概括这节的写作策略"
    }
  ],
  "citation_density": "每 100 字 ~3 引用",
  "figure_count": 3,
  "figure_types": ["PRISMA flow", "evidence map", "conceptual framework"],
  "table_count": 4,
  "voice_register": "客观第三人称 / 过去时为主 / 偶用现在时陈述领域共识",
  "structure_notes": "全文约 6000 字,Discussion 占 30%,Methods 简短"
}

不要编造,只基于提供的全文。如果某字段拿不准就留空字符串或空数组,不要塞假数据。
sections 数组覆盖文中实际出现的章节(可能含 Abstract / Introduction / Methods / Results / Discussion / Conclusion / Limitations 等,顺序与原文一致)。
voice_register 用中文描述写作语气。`

/**
 * 把 PDF 文件解析为全文文本(纯函数,不依赖 attachments 表)。
 * 返回 { text, pageCount, error? }。损坏 / 扫描版 PDF 返回 error。
 */
export async function parsePdfFile(pdfPath) {
  try {
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return { text: '', pageCount: 0, error: 'file not found' }
    }
    const buffer = fs.readFileSync(pdfPath)
    const data = await pdfParse(buffer)
    const text = (data.text || '').trim()
    return { text, pageCount: data.numpages || 0 }
  } catch (e) {
    return { text: '', pageCount: 0, error: `pdf-parse failed: ${e.message || String(e)}` }
  }
}

/** 当前模板(若无返 null);extracted_structure 已 parse 成对象 */
export function getJournalTemplate(db, projectId) {
  if (!db || !projectId) return null
  let row
  try {
    row = db.prepare(`SELECT * FROM target_journal_templates WHERE project_id = ?`).get(projectId)
  } catch {
    return null
  }
  if (!row) return null
  let extracted = {}
  try {
    extracted = JSON.parse(row.extracted_structure || '{}')
  } catch {
    extracted = {}
  }
  return { ...row, extracted_structure: extracted }
}

/** 仅删 DB 行(PDF 文件由路由层删) */
export function deleteJournalTemplate(db, projectId) {
  if (!db || !projectId) return { ok: false, error: 'missing args' }
  const row = db.prepare(`SELECT id, source_pdf_path FROM target_journal_templates WHERE project_id = ?`).get(projectId)
  if (!row) return { ok: true, deleted: false }
  db.prepare(`DELETE FROM target_journal_templates WHERE project_id = ?`).run(projectId)
  return { ok: true, deleted: true, source_pdf_path: row.source_pdf_path }
}

/**
 * 主入口:上传后调用 — parse PDF → 跑 LLM → normalize → upsert。
 * 返回 { ok, status, template?, error?, usageLogId? }。永远 resolve,不 throw。
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {string} opts.pdfPath        绝对路径(已落盘)
 * @param {string} opts.pdfFilename    原始文件名(展示用)
 */
export async function extractJournalTemplate(db, { projectId, userId, pdfPath, pdfFilename }) {
  if (!db || !projectId || !userId || !pdfPath) {
    return { ok: false, status: 'config_error', error: 'missing args' }
  }

  // 1. parse PDF
  const parsed = await parsePdfFile(pdfPath)
  if (parsed.error || !parsed.text || parsed.text.length < 200) {
    return {
      ok: false,
      status: 'pdf_parse_failed',
      error: parsed.error || `text too short (${parsed.text.length} chars), maybe scanned PDF`,
    }
  }

  // 控制送 LLM 的字符上限(避免长 PDF 把 prompt 撑爆)
  const MAX_CHARS = 60_000   // ~15K tokens 估算
  const fullText = parsed.text.length > MAX_CHARS
    ? parsed.text.slice(0, MAX_CHARS) + '\n\n[... 后文已截断,原 PDF 共 ' + parsed.text.length + ' 字符 ...]'
    : parsed.text

  const userPrompt = [
    `请分析以下论文 PDF 全文(${parsed.pageCount} 页,${parsed.text.length} 字符)。`,
    `文件名:${pdfFilename || '(未提供)'}`,
    '',
    '请按 system message 的 JSON schema 输出结构分析。',
    '',
    '===== PDF 全文(可能已截断)=====',
    fullText,
  ].join('\n')

  // 2. 跑 LLM
  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'journal_template_extract',
      projectId,
      system: STRUCTURE_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 6144,
      timeoutMs: 300_000,
    })
  } catch (e) {
    return { ok: false, status: 'llm_error', error: e?.message || String(e) }
  }

  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 'llm_error',
      error: result.error,
      usageLogId: result.usageLogId,
    }
  }

  // 3. normalize
  const normalized = normalizeStructureOutput(result.data || null)
  if (!normalized || !Array.isArray(normalized.sections) || normalized.sections.length === 0) {
    return {
      ok: false,
      status: 'normalize_failed',
      error: 'sections empty after normalize',
      usageLogId: result.usageLogId,
    }
  }

  // 4. INSERT OR REPLACE
  try {
    // 先看有没有旧记录(用于 audit)
    const existing = db.prepare(
      `SELECT id, source_pdf_path FROM target_journal_templates WHERE project_id = ?`
    ).get(projectId)

    const id = existing?.id || randomId('jtmpl')
    const now = new Date().toISOString()

    db.prepare(`
      INSERT INTO target_journal_templates
        (id, project_id, source_pdf_path, source_pdf_filename, journal_name, article_title,
         extracted_structure, extracted_at, uploaded_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        source_pdf_path = excluded.source_pdf_path,
        source_pdf_filename = excluded.source_pdf_filename,
        journal_name = excluded.journal_name,
        article_title = excluded.article_title,
        extracted_structure = excluded.extracted_structure,
        extracted_at = excluded.extracted_at,
        uploaded_by_user_id = excluded.uploaded_by_user_id
    `).run(
      id,
      projectId,
      pdfPath,
      pdfFilename || null,
      normalized.journal_name || null,
      normalized.article_title || null,
      JSON.stringify(normalized),
      now,
      userId,
    )

    return {
      ok: true,
      status: 'success',
      template: {
        id,
        project_id: projectId,
        source_pdf_path: pdfPath,
        source_pdf_filename: pdfFilename,
        journal_name: normalized.journal_name,
        article_title: normalized.article_title,
        extracted_structure: normalized,
        extracted_at: now,
      },
      replaced_existing: !!existing,
      old_pdf_path: existing?.source_pdf_path || null,
      model: result.model,
      durationMs: result.durationMs,
      usageLogId: result.usageLogId,
    }
  } catch (e) {
    return {
      ok: false,
      status: 'db_write_failed',
      error: e?.message || String(e),
      usageLogId: result.usageLogId,
    }
  }
}

/**
 * 把 LLM 输出 normalize 成入库结构。容错:字段名变种、wrapper、数字字符串。
 */
export function normalizeStructureOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  // 解一层 wrapper
  if (raw.result && typeof raw.result === 'object' && !raw.sections) raw = raw.result
  if (raw.data && typeof raw.data === 'object' && !raw.sections) raw = raw.data
  if (raw.output && typeof raw.output === 'object' && !raw.sections) raw = raw.output

  const out = {
    journal_name: typeof raw.journal_name === 'string' ? raw.journal_name.trim() : '',
    article_title: typeof raw.article_title === 'string' ? raw.article_title.trim() : '',
    sections: [],
    citation_density: typeof raw.citation_density === 'string' ? raw.citation_density.trim() : '',
    figure_count: toInt(raw.figure_count),
    figure_types: toStringArray(raw.figure_types),
    table_count: toInt(raw.table_count),
    voice_register: typeof raw.voice_register === 'string' ? raw.voice_register.trim() : '',
    structure_notes: typeof raw.structure_notes === 'string' ? raw.structure_notes.trim() : '',
  }

  const rawSections = Array.isArray(raw.sections) ? raw.sections : []
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    if (!name) continue
    out.sections.push({
      name,
      word_count_estimate: toInt(s.word_count_estimate ?? s.word_count ?? s.words),
      subsection_count: toInt(s.subsection_count ?? s.subsections),
      has_figure: !!s.has_figure,
      has_table: !!s.has_table,
      key_moves: toStringArray(s.key_moves ?? s.moves),
      notes: typeof s.notes === 'string' ? s.notes.trim() : '',
    })
  }
  return out
}

function toInt(v) {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d.-]/g, ''), 10)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

function toStringArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  if (typeof v === 'string') return v.split(/[;,、\n]/).map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * 给定 drafting section 名(title/abstract/introduction/...)和模板,
 * 返回该 section 的"模板基准"中文 hint(若无匹配 section 或无模板,返 '')。
 *
 * 用法:在 SECTION_SYSTEMS[section] 末尾拼上这个字符串。
 */
export function buildSectionStyleHint(template, sectionKey) {
  if (!template || !template.extracted_structure) return ''
  const tpl = template.extracted_structure
  const sections = Array.isArray(tpl.sections) ? tpl.sections : []

  // 把 drafting section_key 映射到模板里可能用的 section 名
  const aliases = {
    title:        ['title', 'tit'],
    abstract:     ['abstract', '摘要', 'summary'],
    introduction: ['introduction', 'background', '引言', 'intro'],
    methods:      ['methods', 'methodology', 'materials and methods', 'method', '方法'],
    results:      ['results', 'findings', '结果'],
    discussion:   ['discussion', 'general discussion', '讨论'],
    limitations:  ['limitations', 'limitation', '局限'],
    conclusion:   ['conclusion', 'conclusions', 'concluding remarks', '结论'],
  }
  const keys = aliases[sectionKey] || [sectionKey]

  // 找到第一个名字匹配的 section(忽略大小写)
  const found = sections.find((s) => {
    const n = String(s.name || '').toLowerCase()
    return keys.some((k) => n.includes(k))
  })

  const lines = []
  lines.push('')
  lines.push('===== 期刊模板基准(请按此风格撰写)=====')
  if (tpl.journal_name) lines.push(`目标期刊:${tpl.journal_name}`)
  if (found) {
    if (found.word_count_estimate) lines.push(`本节预计字数:约 ${found.word_count_estimate} 字`)
    if (Array.isArray(found.key_moves) && found.key_moves.length) {
      lines.push(`本节关键 moves:${found.key_moves.join(' / ')}`)
    }
    if (found.notes) lines.push(`本节写作策略:${found.notes}`)
    if (found.has_figure) lines.push(`提示:目标期刊该节通常配 1 张图`)
    if (found.has_table) lines.push(`提示:目标期刊该节通常配 1 张表`)
  } else if (sectionKey && sectionKey !== 'title') {
    lines.push(`(模板里未找到对应章节 "${sectionKey}" 的字数基准,按默认写)`)
  }
  if (tpl.voice_register) lines.push(`整体写作语气:${tpl.voice_register}`)
  if (tpl.citation_density) lines.push(`引用密度参考:${tpl.citation_density}`)
  if (tpl.structure_notes) lines.push(`整体结构注:${tpl.structure_notes}`)
  lines.push('注意:以上仅为风格基准,优先保证内容准确、引用合法。')

  return lines.join('\n')
}
