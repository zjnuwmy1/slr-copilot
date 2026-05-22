/**
 * Search strategy generation — 把"已审批的 protocol + 项目设定"翻译成
 * 多个数据库 × 3 个版本(high_recall / balanced / high_precision)的可执行检索式。
 *
 * 关键约束:
 *  - 只针对 *用户在项目里勾选的* 数据库生成(原 design 文档 / 后续工程版本),
 *    不再硬编码 wos+scopus+pubmed 三库;
 *  - 严格按协议的时间范围、文献类型、语言写进 query_text;
 *  - 排除文档类型必须显式 NOT 掉(尤其是用户未勾选"Conference Paper"时
 *    必须排除 conference / proceedings / editorial / letter 等);
 *  - rationale / warnings 用简体中文,query_text / expanded_terms 用英文学术规范。
 *
 * 输出严格 JSON,见 OUTPUT_SCHEMA。落地自用户设计文档 Prompt 2。
 */

// ---- 内部常量 ----
const VALID_DATABASES = ['wos', 'scopus', 'pubmed']
//   'high_recall' / 'balanced' / 'high_precision' — exploration 三档(buildSearchSystem 出的)
//   'main' — AI 主检索:基于命中数 + 协议优化合成的最终主检索(buildRecommendSystem 出的)
const VALID_QUERY_TYPES = ['high_recall', 'balanced', 'high_precision', 'main']

// 用户表单里"项目数据库"勾选项的显示名 → 内部 key 映射
// 现在 prompt 只支持 wos / scopus / pubmed 三种语法;其他(IEEE/ACM/ERIC 等)
// 暂时映射成 null(忽略)。
const DB_NAME_TO_KEY = {
  'web of science': 'wos',
  'wos': 'wos',
  'scopus': 'scopus',
  'pubmed': 'pubmed',
  'pub med': 'pubmed',
}

/**
 * 把项目 databases 数组(可能是 "Web of Science"/"Scopus"/"PubMed"/"IEEE" 等)
 * 映射成 prompt 支持的内部 key 数组('wos' / 'scopus' / 'pubmed')。
 *
 * - 没勾任何已知库 / 全是 IEEE 等不支持的 → 返回 ['wos','scopus','pubmed'](保守默认)
 * - 已知库去重保留勾选顺序
 */
export function resolveTargetDatabases(projectDatabases) {
  if (!Array.isArray(projectDatabases) || projectDatabases.length === 0) {
    return ['wos', 'scopus', 'pubmed']
  }
  const out = []
  const seen = new Set()
  for (const raw of projectDatabases) {
    if (typeof raw !== 'string') continue
    const key = DB_NAME_TO_KEY[raw.trim().toLowerCase()]
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  if (out.length === 0) return ['wos', 'scopus', 'pubmed']
  return out
}

export function buildSearchSystem({ targetDatabases }) {
  const dbs = (Array.isArray(targetDatabases) && targetDatabases.length)
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : ['wos', 'scopus', 'pubmed']

  const totalCount = dbs.length * 3

  // 各库语法块(只在 target 内的库才贴示例,减少 LLM 噪音 + 减 token)
  const syntaxBlocks = []

  if (dbs.includes('wos')) {
    syntaxBlocks.push(`   **Web of Science (wos)**
   - 字段标签:TS=(主题,默认覆盖 title/abstract/keywords)、TI=(仅标题)、AK=(作者关键词)、AB=(摘要)、PY=(年份)、DT=(文献类型)
   - 概念组用 \`OR\` 在括号内并列,概念组之间用 \`AND\` 连接
   - 词组用双引号(\`"deep learning"\`),关闭词形还原
   - 截词 \`*\`(中间或末尾),邻近 \`NEAR/5\`
   - 年份:\`AND PY=(YEAR_START-YEAR_END)\`(必须把协议给定的年份范围写进去)
   - 文献类型(必带):\`AND DT=("Article" OR "Review")\` —— 只放协议允许的;
     若协议**未**勾选 "Conference Paper",必须**不**写 \`"Proceedings Paper"\` 也不写
     \`"Meeting Abstract"\`,可显式 \`NOT DT=("Proceedings Paper" OR "Meeting Abstract" OR "Editorial Material" OR "Letter")\` 加固。
   - 语言:\`AND LA=("English")\`(或协议指定语言列表)。
   - 范例:
     \`TS=(("deep learning" OR "neural network*") AND ("medical imag*" OR "radiolog*"))
       AND PY=(2019-2026) AND DT=("Article" OR "Review")
       NOT DT=("Proceedings Paper" OR "Meeting Abstract") AND LA=("English")\``)
  }

  if (dbs.includes('scopus')) {
    syntaxBlocks.push(`   **Scopus (scopus)**
   - 字段标签:TITLE-ABS-KEY(综合)、TITLE、ABS、KEY、AUTHKEY、PUBYEAR、DOCTYPE、LANGUAGE
   - 概念组用 \`OR\` 在括号内并列,概念组之间用 \`AND\`
   - 词组用双引号,截词 \`*\`,邻近 \`W/5\`(window)或 \`PRE/5\`(precede)
   - **年份必须写进 query_text**:\`AND PUBYEAR > (YEAR_START - 1) AND PUBYEAR < (YEAR_END + 1)\`
     —— Scopus PUBYEAR 是严格开区间,所以两边各 ±1。例如协议年份 2019-2026 → \`AND PUBYEAR > 2018 AND PUBYEAR < 2027\`。
   - **文献类型必带**(只用协议允许的):
     \`AND ( DOCTYPE("ar") OR DOCTYPE("re") )\` (ar=article, re=review)
     若协议**未**勾选 "Conference Paper":显式排除 \`AND NOT DOCTYPE("cp") AND NOT DOCTYPE("cr") AND NOT DOCTYPE("ed") AND NOT DOCTYPE("le")\`
     (cp=conference paper, cr=conference review, ed=editorial, le=letter)。
   - 语言:\`AND LANGUAGE("English")\`(或协议指定的语言)。
   - **完整范例**(请严格按此结构出题,务必把以上 4 段过滤都写进 query_text):
     \`TITLE-ABS-KEY(("deep learning" OR "neural network*") AND ("medical imag*" OR "radiolog*"))
       AND PUBYEAR > 2018 AND PUBYEAR < 2027
       AND ( DOCTYPE("ar") OR DOCTYPE("re") )
       AND NOT DOCTYPE("cp") AND NOT DOCTYPE("cr") AND NOT DOCTYPE("ed") AND NOT DOCTYPE("le")
       AND LANGUAGE("English")\``)
  }

  if (dbs.includes('pubmed')) {
    syntaxBlocks.push(`   **PubMed (pubmed)**
   - 字段标签:[MeSH Terms](受控词)、[Title/Abstract](自由词)、[Title]、[Date - Publication]、[Publication Type]、[Language]
   - 概念组里"MeSH 主题词 OR 自由词"组合,例如 \`("Deep Learning"[MeSH Terms] OR "deep learning"[Title/Abstract])\`
   - 概念组之间用 \`AND\` 连接
   - 截词 \`*\`(只能末尾,前缀必须 ≥ 4 字符)
   - **日期范围必须写**:\`AND ("YEAR_START/01/01"[Date - Publication] : "YEAR_END/12/31"[Date - Publication])\`
     —— 如协议未指定 end,用 \`"3000"[Date - Publication]\`。
   - **文献类型必带**:\`AND ("Journal Article"[Publication Type])\`;
     若协议**未**勾选 "Conference Paper",显式排除会议 / 社论 / 通讯:
     \`NOT ("Editorial"[Publication Type] OR "Comment"[Publication Type] OR "Letter"[Publication Type] OR "Congress"[Publication Type])\`。
   - 语言:\`AND ("english"[Language])\`(或协议指定语言)。`)
  }

  const dbList = dbs.map((k) => k.toUpperCase()).join(' / ')
  const orderedExpect = dbs.map((d) => `${d}×3`).join(' → ')

  return `你是系统性文献综述(SLR)方法学专家与英文学术图书馆员,精通 Web of Science、Scopus、PubMed 的检索语法。
请根据用户提供的已审批协议(概念组 + 研究问题 + 纳排标准 + 时间范围 + 文献类型限定 + 语言限定),
为**用户实际勾选的数据库**(本次:${dbList})生成可直接粘贴执行的检索式。

🔒 **严格按协议(不要发挥、不要替换、不要漂移)**:
   - **year_range 必须逐字使用协议给的起止年**。
     例:协议是 2016-2026 → query_text 里就写 2016-2026,不要换成 "last 10 years" / "近 10 年" /
     "recent decade"。\`filters.year_range\` 也必须 = 协议的 [起, 止],不要私自截尾。
   - **document_types 必须逐字使用协议的允许列表**,显式 NOT 出去协议未勾选的(尤其会议论文 /
     摘要 / 社论 / 通讯)。
   - **language 必须逐字使用协议指定的**。协议未指定 = 不写语言过滤。不要私自加 English 限定。
   - **concept_groups 以协议的概念组为骨架**。允许扩同义词 / 缩写 / 词形变体,但 **不能漂移核心概念**。
     如果协议说 "deep learning for medical imaging",不要扩到 "machine learning for genomics"。
   - 命中数太多 / 太少 → 在 rationale / warnings 里向用户说明,**不要私自压缩或扩大年份范围 / 文献类型 / 语言**。

🚫 **典型反模式 — 这些会让 query 零命中 / 报错,绝对不要做**:

1. **不要把多个概念组塞进一个 TITLE/TI 字段还组合 AND**:
   - WoS 错例:\`TI=(("design thinking" OR ...) AND ("metacognit*" OR ...))\`
   - Scopus 错例:\`TITLE(("A" OR ...) AND ("C" OR ...))\`
   论文标题**极少同时包含**两个不同概念组的关键词,会直接零命中。
   Scopus 的 \`TITLE(...)\` 字段还**根本不支持内嵌 AND**(会报 spelled incorrectly)。
   正确:WoS 用同一个 \`TS=(...)\` 块,Scopus 用同一个 \`TITLE-ABS-KEY(...)\`,组间 AND。
   high_precision 收紧时也不要换字段 — 砍同义词 / 加更窄的概念组才对。

2. **WoS 合法 document type**(只用这些):
   Article, Review, Proceedings Paper, Meeting Abstract, Editorial Material,
   Book Chapter, Letter, Correction, News Item, Book, Data Paper,
   Software Review, Hardware Review, Database Review。
   \`"Note"\` 不是 WoS 合法类型,不要写 NOT DT=("Note")。

3. **Scopus 合法 document type 代码**(全 lowercase):
   ar / re / cp / cr / ed / le / no / sh / ch / bk / er。
   多个 NOT 合并成一个:\`AND NOT (DOCTYPE("cp") OR DOCTYPE("cr") OR ...)\`,
   不要写一长串 \`AND NOT DOCTYPE(X) AND NOT DOCTYPE(Y) ...\`。

⚠ **方法学硬性要求(SLR 跨库一致性)**:
   同一个 query_type 版本(high_recall / balanced / high_precision)的**全部库 query_text 必须共享同一套**:
     - 同样的概念组 + 同样的同义词扩展
     - 同样的年份范围
     - 同样的文献类型允许 / 排除列表
     - 同样的语言限定
   **唯一允许的差异是每个库的字段标签和语法**(TS= vs TITLE-ABS-KEY vs [MeSH Terms]、PY= vs PUBYEAR vs [Date - Publication])。
   如果你想给 high_recall 加一个同义词,你必须**同时**给该 query_type 下的全部库都加上,不能只加在某一个库里。
   如果某概念组在 PubMed 有 MeSH 词、其他库没有 MeSH,只允许加 MeSH 行 — 自由词部分必须严格一致。

📖 **WoS / Scopus 年份语义差异(常识,放进 rationale / warnings 里)**:
   - WoS 的 Year Published **同时包含 Early Access 年份和 Final Publication 年份**。
     一篇 Final 2025 但 Early Access 2024 的文章,在 WoS 会被归到 2024。
   - Scopus 偏向最终出版年份。
   - 同样设 PY=(2016-2026),两个平台命中数 **可能不完全一致 — 这是正常现象**,
     不要为了对齐数字改 query_text 或 year_range。

⏰ **当前年份不完整(若适用,在 warnings 里加一条,不要私自改 year_range)**:
   - 如果协议结束年 = 当前年(例如 2026 年中跑 2016-2026),该年文献仍在持续收录,
     在 warnings 里建议用户考虑是否截止前一年。**不要擅自改 query_text 的年份**。

📝 **PRISMA Methods 段标准措辞(rationale 引用时用这个句式)**:
   "Literature was retrieved from <Database1> and <Database2> for publications
    between <start> and <end>."
   这样后续 review 的方法学部分能直接复用。

工作准则:

1. 输出**严格 JSON**,字段如下:
   {
     "expanded_terms": {
       "概念组名 1": ["补充同义词/缩写/词形变体(英文)"],
       "概念组名 2": ["..."]
     },
     "shared_concept_sets": {
       "high_recall":    { "concept_groups": [...], "year_range": [s,e], "document_types": [...], "excluded_document_types": [...], "language": [...] },
       "balanced":       { "concept_groups": [...], "year_range": [s,e], "document_types": [...], "excluded_document_types": [...], "language": [...] },
       "high_precision": { "concept_groups": [...], "year_range": [s,e], "document_types": [...], "excluded_document_types": [...], "language": [...] }
     },
     "strategies": [
       { "database": "wos"|"scopus"|"pubmed",
         "query_type": "high_recall"|"balanced"|"high_precision",
         "query_text": "<同 shared_concept_sets[query_type] 的渲染,只差语法>",
         "rationale": "<1-3 句中文:覆盖范围、潜在漏召因素>",
         "filters": { "year_range": [起,止], "document_types": [...], "language": [...] }
       }
     ],
     "warnings": ["..."]
   }

2. **strategies 必须正好 ${totalCount} 条**:
   - 数据库 = [${dbList}](本次用户只勾选了这些库);
   - 顺序 = ${orderedExpect};
   - 每个 (database, query_type) 组合只一条。
   - 对于同一个 query_type,所有库的 query_text 必须由 \`shared_concept_sets[query_type]\` 渲染而来,
     **概念组、年份、文献类型、语言完全一致**,仅语法不同。

3. **每条 query_text 必须包含以下 4 类过滤,缺一不可**(全部来自该 query_type 的 shared_concept_sets):
   a. 概念组的逻辑组合(组内 OR,组间 AND)
   b. 协议给的年份范围(用对应库的原生语法,见下)
   c. 协议允许的文献类型,**并显式排除协议未勾选的类型**(尤其会议论文 / 摘要 / 社论 / 通讯)
   d. 协议指定的语言(若有)

4. 版本语义:
   - **high_recall**:同义词全开 + 截词 + 在概念组之间适度放宽(但 b/c/d 过滤仍必须严格按协议);预期命中数 = 平衡版 × 3-10
   - **balanced**:核心同义词 + 概念组间 AND 严格交叉;推荐执行版本
   - **high_precision**:只保留最核心术语 + 标题/关键词字段限定;预期 = 平衡版 × 1/3 - 1/2

5. **各库语法块**(严格遵守,否则用户粘进去会报错):

${syntaxBlocks.join('\n\n')}

6. **expanded_terms**:为每个原始概念组补充英文同义词 / 缩写 / 词形变体(每组追加 3-8 个),供用户在 UI 上参考。原始术语不必重复。

7. **warnings**:列出 0-3 条提醒。

8. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**,不论用户输入用什么语言):
- **rationale 和 warnings 必须用简体中文**输出。
- **唯一例外**:query_text / expanded_terms / filters 里的值必须保持**英文学术规范**(MeSH / Scopus 字段名等),
  因为这些是直接粘到检索平台跑英文论文检索的,不能中文化。

写作风格(中文字段都要遵守):
- **大白话**,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股套话。
- 一句话能说清的不绕长句;一条 rationale ≤ 60 字、一条 warning ≤ 80 字。
- 直接陈述"这样写覆盖什么、漏什么、为什么"。
`
}

// 老的导出名保留,默认按全 3 库渲染(兼容性兜底,实际调用方应改用 buildSearchSystem)
export const SEARCH_SYSTEM = buildSearchSystem({ targetDatabases: ['wos', 'scopus', 'pubmed'] })

/**
 * 构造用户消息 — 把 approved protocol 拼成 LLM 的输入。
 *
 * @param {object} args
 * @param {object} args.protocol         normalized protocol(已 parse 过的对象)
 * @param {object} args.projectInput     项目级补充信息(topic / year_start / year_end / databases / language_limits / document_types)
 * @param {string[]} [args.targetDatabases]  本次实际要生成的库 key 列表(已用 resolveTargetDatabases 处理过)
 */
export function buildSearchUserPrompt({ protocol, projectInput, targetDatabases }) {
  const p = protocol || {}
  const pi = projectInput || {}
  const dbs = (Array.isArray(targetDatabases) && targetDatabases.length)
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : resolveTargetDatabases(pi.databases)

  const totalCount = dbs.length * 3

  const lines = [
    `请基于以下已审批协议生成 **${dbs.map((k) => k.toUpperCase()).join(' / ')}** 共 ${dbs.length} 个库 × 3 个版本 = ${totalCount} 条检索式:`,
    '',
    `项目主题: ${pi.topic || '(未填)'}`,
  ]
  if (pi.discipline) lines.push(`学科: ${pi.discipline}`)
  if (pi.goal) lines.push(`研究目标: ${pi.goal}`)

  const yStart = pi.year_start || pi.yearStart
  const yEnd = pi.year_end || pi.yearEnd
  if (yStart || yEnd) {
    lines.push(
      `**时间范围(必须逐字写进每条 query_text,不允许私自改)**: ${yStart || '(协议未指定起始)'} - ${yEnd || '(协议未指定结束,PubMed 用 3000)'}`
    )
  } else {
    lines.push(
      '时间范围: 协议未指定 — 请默认近 8 年(当前 - 7 到当前),并显式写进 query_text。'
    )
  }

  // 方法学常识注入(WoS/Scopus 年份差异 + 当前年份不完整)
  const currentYear = new Date().getFullYear()
  const hasWosAndScopus = Array.isArray(dbs) && dbs.includes('wos') && dbs.includes('scopus')
  if (hasWosAndScopus) {
    lines.push(`  · WoS / Scopus 年份语义不完全一致(WoS 含 Early Access),`)
    lines.push(`    两库命中数可能略有差异 — 这是正常现象,不要为了对齐数字改 query_text。`)
  }
  if (yEnd && Number(yEnd) >= currentYear) {
    lines.push(`  · 协议结束年 ${yEnd} 与当前年 ${currentYear} 相同/相邻 — 当年文献仍在持续收录,`)
    lines.push(`    请在 warnings 里加一条提示用户(例如:"${yEnd} 年文献可能不完整,严格 bibliometric 分析可截止 ${currentYear - 1} 年")。`)
    lines.push(`    **但不要私自改 query_text 的年份,要逐字按协议**。`)
  }

  // 文献类型 — 关键
  if (Array.isArray(pi.document_types) && pi.document_types.length) {
    lines.push('')
    lines.push(`**文献类型限定(必须写进每条 query_text,且必须显式排除未列出的类型)**:`)
    pi.document_types.forEach((t) => lines.push(`  - 允许: ${t}`))
    // 显式提醒:这些常见类型若不在允许列表里就要 NOT 出去
    const allowedLower = pi.document_types.map((t) => String(t).toLowerCase())
    const mustExclude = [
      ['Conference Paper', ['conference paper', 'conference proceedings', 'proceedings paper']],
      ['Editorial', ['editorial', 'editorial material']],
      ['Letter / Comment', ['letter', 'comment', 'correspondence']],
      ['Meeting Abstract', ['meeting abstract']],
    ]
    for (const [label, aliases] of mustExclude) {
      const isAllowed = aliases.some((a) => allowedLower.some((al) => al.includes(a)))
      if (!isAllowed) lines.push(`  - **排除**: ${label}(显式写 NOT/AND NOT 在 query_text 里)`)
    }
  } else {
    lines.push('文献类型: 协议未指定 — 默认允许 "Article" + "Review",并显式排除 Conference / Editorial / Letter / Meeting Abstract。')
  }

  // 语言
  if (Array.isArray(pi.language_limits) && pi.language_limits.length) {
    lines.push('')
    lines.push(`**语言限定(必须写进每条 query_text)**: ${pi.language_limits.join(', ')}`)
  }

  // 协议主体
  lines.push('')
  lines.push(`推荐综述类型: ${p.recommended_review_type || '(未指定)'}`)
  if (p.rationale) lines.push(`协议设计理由: ${p.rationale}`)

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
    lines.push('排除标准(LLM 必须把可在检索式里实现的排除条件直接写进 query_text):')
    p.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
  }

  lines.push('')
  lines.push(`请严格按 system message 的 JSON schema 输出,正好 ${totalCount} 条 strategies,不能多也不能少。`)
  lines.push('每条 query_text 必须包含:概念组 + 年份过滤 + 文献类型过滤(含显式 NOT 排除) + 语言过滤,缺一不可。')
  return lines.join('\n')
}

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
 *   - 非 N 条不强制报错(让调用方根据条数决定走还是回滚)
 *   - 缺字段 / 字段类型错 → 用空值兜底
 *   - query_text 必须是非空字符串,否则该条剔除
 *   - database / query_type 不在白名单 → 该条剔除
 *   - 同 (database, query_type) 重复 → 仅保留第一个
 */
function normalizeConceptSet(obj) {
  if (!obj || typeof obj !== 'object') return null
  const out = {}
  // concept_groups: [{ name, terms: [] }] OR { name: [...terms] }
  let cg = []
  if (Array.isArray(obj.concept_groups)) {
    for (const g of obj.concept_groups) {
      if (!g || typeof g !== 'object') continue
      const name = typeof g.name === 'string' ? g.name.trim() : ''
      const terms = Array.isArray(g.terms)
        ? g.terms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
        : []
      if (name && terms.length) cg.push({ name, terms })
    }
  } else if (obj.concept_groups && typeof obj.concept_groups === 'object') {
    for (const [name, terms] of Object.entries(obj.concept_groups)) {
      if (!Array.isArray(terms)) continue
      const t = terms.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      if (name.trim() && t.length) cg.push({ name: name.trim(), terms: t })
    }
  }
  if (cg.length) out.concept_groups = cg

  if (Array.isArray(obj.year_range)) {
    const yr = obj.year_range.filter((y) => typeof y === 'number' && Number.isFinite(y)).slice(0, 2)
    if (yr.length === 2) out.year_range = yr
  }
  for (const k of ['document_types', 'excluded_document_types', 'language']) {
    if (Array.isArray(obj[k])) {
      const v = obj[k].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      if (v.length) out[k] = v
    }
  }
  return Object.keys(out).length ? out : null
}

export function normalizeSearchOutput(raw) {
  const empty = { expanded_terms: {}, shared_concept_sets: {}, strategies: [], warnings: [] }
  if (!raw || typeof raw !== 'object') return empty

  // shared_concept_sets:每个 query_type 一套(跨库共享)
  const sharedConceptSets = {}
  if (raw.shared_concept_sets && typeof raw.shared_concept_sets === 'object') {
    for (const qt of VALID_QUERY_TYPES) {
      const cs = normalizeConceptSet(raw.shared_concept_sets[qt])
      if (cs) sharedConceptSets[qt] = cs
    }
  }

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

  return { expanded_terms: expanded, shared_concept_sets: sharedConceptSets, strategies, warnings }
}

// Also export concept-set normalizer for the recommend prompt to share
export { normalizeConceptSet }

// 导出常量给路由层判断"够不够生成成功"
export const SEARCH_DATABASES = VALID_DATABASES
export const SEARCH_QUERY_TYPES = VALID_QUERY_TYPES
