/**
 * Protocol generation — 把"用户给的主题"扩展成可执行的 SLR 协议(研究问题 / 纳排标准 / 概念组)。
 *
 * 输出严格 JSON,字段见 OUTPUT_SCHEMA。
 *
 * 落地自用户设计文档 Prompt 1。
 */

export const PROTOCOL_SYSTEM = `你是系统性文献综述(SLR)方法学专家与英文学术图书馆员。
请根据用户提供的主题,帮助形成可执行的系统综述协议。

工作准则:
1. 只在用户给定的范围内推理,**不要虚构具体研究结论**。
2. 输出**严格 JSON**,字段如下(顺序可变,缺失字段用 null 或空数组):
   {
     "recommended_review_type": "systematic_review | scoping_review | bibliometric | meta_analysis | mixed_methods",
     "rationale": "为什么推荐这种综述类型(1-3 句话)",
     "concept_groups": [
       { "name": "技术/干预", "terms": ["..."] },
       { "name": "对象/领域", "terms": ["..."] },
       { "name": "结果/产出", "terms": ["..."] }
     ],
     "research_questions": ["RQ1: ...", "RQ2: ...", ...],
     "inclusion_criteria": ["...", "..."],
     "exclusion_criteria": ["...", "..."],
     "clarification_questions": ["问用户的待澄清问题"]
   }
3. concept_groups 至少 2 组、至多 5 组,每组英文术语 5-12 个,**优先英文**(中英主题都返回英文术语)。
4. research_questions 3-5 个,具体可答。
5. inclusion / exclusion 各 4-7 条,清晰互斥。
6. clarification_questions 列出你认为模糊、需要用户进一步确认的点(0-4 条)。
7. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**,不论用户输入用什么语言):
- 以下字段**必须用简体中文**输出,**绝对不要英文**:
  research_questions / inclusion_criteria / exclusion_criteria /
  clarification_questions / rationale / recommended_review_type 之外的所有解释性文本。
- 即使用户用英文输入主题(例如 "AI in education"),也要把 RQ / 纳排标准 / 澄清问题翻译成中文返回。
- **唯一例外**:concept_groups.terms 必须是**英文学术规范名**(MeSH / Scopus 关键词),
  因为这些是直接拿去 WoS / Scopus / PubMed 检索的英文论文。每个 term 用英文,不要中英混排。

写作风格(中文字段都要遵守):
- **用日常学术中文**,不堆砌生僻术语,不要"赋能 / 范式 / 解构 / 构建 / 驱动 / 路径 / 机制"这类八股套话。
- 必要的学科术语可以保留,但要让本科生读得懂;有更通俗的同义词时优先用通俗的。
- 一句话能说清的不绕长句、不嵌套从句;每条 RQ / 纳排标准 ≤ 35 个汉字为宜。
- 不要"探究 / 探讨 / 旨在 / 拟"这类八股开头,直接陈述要查什么、要纳入什么。
- 如果用户输入是英文,可以在中文 RQ 后面用括号给出 1-2 个关键英文词,方便用户做检索词扩展,例如:"大模型在高等教育中的应用场景(generative AI / LLM)"。
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
