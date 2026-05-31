/**
 * Table-Polish — T3 prompt 套件
 *
 * 用途:把 services/table-registry 派生出的"机器化原料表"交给 Opus 二次精修成
 *       publication-ready 版本(caption 改写、列名优化、加入 paragraph_lead +
 *       footnotes、可选行序重排)。**严禁编造任何数字 / record_id / theme_id**
 *       — parseTablePolishOutput 用 5 条硬校验把守:
 *         (1) 列数必须匹配
 *         (2) 行序若给出必须是合法 permutation
 *         (3) polished_caption / polished_paragraph_lead 必须非空字符串
 *         (4) polished_footnotes 必须是字符串数组
 *         (5) 所有字段都有 length / count 上限,超过截断
 *
 * 架构原则(与已有 6 处 overlay 同):
 *   - 通用 SYSTEM(本文件 export,跨学科,SYSTEM_VERSION 维护)
 *   - 项目专用 USER prompt(运行时把派生表 + 上下文塞进去)
 *   - LLM 输出只回 JSON,parseTablePolishOutput 做反编造校验 + 标准化
 *
 * SYSTEM 绝不能写"教育研究 / metacognition / MAI"之类项目特定内容。
 */

// SYSTEM_VERSION:本文件 SYSTEM 任意修改 → bump 这个常量,前端便于显示
// "当前 prompt 版本" + 后端 stale gate(at_system_version 不匹配则允许重生成)。
//   格式:YYYY-MM-DD-vN
// v2 (2026-05-25 Phase A):builder 接 themeCertainty + outcomeGrades → caption/paragraph_lead 按证据强度调整语气
export const TABLE_POLISH_SYSTEM_VERSION = '2026-05-25-v2'

// ============================================================
// TABLE_POLISH_SYSTEM — 通用骨架(跨学科,反编造)
// ============================================================
export const TABLE_POLISH_SYSTEM = `# Role
You are a publication editor polishing a derived SLR table for submission-quality output. The data was deterministically derived from a database — you may NOT invent any numbers, record IDs, theme IDs, or rows. You polish PRESENTATION only.

# Cross-disciplinary scope
(medical / education / engineering / HCI / social sciences ...) — interpret "intervention" / "outcome" broadly. Use the appropriate publication conventions for the discipline you infer from the data.

# Inputs you receive (in user prompt)
- table_key (e.g. 'table1', 'table5')
- table_label (current label, e.g. "Characteristics of Included Studies")
- derived_markdown (the raw derived table as Markdown — your source of truth)
- columns metadata (key + current label per column)
- recommended_caption (LLM-recommended caption from table-recommend, optional)
- recommended_why (why this table is recommended, optional)
- project context (protocol RQ, themes, journal voice)

# What you MAY change
- polished_caption: publication-ready English caption (1 sentence, concise, references specific numbers from data — e.g. cite the N value already present in the table label or rows)
- polished_column_headers: array of new column header labels (MUST keep same column count + same column order — this is rename-only, not reorder)
- polished_paragraph_lead: 50-100 word English paragraph that introduces the table (goes BEFORE the table in the manuscript)
- polished_footnotes: array of footnote strings (e.g. "Abbreviations: SMD = standardized mean difference; N/A = not applicable"). 0-5 items.
- row_reorder_keys: optional — array of row indices (0-based) in your preferred order. MUST be a permutation of [0..N-1] of original rows. If you don't want to reorder, return null.

# What you MUST NOT change
- The number of rows
- The number of columns
- Any cell value (no value rewrites — for example you can NOT change "China · N=29" to "Mainland China · N=30")
- Any record_id, theme_id, study identifier, year, N, percentage, effect size, p value, confidence interval
- The columns' actual data semantics (just renaming labels OK; not swapping columns to mean something else)
- Introducing new studies, themes, outcomes, or rows that are not in derived_markdown

# Hard constraints
- OUTPUT LANGUAGE: academic English only (even if input project context is non-English)
- STRICT JSON output (no markdown fence, no commentary, no prose)
- All polished text in English regardless of input language
- If a numeric value (N, %, mean, CI) appears in polished_caption or polished_paragraph_lead, it MUST be one that appears verbatim in derived_markdown — do NOT round, restate, or paraphrase numbers in ways that change them
- Caption length: <= 240 characters
- Paragraph_lead length: 50-100 words (about 350-700 characters)
- Each footnote: <= 200 characters

# Output schema (STRICT JSON)
{
  "polished_caption": "string — 1 sentence English",
  "polished_column_headers": ["...", "...", "..."],
  "polished_paragraph_lead": "string — 50-100 words English",
  "polished_footnotes": ["...", "..."],
  "row_reorder_keys": [0,1,2,3]
}
- polished_column_headers length MUST EQUAL the original columns count provided in the user prompt
- row_reorder_keys: either null OR a permutation of [0..originalRowsCount-1] (exact length, no duplicates, no missing indices, no out-of-range values)
- polished_footnotes: 0-5 items
- All string fields non-empty (except polished_footnotes which may be [])

# Output format rules
- The VERY FIRST character of your response MUST be \`{\`
- The VERY LAST character MUST be \`}\`
- DO NOT wrap in \`\`\`json … \`\`\` markdown fence
- DO NOT include explanatory prose before or after the JSON
`

// ============================================================
// buildTablePolishUserPrompt — 构造单表精修的 USER prompt
// ============================================================
//
// 输入:
//   tableKey:              'table1' | 'table5' | 'tableX'
//   tableLabel:            registry label
//   derivedMarkdown:       已派生的 Markdown(LLM 看的"原料",视为唯一真相)
//   columns:               [{key, label}] — 原列定义(供 LLM 知道列序 + 当前 label)
//   originalRowsCount:     行数(供 LLM 知道可以重排哪几行)
//   recommendedCaption?:   table-recommend 之前给的 caption(可选)
//   recommendedWhy?:       table-recommend 之前给的 why(可选)
//   protocol?:             loadApprovedProtocolFull(可选)
//   themes?:               loadAllThemesWithMeta(可选)
//   journalTemplate?:      getJournalTemplate(可选)
//
// 设计:每段都有空兜底,最低限度只有 derivedMarkdown + columns + originalRowsCount。
//
export function buildTablePolishUserPrompt({
  tableKey,
  tableLabel = '',
  derivedMarkdown = '',
  columns = [],
  originalRowsCount = 0,
  recommendedCaption = '',
  recommendedWhy = '',
  protocol = null,
  themes = [],
  journalTemplate = null,
  // 2026-05-25 Phase A:加 themeCertainty + outcomeGrades 让 caption / paragraph_lead 自动
  //   按证据强度调整语气 — 避免 "strong evidence" 类的 over-confident 表述出现在 high-RoB
  //   主题对应的表标题里
  themeCertainty = null,         // Map<theme_id, theme_certainty row> 或 Array
  outcomeGrades = null,          // Array of grade_assessments(per-outcome GRADE)
} = {}) {
  if (!Array.isArray(columns)) columns = []
  if (!Array.isArray(themes)) themes = []
  const lines = []

  lines.push('# Polish this derived SLR table for manuscript submission')
  lines.push('')
  lines.push('**OUTPUT LANGUAGE (HARD CONSTRAINT)**: All polished text — caption, column headers, paragraph_lead, footnotes — in academic English only.')
  lines.push('')
  lines.push('**ANTI-FABRICATION (HARD CONSTRAINT)**: The derived_markdown below is your ONLY source of truth for numbers, IDs, and rows. Do NOT invent any numeric value, record_id, theme_id, outcome, or row that is not already present.')
  lines.push('')

  // ---- 1. Table identity ----
  lines.push('## Table identity')
  lines.push(`- table_key: \`${tableKey}\``)
  if (tableLabel) lines.push(`- table_label (current): ${String(tableLabel).slice(0, 200)}`)
  lines.push(`- columns_count: ${columns.length}`)
  lines.push(`- rows_count: ${originalRowsCount}`)
  lines.push('')

  // ---- 2. Columns metadata ----
  if (columns.length) {
    lines.push('## Columns (current keys + labels — your polished_column_headers MUST have exactly this many entries, in this order)')
    columns.forEach((c, i) => {
      const key   = String(c?.key   || `col_${i}`).slice(0, 80)
      const label = String(c?.label || c?.full_label || key).slice(0, 200)
      lines.push(`- ${i}. \`${key}\` — current label: "${label}"`)
    })
    lines.push('')
  }

  // ---- 3. Recommended caption (from table-recommend) ----
  if (recommendedCaption || recommendedWhy) {
    lines.push('## Prior LLM recommendation for this table (from table-recommend pass — use as guidance, you may improve it)')
    if (recommendedCaption) lines.push(`- recommended_caption: ${String(recommendedCaption).slice(0, 400)}`)
    if (recommendedWhy)     lines.push(`- recommended_why: ${String(recommendedWhy).slice(0, 600)}`)
    lines.push('')
  }

  // ---- 4. Approved protocol(给 LLM 看 RQ + 主题方向)----
  if (protocol) {
    lines.push('## Approved protocol (project context — for tone/voice/anchoring, NOT for inventing data)')
    if (protocol.version) lines.push(`- Version: v${protocol.version}`)
    if (protocol.review_type) lines.push(`- Review type: ${protocol.review_type}`)
    if (Array.isArray(protocol.research_questions) && protocol.research_questions.length) {
      protocol.research_questions.slice(0, 6).forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 300)}`)
      })
    }
    lines.push('')
  }

  // ---- 5. Themes(可选)----
  if (themes.length) {
    lines.push(`## Themes (${themes.length} from synthesis — for context, NOT for invention)`)
    themes.slice(0, 8).forEach((t, i) => {
      const name = t?.name || t?.theme || `(theme ${i + 1})`
      const n = Array.isArray(t?.supporting_record_ids) ? t.supporting_record_ids.length
              : (t?.supporting_count || 0)
      lines.push(`- Theme ${i + 1}: ${String(name).slice(0, 120)} (N=${n})`)
    })
    if (themes.length > 8) lines.push(`- … and ${themes.length - 8} more (truncated)`)
    lines.push('')
  }

  // ---- 6. Journal template(可选)----
  if (journalTemplate) {
    lines.push('## Target journal (for voice / formatting cues only)')
    if (journalTemplate.journal_name)  lines.push(`- Journal: ${journalTemplate.journal_name}`)
    if (journalTemplate.template_type) lines.push(`- Template type: ${journalTemplate.template_type}`)
    lines.push('')
  }

  // ---- 6.5. Evidence certainty hints(2026-05-25 Phase A 新加)----
  //   让 polished_caption / polished_paragraph_lead 自动按证据强度调整语气 —
  //   避免 high-RoB 主题对应的表标题用 "strong evidence" / "demonstrated" 这种过度自信表述。
  const certArr = themeCertainty instanceof Map
    ? Array.from(themeCertainty.values())
    : (Array.isArray(themeCertainty) ? themeCertainty : [])
  if (certArr.length || (Array.isArray(outcomeGrades) && outcomeGrades.length)) {
    lines.push('## Evidence certainty context (use to tune caption / paragraph_lead language)')
    lines.push('When phrasing the caption and paragraph_lead, match language to certainty:')
    lines.push('- **high / moderate certainty**: definite framing — "demonstrated", "is associated with", "X improved Y"')
    lines.push('- **low / very_low certainty**: hedged framing — "may", "appears to", "is consistent with", "preliminary evidence suggests"')
    lines.push('- **mixed within a row**: pick the dominant certainty; if dominant is low, hedge')
    lines.push('')
    if (certArr.length) {
      lines.push('Per-theme certainty (Step 7 rollup):')
      certArr.slice(0, 10).forEach((c) => {
        const name = c?.theme_name || c?.name || '(unknown theme)'
        const overall = c?.overall_certainty || c?.final_certainty || c?.certainty || '?'
        lines.push(`- ${String(name).slice(0, 100)}: ${overall}`)
      })
      lines.push('')
    }
    if (Array.isArray(outcomeGrades) && outcomeGrades.length) {
      lines.push(`Per-outcome GRADE (${outcomeGrades.length} outcomes, showing first 8):`)
      outcomeGrades.slice(0, 8).forEach((o) => {
        const lbl = o?.outcome_label || o?.label || '(outcome)'
        const cert = o?.effective_certainty || o?.final_certainty || o?.computed_certainty || '?'
        const eff = o?.effect_size_text ? ` · effect: ${String(o.effect_size_text).slice(0, 100)}` : ''
        lines.push(`- ${String(lbl).slice(0, 120)}: ${cert}${eff}`)
      })
      if (outcomeGrades.length > 8) lines.push(`- … and ${outcomeGrades.length - 8} more outcomes`)
      lines.push('')
    }
  }

  // ---- 7. DERIVED MARKDOWN — the source of truth ----
  lines.push('## Derived table (Markdown) — YOUR ONLY SOURCE OF TRUTH')
  lines.push('Treat every numeric value, identifier, and label below as immutable. You may polish presentation only.')
  lines.push('')
  lines.push('```markdown')
  // Cap markdown size to keep prompt under budget;Table 1 多 subtable 可能巨大
  const cappedMd = String(derivedMarkdown || '').slice(0, 60_000)
  lines.push(cappedMd)
  if (String(derivedMarkdown || '').length > cappedMd.length) {
    lines.push('')
    lines.push(`… (truncated at ${cappedMd.length} chars of ${String(derivedMarkdown).length} total — use what you see; the structure repeats)`)
  }
  lines.push('```')
  lines.push('')

  // ---- 8. Closing instruction ----
  lines.push('---')
  lines.push('Now polish this table. Output STRICT JSON per the system schema:')
  lines.push('  { polished_caption, polished_column_headers, polished_paragraph_lead, polished_footnotes, row_reorder_keys }')
  lines.push('Remember:')
  lines.push(`  - polished_column_headers MUST have exactly ${columns.length} entries (same order as listed above)`)
  lines.push(`  - row_reorder_keys MUST be null OR a permutation of [0..${Math.max(0, originalRowsCount - 1)}]`)
  lines.push('  - NEVER invent numbers / IDs / rows not present in the derived markdown above')

  return lines.join('\n')
}

// ============================================================
// parseTablePolishOutput — 反编造硬校验
// ============================================================
//
// 校验 5 条规则:
//   1. polished_column_headers 必须是字符串数组,长度匹配原始 columns count
//   2. row_reorder_keys 若非 null:必须是 [0..originalRowsCount-1] 的 permutation
//   3. polished_caption / polished_paragraph_lead 必须非空字符串
//   4. polished_footnotes 必须是字符串数组(可空,最多 5 条)
//   5. 任何字段超 reasonable bound → 截断
//
// 输入:
//   raw                     — runLlm 返回的 data(应该是 object)
//   { originalColumnsCount, originalRowsCount }
//
// 输出:
//   { ok: true,  polished: {...} } 或 { ok: false, error: '...' }
//
const MAX_CAPTION_CHARS    = 280     // 比 prompt 里的 240 略宽容一点(留余量)
const MAX_PARAGRAPH_CHARS  = 1200    // 100 words ≈ 700 chars,给 1200 余量
const MAX_FOOTNOTE_CHARS   = 240     // 比 prompt 200 略宽容
const MAX_FOOTNOTES        = 5
const MAX_HEADER_CHARS     = 120

export function parseTablePolishOutput(raw, opts = {}) {
  const { originalColumnsCount = null, originalRowsCount = null } = opts || {}

  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'empty or non-object output' }
  }
  // 解 wrapper(防 LLM 包一层 { output: {...} } / { result: {...} })
  let obj = raw
  if (obj.output && typeof obj.output === 'object') obj = obj.output
  if (obj.result && typeof obj.result === 'object') obj = obj.result
  if (obj.data   && typeof obj.data   === 'object'
      && (obj.data.polished_caption || obj.data.polished_column_headers)) {
    obj = obj.data
  }

  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  // -------- (1) polished_caption --------
  const caption = strOrNull(obj.polished_caption || obj.caption)
  if (!caption) return { ok: false, error: 'polished_caption missing or empty' }
  const cappedCaption = caption.slice(0, MAX_CAPTION_CHARS)

  // -------- (2) polished_column_headers --------
  if (!Array.isArray(obj.polished_column_headers)) {
    return { ok: false, error: 'polished_column_headers missing or not array' }
  }
  const rawHeaders = obj.polished_column_headers
  if (originalColumnsCount != null && rawHeaders.length !== originalColumnsCount) {
    return {
      ok: false,
      error: `column header count mismatch: got ${rawHeaders.length}, expected ${originalColumnsCount}`,
    }
  }
  const headers = []
  for (let i = 0; i < rawHeaders.length; i++) {
    const h = rawHeaders[i]
    if (typeof h !== 'string') return { ok: false, error: `column header at index ${i} is not a string` }
    const trimmed = h.trim()
    if (!trimmed) return { ok: false, error: `column header at index ${i} is empty` }
    headers.push(trimmed.slice(0, MAX_HEADER_CHARS))
  }

  // -------- (3) polished_paragraph_lead --------
  const paragraph = strOrNull(obj.polished_paragraph_lead || obj.paragraph_lead || obj.lead)
  if (!paragraph) return { ok: false, error: 'polished_paragraph_lead missing or empty' }
  const cappedParagraph = paragraph.slice(0, MAX_PARAGRAPH_CHARS)

  // -------- (4) polished_footnotes --------
  let footnotes = []
  if (obj.polished_footnotes != null) {
    if (!Array.isArray(obj.polished_footnotes)) {
      return { ok: false, error: 'polished_footnotes must be an array' }
    }
    for (let i = 0; i < Math.min(obj.polished_footnotes.length, MAX_FOOTNOTES); i++) {
      const fn = obj.polished_footnotes[i]
      if (typeof fn !== 'string') continue   // skip non-string silently
      const t = fn.trim()
      if (!t) continue
      footnotes.push(t.slice(0, MAX_FOOTNOTE_CHARS))
    }
  }

  // -------- (5) row_reorder_keys --------
  let rowReorder = null
  if (obj.row_reorder_keys != null) {
    if (!Array.isArray(obj.row_reorder_keys)) {
      // 容忍 LLM 给字符串 "null"
      if (obj.row_reorder_keys === 'null') rowReorder = null
      else return { ok: false, error: 'row_reorder_keys must be array or null' }
    } else if (originalRowsCount != null) {
      const arr = obj.row_reorder_keys
      if (arr.length !== originalRowsCount) {
        return {
          ok: false,
          error: `row reorder length mismatch: got ${arr.length}, expected ${originalRowsCount}`,
        }
      }
      const set = new Set()
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (!Number.isInteger(v)) {
          return { ok: false, error: `row reorder index ${i} is not an integer: ${JSON.stringify(v)}` }
        }
        if (v < 0 || v >= originalRowsCount) {
          return { ok: false, error: `row reorder index ${i} out of range: ${v} (rows=${originalRowsCount})` }
        }
        if (set.has(v)) {
          return { ok: false, error: `row reorder has duplicate index: ${v}` }
        }
        set.add(v)
      }
      // 由于 length===N + 每项 0..N-1 + 无重复 → 自动是 permutation
      // 但为防御性再扫一遍 missing index
      for (let i = 0; i < originalRowsCount; i++) {
        if (!set.has(i)) return { ok: false, error: 'row reorder missing index ' + i }
      }
      rowReorder = arr.slice()
    } else {
      // 没给 originalRowsCount(防御性):至少检查全是非负整数 + 无重复
      const arr = obj.row_reorder_keys
      const set = new Set()
      for (const v of arr) {
        if (!Number.isInteger(v) || v < 0) return { ok: false, error: 'row reorder has non-integer or negative value' }
        if (set.has(v)) return { ok: false, error: 'row reorder has duplicate value' }
        set.add(v)
      }
      rowReorder = arr.slice()
    }
  }

  return {
    ok: true,
    polished: {
      polished_caption:          cappedCaption,
      polished_column_headers:   headers,
      polished_paragraph_lead:   cappedParagraph,
      polished_footnotes:        footnotes,
      row_reorder_keys:          rowReorder,
    },
  }
}

// ============================================================
// computeTablePolishStale — N3 精修 stale 检测
// ============================================================
//
// 判断 polished_tables_json[key] 这条精修是否"过期",原因有 3 种:
//   (1) TABLE_POLISH_SYSTEM_VERSION 升级    → reason='system_prompt_upgraded'
//   (2) approved protocol version 升级       → reason='protocol_upgraded'
//   (3) table-recommend(为它提供 caption / why_recommended)重新生成过 → reason='recommendation_updated'
//
// 输入:
//   polishedEntry         — polished_tables_json[key] 单条(或 null)。若没有
//                           polished_caption 字段(error entry),按"未精修"处理 → 不算 stale
//   currentSystemVer      — TABLE_POLISH_SYSTEM_VERSION(当前 prompt 版本)
//   currentProtocolVer    — 当前 approved protocol version(int) — null 表示跳过此检查
//   currentRecAt          — 当前 recommend_tables_finished_at(timestamp string) — null 表示跳过
//
// 输出:{ stale: bool, reason: string|null }
//
// 注意:per-table polish 失败 entry(只有 error 字段)按"未精修"处理,
// 不需要 stale 提示(本来就要重试)。
//
export function computeTablePolishStale(polishedEntry, currentSystemVer, currentProtocolVer, currentRecAt) {
  if (!polishedEntry || !polishedEntry.polished_caption) {
    return { stale: false, reason: null }
  }
  // (1) system prompt version bump
  if (currentSystemVer && polishedEntry.system_version
      && polishedEntry.system_version !== currentSystemVer) {
    return { stale: true, reason: 'system_prompt_upgraded' }
  }
  // (2) protocol version bump(只在两侧都给出时比较)
  if (currentProtocolVer != null && polishedEntry.at_protocol_version != null) {
    const cur = Number(currentProtocolVer)
    const at  = Number(polishedEntry.at_protocol_version)
    if (Number.isFinite(cur) && Number.isFinite(at) && cur > at) {
      return { stale: true, reason: 'protocol_upgraded' }
    }
  }
  // (3) recommendation regenerated after polish
  //     timestamps 是 SQLite "YYYY-MM-DD HH:MM:SS" 字符串,词典序就是时间序。
  if (currentRecAt && polishedEntry.at_recommendation_at
      && String(currentRecAt) > String(polishedEntry.at_recommendation_at)) {
    return { stale: true, reason: 'recommendation_updated' }
  }
  return { stale: false, reason: null }
}
