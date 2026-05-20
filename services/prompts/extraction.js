/**
 * Full-text 结构化抽取(Extraction) — 把单篇论文的全文文本(已切片)解析成
 * SLR 可入库的结构化 JSON:研究特征、干预/焦点、结果/主题、关键发现、局限。
 *
 * 每个 key_findings 必须带 supporting_location {section, page, chunk_id} 反向链回
 * paper_chunks,Phase 6 的 synthesis (Agent O) 会消费这个 JSON 做跨论文聚类。
 *
 * 落地自用户设计文档 Prompt 4(在 screening 决定为 include 之后被调用)。
 */

export const EXTRACTION_SCHEMA_VERSION = 'v1.0'
export const EXTRACTION_PROMPT_VERSION = 'extraction.v1.0'

export const EXTRACTION_SYSTEM = `你是系统性文献综述(SLR)的数据抽取员。
请根据用户提供的**单篇论文全文文本**,按统一 schema 抽取结构化字段。

工作准则:

1. **只用提供的全文文本**,不引用任何外部知识、不补全表外细节。
   - 文本里没明说的字段 → 填 null,或在必填字符串字段填 "not reported"。
   - 不要从论文标题/期刊去推测国家/样本量等具体事实。

2. 输出**严格 JSON**,字段如下(顺序可变,缺失字段用 null 或空数组):
   {
     "bibliographic_metadata": {
       "title": "string|null",
       "authors": ["string", ...],
       "year": number|null,
       "journal": "string|null",
       "doi": "string|null"
     },
     "study_characteristics": {
       "study_type": "RCT | cohort | case_control | cross_sectional | qualitative | mixed_methods | systematic_review | case_study | survey | experimental | simulation | theoretical | other | not_reported",
       "country": "string|null",
       "population": "string|null",
       "sample_size": number|null,
       "setting": "string|null",
       "methods": "string|null",
       "data_sources": ["string", ...]
     },
     "intervention_or_focus": "string",
     "outcomes_or_themes": ["string", ...],
     "key_findings": [
       {
         "finding": "中文 finding 主句(英文术语可放括号内)",
         "evidence_type": "empirical | theoretical | review | methodological | descriptive",
         "supporting_location": {
           "section": "abstract|introduction|methods|results|discussion|conclusion|other",
           "page": number|null,
           "chunk_id": "string|null"
         },
         "strength": "strong | moderate | weak | unclear"
       }
     ],
     "limitations_reported_by_authors": ["string", ...],
     "reviewer_notes": ["string", ...],
     "requires_manual_check": ["string", ...]
   }

3. **key_findings 必须真实可定位**:每条 finding 写下它在哪个 chunk_id / 哪个 section / 哪页找到。
   - 如果用户提供了 chunk_id,你**必须**用提供过的某个真实 chunk_id 填入,不要编造。
   - 如果只有 abstract 兜底(没有全文 chunk),把 section 标 "abstract" 即可。
   - 不要为了凑数硬塞 finding;3-8 条最合适,实在没有就给 0 条。

4. **requires_manual_check**:把以下情况写进数组(每条 ≤ 80 字)
   - 论文里有图/表/公式你无法可靠解析(标 "table_3_data_not_parsed");
   - 数据矛盾(摘要写 N=200 正文写 N=210);
   - 抽取置信度低(英文术语模糊、章节缺失);
   - 没有就给空数组,**不要硬凑**。

5. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**):
- 以下字段**必须用简体中文**:
  intervention_or_focus / outcomes_or_themes / key_findings.finding /
  limitations_reported_by_authors / reviewer_notes / requires_manual_check /
  study_characteristics 里所有自由文本字段(population / setting / methods 等)。
- **唯一例外**:bibliographic_metadata(原样英文)、study_type 枚举值、evidence_type 枚举值、
  section 枚举值、strength 枚举值 保持英文。
- 关键英文术语(如 "deep learning"、"PRISMA")可在中文 finding 的括号内保留,方便检索。

写作风格(中文字段都要遵守):
- **大白话**,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度 / 范畴"这类八股套话。
- 一条 finding ≤ 80 个汉字;outcomes_or_themes 每条 ≤ 30 字。
- 直接陈述"作者发现 X 与 Y 相关、效应量 0.42",不要"研究旨在探讨..."、"基于...的视角"开头。
`

/**
 * 构造用户消息 — 把 record 元数据 + 全文 chunks(或 abstract 兜底)+ RQs 拼成 LLM 输入。
 *
 * @param {object} args
 * @param {object} args.record           records 表的一行(已 parse keywords)
 * @param {Array}  args.chunks           paper_chunks 数组([{id, section_type, heading, page_start, page_end, text, ...}])
 * @param {Array}  args.researchQuestions  approved protocol 的 RQ 列表
 * @param {boolean} args.partial         true = 没 chunks,只用 abstract 兜底
 */
export function buildExtractionUserPrompt({ record, chunks, researchQuestions, partial }) {
  const lines = []
  lines.push('请基于以下单篇论文的全文文本,按 system message 的 schema 抽取结构化字段。')
  lines.push('')

  // 1) 元数据
  lines.push('=== 论文元数据 ===')
  lines.push(`title: ${record?.title || ''}`)
  if (record?.authors_text) lines.push(`authors: ${record.authors_text}`)
  if (record?.year) lines.push(`year: ${record.year}`)
  if (record?.journal) lines.push(`journal: ${record.journal}`)
  if (record?.doi) lines.push(`doi: ${record.doi}`)

  // 2) 研究问题(给 LLM 一个"我要看哪些方面"的锚点)
  if (Array.isArray(researchQuestions) && researchQuestions.length) {
    lines.push('')
    lines.push('=== 项目研究问题(辅助你聚焦,但不要让 RQ 反向限制你抽取范围)===')
    researchQuestions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  }

  // 3) 全文 chunks(分组)
  lines.push('')
  if (partial) {
    lines.push('=== 全文(兜底:仅 abstract,因 PDF 切片不可用)===')
    const abs = String(record?.abstract || '').trim()
    if (abs) {
      lines.push(abs)
    } else {
      lines.push('(无 abstract 可用,请尽量从标题与作者元数据中标记 requires_manual_check)')
    }
    lines.push('')
    lines.push('注意:由于只有 abstract,key_findings.supporting_location.section 一律填 "abstract",chunk_id 填 null。请在 requires_manual_check 第一条写 "only_abstract_available_no_fulltext"。')
  } else {
    // 按 section_type 分组,但保持 chunk_index 顺序
    const grouped = groupChunksBySection(chunks)
    lines.push('=== 全文(按章节分组,每段前缀 chunk_id|page,你必须用这些真实 chunk_id 填进 supporting_location)===')
    for (const [section, items] of grouped) {
      lines.push('')
      lines.push(`---- SECTION: ${section} ----`)
      for (const c of items) {
        const pageRange = formatPageRange(c.page_start, c.page_end)
        const heading = c.heading ? ` | heading: ${c.heading}` : ''
        lines.push(`[chunk_id=${c.id} | page=${pageRange}${heading}]`)
        lines.push(String(c.text || '').trim())
      }
    }
  }

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出,不要加任何解释或 Markdown 围栏。')
  return lines.join('\n')
}

function groupChunksBySection(chunks) {
  const order = ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion', 'references', 'other']
  const map = new Map()
  for (const c of chunks || []) {
    const s = c?.section_type || 'other'
    if (!map.has(s)) map.set(s, [])
    map.get(s).push(c)
  }
  // 按 chunk_index / page 排序
  for (const [, arr] of map) {
    arr.sort((a, b) => {
      const ai = a.chunk_index ?? a.page_start ?? 0
      const bi = b.chunk_index ?? b.page_start ?? 0
      return ai - bi
    })
  }
  // 按 order 输出
  const out = []
  for (const k of order) {
    if (map.has(k)) {
      out.push([k, map.get(k)])
      map.delete(k)
    }
  }
  // 剩余 unknown section 附在末尾
  for (const [k, v] of map) out.push([k, v])
  return out
}

function formatPageRange(s, e) {
  if (s == null && e == null) return '?'
  if (s != null && e != null && s !== e) return `${s}-${e}`
  return String(s ?? e)
}

// ============================================================
// Normalize — LLM 返回 → 入库形状
// ============================================================

const STUDY_TYPES = new Set([
  'RCT', 'cohort', 'case_control', 'cross_sectional', 'qualitative',
  'mixed_methods', 'systematic_review', 'case_study', 'survey',
  'experimental', 'simulation', 'theoretical', 'other', 'not_reported',
])
const EVIDENCE_TYPES = new Set(['empirical', 'theoretical', 'review', 'methodological', 'descriptive'])
const SECTIONS = new Set(['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion', 'references', 'other'])
const STRENGTHS = new Set(['strong', 'moderate', 'weak', 'unclear'])

/**
 * 把 LLM 输出 normalize 成可入库形状。
 *
 * 容错规则:
 *  - raw 可能被包了一层({extraction: {...}} / {output: {...}}),自动剥
 *  - 字段名同义词(findings → key_findings, metadata → bibliographic_metadata)
 *  - 任何字段缺失就给空值,不抛
 *  - 枚举值大小写归一,不在白名单 → 用兜底值
 *  - sample_size 是字符串"约 200" → 尝试解析数字,失败 → null
 *  - chunk_id 不在 validChunkIds 集合里 → 置 null,并把"unverified_chunk_id"加进 requires_manual_check
 *
 * @param {any} raw                LLM 解出的 JSON 对象
 * @param {Set<string>} validChunkIds  实际存在的 chunk_id 集合(供反向校验)
 */
export function normalizeExtractionOutput(raw, validChunkIds = null) {
  if (!raw || typeof raw !== 'object') return emptyExtraction()
  raw = unwrapOne(raw)
  raw = unwrapOne(raw)

  const aliases = {
    bibliographic_metadata: ['bibliographic_metadata', 'bibliographicMetadata', 'metadata', 'bib', 'biblio'],
    study_characteristics: ['study_characteristics', 'studyCharacteristics', 'study_info', 'characteristics'],
    intervention_or_focus: ['intervention_or_focus', 'interventionOrFocus', 'intervention', 'focus'],
    outcomes_or_themes: ['outcomes_or_themes', 'outcomesOrThemes', 'outcomes', 'themes'],
    key_findings: ['key_findings', 'keyFindings', 'findings', 'main_findings'],
    limitations_reported_by_authors: ['limitations_reported_by_authors', 'limitationsReportedByAuthors', 'limitations', 'author_limitations'],
    reviewer_notes: ['reviewer_notes', 'reviewerNotes', 'notes', 'reviewer'],
    requires_manual_check: ['requires_manual_check', 'requiresManualCheck', 'manual_check', 'flags'],
  }
  const pick = (key) => {
    for (const k of aliases[key]) if (raw[k] !== undefined) return raw[k]
    return undefined
  }

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : [])
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const numOrNull = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const m = v.match(/-?\d+(?:\.\d+)?/)
      if (m) {
        const n = parseFloat(m[0])
        if (Number.isFinite(n)) return n
      }
    }
    return null
  }
  const enumOrFallback = (v, set, fallback) => {
    if (typeof v !== 'string') return fallback
    const t = v.trim()
    if (set.has(t)) return t
    const lower = t.toLowerCase().replace(/[\s-]+/g, '_')
    if (set.has(lower)) return lower
    // upper-case 检查(RCT)
    const upper = t.toUpperCase()
    if (set.has(upper)) return upper
    return fallback
  }

  const manualCheck = arr(pick('requires_manual_check')).map(String)

  // bibliographic_metadata
  const metaRaw = pick('bibliographic_metadata') || {}
  const meta = {
    title: typeof metaRaw === 'object' ? strOrNull(metaRaw.title) : null,
    authors: typeof metaRaw === 'object' && Array.isArray(metaRaw.authors)
      ? metaRaw.authors.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    year: typeof metaRaw === 'object' ? numOrNull(metaRaw.year) : null,
    journal: typeof metaRaw === 'object' ? strOrNull(metaRaw.journal) : null,
    doi: typeof metaRaw === 'object' ? strOrNull(metaRaw.doi) : null,
  }

  // study_characteristics
  const scRaw = pick('study_characteristics') || {}
  const sc = {
    study_type: enumOrFallback(scRaw.study_type || scRaw.studyType, STUDY_TYPES, 'not_reported'),
    country: strOrNull(scRaw.country),
    population: strOrNull(scRaw.population),
    sample_size: numOrNull(scRaw.sample_size ?? scRaw.sampleSize ?? scRaw.n),
    setting: strOrNull(scRaw.setting),
    methods: strOrNull(scRaw.methods),
    data_sources: Array.isArray(scRaw.data_sources || scRaw.dataSources)
      ? (scRaw.data_sources || scRaw.dataSources)
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
      : [],
  }

  // key_findings
  const kfRaw = arr(pick('key_findings'))
  const keyFindings = []
  for (const f of kfRaw) {
    if (!f || typeof f !== 'object') continue
    const finding = strOrNull(f.finding || f.text || f.content)
    if (!finding) continue
    const loc = f.supporting_location || f.location || {}
    const section = enumOrFallback(loc.section, SECTIONS, 'other')
    const page = numOrNull(loc.page)
    let chunkId = strOrNull(loc.chunk_id || loc.chunkId)
    if (validChunkIds && chunkId && !validChunkIds.has(chunkId)) {
      manualCheck.push(`unverified_chunk_id:${chunkId.slice(0, 60)}`)
      chunkId = null
    }
    keyFindings.push({
      finding,
      evidence_type: enumOrFallback(f.evidence_type || f.evidenceType, EVIDENCE_TYPES, 'empirical'),
      supporting_location: { section, page, chunk_id: chunkId },
      strength: enumOrFallback(f.strength, STRENGTHS, 'unclear'),
    })
  }

  return {
    bibliographic_metadata: meta,
    study_characteristics: sc,
    intervention_or_focus: typeof pick('intervention_or_focus') === 'string'
      ? pick('intervention_or_focus').trim()
      : '',
    outcomes_or_themes: arr(pick('outcomes_or_themes')).map(String),
    key_findings: keyFindings,
    limitations_reported_by_authors: arr(pick('limitations_reported_by_authors')).map(String),
    reviewer_notes: arr(pick('reviewer_notes')).map(String),
    requires_manual_check: dedupe(manualCheck),
  }
}

function emptyExtraction() {
  return {
    bibliographic_metadata: { title: null, authors: [], year: null, journal: null, doi: null },
    study_characteristics: {
      study_type: 'not_reported', country: null, population: null,
      sample_size: null, setting: null, methods: null, data_sources: [],
    },
    intervention_or_focus: '',
    outcomes_or_themes: [],
    key_findings: [],
    limitations_reported_by_authors: [],
    reviewer_notes: [],
    requires_manual_check: [],
  }
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  const hasExtractionField = keys.some((k) =>
    /^(bibliographic_metadata|study_characteristics|key_findings|intervention_or_focus|outcomes_or_themes)$/i.test(k)
  )
  if (hasExtractionField) return raw
  for (const k of keys) {
    if (/^(extraction|output|result|data|response)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object') return v
    }
  }
  return raw
}

function dedupe(arr) {
  const seen = new Set()
  const out = []
  for (const s of arr) {
    const k = String(s).trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** 状态徽章工具,给视图和路由共用 */
export const EXTRACTION_STATUS_LABEL = {
  not_extracted: { cls: 'bg-slate-100 text-slate-500', text: '未抽取' },
  failed:        { cls: 'bg-rose-100 text-rose-700',  text: '抽取失败' },
  extracted:     { cls: 'bg-blue-100 text-blue-700',  text: '已抽取' },
  needs_check:   { cls: 'bg-amber-100 text-amber-700', text: '需人工核查' },
  verified:      { cls: 'bg-emerald-100 text-emerald-700', text: '已审验' },
}
