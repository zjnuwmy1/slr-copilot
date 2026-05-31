/**
 * Protocol generation — 把"用户给的主题"扩展成可执行的 SLR 协议(研究问题 / 纳排标准 / 概念组)。
 *
 * 输出严格 JSON,字段见 OUTPUT_SCHEMA。
 *
 * 落地自用户设计文档 Prompt 1。
 */

// SYSTEM_VERSION — bump 时不会影响已生成协议(协议存的是 LLM 输出文本,不绑 system version)。
// 留作 audit 标记 + 未来扩展 stale 检测用。
export const PROTOCOL_SYSTEM_VERSION = '2026-05-24-v2-english'

export const PROTOCOL_SYSTEM = `# Role
You are a systematic literature review (SLR) methodologist and academic English librarian.
Given a user-supplied topic (which may be in Chinese / Spanish / Japanese / any language),
produce an executable SLR protocol — translating concepts to academic English where needed.

# Cross-discipline scope
This protocol may be in medicine, education, engineering, HCI, social sciences, humanities,
or any other research field. Interpret "intervention" / "participants" / "outcome" broadly
(e.g. for an engineering review, "intervention" = a method / algorithm / system component;
for an education review, "intervention" = pedagogy / curriculum / instructional design).

# Working principles
1. Reason only within the user-supplied scope. **Do not fabricate specific study findings.**
2. Output **strict JSON** with the schema below (key order flexible; missing fields → null / [] ):
   {
     "recommended_review_type": "systematic_review | scoping_review | bibliometric | meta_analysis | mixed_methods",
     "rationale": "1-3 sentence justification for the review type",
     "concept_groups": [
       { "name": "Intervention / Technology", "terms": ["..."] },
       { "name": "Population / Domain",       "terms": ["..."] },
       { "name": "Outcome / Construct",       "terms": ["..."] }
     ],
     "research_questions": ["RQ1: ...", "RQ2: ...", ...],
     "inclusion_criteria": ["...", "..."],
     "exclusion_criteria": ["...", "..."],
     "clarification_questions": ["..."]
   }
3. concept_groups: 2-5 groups, 5-12 English academic terms each (MeSH / Scopus / WoS conventions).
4. research_questions: 3-5 items, each specific and answerable.
5. inclusion / exclusion: 4-7 items each, clearly mutually exclusive.
6. clarification_questions: 0-4 items — points you find ambiguous and want the user to confirm.
7. **Output ONLY the JSON object** — no preamble, no Markdown, no code fences, no trailing commentary.

# OUTPUT LANGUAGE — HARD CONSTRAINT (applies to ALL projects regardless of user input language)
- ALL output text fields MUST be in academic English. ZERO Chinese / Japanese / Spanish / non-English characters in:
  research_questions, inclusion_criteria, exclusion_criteria, clarification_questions, rationale,
  concept_groups[].name, concept_groups[].terms.
- If the user input is in Chinese (or any other language), translate concepts into precise academic English.
- The ONLY justification for keeping a non-English token in output is if it is a proper noun without an
  established English form (rare). When in doubt, translate.

# Writing style (English)
- Plain academic English readable by an upper-undergraduate. No jargon-stuffing.
- One sentence per RQ; ≤25 words per item where possible. Use active voice; avoid "this study aims to".
- Begin RQs with the actual interrogative ("How does …", "What characteristics …", "To what extent …"),
  not with "explore" / "investigate" / "examine" boilerplate.
- For each concept_groups.term, use the canonical English search term (e.g. "Generative artificial intelligence"
  not "generative AI usage"; "Self-Regulated Learning" not "students who self-regulate").
- Acronyms: spell out on first use within an item if not universally known.
`

/**
 * 构造用户消息
 */
export function buildProtocolUserPrompt(input) {
  const {
    topic,
    discipline = '',
    goal = '',
    yearStart = null,
    yearEnd = null,
    databases = [],
    languageLimits = [],
    documentTypes = [],
    seedTitles = [],
  } = input

  const lines = [
    '请基于以下用户输入生成 SLR 协议:',
    '',
    `主题: ${topic}`,
  ]
  if (discipline) lines.push(`学科: ${discipline}`)
  if (goal) lines.push(`初步目标: ${goal}`)
  if (yearStart || yearEnd) lines.push(`时间范围: ${yearStart || '不限'} - ${yearEnd || '不限'}`)
  if (databases.length) lines.push(`目标数据库: ${databases.join(', ')}`)
  if (languageLimits.length) lines.push(`语言限制: ${languageLimits.join(', ')}`)
  if (documentTypes.length) lines.push(`文献类型: ${documentTypes.join(', ')}`)
  if (seedTitles.length) {
    lines.push('种子文献题名(用于扩展概念组):')
    seedTitles.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`))
  }
  lines.push('')
  lines.push('请输出严格 JSON。')
  return lines.join('\n')
}

/**
 * 把 LLM 输出 normalize 成数据库能存的形状。
 * 容错策略:
 *  1) raw 可能被包了一层(`{protocol: {...}}` / `{output: {...}}` / `{result: {...}}`),自动剥
 *  2) 字段名同义词(questions → research_questions, inclusion → inclusion_criteria,etc.)
 *  3) 任何字段缺失就给空数组 / null,不抛
 */
export function normalizeProtocolOutput(raw) {
  if (!raw || typeof raw !== 'object') {
    return emptyProtocol()
  }

  // 1) 剥 wrapper:如果顶层只有一个 key 且 value 是对象,递归一次
  raw = unwrapOne(raw)
  raw = unwrapOne(raw)  // 最多剥两层 protect against {data: {protocol: {...}}}

  // 2) 字段同义词映射:LLM 偶尔会用不同 key
  const aliases = {
    research_questions: ['research_questions', 'researchQuestions', 'questions', 'rq', 'RQs'],
    inclusion_criteria: ['inclusion_criteria', 'inclusionCriteria', 'inclusion', 'include_criteria'],
    exclusion_criteria: ['exclusion_criteria', 'exclusionCriteria', 'exclusion', 'exclude_criteria'],
    concept_groups: ['concept_groups', 'conceptGroups', 'concepts', 'groups', 'keywords'],
    clarification_questions: ['clarification_questions', 'clarificationQuestions', 'clarifications', 'questions_for_user'],
    recommended_review_type: ['recommended_review_type', 'recommendedReviewType', 'review_type', 'reviewType'],
    rationale: ['rationale', 'reason', 'reasoning', 'justification'],
  }
  const pick = (key) => {
    for (const k of aliases[key]) if (raw[k] !== undefined) return raw[k]
    return undefined
  }

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()) : [])
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  return {
    recommended_review_type: strOrNull(pick('recommended_review_type')),
    rationale: typeof pick('rationale') === 'string' ? pick('rationale').trim() : '',
    concept_groups: normalizeConceptGroups(pick('concept_groups'), arr, strOrNull),
    research_questions: arr(pick('research_questions')).map(String),
    inclusion_criteria: arr(pick('inclusion_criteria')).map(String),
    exclusion_criteria: arr(pick('exclusion_criteria')).map(String),
    clarification_questions: arr(pick('clarification_questions')).map(String),
  }
}

function emptyProtocol() {
  return {
    recommended_review_type: null,
    rationale: '',
    concept_groups: [],
    research_questions: [],
    inclusion_criteria: [],
    exclusion_criteria: [],
    clarification_questions: [],
  }
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  // 顶层有 research_questions 之类的直接字段就不要剥
  const hasProtocolField = keys.some((k) =>
    /^(research_questions|inclusion_criteria|exclusion_criteria|concept_groups|rationale)$/i.test(k)
  )
  if (hasProtocolField) return raw
  // 顶层只有 1-2 个 key 且其中一个 value 是 object,递归进去
  for (const k of keys) {
    if (/^(protocol|output|result|data|response)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object') return v
    }
  }
  return raw
}

/** concept_groups 可能是 [{name, terms}],也可能是 {组名: [...]} 形式 */
function normalizeConceptGroups(cg, arr, strOrNull) {
  if (!cg) return []
  if (Array.isArray(cg)) {
    return cg
      .filter((g) => g && typeof g === 'object')
      .map((g) => ({
        name: strOrNull(g.name) || strOrNull(g.group) || '未命名',
        terms: arr(g.terms || g.keywords || g.items).map(String),
      }))
      .filter((g) => g.terms.length > 0)
  }
  if (typeof cg === 'object') {
    return Object.entries(cg)
      .filter(([_, v]) => Array.isArray(v) && v.length)
      .map(([name, terms]) => ({ name, terms: terms.map(String) }))
  }
  return []
}
