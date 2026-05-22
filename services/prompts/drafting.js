/**
 * Drafting — 综述初稿章节写作。
 *
 * 落地自用户设计文档 Prompt 6(章节起草)+ 7(整文组装的引用一致性约束)。
 *
 * 每个章节单独跑一次 LLM,因为:
 *  1) 上下文不同(intro 不需要 evidence matrix,results 需要;methods 需要 PRISMA flow);
 *  2) 单次 8K maxTokens 才够中文 + 引用占位的体量;
 *  3) 失败可单独重试。
 *
 * 写作约束:
 *  - 每个事实性陈述后面带 `[record_id]` 占位符,例:
 *    "端到端学习在内窥镜分割任务上准确率比传统方法高 5-8 个百分点 [rec_abc123]。"
 *  - LLM 同时返回 citation_map,把 placeholder 映射回 record_id。
 *  - References 章节**不走 LLM**,由调用方用 exportReferencesSection 生成。
 */

// ============================================================
// 共用约束:每个 system message 都拼接
// ============================================================

const COMMON_RULES = `
GENERAL RULES (these override anything that conflicts in the user prompt):

1. **OUTPUT LANGUAGE — MUST be academic English.**
   - The final manuscript is for journal submission, so every word in
     \`content_markdown\` MUST be written in English, regardless of the
     language used in the user prompt.
   - The user prompt may contain Chinese (research topic, themes,
     findings, criteria, etc.) — read and translate them faithfully
     into English. Do NOT output Chinese characters anywhere in
     \`content_markdown\` except for proper nouns that have no
     established English equivalent.
   - Use standard SLR academic register: third person, past tense for
     methods and results, present tense for established knowledge.
     Avoid first-person voice unless the journal style explicitly
     prefers it.
   - Avoid filler openers ("This review aims to explore…",
     "In recent years, …") and avoid hyped vocabulary
     ("paradigm-shifting", "groundbreaking", "revolutionary").

2. **STRICT JSON OUTPUT** with these fields:
   {
     "content_markdown": "the section body in Markdown, written in English",
     "citation_map": [
       { "placeholder": "[rec_abc123]", "paper_id": "rec_abc123" }
     ]
   }

3. **CITATION RULES (critical — do not violate)**:
   - Every concrete factual statement, number, or claim must be
     followed by a \`[record_id]\` placeholder.
   - \`record_id\` MUST come from the "Citable papers" list in the user
     prompt — never invent IDs and never write paper titles inline.
   - Multiple supporting papers go inside the same brackets, comma
     separated: \`[rec_a, rec_b, rec_c]\`.
   - Populate \`citation_map\` with every placeholder you used. If one
     placeholder maps to multiple paper_ids, emit one row per paper_id
     with the same \`placeholder\` value.
   - Do NOT use IEEE-style \`[1]\`/\`[2]\` numbering — the export layer
     numbers them.
   - Methods-of-the-review sentences and transitions do not need
     citations.

4. **MARKDOWN FORMAT**:
   - Use \`##\` for section headings, \`###\` for sub-sections.
   - Blank line between paragraphs.
   - Bulleted lists with \`-\`.
   - GFM tables (\`| col | col |\` + separator row).
   - Do NOT include a References section inside \`content_markdown\`
     (References is appended separately by the export layer).

5. **OUTPUT JSON ONLY** — no prose before or after, no \`\`\`json fences.
`

// ============================================================
// 每个章节的特化 system message
// ============================================================

export const SECTION_SYSTEMS = {
  title: `You are a systematic literature review methodologist. Task: produce
an accurate, searchable English title for this systematic review,
based on the research topic, research questions, and theme clusters.
${COMMON_RULES}

SECTION-SPECIFIC RULES (title):
- \`content_markdown\` is a single Markdown level-1 heading line
  (\`# Title here\`) and nothing else.
- 10–20 words, declarative (no question marks), and includes the
  phrase "systematic review" (or "scoping review", as appropriate).
- No subtitle unless it adds substantive information.
- \`citation_map\` is an empty array.
`,

  abstract: `You are a systematic literature review methodologist with deep
knowledge of the PRISMA 2020 for Abstracts checklist (item #2). Task:
write a structured English abstract of 250–300 words covering
background, methods, results, discussion, and conclusion.
${COMMON_RULES}

SECTION-SPECIFIC RULES (abstract):
- Start \`content_markdown\` with \`## Abstract\`.
- Use bold lead-ins on each sub-paragraph: \`**Background:** …\`,
  \`**Methods:** …\`, \`**Results:** …\`, \`**Discussion:** …\`,
  \`**Conclusion:** …\` — do NOT use \`###\` sub-headings.
- Cite specific studies with \`[record_id]\` where appropriate, but
  keep the abstract synoptic — at most 6 citations.
- End with one line of keywords: \`**Keywords**: keyword1; keyword2; …\`
  (3–6 keywords, no citations on this line).
`,

  introduction: `You are a systematic literature review methodologist. Task: write
the Introduction section of the review.
${COMMON_RULES}

SECTION-SPECIFIC RULES (introduction):
- Start \`content_markdown\` with \`## Introduction\`.
- Three paragraphs:
  1) Background — why this topic matters (cite 3–6 key papers).
  2) Existing gap / limitation in prior work (cite 2–5 papers
     describing what has and has not been done).
  3) The objective of this review — restate the research questions
     in natural prose, 1–2 sentences.
- 400–700 words total.
`,

  methods: `You are a systematic literature review methodologist trained in
PRISMA 2020. Task: write the Methods section.
${COMMON_RULES}

SECTION-SPECIFIC RULES (methods):
- Start \`content_markdown\` with \`## Methods\`, then sub-sections:
  - \`### Search strategy\` — name each database actually used and
    the version of the query that was executed.
  - \`### Eligibility criteria\` — list inclusion and exclusion
    criteria as bullets.
  - \`### Screening and data-extraction process\` — describe the
    title/abstract screen → full-text assessment → data extraction
    pipeline.
  - \`### Synthesis approach\` — state that thematic synthesis was
    used (and Meta-analysis was not, unless otherwise specified).
- The Methods section usually requires no in-text citations (you are
  describing this review's own procedure) — \`citation_map\` may be
  empty or very short.
- 300–500 words total.
`,

  results: `You are a systematic literature review methodologist. Task: write
the Results section based on the theme clusters and Evidence Matrix.
${COMMON_RULES}

SECTION-SPECIFIC RULES (results):
- Start \`content_markdown\` with \`## Results\`.
- Opening paragraph: overview — number of included studies, study
  types covered, year range, geography (based on PRISMA counts the
  user provided; this paragraph does NOT need citations).
- Then one sub-section per theme:
  - \`### <Theme name in English>\`
  - Consistent findings within the theme (each with \`[record_id]\`).
  - Conflicting findings, when present, introduced with "However, X
    reported …" (with citations).
  - 1–2 closing summary sentences for the theme.
- 800–1500 words total. Citation density is HIGH (2–6 placeholders
  per paragraph).
- **Every concrete number, performance comparison, or experimental
  outcome MUST carry a citation.**
`,

  discussion: `You are a systematic literature review methodologist. Task: write
the Discussion section.
${COMMON_RULES}

SECTION-SPECIFIC RULES (discussion):
- Start \`content_markdown\` with \`## Discussion\`.
- Three sub-sections:
  - \`### Principal findings\` — distil the Results themes into 2–4
    core take-aways (with supporting citations).
  - \`### Evidence gaps\` — draw on the evidence_gaps inputs to
    discuss limitations of the current body of evidence (cite 2–4
    representative studies).
  - \`### Implications for practice and future research\` — light on
    citations, 1–2 paragraphs of synthesis.
- 500–900 words total.
- Discussion explains "why", not "who said what" — that's Results.
`,

  limitations: `You are a systematic literature review methodologist. Task: write
the Limitations section.
${COMMON_RULES}

SECTION-SPECIFIC RULES (limitations):
- Start \`content_markdown\` with \`## Limitations\`.
- Two angles:
  1) Limitations of this review itself (search date range, language
     restrictions, grey literature coverage, single-reviewer
     screening, etc.) — usually no citations needed.
  2) Methodological limitations of the included body of evidence
     (sample sizes, heterogeneity, inconsistent outcome measures);
     cite 2–3 representative studies.
- 200–400 words total.
`,

  conclusion: `You are a systematic literature review methodologist. Task: write
the Conclusion section.
${COMMON_RULES}

SECTION-SPECIFIC RULES (conclusion):
- Start \`content_markdown\` with \`## Conclusion\`.
- One paragraph of 100–200 words.
- Do not introduce new claims. Distil the Discussion's core
  conclusions into 3–5 crisp sentences.
- Close with one sentence on suggested directions for future
  research.
- 0–3 citations, only on the most critical claims.
`,
}

/**
 * 给定章节名,返回对应的 system message;不存在则返回 null。
 */
export function getSectionSystem(section) {
  return SECTION_SYSTEMS[section] || null
}

/**
 * Phase 9 Agent W:把"目标期刊模板"约束拼到 system message 末尾。
 *
 * 调用方:`routes/projects/report.js` 在 runLlm 之前用这个函数包装 system。
 * 若 styleHint 为空字符串/null,直接返回原 system(零回归)。
 *
 * @param {string} system    原 SECTION_SYSTEMS[section] 内容
 * @param {string|null} styleHint  来自 journal-template 的 buildSectionStyleHint() 输出
 * @returns {string} 拼接后的 system
 */
export function augmentSystemWithTemplate(system, styleHint) {
  if (!system) return system
  if (!styleHint || typeof styleHint !== 'string' || !styleHint.trim()) return system
  return system + '\n\n' + styleHint.trim() + '\n'
}

/**
 * 标准 9 章节顺序(References 不在这里,导出时单独拼)。
 */
export const SECTION_ORDER = [
  'title',
  'abstract',
  'introduction',
  'methods',
  'results',
  'discussion',
  'limitations',
  'conclusion',
]

export const SECTION_LABELS = {
  title:        '题目(Title)',
  abstract:     '摘要(Abstract)',
  introduction: '引言(Introduction)',
  methods:      '方法(Methods)',
  results:      '结果(Results)',
  discussion:   '讨论(Discussion)',
  limitations:  '局限(Limitations)',
  conclusion:   '结论(Conclusion)',
  references:   '参考文献(References)',
}

/**
 * 构造每个章节的 user prompt。
 *
 * @param {object} args
 * @param {string} args.section
 * @param {object} args.project        含 title, topic, discipline, year_start, year_end, databases 等
 * @param {object|null} args.protocol  含 research_questions, inclusion_criteria, exclusion_criteria
 * @param {Array}  args.themes         normalize 后的 themes,含 supporting_record_ids
 * @param {Array}  args.evidencePoints 可引用的 finding 列表 [{record_id, finding, section, ...}]
 * @param {object|null} args.prismaCounts PRISMA flow 数字
 * @param {Array}  args.citableRecords 可引用论文列表 [{record_id, short_label}]  ← LLM 用 record_id 引用
 * @param {Array}  args.searchStrategies 已用的检索式(给 methods 用)
 */
export function buildSectionUserPrompt({
  section,
  project = {},
  protocol = null,
  themes = [],
  evidencePoints = [],
  prismaCounts = null,
  citableRecords = [],
  searchStrategies = [],
}) {
  const lines = [`请为系统综述撰写 **${section}** 章节。`, '']

  // 项目基础信息
  lines.push('===== 项目信息 =====')
  if (project.title) lines.push(`项目标题: ${project.title}`)
  if (project.topic) lines.push(`研究主题: ${project.topic}`)
  if (project.discipline) lines.push(`学科: ${project.discipline}`)
  if (project.goal) lines.push(`研究目标: ${project.goal}`)
  if (project.year_start || project.year_end) {
    lines.push(`时间范围: ${project.year_start || '不限'} - ${project.year_end || '不限'}`)
  }
  if (Array.isArray(project.databases) && project.databases.length) {
    lines.push(`检索数据库: ${project.databases.join(', ')}`)
  }

  // 协议
  if (protocol) {
    lines.push('')
    lines.push('===== 已审批协议 =====')
    if (Array.isArray(protocol.research_questions) && protocol.research_questions.length) {
      lines.push('研究问题:')
      protocol.research_questions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
    }
    if (['methods', 'introduction', 'abstract'].includes(section)) {
      if (Array.isArray(protocol.inclusion_criteria) && protocol.inclusion_criteria.length) {
        lines.push('纳入标准:')
        protocol.inclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
      }
      if (Array.isArray(protocol.exclusion_criteria) && protocol.exclusion_criteria.length) {
        lines.push('排除标准:')
        protocol.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
      }
    }
  }

  // PRISMA 计数(主要给 methods / results / abstract 用)
  if (prismaCounts && ['methods', 'results', 'abstract'].includes(section)) {
    lines.push('')
    lines.push('===== PRISMA Flow 计数(由系统精确计算,直接引用) =====')
    lines.push(`检索命中(去重前): ${formatRecordsIdentified(prismaCounts.records_identified)}`)
    lines.push(`去重移除: ${prismaCounts.duplicates_removed ?? 0}`)
    lines.push(`待筛选(去重后): ${prismaCounts.records_screened ?? 0}`)
    lines.push(`标题/摘要排除: ${prismaCounts.excluded_title_abstract ?? 0}`)
    lines.push(`全文评估: ${prismaCounts.full_text_assessed ?? 0}`)
    lines.push(`全文排除: ${prismaCounts.full_text_excluded ?? 0}`)
    lines.push(`最终纳入: ${prismaCounts.studies_included ?? 0}`)
  }

  // 检索式(methods 用)
  if (section === 'methods' && searchStrategies.length) {
    lines.push('')
    lines.push('===== 已使用的检索式 =====')
    for (const s of searchStrategies.slice(0, 9)) {
      lines.push(`- [${s.database_name} / ${s.query_type}] 命中 ${s.result_count ?? '未记录'} 条`)
    }
  }

  // Themes + Evidence(results / discussion / limitations / conclusion 用)
  if (['results', 'discussion', 'limitations', 'conclusion', 'abstract', 'introduction'].includes(section)) {
    if (themes.length) {
      lines.push('')
      lines.push('===== 主题聚类(Themes) =====')
      themes.forEach((t, i) => {
        lines.push('')
        lines.push(`主题 ${i + 1}: ${t.name}`)
        if (t.description) lines.push(`描述: ${t.description}`)
        if (t.evidence_strength) lines.push(`证据强度: ${t.evidence_strength}`)
        const ids = Array.isArray(t.supporting_record_ids) ? t.supporting_record_ids : []
        if (ids.length) lines.push(`支持论文 record_id: ${ids.join(', ')}`)
        if (Array.isArray(t.consistent_findings) && t.consistent_findings.length) {
          lines.push('一致结论:')
          t.consistent_findings.forEach((f) => lines.push(`  - ${f}`))
        }
        if (Array.isArray(t.conflicting_findings) && t.conflicting_findings.length) {
          lines.push('矛盾结论:')
          t.conflicting_findings.forEach((f) => lines.push(`  - ${f}`))
        }
        if (Array.isArray(t.evidence_gaps) && t.evidence_gaps.length) {
          lines.push('证据空白:')
          t.evidence_gaps.forEach((f) => lines.push(`  - ${f}`))
        }
      })
    }

    if (evidencePoints.length && ['results', 'discussion'].includes(section)) {
      lines.push('')
      lines.push('===== 重点 finding(可在正文引用) =====')
      // 限制条数:前 60 条
      evidencePoints.slice(0, 60).forEach((ep) => {
        const tag = ep.strength ? `[${ep.strength}]` : ''
        lines.push(`- ${tag} ${ep.finding} (record_id: ${ep.record_id}${ep.section ? ', section=' + ep.section : ''})`)
      })
    }
  }

  // 可引用论文列表 — 这是引用合法性的来源
  if (citableRecords.length) {
    lines.push('')
    lines.push('===== 可引用论文列表(引用时必须用这些 record_id) =====')
    citableRecords.forEach((r) => {
      lines.push(`  ${r.record_id}: ${r.short_label || ''}`)
    })
  }

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出本章节。')
  lines.push('记住:正文里的 [record_id] 必须来自上面的「可引用论文列表」,绝对不要编造。')
  lines.push('')
  lines.push('===== FINAL OUTPUT-LANGUAGE OVERRIDE =====')
  lines.push('Regardless of the language used above, **`content_markdown` MUST**')
  lines.push('**be written in academic English**. Translate any Chinese inputs')
  lines.push('faithfully. Do not include Chinese characters in the manuscript')
  lines.push('except for proper nouns without an established English equivalent.')
  return lines.join('\n')
}

/**
 * 格式化 records_identified:可能是数字,也可能是 { wos:N, scopus:N, ...other:N }
 */
function formatRecordsIdentified(v) {
  if (v == null) return '0'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const parts = []
    let total = 0
    for (const [k, n] of Object.entries(v)) {
      if (typeof n !== 'number') continue
      total += n
      parts.push(`${k}=${n}`)
    }
    return parts.length ? `${total}(${parts.join(', ')})` : '0'
  }
  return String(v)
}

// ============================================================
// 输出 normalize
// ============================================================

/**
 * 把 LLM 输出 normalize 成可入库的结构。
 *
 * @param {any} raw   LLM 解析后的 JSON
 * @param {object} ctx
 * @param {Set<string>|string[]|null} ctx.knownRecordIds  citation_map 强校验:placeholder→paper_id 必须在这个集合里
 * @returns {{ content_markdown: string, citation_map: Array<{placeholder, paper_id}>, citation_issues: string[] }}
 */
export function normalizeSectionOutput(raw, { knownRecordIds = null } = {}) {
  const empty = { content_markdown: '', citation_map: [], citation_issues: [] }
  if (!raw || typeof raw !== 'object') return empty

  raw = unwrapOne(raw)
  raw = unwrapOne(raw)

  // content_markdown
  let content =
    typeof raw.content_markdown === 'string'
      ? raw.content_markdown
      : typeof raw.content === 'string'
        ? raw.content
        : typeof raw.markdown === 'string'
          ? raw.markdown
          : typeof raw.text === 'string'
            ? raw.text
            : ''

  content = String(content || '').trim()

  // citation_map
  const known = knownRecordIds
    ? (knownRecordIds instanceof Set ? knownRecordIds : new Set(knownRecordIds))
    : null

  const rawMap = Array.isArray(raw.citation_map) ? raw.citation_map
    : Array.isArray(raw.citations) ? raw.citations
    : Array.isArray(raw.citationMap) ? raw.citationMap
    : []

  const citationMap = []
  const issues = []
  const seenPair = new Set()

  for (const entry of rawMap) {
    if (!entry || typeof entry !== 'object') continue
    const placeholder = typeof entry.placeholder === 'string' ? entry.placeholder.trim() : ''
    let paperIds = []
    if (typeof entry.paper_id === 'string') paperIds = [entry.paper_id.trim()]
    else if (Array.isArray(entry.paper_id)) paperIds = entry.paper_id.filter((x) => typeof x === 'string')
    else if (typeof entry.record_id === 'string') paperIds = [entry.record_id.trim()]
    else if (Array.isArray(entry.record_ids)) paperIds = entry.record_ids.filter((x) => typeof x === 'string')

    if (!placeholder || paperIds.length === 0) continue

    for (const pid of paperIds) {
      const p = (pid || '').trim()
      if (!p) continue
      if (known && !known.has(p)) {
        issues.push(`paper_id 不在已知论文集合: ${p}`)
        continue
      }
      const key = placeholder + '|' + p
      if (seenPair.has(key)) continue
      seenPair.add(key)
      citationMap.push({ placeholder, paper_id: p })
    }
  }

  // 反向校验:正文里所有 [xxx] 占位是否都在 citation_map 里 — 抽取一下,找漏报
  if (content && known) {
    const placeholdersInText = extractPlaceholdersFromMarkdown(content)
    const mappedPlaceholders = new Set(citationMap.map((c) => c.placeholder))
    // 如果 placeholder 在 citation_map 里出现过则 OK;否则补一条(只补合法的 record_id)
    for (const ph of placeholdersInText) {
      if (mappedPlaceholders.has(ph)) continue
      // 尝试从 placeholder 内部把 record_id 提出来,如果 known 包含就补
      const inner = ph.replace(/^\[/, '').replace(/\]$/, '')
      const ids = inner.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
      const legitIds = ids.filter((id) => known.has(id))
      if (legitIds.length) {
        for (const id of legitIds) {
          const key = ph + '|' + id
          if (seenPair.has(key)) continue
          seenPair.add(key)
          citationMap.push({ placeholder: ph, paper_id: id })
        }
      } else {
        issues.push(`正文有占位 ${ph},但 citation_map 未声明且不含已知 record_id`)
      }
    }
  }

  return { content_markdown: content, citation_map: citationMap, citation_issues: issues }
}

/**
 * 从 markdown 文本里提取 [record_id] / [id1, id2] 风格的占位。
 * 简化:匹配 `\[ ... \]`,只取里面看起来像 record_id 的(字母+数字+下划线/连字符)。
 */
export function extractPlaceholdersFromMarkdown(md) {
  if (typeof md !== 'string' || !md) return []
  const out = new Set()
  // 简单贪婪:形如 [xxx] 或 [a, b, c]
  const re = /\[([a-zA-Z][a-zA-Z0-9_\-,\s]+)\]/g
  let m
  while ((m = re.exec(md)) !== null) {
    const inner = m[1]
    // 跳过 markdown 链接的 anchor 文字部分 → 通过紧跟的 ( 检测
    const next = md[m.index + m[0].length]
    if (next === '(') continue
    // 必须看起来像 record_id:含字母 + 数字 / 下划线
    if (!/[a-zA-Z]/.test(inner)) continue
    if (!/\d|_|-/.test(inner)) continue
    out.add('[' + inner + ']')
  }
  return Array.from(out)
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  const hasTop = keys.some((k) => /^(content_markdown|content|markdown|citation_map|citations)$/i.test(k))
  if (hasTop) return raw
  for (const k of keys) {
    if (/^(result|output|data|response|section)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object') return v
    }
  }
  return raw
}
