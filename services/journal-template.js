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

// v2 (2026-05-24):rewritten in English + English-only output enforcement.
//   Previously the prompt was Chinese-authored and explicitly required
//   voice_register to be Chinese — but downstream Step 8 injects this
//   structure into drafting prompts whose output is academic English.
//   Chinese voice_register / Chinese key_moves drift the drafter toward
//   Chinese phrasing. v2 makes the entire extracted_structure English-only,
//   so it composes cleanly into the English drafting pipeline.
// 2026-05-26-v3:加 per-section `citation_behavior` 字段 + abstract_format
//   `in_abstract_citation_count`,让 drafting 端的 buildSectionStyleHint 能告诉
//   各 SECTION_SYSTEMS 这个目标期刊每段实际引文密度(摘要常常 0、conclusion 常常 0、
//   methods 视刊而定、intro/discussion 高)。每段 SECTION_SYSTEMS 再按这个数字
//   override 自己原硬编码的"<=6 / 0-3 / usually none"等默认。
export const STRUCTURE_SYSTEM_VERSION = '2026-05-26-v3'

/** LLM system message — strict JSON schema, cross-discipline, ENGLISH-only output */
export const STRUCTURE_SYSTEM = `# Role
You are an academic writing analyst with deep expertise in journal-article structure and methodological-review writing conventions across disciplines (medical / education / engineering / HCI / social science / policy / any other domain).

# Task
The user uploaded the full text of one published article from a target journal they intend to submit to. Extract that article's structural template — section list, word counts, moves, citation density, figure/table inventory, voice register — so the platform can use it as the writing baseline when drafting the user's own systematic review.

# Output (STRICT JSON — no markdown fence, no prose before/after)

{
  "journal_name": "<journal name; derive from masthead / running header / DOI context; empty string if not detectable>",
  "article_title": "<full article title, English; if the source PDF title is non-English, translate to English>",
  "sections": [
    {
      "name": "Introduction",
      "word_count_estimate": 800,
      "subsection_count": 0,
      "has_figure": false,
      "has_table": false,
      "key_moves": ["establish problem importance", "scope the topic", "state the research question"],
      "notes": "1-2 sentences in English summarising the section's writing strategy",
      "citation_behavior": {
        "density": "<one of: 'none' (0) | 'sparse' (1-3) | 'moderate' (4-10) | 'heavy' (11-30) | 'very_heavy' (>30)>",
        "approximate_count": <integer — actual count of in-text citations you counted in this section, 0 if none>,
        "notes": "<1 short English sentence — e.g. 'cites 8 prior reviews to scope the topic' or 'no citations — purely procedural description' or 'cites only validated measurement instruments'>"
      }
    }
  ],
  "abstract_format": {
    "shape": "<one of: 'unstructured_single_paragraph' | 'structured_with_bold_headings' | 'structured_with_inline_headings' | 'structured_no_headings'>",
    "has_keywords_line": <true|false — does the abstract end with a 'Keywords:' line?>,
    "word_count_estimate": <integer — the source abstract's prose word count, 0 if unknown>,
    "headings_used": ["Background", "Methods", "Results", "Conclusion"],
    "sample_first_120_words": "<verbatim opening ~120 words of the source paper's abstract so the drafter can mimic the cadence; empty string if not extractable>",
    "notes": "<1 short sentence in English describing the format — e.g. 'single flowing paragraph, no sub-headings, narrative tone'>",
    "in_abstract_citation_count": <integer — actual number of in-text citations inside the abstract itself. Most journals = 0; Nature / Cell / Lancet / BMJ News occasionally allow 1-3. Count [N] or (Author, YYYY) refs you see in the abstract prose only, not the body. 0 if none.>,
    "in_abstract_citation_notes": "<1 short English sentence — e.g. 'no citations in abstract per journal convention' or 'abstract cites 2 prior reviews to motivate the gap'>"
  },
  "citation_density": "approximately 3 citations per 100 words",
  "figure_count": 3,
  "figure_types": ["PRISMA flow", "evidence map", "conceptual framework"],
  "table_count": 4,
  "voice_register": "objective third person; predominantly past tense; present tense for established field consensus",
  "structure_notes": "approximately 6000 words; Discussion ~30%; Methods is concise"
}

# Hard constraints
1. **OUTPUT LANGUAGE — academic English ONLY.** Every string field above (journal_name, article_title, sections[].name, sections[].key_moves[], sections[].notes, abstract_format.notes, abstract_format.headings_used[], citation_density, figure_types[], voice_register, structure_notes) MUST be in English. If the source PDF is in Chinese / Japanese / Spanish / any other language, translate to standard scholarly English when emitting the structure. EXCEPTION: \`abstract_format.sample_first_120_words\` is the literal opening words of the abstract and may be kept in the source language (the drafter uses it for cadence reference, not direct copy).
2. **OUTPUT FORMAT — STRICT JSON.** Your ENTIRE response MUST be a single raw JSON object:
   - First character \`{\`, last character \`}\`.
   - NO markdown code fence (no \`\`\`json … \`\`\`).
   - NO text before or after the JSON.
3. **No fabrication.** Only output what the supplied PDF text actually contains. If a field cannot be determined (e.g. no figures present), emit empty string or empty array — never fake values.
4. **sections array** lists the article's actual top-level sections in the order they appear (typically Abstract / Introduction / (Literature Review) / Methods / Results / Discussion / (Limitations) / Conclusion / References; some journals merge or split). Use the journal's actual section names (translated to English), not a generic IMRaD assumption.
5. **Cross-discipline.** Do not assume any specific discipline. Adapt section vocabulary to whatever the source article uses (e.g. "Materials and Methods" vs "Methods"; "Theoretical Framework" vs "Literature Review").
6. **word_count_estimate** is integer words of body prose in that section (exclude headings, captions, in-text citations as standalone words). 0 if you cannot estimate.
7. **citation_behavior (per-section)** — Count in-text citation markers in each section yourself ([N] / (Author, YYYY) / superscript). \`density\` buckets: none = 0, sparse = 1-3, moderate = 4-10, heavy = 11-30, very_heavy = >30. This is CRITICAL because different journals have very different per-section conventions:
   - Abstract: most journals = none; Nature/Cell/Lancet sometimes allow sparse
   - Introduction: typically heavy/very_heavy
   - Methods: most clinical journals = none/sparse (procedural); engineering/HCI sometimes moderate (cite tools/instruments); ICME / measurement-heavy journals can be moderate
   - Results: in primary research = none/sparse (own data); in SLR/scoping = heavy (cite included studies)
   - Discussion: typically heavy
   - Conclusion: most journals = none/sparse; some BMC/Frontiers permit moderate
   - Limitations: typically none/sparse
   Emit honest count per section. \`notes\` field is a 1-sentence English characterisation of WHAT is being cited (e.g. "cites 8 prior reviews to scope the topic"; "cites only validated measurement instruments"; "no citations — purely procedural"). The drafter uses these numbers to override hardcoded defaults (e.g. "abstract ≤ 6 citations") with the target journal's actual convention.
8. **abstract_format.in_abstract_citation_count** — Specifically count citations inside the ABSTRACT prose only (not the body section "Introduction"). Most reviews = 0; medical reviews following PRISMA-A typically = 0; some journals allow 1-3 reference citations to anchor "extending prior work X [N]".`

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
    abstract_format: normalizeAbstractFormat(raw.abstract_format),
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
      // 2026-05-26-v3:per-section 引文行为(白名单 normalize,缺失 LLM 输出时返 null)
      citation_behavior: normalizeCitationBehavior(s.citation_behavior),
    })
  }
  return out
}

// 2026-05-26-v3:把 LLM 的 citation_behavior 子对象 normalize。
//   density 限定 5 个枚举值;approximate_count 转 int;notes 字符串裁剪。
//   全空(LLM 没输出/字段非法) → 返 null,UI 跳过该段引文密度列单元格。
function normalizeCitationBehavior(raw) {
  if (!raw || typeof raw !== 'object') return null
  const allowedDensity = new Set(['none', 'sparse', 'moderate', 'heavy', 'very_heavy'])
  const densityRaw = typeof raw.density === 'string'
    ? raw.density.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : ''
  const density = allowedDensity.has(densityRaw) ? densityRaw : ''
  const cnt = raw.approximate_count
  const approximate_count = (cnt == null || cnt === '')
    ? null
    : (Number.isFinite(Number(cnt)) ? Math.max(0, Math.round(Number(cnt))) : null)
  const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 400) : ''
  if (!density && approximate_count == null && !notes) return null
  return { density, approximate_count, notes }
}

function toInt(v) {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d.-]/g, ''), 10)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

/**
 * Normalize the abstract_format block from LLM. Capture: shape, headings list,
 * sample opening, keywords-line flag, word count. Empty defaults if missing —
 * drafter then falls back to PRISMA-for-Abstracts structured form.
 */
function normalizeAbstractFormat(raw) {
  const def = {
    shape: '',                       // '' | unstructured_single_paragraph | structured_with_bold_headings | structured_with_inline_headings | structured_no_headings
    has_keywords_line: false,
    word_count_estimate: 0,
    headings_used: [],
    sample_first_120_words: '',
    notes: '',
  }
  if (!raw || typeof raw !== 'object') return def
  const allowedShapes = new Set([
    'unstructured_single_paragraph',
    'structured_with_bold_headings',
    'structured_with_inline_headings',
    'structured_no_headings',
  ])
  const shapeRaw = typeof raw.shape === 'string' ? raw.shape.trim().toLowerCase().replace(/[\s-]+/g, '_') : ''
  // 2026-05-26-v3:in_abstract_citation_count + notes — 抽取摘要内 in-text 引文数
  //   LLM 给数字字符串 / 缺失 / 不合法 → null,UI fallback 到老的 "≤6" 默认
  const cntRaw = raw.in_abstract_citation_count
  const inAbsCnt = (cntRaw == null || cntRaw === '')
    ? null
    : (Number.isFinite(Number(cntRaw)) ? Math.max(0, Math.round(Number(cntRaw))) : null)
  return {
    shape: allowedShapes.has(shapeRaw) ? shapeRaw : '',
    has_keywords_line: !!raw.has_keywords_line,
    word_count_estimate: toInt(raw.word_count_estimate),
    headings_used: toStringArray(raw.headings_used),
    sample_first_120_words: typeof raw.sample_first_120_words === 'string'
      ? raw.sample_first_120_words.trim().slice(0, 1200)
      : '',
    notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    in_abstract_citation_count: inAbsCnt,
    in_abstract_citation_notes: typeof raw.in_abstract_citation_notes === 'string'
      ? raw.in_abstract_citation_notes.trim().slice(0, 400) : '',
  }
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
  lines.push('===== Target-journal template baseline (mirror this voice / structure) =====')
  if (tpl.journal_name) lines.push(`Target journal: ${tpl.journal_name}`)
  if (found) {
    if (found.word_count_estimate) lines.push(`Estimated section length: ~${found.word_count_estimate} words`)
    if (Array.isArray(found.key_moves) && found.key_moves.length) {
      lines.push(`Section moves observed: ${found.key_moves.join(' / ')}`)
    }
    if (found.notes) lines.push(`Section writing strategy: ${found.notes}`)
    if (found.has_figure) lines.push(`Note: this journal usually carries 1 figure in this section`)
    if (found.has_table) lines.push(`Note: this journal usually carries 1 table in this section`)

    // 2026-05-26-v3:per-section citation behavior(摘自源 journal 文章的实际密度)
    //   告诉 drafter:这个目标期刊的 <sectionKey> 段是否引文密集,
    //   让 SECTION_SYSTEMS 里的硬编码默认("abstract ≤ 6"/"methods usually no citations"/
    //   "conclusion 0-3")在模板说不同时让步。
    if (found.citation_behavior && typeof found.citation_behavior === 'object') {
      const cb = found.citation_behavior
      const density = String(cb.density || '').trim()
      const count = Number(cb.approximate_count)
      const cbNotes = String(cb.notes || '').trim()
      if (density || Number.isFinite(count) || cbNotes) {
        lines.push('')
        lines.push('-- Target-journal citation behavior in this section (★ overrides generic defaults) --')
        if (density) {
          const densityHuman = {
            none:       'NONE — the source paper has 0 citations in this section. Match this: emit 0 in-text citations here.',
            sparse:     'SPARSE (1-3 citations). Cite only the most critical anchor references.',
            moderate:   'MODERATE (4-10 citations). Cite key prior work + tools/instruments.',
            heavy:      'HEAVY (11-30 citations). Standard dense literature engagement.',
            very_heavy: 'VERY HEAVY (>30 citations). Comprehensive literature scaffolding.',
          }[density] || density
          lines.push(`- Density: ${densityHuman}`)
        }
        if (Number.isFinite(count)) lines.push(`- Observed in source article: ~${count} in-text citations in this section.`)
        if (cbNotes) lines.push(`- What was cited: ${cbNotes}`)
        lines.push('- ★ When the generic SECTION_SYSTEMS rule contradicts this (e.g., "abstract MUST have ≤6 citations" but this journal has 0; or "methods usually no citations" but this journal has 5 for measurement tools), DEFER TO THIS BLOCK. It reflects the target journal\'s actual convention.')
      }
    }
  } else if (sectionKey && sectionKey !== 'title') {
    lines.push(`(No matching "${sectionKey}" section in the template — fall back to defaults.)`)
  }

  // ── Abstract — surface abstract_format prominently so the drafter MIRRORS
  //    the source paper's abstract shape (single paragraph vs structured),
  //    not the platform's default PRISMA-for-Abstracts form.
  if (sectionKey === 'abstract' && tpl.abstract_format && typeof tpl.abstract_format === 'object') {
    const af = tpl.abstract_format
    const hasAnything = af.shape || af.headings_used?.length || af.sample_first_120_words || af.notes
    if (hasAnything) {
      lines.push('')
      lines.push('-- Target-journal abstract format (★ HARD: mirror the SOURCE PAPER\'S abstract shape, do NOT default to PRISMA-for-Abstracts structured form) --')
      if (af.shape) {
        const shapeHuman = {
          unstructured_single_paragraph:    'SINGLE FLOWING PARAGRAPH (no Background/Methods/Results sub-headings). Write the entire abstract as one continuous narrative paragraph that touches on background → methods → findings → conclusion in natural flow.',
          structured_with_bold_headings:    'STRUCTURED with bold inline lead-ins (e.g., **Background:** … **Methods:** … **Results:** … **Conclusion:** …). Use exactly the headings listed below.',
          structured_with_inline_headings:  'STRUCTURED with non-bold inline lead-ins (e.g., Background. … Methods. … Results. …). No bold; period-separated lead-ins.',
          structured_no_headings:           'STRUCTURED into clearly separated paragraphs but with NO explicit sub-headings — one paragraph per section (background / methods / results / discussion / conclusion), separated by blank lines.',
        }[af.shape] || af.shape
        lines.push(`- Shape: ${shapeHuman}`)
      }
      if (Array.isArray(af.headings_used) && af.headings_used.length) {
        lines.push(`- Sub-headings used in the source abstract: ${af.headings_used.join(' / ')}`)
      }
      if (af.word_count_estimate) {
        lines.push(`- Source abstract length: ~${af.word_count_estimate} words (match within ±20%)`)
      }
      lines.push(`- Keywords line at end: ${af.has_keywords_line ? 'YES — append "**Keywords:** k1; k2; …" after the abstract body' : 'NO — do NOT add a keywords line'}`)
      // 2026-05-26-v3:in_abstract_citation_count — 抽取时实数到的"摘要里有几个引文"
      //   大多数综述 = 0;Nature/Cell/Lancet/某些 BMJ 偶尔 1-3
      if (typeof af.in_abstract_citation_count === 'number' && af.in_abstract_citation_count >= 0) {
        const n = af.in_abstract_citation_count
        if (n === 0) {
          lines.push('- In-abstract citations: **0** (this journal\'s abstract carries no in-text citations) — emit 0 [rec_xxx] placeholders in your abstract; OVERRIDES the generic "≤6 citations" rule from SECTION_SYSTEMS.')
        } else {
          lines.push(`- In-abstract citations: **~${n}** (this journal allows ${n} in-text citation${n > 1 ? 's' : ''} in the abstract). Cite only the most critical anchor reference${n > 1 ? 's' : ''}; do not exceed this count.`)
        }
        if (af.in_abstract_citation_notes) {
          lines.push(`  - Notes: ${af.in_abstract_citation_notes}`)
        }
      }
      if (af.sample_first_120_words) {
        lines.push(`- Opening cadence reference (first ~120 words of the source paper's abstract — mimic the RHYTHM / SENTENCE LENGTH / TONE, do NOT copy content):`)
        lines.push(`  "${af.sample_first_120_words.slice(0, 600)}"`)
      }
      if (af.notes) lines.push(`- Format notes: ${af.notes}`)
    }
  }

  if (tpl.voice_register) lines.push(`Overall voice register: ${tpl.voice_register}`)
  if (tpl.citation_density) lines.push(`Citation density reference: ${tpl.citation_density}`)
  if (tpl.structure_notes) lines.push(`Overall structure notes: ${tpl.structure_notes}`)
  lines.push('Reminder: these are stylistic baselines; correctness of content + legality of citations always come first.')

  return lines.join('\n')
}

// ============================================================
// 2026-05-25 P2-9: abstract_format 单字段补抽
// ------------------------------------------------------------
// 老项目当年抽期刊模板时,STRUCTURE_SYSTEM 还没有 abstract_format 字段。
// 现在 drafting prompt 强依赖 abstract_format.shape 来决定 abstract 输出
// 是 single-paragraph 还是 structured-headings —— 老项目这字段空 → drafter
// 默退到 PRISMA-for-Abstracts 默认结构,可能跟目标期刊真实习惯不符。
//
// 这个函数只抽 abstract_format 一个字段:
//   - 重新 parse 已落盘的 source_pdf_path
//   - 用一个 mini SYSTEM(只 abstract_format JSON schema)跑 Sonnet,几秒回
//   - 把结果 merge 到 extracted_structure.abstract_format(其他字段不动)
//   - upsert
//
// 复用:parsePdfFile / normalizeAbstractFormat / runLlm。
// 不会改其他 section / journal_name / structure_notes 等。
// ============================================================

const ABSTRACT_FORMAT_SYSTEM = `# Role
You are an academic writing analyst. Look at a published journal article's PDF text and characterize ONLY its abstract's structural format.

# Output (STRICT JSON — no markdown fence, no prose before/after)

{
  "abstract_format": {
    "shape": "<one of: 'unstructured_single_paragraph' | 'structured_with_bold_headings' | 'structured_with_inline_headings' | 'structured_no_headings'>",
    "has_keywords_line": <true|false — does the abstract end with a 'Keywords:' line?>,
    "word_count_estimate": <integer — abstract prose word count, 0 if unknown>,
    "headings_used": ["Background", "Methods", "Results", "Conclusion"],
    "sample_first_120_words": "<verbatim opening ~120 words of the source paper's abstract; empty string if not extractable>",
    "notes": "<1 short sentence in English describing the format>"
  }
}

# Hard constraints
1. **STRICT JSON.** First character \`{\`, last character \`}\`. No code fence, no prose around.
2. Look at the abstract section ONLY — usually right after the title / authors, before Introduction.
3. \`shape\` distinguishes:
   - unstructured_single_paragraph: one flowing paragraph, no sub-headings
   - structured_with_bold_headings: e.g. **Background:** ... **Methods:** ...
   - structured_with_inline_headings: inline non-bold labels like "Background. ... Methods. ..."
   - structured_no_headings: distinctly multi-paragraph but headings absent
4. \`sample_first_120_words\` may be in source language (Chinese / Japanese / etc.) — drafter uses it for cadence only.
5. All other fields (notes, headings_used) MUST be in English.
6. If abstract cannot be located in the text, return shape: '' and notes: 'abstract not found'.`

/**
 * 抽取 abstract_format 单字段并 merge 回 extracted_structure。
 *
 * 返回 { ok, status, abstract_format?, replaced?, error?, usageLogId? }
 *   status: 'success' | 'no_template' | 'already_filled' | 'pdf_missing'
 *         | 'pdf_parse_failed' | 'llm_error' | 'normalize_failed' | 'db_write_failed'
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {boolean} [opts.force]  true 时即使 shape 已填也强制重抽
 */
export async function backfillAbstractFormat(db, { projectId, userId, force = false }) {
  if (!db || !projectId || !userId) {
    return { ok: false, status: 'config_error', error: 'missing args' }
  }

  // 1. 取现有模板
  const template = getJournalTemplate(db, projectId)
  if (!template) {
    return { ok: false, status: 'no_template', error: '该项目还没有上传期刊模板' }
  }

  const existing = template.extracted_structure || {}
  const existingAbs = existing.abstract_format || {}
  if (!force && existingAbs.shape && existingAbs.shape.length) {
    return {
      ok: true,
      status: 'already_filled',
      abstract_format: existingAbs,
      message: 'abstract_format 已存在,无需补抽(传 force=1 强制重抽)',
    }
  }

  // 2. parse PDF
  if (!template.source_pdf_path) {
    return { ok: false, status: 'pdf_missing', error: '模板缺 source_pdf_path 字段(可能是早期手动 INSERT)' }
  }
  const parsed = await parsePdfFile(template.source_pdf_path)
  if (parsed.error || !parsed.text || parsed.text.length < 200) {
    return {
      ok: false,
      status: 'pdf_parse_failed',
      error: parsed.error || `text too short (${parsed.text?.length || 0} chars), maybe scanned PDF or file gone`,
    }
  }

  // 截 8000ch 足够覆盖 abstract(通常前 3000ch 内)
  const MAX_CHARS = 8000
  const headText = parsed.text.length > MAX_CHARS
    ? parsed.text.slice(0, MAX_CHARS) + '\n\n[... 后文已截断,只送前 ' + MAX_CHARS + ' 字符给 LLM ...]'
    : parsed.text

  const userPrompt = [
    `请分析以下期刊文章 PDF 前部文本,只抽取 abstract_format 字段。`,
    `文件名:${template.source_pdf_filename || '(未提供)'}`,
    '',
    '严格按 system message 的 JSON schema 输出。',
    '',
    '===== PDF 前部文本(含 title + abstract + 部分 introduction)=====',
    headText,
  ].join('\n')

  // 3. 跑 Sonnet 轻量 LLM
  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'journal_template_backfill_abstract_format',
      projectId,
      system: ABSTRACT_FORMAT_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'light',   // Sonnet — 这一字段不需要 heavy
      maxTokens: 1024,
      timeoutMs: 90_000,
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

  // 4. normalize
  let rawAbs = result.data
  if (rawAbs && typeof rawAbs === 'object' && rawAbs.abstract_format) rawAbs = rawAbs.abstract_format
  const normalized = normalizeAbstractFormat(rawAbs)
  if (!normalized || !normalized.shape) {
    return {
      ok: false,
      status: 'normalize_failed',
      error: 'LLM 返回的 abstract_format.shape 空或非法',
      usageLogId: result.usageLogId,
    }
  }

  // 5. merge 回 extracted_structure 并 update
  const merged = {
    ...existing,
    abstract_format: normalized,
  }
  try {
    db.prepare(`
      UPDATE target_journal_templates
         SET extracted_structure = ?,
             extracted_at        = ?
       WHERE project_id = ?
    `).run(JSON.stringify(merged), new Date().toISOString(), projectId)
  } catch (e) {
    return {
      ok: false,
      status: 'db_write_failed',
      error: e?.message || String(e),
      usageLogId: result.usageLogId,
    }
  }

  return {
    ok: true,
    status: 'success',
    abstract_format: normalized,
    replaced: !!(existingAbs.shape && existingAbs.shape.length),
    model: result.model,
    durationMs: result.durationMs,
    usageLogId: result.usageLogId,
  }
}
