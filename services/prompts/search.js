/**
 * Search strategy generation — 把"已审批的 protocol"翻译成 WoS / Scopus / PubMed 三库
 * 三个版本(高召回 / 平衡 / 高精确)共 9 条可执行检索式。
 *
 * 输出严格 JSON,字段见 OUTPUT_SCHEMA。
 *
 * 落地自用户设计文档 Prompt 2(LLM 在 protocol approved 之后被调用一次)。
 */

export const SEARCH_SYSTEM = `你是系统性文献综述(SLR)方法学专家与英文学术图书馆员,精通 Web of Science、Scopus、PubMed 三大库的检索语法。
请根据用户提供的已审批协议(概念组 + 研究问题 + 纳排标准),生成可直接粘贴执行的检索式。

工作准则:

1. 输出**严格 JSON**,字段如下(顺序可变,缺失字段用 null 或空数组):
   {
     "expanded_terms": {
       "概念组名 1": ["补充同义词/缩写/词形变体"],
       "概念组名 2": ["..."]
     },
     "strategies": [
       { "database": "wos"|"scopus"|"pubmed",
         "query_type": "high_recall"|"balanced"|"high_precision",
         "query_text": "<可直接粘贴执行的完整检索式>",
         "rationale": "<1-3 句话:为什么这样写、覆盖范围、潜在漏召因素>",
         "filters": { "year_range": [起,止], "document_types": [...], "language": [...] }
       }
     ],
     "warnings": ["如:Scopus 高精确版可能漏掉灰色文献,建议补 Google Scholar"]
   }

2. **strategies 必须 9 条**:3 个数据库 × 3 个版本,顺序为
   wos×3 → scopus×3 → pubmed×3,版本顺序为 high_recall → balanced → high_precision。
   每个组合都必须有,不要省略,不要重复。

3. 高召回(high_recall):同义词全开、加大量截词、放宽时间和文献类型;预期命中数量 > 平衡版 3-10 倍。
   平衡(balanced):核心同义词 + 概念组间 AND 严格交叉、时间限定、文献类型限定;预期为推荐执行版本。
   高精确(high_precision):只保留最核心术语 + 标题/关键词字段限定 + 严格的同义词;预期是平衡版的 1/3 - 1/2。

4. **三库语法**(严格遵守,否则用户粘进去会报错):

   **Web of Science (wos)**
   - 字段标签:TS=(主题,默认覆盖 title/abstract/keywords)、TI=(仅标题)、AK=(作者关键词)、AB=(摘要)、PY=(年份)、DT=(文献类型)
   - 概念组用 \`OR\` 在括号内并列,概念组之间用 \`AND\` 连接
   - 词组用双引号包(如 \`"deep learning"\`),关闭词形还原
   - 截词用 \`*\`(中间或末尾),邻近用 \`NEAR/5\`
   - 年份:\`PY=(2019-2026)\`,文献类型:\`DT=("Article" OR "Review")\`
   - 范例:\`TS=(("deep learning" OR "neural network*") AND ("medical imag*" OR "radiolog*")) AND PY=(2019-2026) AND DT=("Article")\`

   **Scopus (scopus)**
   - 字段标签:TITLE-ABS-KEY(综合)、TITLE、ABS、KEY、AUTHKEY、PUBYEAR、DOCTYPE、LANGUAGE
   - 概念组用 \`OR\` 在括号内并列,概念组之间用 \`AND\`
   - 词组用双引号(\`"\`),截词 \`*\`,邻近 \`W/5\`(window)或 \`PRE/5\`(precede)
   - 年份用 \`AND PUBYEAR > 2018 AND PUBYEAR < 2027\`(两边开区间,边界 ±1)
   - 文献类型:\`AND DOCTYPE("ar") OR DOCTYPE("re")\`(ar=article, re=review)
   - 范例:\`TITLE-ABS-KEY(("deep learning" OR "neural network*") AND ("medical imag*" OR "radiolog*")) AND PUBYEAR > 2018 AND PUBYEAR < 2027 AND DOCTYPE("ar")\`

   **PubMed (pubmed)**
   - 字段标签:[MeSH Terms](受控词)、[Title/Abstract](自由词)、[Title]、[Date - Publication]、[Publication Type]、[Language]
   - 概念组里"MeSH 主题词 OR 自由词"组合,例如 \`("Deep Learning"[MeSH Terms] OR "deep learning"[Title/Abstract])\`
   - 概念组之间用 \`AND\` 连接
   - 截词 \`*\`(只能在末尾,且必须 ≥ 4 个前缀字符)
   - 日期范围:\`AND ("2019/01/01"[Date - Publication] : "3000"[Date - Publication])\`(用 3000 作 open-ended)
   - 文献类型:\`AND ("Journal Article"[Publication Type])\`,排除社论:\`NOT ("Editorial"[Publication Type] OR "Comment"[Publication Type])\`
   - 范例:\`(("Deep Learning"[MeSH Terms] OR "deep learning"[Title/Abstract] OR "neural network*"[Title/Abstract]) AND ("Diagnostic Imaging"[MeSH Terms] OR "medical imag*"[Title/Abstract])) AND ("2019/01/01"[Date - Publication] : "3000"[Date - Publication]) AND "Journal Article"[Publication Type]\`

5. **expanded_terms**:为每个原始概念组补充 LLM 想到的英文同义词 / 缩写 / 词形变体(每组追加 3-8 个),供用户在 UI 上参考。原始术语不必重复。

6. **warnings**:列出 0-3 条提醒,如"PubMed 高召回可能命中数万条,建议先在 Scopus 试跑"、"未限定语言可能引入大量非英文文献"等。

7. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**,不论用户输入用什么语言):
- **rationale 和 warnings 必须用简体中文**输出。即使用户输入或协议里有英文,这两个字段也要翻译成中文。
- **唯一例外**:query_text、expanded_terms、filters 里的值必须保持**英文学术规范**(MeSH / Scopus 字段名等),
  因为这些是直接粘到 WoS / Scopus / PubMed 跑英文论文检索的,不能中文化。

写作风格(中文字段都要遵守):
- **大白话**,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股套话。
- 一句话能说清的不绕长句;一条 rationale ≤ 60 字、一条 warning ≤ 80 字。
- 直接陈述"这样写覆盖什么、漏什么、为什么",不要"基于...的考量"、"从...的视角"开头。
`

/**
 * 构造用户消息 — 把 approved protocol 拼成 LLM 的输入。
 *
 * @param {object} args
 * @param {object} args.protocol      normalized protocol(已 parse 过的对象)
 * @param {object} args.projectInput  项目级补充信息(topic / year_start / year_end / databases / language_limits / document_types)
 */
export function buildSearchUserPrompt({ protocol, projectInput }) {
  const p = protocol || {}
  const pi = projectInput || {}

  const lines = [
    '请基于以下已审批协议生成 WoS / Scopus / PubMed 三库 × 三版本检索式:',
    '',
    `项目主题: ${pi.topic || '(未填)'}`,
  ]
  if (pi.discipline) lines.push(`学科: ${pi.discipline}`)
  if (pi.goal) lines.push(`研究目标: ${pi.goal}`)

  const yStart = pi.year_start || pi.yearStart
  const yEnd = pi.year_end || pi.yearEnd
  if (yStart || yEnd) {
    lines.push(`时间范围: ${yStart || '不限'} - ${yEnd || '不限'}(请把这个范围作为 filters.year_range 的默认值,并直接写进 query_text)`)
  } else {
    lines.push('时间范围: 用户未指定,请默认近 8 年(当前 - 7 到当前)')
  }
  if (Array.isArray(pi.document_types) && pi.document_types.length) {
    lines.push(`文献类型限定: ${pi.document_types.join(', ')}`)
  }
  if (Array.isArray(pi.language_limits) && pi.language_limits.length) {
    lines.push(`语言限定: ${pi.language_limits.join(', ')}`)
  }

  // 协议主体
  lines.push('')
  lines.push(`推荐综述类型: ${p.recommended_review_type || '(未指定)'}`)
  if (p.rationale) lines.push(`理由: ${p.rationale}`)

  if (Array.isArray(p.research_questions) && p.research_questions.length) {
    lines.push('')
    lines.push('研究问题:')
    p.research_questions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  }

  if (Array.isArray(p.concept_groups) && p.concept_groups.length) {
    lines.push('')
    lines.push('概念组(每组内 OR,组间 AND):')
    p.concept_groups.forEach((g, i) => {
      const terms = Array.isArray(g.terms) ? g.terms : []
      lines.push(`  ${i + 1}. ${g.name || '未命名'}: ${terms.join(' | ')}`)
    })
  }

  if (Array.isArray(p.inclusion_criteria) && p.inclusion_criteria.length) {
    lines.push('')
    lines.push('纳入标准(供你判断字段限定与文献类型限定的依据):')
    p.inclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
  }
  if (Array.isArray(p.exclusion_criteria) && p.exclusion_criteria.length) {
    lines.push('')
    lines.push('排除标准:')
    p.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
  }

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出,9 条 strategies 不能少。')
  return lines.join('\n')
}

// ---- 内部常量 ----
const VALID_DATABASES = ['wos', 'scopus', 'pubmed']
const VALID_QUERY_TYPES = ['high_recall', 'balanced', 'high_precision']

/**
 * 把 LLM 输出 normalize 成可直接入库的结构。
 *
 * 入库结构(返回):
 *   {
 *     expanded_terms: { groupName: [terms] },
 *     strategies: [
 *       { database, query_type, query_text, rationale, filters: {year_range,document_types,language} }
 *     ],
 *     warnings: [],
 *   }
 *
 * 容错规则:
 *   - 非 9 条不强制报错(让调用方根据条数决定走还是回滚)
 *   - 缺字段 / 字段类型错 → 用空值兜底
 *   - query_text 必须是非空字符串,否则该条剔除
 *   - database / query_type 不在白名单 → 该条剔除
 *   - 同 (database, query_type) 重复 → 仅保留第一个
 */
export function normalizeSearchOutput(raw) {
  const empty = { expanded_terms: {}, strategies: [], warnings: [] }
  if (!raw || typeof raw !== 'object') return empty

  // expanded_terms
  const expanded = {}
  if (raw.expanded_terms && typeof raw.expanded_terms === 'object' && !Array.isArray(raw.expanded_terms)) {
    for (const [k, v] of Object.entries(raw.expanded_terms)) {
      if (typeof k !== 'string' || !k.trim()) continue
      if (!Array.isArray(v)) continue
      const terms = v.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      if (terms.length) expanded[k.trim()] = terms
    }
  }

  // strategies
  const strategies = []
  const seenKey = new Set()
  if (Array.isArray(raw.strategies)) {
    for (const s of raw.strategies) {
      if (!s || typeof s !== 'object') continue
      const database = typeof s.database === 'string' ? s.database.trim().toLowerCase() : ''
      const queryType = typeof s.query_type === 'string' ? s.query_type.trim().toLowerCase() : ''
      const queryText = typeof s.query_text === 'string' ? s.query_text.trim() : ''
      if (!VALID_DATABASES.includes(database)) continue
      if (!VALID_QUERY_TYPES.includes(queryType)) continue
      if (!queryText) continue

      const key = `${database}|${queryType}`
      if (seenKey.has(key)) continue
      seenKey.add(key)

      const rationale = typeof s.rationale === 'string' ? s.rationale.trim() : ''

      // filters
      let filters = null
      if (s.filters && typeof s.filters === 'object' && !Array.isArray(s.filters)) {
        const f = {}
        if (Array.isArray(s.filters.year_range)) {
          const yr = s.filters.year_range
            .filter((y) => typeof y === 'number' && Number.isFinite(y))
            .slice(0, 2)
          if (yr.length === 2) f.year_range = yr
        }
        if (Array.isArray(s.filters.document_types)) {
          const dt = s.filters.document_types.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
          if (dt.length) f.document_types = dt
        }
        if (Array.isArray(s.filters.language)) {
          const lang = s.filters.language.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
          if (lang.length) f.language = lang
        }
        if (Object.keys(f).length) filters = f
      }

      strategies.push({
        database,
        query_type: queryType,
        query_text: queryText,
        rationale,
        filters,
      })
    }
  }

  // warnings
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : []

  return { expanded_terms: expanded, strategies, warnings }
}

// 导出常量给路由层判断"够不够生成成功"
export const SEARCH_DATABASES = VALID_DATABASES
export const SEARCH_QUERY_TYPES = VALID_QUERY_TYPES
