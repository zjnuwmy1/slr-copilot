import { canonicalDocType, canonicalLanguage, partitionByCanonical } from './_taxonomy.js'

/**
 * AI 主检索优化(原"推荐最佳") —— 完全重新设计。
 *
 * 流程语义:
 *   用户跑完前面 N 条 exploration 检索式(high_recall / balanced /
 *   high_precision × 用户勾选的库),回填了命中数。
 *
 *   "AI 主检索" 不是从已有 9 条里挑一条赢家,而是 **基于已跑过的命中数 + 协议**,
 *   为用户勾选的 **每个库** 重新合成一条 "主检索"(query_type = 'main')。
 *   每条都是一份新的、优化过的最终方案,作为正式纳入文献的 source-of-truth。
 *
 * 输入:
 *   - target_databases:  用户勾选的库(已映射为 'wos'/'scopus'/'pubmed')
 *   - approved protocol:研究问题 / 概念组 / 纳排标准 / 时间范围 / 文献类型 / 语言
 *   - previous_strategies: 已跑过的检索式 + 命中数(供 LLM 判断哪些组合有效)
 *
 * 输出:
 *   { "optimized_queries": [
 *       { "database": "scopus",
 *         "query_text": "<完整、可直接粘进 Scopus 跑的检索式>",
 *         "rationale": "≤80 字中文 — 为什么这样调整(参考了哪条命中数 + 协议哪条规则)",
 *         "based_on_strategy_ids": ["<前面已跑过的 strategy id>", ...],
 *         "expected_count_estimate": 800,
 *         "filters": {"year_range":[s,e],"document_types":[...],"language":[...]}
 *       },
 *       ...
 *     ],
 *     "overall_rationale": "1-2 句中文总结 — 整体优化思路",
 *     "warnings": ["..."]
 *   }
 *
 * 关键约束:
 *   - target_databases 里有几个库 → optimized_queries 就必须有几条,一一对应
 *   - query_text 必须按各库原生语法 + 写进协议给的 4 类过滤(概念组 + 年份
 *     + 文献类型 NOT 排除 + 语言),和 search.js 同步
 *   - rationale 必须 reference 一条以上 previous strategy id + 说明改进点
 *   - based_on_strategy_ids 不强求 — 优化可以参考任意条,LLM 自己判断
 */

import { normalizeConceptSet } from './search.js'

const DB_LABEL = {
  wos: 'Web of Science',
  scopus: 'Scopus',
  pubmed: 'PubMed',
}

const QT_LABEL_FOR_PROMPT = {
  high_recall: '高召回',
  balanced: '平衡',
  high_precision: '高精确',
  main: '已优化的主检索',
}

const VALID_DATABASES = ['wos', 'scopus', 'pubmed']

/**
 * 召回锚定区间(recall-anchored band)。
 *
 * 背景:系统综述以**召回优先**。"主检索"是对 high_recall 探查的**去噪精炼**,
 * 而不是收窄到 high_precision。但旧实现把约束区间取成 exploration 三个版本的
 * 全局 [min, max] —— min 来自 high_precision 的≈0 命中,等于**授权优化器塌缩到接近 0**
 * (实测案例:high_recall=132,优化主检索却塌到 1,且因 1∈[0,132] 而无任何警告)。
 *
 * 这里把区间下限**锚定到 high_recall 命中数**(最宽的 exploration),而非全局 min:
 *   - lo = round(high_recall × 0.5)  —— 主检索召回不得低于 high_recall 的一半
 *   - hi = max(全局 max, round(high_recall × 1.5))  —— 去噪后允许小幅高于 high_recall
 *
 * 返回 { lo, hi, recallCount } 或 null(无数据)。
 */
function recallAnchoredBand(r) {
  if (!r || !Array.isArray(r.hits) || r.hits.length === 0) return null
  const hr = r.hits.find((h) => h && h.qt === 'high_recall' && Number.isFinite(h.count))
  const recallCount = hr ? hr.count : (Number.isFinite(r.max) ? r.max : null)
  if (!Number.isFinite(recallCount)) return null
  const lo = Math.max(0, Math.round(recallCount * 0.5))
  const hi = Math.max(Number.isFinite(r.max) ? r.max : 0, Math.round(recallCount * 1.5))
  return { lo, hi, recallCount }
}

export function buildRecommendSystem({ targetDatabases }) {
  const dbs = Array.isArray(targetDatabases) && targetDatabases.length
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : ['wos', 'scopus', 'pubmed']
  const N = dbs.length
  const dbList = dbs.map((k) => k.toUpperCase()).join(' / ')

  return `你是 SLR 检索式优化专家。

任务:基于"已审批协议 + 用户跑过的 exploration 检索式命中数",
为本项目用户勾选的 ${N} 个库(${dbList})合成主检索。

🚨🚨🚨 **核心原则:你的工作是"分析",不是"创作"** 🚨🚨🚨
   exploration 数据是基准事实。你的 concept_set 词项**必须只能来自 exploration query_text
   里实际出现过的词项**(允许词形变体:复数 / 截词 / 大小写),
   **不允许凭空加未在任何 exploration 里出现过的新概念词 / 新同义词**。
   原因:exploration 已经实测过这些词的命中数,任何引入未测过的词都会让预估偏离真实。

   ✅ 合法:
   - 删:把 high_recall 里某个产生过多噪音的词从 concept_set 里去掉
   - 收紧:把宽截词 \`learn*\` 改为精确词 \`learning\` (仍属同一词根)
   - 变体:exploration 用了 "metacognitive",改成 "metacognit*" 以同时覆盖名词/形容词
   - 拆/合:exploration 把"AI" 和 "deep learning" 分两个组,主检索合并为同一组的 OR
   - 字段:exploration 全部用 TS=/TITLE-ABS-KEY,主检索仍用 TS=/TITLE-ABS-KEY(不切到标题)

   ❌ 违法:
   - 加新词:exploration 里所有 query 都没有 "neural"、"backpropagation"、"transformer",
            你不能在主检索里凭空加它们
   - 加新概念组:exploration 里只测了 [AI × 教育] 两组,你不能加第三组 "评估方法"
   - 跨库不同:WoS 加了 "DL",Scopus 没加 — 违反跨库一致性

🔒 **严格按协议(优化只能在协议框架内,不要漂移)**:
   - **year_range 必须 = 协议给的起止年**,逐字使用。不要 "last 10 years" / "近 10 年" /
     "recent decade",不要私自把 2016-2026 改成 2016-2025 或 2020-2026。
   - **document_types 必须 = 协议允许列表**;**excluded_document_types** 包含所有协议未勾选的常见类型
     (Conference Paper / Editorial / Letter / Comment / Meeting Abstract)。
   - **language 必须 = 协议指定**。协议未指定则不写。
   - **concept_groups 以协议为骨架**,且词项必须来自 exploration 实测过的词(见上面"核心原则")。

📊 **优化只能动以下几样(在协议框架内,基于命中数反馈)**:
   - 删 exploration 里已测过但产生过宽噪音的同义词
   - 同词根的截词变体(\`learn*\` ↔ \`learning\`)
   - concept_groups 拆分/合并(但不引入新组)
   - **不要**:动 year_range / 动 document_types / 动 language / 加新词。
     如果命中数太多 / 太少,在 rationale 里说明并 warning 给用户,**不要私自压缩或扩大协议范围**。

🚫 **典型反模式 — 这些会让 query 零命中 / 报错,绝对不要做**:

1. **不要把多个概念组塞进一个 TITLE/TI 字段还组合 AND**:
   - WoS 错例:\`TI=(("design thinking" OR ...) AND ("metacognit*" OR ...))\`
   - Scopus 错例:\`TITLE(("A" OR ...) AND ("C" OR ...))\`
   论文标题**极少同时包含**两个不同概念组的关键词,会直接零命中。
   Scopus 的 \`TITLE(...)\` 字段还**根本不支持内嵌 AND**,会报 "spelled incorrectly"。
   正确做法:
   - WoS: 所有概念组放进**同一个 \`TS=(...)\` 块**,组间 AND;**不要换字段**。
   - Scopus: 所有概念组放进**同一个 \`TITLE-ABS-KEY(...)\` 块**,组间 AND。

2. **收紧只在命中数过多时才做**(例如 high_recall 已 > 1000)。收紧时不要切到 title-only 字段(TI / TITLE)。
   合法的收紧路径(**仅当 high_recall 命中数很大时**):
   - 删 concept_set 里过宽的同义词(例如砍掉 "AI agent*" "foundation model*")
   - 加更具体的概念组(如 "outcome measure" 类)
   🚫 **当 high_recall 命中数本身已偏低(< 200)时,严禁收窄** —— 这是窄主题,删词会让命中塌到个位数。
       此时主检索应当**保持甚至放宽召回**(≈high_recall),只去掉明显拼错/重复的词、修语法,不要缩概念组。
   **唯一例外**:当协议明确说"只搜标题"时,才能整体切到 TI / TITLE。

3. **WoS 合法 document type**(常用)— 只用这些,不要发明:
   Article, Review, Proceedings Paper, Meeting Abstract, Editorial Material,
   Book Chapter, Letter, Correction, News Item, Book, Data Paper,
   Software Review, Hardware Review, Database Review。
   \`"Note"\` 不是 WoS 合法类型,**不要写 NOT DT=("Note")**。

4. **Scopus 合法 document type 代码**(全部 lowercase):
   ar (Article), re (Review), cp (Conference Paper), cr (Conference Review),
   ed (Editorial), le (Letter), no (Note), sh (Short Survey),
   ch (Book Chapter), bk (Book), er (Erratum)。
   多个 NOT 用一个 \`AND NOT (DOCTYPE("cp") OR DOCTYPE("cr") OR ...)\` 合并,
   **不要**写一长串 \`AND NOT DOCTYPE("X") AND NOT DOCTYPE("Y") AND ...\`
   (Scopus parser 偶尔会因此误判)。

⚠ **方法学硬性要求(SLR 跨库一致性)**:
   主检索是 **一套共享的概念规格**(\`concept_set\`),在 ${N} 个库里用各自的语法分别**渲染**一遍。
   - 概念组(包括同义词扩展)、年份范围、允许的文献类型、排除的文献类型、语言 ——
     **这五样必须在所有库里完全一致**,不允许 Scopus 有 "deep learning" 但 PubMed 改成 "deep learning OR DL"。
   - 当你想优化(加同义词 / 加排除项 / 收紧字段)时,**先优化 \`concept_set\`**,
     然后**所有库**用新的 concept_set 重新渲染一遍 query_text。
   - 唯一允许的差异 = 数据库语法标签(TS= / TITLE-ABS-KEY / [MeSH Terms]、PY= / PUBYEAR / [Date - Publication] 等)。

📖 **WoS / Scopus 年份语义差异(在 warnings 里提到)**:
   - WoS 的 Year Published 同时包含 Early Access + Final Publication 年份;Scopus 偏向最终出版年。
   - 同样的 year_range 在两库命中数会略有差异,**这是正常现象**,不要为对齐数字改 query_text。

⏰ **当前年份不完整(若 year_range 包含当前年,在 warnings 里加一条)**:
   - 协议结束年 = 当前年 → 该年文献还在持续收录,建议告知用户严格 bibliometric 可截止前一年。
   - **不要私自改 year_range**,只给提醒。

**输出格式 — 严格 JSON,字段名一字不差**(不要包在 result/data/output 任何 envelope 里,直接顶层输出):
{
  "evidence_analysis": {
    "term_universe": ["<列出 exploration 全部 query_text 里出现过的核心词项,去重,合并词形变体>"],
    "per_database": [
      {
        "database": "wos",
        "rows": [
          { "query_type": "high_recall",    "actual_hits": 130, "key_diffs_vs_balanced": "包含了 X / Y 两个宽词" },
          { "query_type": "balanced",       "actual_hits": 106, "key_diffs_vs_high_precision": "比 hp 多了 Z 词" },
          { "query_type": "high_precision", "actual_hits": 5,   "what_made_it_drop": "只用了 TI=,而且只保留 A/B 两词" }
        ],
        "summary": "≤120 字中文 — 这个库的命中数分布说明了什么,主检索应该靠近哪个版本"
      }
    ],
    "target_decision": "≤120 字中文 — 综合所有库 + 用户期望(如有),决定主检索向哪个区间靠"
  },
  "concept_set": {
    "concept_groups": [
      { "name": "<协议里的组名>", "terms": ["<仅限 exploration 出现过的词或其词形变体>"] }
    ],
    "year_range": [起, 止],
    "document_types": ["Journal Article"],
    "excluded_document_types": ["Conference Paper", "Editorial", "Letter"],
    "language": ["English"],
    "removed_terms": ["<从 exploration 砍掉的词,每个标注砍掉的理由>"],
    "kept_terms_summary": "≤80 字 — 保留的核心词项群"
  },
  "optimized_queries": [
    {
      "database": "<必须是 ${dbs.map((k) => `'${k}'`).join(' / ')} 之一>",
      "query_text": "<concept_set 在该库语法下的完整渲染 — 必含概念组 + 年份 + 文献类型(含 NOT 排除)+ 语言>",
      "rationale": "≤80 字中文 — concept_set 比 exploration 改了什么,为什么这样改后命中会落在预期",
      "based_on_strategy_ids": ["<必填!引用至少 1 条 exploration strategy id,说明这条优化是从哪个版本演变来的>"],
      "expected_count_estimate": <整数 — 你预估该库主检索的命中数>,
      "expected_within_explored_range": <true|false — 你的估算是否落在该库 exploration 三个版本的 [min, max] 范围内>,
      "expected_count_basis": "≤80 字中文 — 用哪两条 exploration 行 + 改动来推导这个数字(例如:'balanced 106 - 去掉宽词 X 估计 -15%')"
    }
  ],
  "overall_rationale": "1-2 句中文 — 整体优化思路",
  "warnings": ["..."]
}

**绝对规则**:
1. \`evidence_analysis\` 是顶层必填字段 — **先分析,后改**。不允许跳过这一步直接出 query。
2. \`concept_set\` 是顶层必填字段,**全部 \`optimized_queries\` 共用一套**。
3. \`optimized_queries\` **数组长度必须等于 ${N}**,每个库各出现一次。
4. **${N} 条 query_text 的概念词、年份、文献类型允许/排除列表、语言必须完全一致** —
   只允许字段标签和语法不同。请自己在头脑里逐条对照检查后再输出。
5. database 字段只能是:${dbs.map((k) => `'${k}'`).join(', ')}。
6. **\`expected_count_estimate\` 必须落在**召回锚定区间** \`[round(high_recall × 0.5), round(high_recall × 1.5)]\` 之间**(没有用户目标时)。
   - **召回优先(系统综述铁律)**:主检索是 high_recall 的去噪精炼,预估命中数**绝不能低于 high_recall 的一半**。
     宁可多筛几十篇,也不能漏检 —— 把主检索做成接近 high_precision 的低命中是**错误**的。
   - 若用户给了目标区间,先取 \`intersect(用户目标, 召回锚定区间)\`,主检索预估必须落在这个交集里。
   - 若 \`expected_within_explored_range = false\`,你必须在 \`expected_count_basis\` 里**逐条解释**为什么有信心破例
     (例如:"删掉了 high_recall 里专门拉宽用的 \`foundation model*\`,该词在标题摘要里出现 50+ 次,
     去掉后估算从 130 降到 80,仍 > high_recall 一半")—— 否则系统会拒绝接收。
7. **词项宇宙**:\`concept_set.concept_groups[*].terms\` 里的每个词,**必须**能在
   \`evidence_analysis.term_universe\` 里找到对应(允许词形变体)。引入未测过的新词 = 输出会被拒绝。
8. \`based_on_strategy_ids\` **不能为空** — 主检索是 exploration 的演化,必须能引用到具体 id。
9. 优化方向(全部体现在 concept_set 里,然后同步渲染到所有库):
   - **high_recall < 200(窄主题)→ 保召回**:主检索≈high_recall,只去明显噪音 + 修语法,
     **绝不删概念组、绝不收窄**。若命中数仍太少,在 warnings 里告诉用户 exploration 词项太窄、
     需要回到协议补充同义词(而不是让你在这里删词)。
   - 命中数 > 2000 → 才从 exploration 里挑过宽的词砍掉
   - 200-2000 → 接近 sweet spot,**只做最小幅去噪**,不要大改
10. rationale 解释 concept_set 相比 exploration 的具体改动 — 必须**引用具体的 strategy_id 和命中数字**。
11. **绝对不要** 直接复制 exploration 的 query_text — 主检索是基于 concept_set 重新渲染。
12. **只输出 JSON**,不要前后加解释、Markdown、代码围栏(\`\`\`)。

**各库语法块**(查询里必须正确使用):

   **WoS**(若 'wos' 在目标库里):
   - TS=(主题) / TI=(标题) / PY=(年份) / DT=(文献类型) / LA=(语言)
   - 范例:
     \`TS=(("deep learning" OR "neural network*") AND ("medical imag*"))
       AND PY=(2019-2026) AND DT=("Article" OR "Review")
       NOT DT=("Proceedings Paper" OR "Meeting Abstract" OR "Editorial Material")
       AND LA=("English")\`

   **Scopus**(若 'scopus' 在目标库里):
   - TITLE-ABS-KEY(...) / PUBYEAR > N AND PUBYEAR < N / DOCTYPE / LANGUAGE
   - **年份用 PUBYEAR 严格开区间,边界 ±1**。协议 2019-2026 → \`PUBYEAR > 2018 AND PUBYEAR < 2027\`。
   - 范例:
     \`TITLE-ABS-KEY(("deep learning" OR "neural network*") AND ("medical imag*"))
       AND PUBYEAR > 2018 AND PUBYEAR < 2027
       AND ( DOCTYPE("ar") OR DOCTYPE("re") )
       AND NOT DOCTYPE("cp") AND NOT DOCTYPE("cr") AND NOT DOCTYPE("ed") AND NOT DOCTYPE("le")
       AND LANGUAGE("English")\`

   **PubMed**(若 'pubmed' 在目标库里):
   - [MeSH Terms] / [Title/Abstract] / [Date - Publication] / [Publication Type] / [Language]
   - 范例:
     \`(("Deep Learning"[MeSH Terms] OR "deep learning"[Title/Abstract])
       AND ("Diagnostic Imaging"[MeSH Terms] OR "medical imag*"[Title/Abstract]))
       AND ("2019/01/01"[Date - Publication] : "2026/12/31"[Date - Publication])
       AND ("Journal Article"[Publication Type])
       NOT ("Editorial"[Publication Type] OR "Comment"[Publication Type] OR "Letter"[Publication Type] OR "Congress"[Publication Type])
       AND ("english"[Language])\`

写作风格(中文字段都要遵守):
- 大白话,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 颗粒度"这类八股套话。
- rationale ≤ 80 字 / warning ≤ 80 字 / overall_rationale ≤ 120 字。
`
}

/**
 * 构造用户消息 — 把"已审批协议 + exploration 检索式命中数"拼成 LLM 输入。
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {object} args.protocol             已审批 protocol
 * @param {object} args.projectInput         { year_start, year_end, document_types, language_limits, ... }
 * @param {string[]} args.targetDatabases    ['wos','scopus','pubmed'] 的子集
 * @param {Array}  args.previousStrategies   [{ id, database_name, query_type, result_count, rationale, query_text }]
 */
export function buildRecommendPrompt({
  topic,
  protocol,
  projectInput,
  targetDatabases,
  previousStrategies,
  userTargetHits,         // { min: number|null, max: number|null, note: string|null }
}) {
  const p = protocol || {}
  const pi = projectInput || {}
  const dbs = Array.isArray(targetDatabases) && targetDatabases.length
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : ['wos', 'scopus', 'pubmed']

  const lines = []
  lines.push(`请基于以下"已审批协议 + 已跑过的 exploration 检索式命中数",`)
  lines.push(`为 **${dbs.map((k) => k.toUpperCase()).join(' / ')}** 各重新合成 1 条优化主检索(共 ${dbs.length} 条):`)
  lines.push('')

  // —— 用户期望命中数(若有,作为强约束让 LLM 调整 concept_set 广度)——
  if (userTargetHits && (userTargetHits.min || userTargetHits.max || userTargetHits.note)) {
    const tmin = userTargetHits.min
    const tmax = userTargetHits.max
    lines.push('🎯 **用户对主检索的期望(关键 — 优化时必须向这个目标靠)**:')
    if (tmin != null && tmax != null) {
      lines.push(`   - 每个库的命中数大约落在 **${tmin} - ${tmax}** 条`)
    } else if (tmin != null) {
      lines.push(`   - 每个库的命中数 **至少 ${tmin}** 条(下限)`)
    } else if (tmax != null) {
      lines.push(`   - 每个库的命中数 **不超过 ${tmax}** 条(上限)`)
    }
    if (userTargetHits.note) {
      lines.push(`   - 用户附加说明: ${String(userTargetHits.note).trim().slice(0, 300)}`)
    }
    lines.push('   - 优化策略:')
    lines.push('     * exploration 命中数过宽于目标 → concept_set 减同义词 / 加标题字段限定')
    lines.push('     * exploration 命中数过窄于目标 → concept_set 扩同义词 / 放宽到 TITLE-ABS-KEY')
    lines.push('     * 每条 optimized_queries[].expected_count_estimate 必须落在用户给定区间内')
    lines.push('     * **依旧不可** 私改 year_range / document_types / language(协议优先级 > 用户目标)')
    lines.push('')
  }

  // —— 项目背景 ——
  if (topic) lines.push(`项目主题: ${topic}`)
  if (pi.discipline) lines.push(`学科: ${pi.discipline}`)
  if (pi.goal) lines.push(`研究目标: ${pi.goal}`)

  // —— 协议(必带 4 类过滤的依据 — 这些值 LLM 必须逐字使用,不允许私改)——
  const yStart = pi.year_start || pi.yearStart
  const yEnd = pi.year_end || pi.yearEnd
  if (yStart || yEnd) {
    lines.push(`**时间范围(必须**逐字**写进每条 query_text + concept_set.year_range,不允许私改)**: ${yStart || '(协议未指定)'} - ${yEnd || '(协议未指定)'}`)
  }
  if (Array.isArray(pi.document_types) && pi.document_types.length) {
    lines.push('')
    lines.push(`**文献类型限定(必须逐字写进每条 query_text + concept_set.document_types,并显式 NOT 排除未列出的类型)**:`)
    lines.push(`> ⚠ \`concept_set.document_types\` 字段请**逐字使用下面"允许"列表里给出的字符串**(如 "Journal Article"),`)
    lines.push(`> 而不是数据库特有的简写(WoS "Article" / Scopus "ar")—— 简写只在 query_text 的 DT=/DOCTYPE() 子句里出现。`)
    pi.document_types.forEach((t) => lines.push(`  - 允许: ${t}`))
    const allowedLower = pi.document_types.map((t) => String(t).toLowerCase())
    const mustExclude = [
      ['Conference Paper', ['conference paper', 'conference proceedings', 'proceedings paper']],
      ['Editorial', ['editorial', 'editorial material']],
      ['Letter / Comment', ['letter', 'comment', 'correspondence']],
      ['Meeting Abstract', ['meeting abstract']],
    ]
    for (const [label, aliases] of mustExclude) {
      const isAllowed = aliases.some((a) => allowedLower.some((al) => al.includes(a)))
      if (!isAllowed) lines.push(`  - **排除**: ${label}(在 query_text + concept_set.excluded_document_types 里都要)`)
    }
  }
  if (Array.isArray(pi.language_limits) && pi.language_limits.length) {
    lines.push('')
    lines.push(`**语言限定(必须逐字写进每条 query_text + concept_set.language)**: ${pi.language_limits.join(', ')}`)
  }

  // 方法学常识动态注入(WoS/Scopus 差异 + 当前年份不完整)
  const currentYear = new Date().getFullYear()
  const hasWosAndScopus = Array.isArray(dbs) && dbs.includes('wos') && dbs.includes('scopus')
  if (hasWosAndScopus) {
    lines.push('')
    lines.push('📖 注:WoS 的 Year Published 含 Early Access 年份,Scopus 偏向最终出版年份。')
    lines.push('   同一个 year_range 在两库的命中数可能略有差异,这是正常现象 ——')
    lines.push('   **不要为了对齐两库数字而改 query_text 或 year_range**;请在 warnings 里向用户解释。')
  }
  if (yEnd && Number(yEnd) >= currentYear) {
    lines.push('')
    lines.push(`⏰ 注:协议结束年 ${yEnd} = 当前年 ${currentYear}(或更晚),该年文献仍在持续收录。`)
    lines.push(`   请在 warnings 里加一条建议(如:"${yEnd} 年文献可能不完整,严格 bibliometric 可考虑截止 ${currentYear - 1} 年"),`)
    lines.push(`   **但不要私自改 query_text / concept_set.year_range — 必须逐字按协议**。`)
  }

  // —— 协议主体 ——
  lines.push('')
  if (Array.isArray(p.research_questions) && p.research_questions.length) {
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
    lines.push('纳入标准:')
    p.inclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
  }
  if (Array.isArray(p.exclusion_criteria) && p.exclusion_criteria.length) {
    lines.push('')
    lines.push('排除标准:')
    p.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
  }

  // —— 已跑过的 exploration 检索式 + 命中数(关键反馈信号) ——
  lines.push('')
  lines.push('===== 已跑过的检索式 + 命中数(主检索优化的依据)=====')
  // 收集每个库的 [min, max] 命中数,给 LLM 一个硬约束区间
  const dbHitRanges = {}  // db => { min, max, hits: [{ qt, count }] }
  if (Array.isArray(previousStrategies) && previousStrategies.length) {
    for (const s of previousStrategies) {
      const db = s.database_name || s.database
      if (s.result_count == null) continue
      if (!dbHitRanges[db]) dbHitRanges[db] = { min: Infinity, max: -Infinity, hits: [] }
      dbHitRanges[db].min = Math.min(dbHitRanges[db].min, s.result_count)
      dbHitRanges[db].max = Math.max(dbHitRanges[db].max, s.result_count)
      dbHitRanges[db].hits.push({ qt: s.query_type, count: s.result_count })
    }
  }

  if (!Array.isArray(previousStrategies) || previousStrategies.length === 0) {
    lines.push('(无前序数据 — 请仅基于协议生成稳健的初版主检索)')
  } else {
    // 按 database 分组,每个库内按 query_type
    const byDb = {}
    for (const s of previousStrategies) {
      const db = s.database_name || s.database
      if (!byDb[db]) byDb[db] = []
      byDb[db].push(s)
    }
    const QT_ORDER = { high_recall: 0, balanced: 1, high_precision: 2 }
    for (const db of dbs) {
      const list = (byDb[db] || []).slice().sort(
        (a, b) => (QT_ORDER[a.query_type] ?? 9) - (QT_ORDER[b.query_type] ?? 9)
      )
      if (list.length === 0) {
        lines.push('')
        lines.push(`[${DB_LABEL[db] || db}] — 暂无 exploration 数据`)
        continue
      }
      lines.push('')
      lines.push(`[${DB_LABEL[db] || db}]`)
      for (const s of list) {
        const qt = QT_LABEL_FOR_PROMPT[s.query_type] || s.query_type
        const hits = s.result_count != null ? `${s.result_count} 命中` : '未回填命中数'
        lines.push(`  - strategy_id: ${s.id}  版本: ${qt}  ${hits}`)
        if (s.rationale) {
          lines.push(`    设计理由: ${String(s.rationale).slice(0, 160)}`)
        }
        if (s.query_text) {
          // 截断 query_text 防 token 爆,保留前 300 字
          const qt2 = String(s.query_text).slice(0, 300)
          lines.push(`    检索式预览: ${qt2}${s.query_text.length > 300 ? '…' : ''}`)
        }
      }
    }
  }

  // —— 关键约束:每个库的**召回锚定**命中数区间 + 用户目标 ——
  // ⚠ 下限**锚定 high_recall × 0.5**(不是全局 min)。系统综述召回优先:主检索是 high_recall
  //   的去噪精炼,绝不能塌缩到 high_precision 的近 0 命中。
  const hasRanges = Object.keys(dbHitRanges).length > 0
  if (hasRanges) {
    lines.push('')
    lines.push('===== 主检索预估命中数的硬约束区间(召回锚定)=====')
    lines.push('每条 optimized_queries[*].expected_count_estimate **必须落在下面对应库的区间内**。')
    lines.push('⚠ **召回优先**:下限 = high_recall 命中数 × 0.5。主检索是对 high_recall 的**去噪精炼**,')
    lines.push('   **不是**收窄到 high_precision —— 预估命中数低于 high_recall 一半 = 过度收窄,会被拒绝/警告。')
    for (const db of dbs) {
      const r = dbHitRanges[db]
      if (!r) {
        lines.push(`  ${DB_LABEL[db] || db}: 无 exploration 数据 → 跳过约束(请保守预估)`)
        continue
      }
      const band = recallAnchoredBand(r)
      // 召回锚定区间为基准,再和用户目标求交集
      let lo = band ? band.lo : r.min
      let hi = band ? band.hi : r.max
      let intersected = false
      if (userTargetHits) {
        const tmin = userTargetHits.min
        const tmax = userTargetHits.max
        if (tmin != null) { lo = Math.max(lo, tmin); intersected = true }
        if (tmax != null) { hi = Math.min(hi, tmax); intersected = true }
      }
      const recallNote = band ? ` (high_recall=${band.recallCount} → 下限 ${band.lo})` : ''
      const note = lo > hi
        ? `(⚠ 用户目标 [${userTargetHits.min ?? '∞'}, ${userTargetHits.max ?? '∞'}] 与召回锚定区间无交集 — 在 warnings 里告知用户,然后向召回区间靠拢)`
        : (intersected ? ' (= 用户目标 ∩ 召回锚定区间)' : recallNote)
      lines.push(`  ${DB_LABEL[db] || db}: 预估必须 ∈ [${lo}, ${hi}]${note}`)
      lines.push(`     依据数据点:${r.hits.map((h) => `${h.qt}=${h.count}`).join(' / ')}`)
      const rc = band ? band.recallCount : r.max
      if (Number.isFinite(rc) && rc < 200) {
        lines.push(`     ⚠ **窄主题信号**:high_recall 命中仅 ${rc}(<200)。这说明概念组本身已经很严,`)
        lines.push(`        **保召回**:不要再删词收窄,主检索应≈high_recall(可仅去明显噪音 / 修语法),不要把它做成 high_precision。`)
      }
    }
    lines.push('')
    lines.push('如果你**确实**有充分把握破例(例如砍掉了一个出现频繁的过宽词,预计降幅可量化),')
    lines.push('请在 `expected_count_basis` 里**用具体词项 + 命中数**做推导。否则不要破例。')
  }

  lines.push('')
  lines.push(`请按 system 的 JSON schema 输出 **正好 ${dbs.length} 条** optimized_queries,每个目标库 1 条。`)
  lines.push('每条 query_text 必须包含:概念组 + 年份过滤 + 文献类型过滤(含显式 NOT 排除)+ 语言过滤,缺一不可。')
  lines.push('记得先填 `evidence_analysis`(对每行 exploration 的命中数做因果分析)再出 concept_set 和 query。')
  return lines.join('\n')
}

// 接受 strategy_id 的多个别名;返回 trimmed 字符串或 ''
function readStrategyId(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const candidates = [obj.strategy_id, obj.strategyId, obj.id, obj.strategyID, obj.strategy]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

// 接受 reason / rationale 的多个别名
function readReason(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const cands = [obj.rationale, obj.reason, obj.explanation, obj.why, obj.justification, obj.note, obj.notes, obj.comment]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 240)
  }
  return ''
}

// 在 BFS 任意深度找含 optimized_queries / queries / strategies 数组的对象
const OPT_ARR_KEY_RE = /^(optimized[_-]?queries|queries|main[_-]?searches?|strategies|recommendations?|optimized|optimizations?|outputs?)$/i

function findOptimizedArray(root) {
  if (!root || typeof root !== 'object') return null
  const visited = new Set()
  const queue = [{ node: root, depth: 0 }]
  while (queue.length > 0) {
    const { node, depth } = queue.shift()
    if (!node || typeof node !== 'object') continue
    if (visited.has(node)) continue
    visited.add(node)
    if (depth > 6) continue
    if (!Array.isArray(node)) {
      for (const k of Object.keys(node)) {
        if (OPT_ARR_KEY_RE.test(k) && Array.isArray(node[k]) && node[k].length > 0) {
          return node[k]
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    } else {
      // 数组根:只要元素里有 database+query_text 就接受
      if (node.length > 0 && node[0] && typeof node[0] === 'object'
          && (node[0].database || node[0].db) && (node[0].query_text || node[0].queryText || node[0].query)) {
        return node
      }
      for (const v of node) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    }
  }
  return null
}

function readDatabase(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const cands = [obj.database, obj.db, obj.database_name, obj.databaseName]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) {
      const lower = c.trim().toLowerCase()
      // 容忍 'Web of Science' → 'wos' 等
      if (VALID_DATABASES.includes(lower)) return lower
      if (lower.includes('web of science') || lower === 'wos') return 'wos'
      if (lower.includes('scopus')) return 'scopus'
      if (lower.includes('pubmed')) return 'pubmed'
    }
  }
  return ''
}

function readQueryText(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const cands = [obj.query_text, obj.queryText, obj.query, obj.search_string, obj.searchString]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

/**
 * Normalize LLM 输出为 { optimized_queries, overall_rationale, warnings }。
 *
 * @param {*} raw                 LLM JSON
 * @param {object} ctx
 * @param {string[]} ctx.targetDatabases  本次必须覆盖的库
 * @param {Set<string>} [ctx.knownStrategyIds]  exploration strategy id 集合(用于校验 based_on_strategy_ids)
 * @returns {{ ok: boolean, error?: string, data?: object }}
 */
export function normalizeRecommendOutput(raw, { targetDatabases, knownStrategyIds, protocolYearRange, protocolDocumentTypes, protocolLanguages, explorationHitRanges, userTargetHits } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'LLM 返回不是有效 JSON 对象' }
  }
  const dbs = Array.isArray(targetDatabases) && targetDatabases.length
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : VALID_DATABASES
  const known = knownStrategyIds instanceof Set ? knownStrategyIds : null
  // explorationHitRanges: { wos: { min, max, hits: [{qt,count}] }, scopus: {...}, ... }
  const hitRanges = (explorationHitRanges && typeof explorationHitRanges === 'object')
    ? explorationHitRanges : {}

  const arr = findOptimizedArray(raw)
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, error: 'AI 返回里没找到 optimized_queries 数组(也试过 queries / strategies / recommendations 等别名)' }
  }

  const out = []
  const seenDb = new Set()
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const database = readDatabase(item)
    if (!database) continue
    if (!dbs.includes(database)) continue
    if (seenDb.has(database)) continue
    const queryText = readQueryText(item)
    if (!queryText) continue
    seenDb.add(database)

    // 校验 based_on_strategy_ids(可选,引用不存在的 id 静默剔除)
    let basedOn = []
    const basedRaw = item.based_on_strategy_ids || item.based_on || item.basedOn || []
    if (Array.isArray(basedRaw)) {
      for (const r of basedRaw) {
        if (typeof r !== 'string') continue
        const id = r.trim()
        if (!id) continue
        if (known && !known.has(id)) continue
        basedOn.push(id)
      }
    }

    // filters
    let filters = null
    if (item.filters && typeof item.filters === 'object' && !Array.isArray(item.filters)) {
      const f = {}
      if (Array.isArray(item.filters.year_range)) {
        const yr = item.filters.year_range
          .filter((y) => typeof y === 'number' && Number.isFinite(y))
          .slice(0, 2)
        if (yr.length === 2) f.year_range = yr
      }
      if (Array.isArray(item.filters.document_types)) {
        const dt = item.filters.document_types.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
        if (dt.length) f.document_types = dt
      }
      if (Array.isArray(item.filters.language)) {
        const lang = item.filters.language.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
        if (lang.length) f.language = lang
      }
      if (Object.keys(f).length) filters = f
    }

    let expected = null
    const exp = item.expected_count_estimate ?? item.expected ?? item.estimated_count
    if (typeof exp === 'number' && Number.isFinite(exp) && exp >= 0) {
      expected = Math.round(exp)
    } else if (typeof exp === 'string') {
      const m = exp.match(/\d+/)
      if (m) {
        const n = Number.parseInt(m[0], 10)
        if (Number.isFinite(n) && n >= 0) expected = n
      }
    }

    // 抓取额外字段(新 schema):expected_count_basis、expected_within_explored_range
    const expectedBasis = (typeof item.expected_count_basis === 'string')
      ? item.expected_count_basis.trim().slice(0, 400)
      : (typeof item.expected_basis === 'string'
        ? item.expected_basis.trim().slice(0, 400)
        : null)
    const withinRangeRaw = item.expected_within_explored_range ?? item.expected_within_range
    let withinRange = null
    if (typeof withinRangeRaw === 'boolean') withinRange = withinRangeRaw
    else if (typeof withinRangeRaw === 'string') withinRange = /^(true|yes|1)$/i.test(withinRangeRaw.trim())

    out.push({
      database,
      query_text: queryText,
      rationale: readReason(item),
      based_on_strategy_ids: basedOn,
      expected_count_estimate: expected,
      expected_count_basis: expectedBasis,
      expected_within_explored_range: withinRange,
      filters,
    })
  }

  if (out.length === 0) {
    return { ok: false, error: '解析后 optimized_queries 为空(database 字段可能漂移到了未支持的库)' }
  }

  // 共享 concept_set —— SLR 跨库一致性的 source-of-truth
  const conceptSet = (() => {
    if (raw.concept_set && typeof raw.concept_set === 'object') {
      return normalizeConceptSet(raw.concept_set)
    }
    // alias 兜底
    for (const k of ['shared_concept_set', 'spec', 'search_spec', 'shared_spec']) {
      if (raw[k] && typeof raw[k] === 'object') {
        const n = normalizeConceptSet(raw[k])
        if (n) return n
      }
    }
    return null
  })()

  // 覆盖率提示(不当成错误,只在 warnings 里加一条)
  const missingDbs = dbs.filter((d) => !seenDb.has(d))

  const overall = (() => {
    const cands = [raw.overall_rationale, raw.overall, raw.summary, raw.note, raw.notes]
    for (const c of cands) {
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 240)
    }
    return ''
  })()

  const warnings = []
  if (Array.isArray(raw.warnings)) {
    for (const w of raw.warnings) {
      if (typeof w === 'string' && w.trim()) warnings.push(w.trim().slice(0, 240))
      if (warnings.length >= 5) break
    }
  }
  if (missingDbs.length) {
    warnings.unshift(`AI 漏了这些库的主检索:${missingDbs.join(', ')}(可重试)`)
  }

  // 若 LLM 没给 concept_set,在 warnings 里加一条提醒(不阻断 — 兼容老输出)
  if (!conceptSet) {
    warnings.push('AI 未输出 concept_set 顶层字段;跨库一致性无法机器校验(可重试以拿到 concept_set)')
  }

  // 协议合规校验(LLM 偶尔不老实,这里捕获偏差到 warnings)
  if (conceptSet) {
    // year_range 必须 = 协议
    if (Array.isArray(protocolYearRange) && protocolYearRange.length === 2 && Array.isArray(conceptSet.year_range) && conceptSet.year_range.length === 2) {
      const [ps, pe] = protocolYearRange
      const [cs2, ce] = conceptSet.year_range
      if (Number(ps) !== Number(cs2) || Number(pe) !== Number(ce)) {
        warnings.unshift(`⚠ AI 私改了年份范围:协议 ${ps}-${pe},AI 给的 ${cs2}-${ce} — 已自动改回协议值。`)
        conceptSet.year_range = [Number(ps), Number(pe)]
      }
    }
    // document_types 私加协议外类型?
    // 用 canonical 比对 —— 协议 "Journal Article" / WoS "Article" / Scopus "ar" 都归一到 canonical=article,
    // 视为同一类型,不剔除也不报警。只有 canonical 真不一致(例如协议只允许 Article 但 AI 加了 Review)才剔。
    if (Array.isArray(protocolDocumentTypes) && protocolDocumentTypes.length && Array.isArray(conceptSet.document_types)) {
      const { kept, removed } = partitionByCanonical(conceptSet.document_types, protocolDocumentTypes, canonicalDocType)
      if (removed.length) {
        warnings.unshift(`⚠ AI 在 document_types 加了协议外的:${removed.join(', ')} — 已自动剔除。`)
        conceptSet.document_types = kept
      }
    }
    // language 私加协议外语言?同样走 canonical 比对(English / en / 英语 → english)
    if (Array.isArray(protocolLanguages) && protocolLanguages.length && Array.isArray(conceptSet.language)) {
      const { kept, removed } = partitionByCanonical(conceptSet.language, protocolLanguages, canonicalLanguage)
      if (removed.length) {
        warnings.unshift(`⚠ AI 在 language 加了协议外的:${removed.join(', ')} — 已自动剔除。`)
        conceptSet.language = kept
      }
    } else if ((!Array.isArray(protocolLanguages) || protocolLanguages.length === 0) && Array.isArray(conceptSet.language) && conceptSet.language.length) {
      warnings.unshift(`⚠ 协议未指定语言,但 AI 私加了 ${conceptSet.language.join(', ')} — 已清空。`)
      conceptSet.language = []
    }
  }

  // expected_count_estimate 范围校验 — 用**召回锚定区间**(下限=high_recall×0.5)对比 AI 预估,
  // 偏离太大就 warning。关键:旧实现用全局 [min,max],min 来自 high_precision≈0,导致塌缩到 1 也
  // 落在 [0,max] 内、静默放行。改用召回锚定后,过度收窄(预估 << high_recall 一半)会被显眼警告。
  for (const q of out) {
    const r = hitRanges[q.database]
    if (!r || !Number.isFinite(r.min) || !Number.isFinite(r.max)) continue
    if (q.expected_count_estimate == null) {
      warnings.push(`⚠ AI 没给 ${q.database.toUpperCase()} 的预估命中数 — 重跑可能改善。`)
      continue
    }
    const band = recallAnchoredBand(r)
    let lo = band ? band.lo : r.min
    let hi = band ? band.hi : r.max
    let userClamped = false
    if (userTargetHits) {
      if (userTargetHits.min != null) { lo = Math.max(lo, userTargetHits.min); userClamped = true }
      if (userTargetHits.max != null) { hi = Math.min(hi, userTargetHits.max); userClamped = true }
    }
    if (lo > hi) {
      // 用户目标与召回锚定区间无交集 — 已经在 prompt 里告知,这里跳过强校验
      continue
    }
    const est = q.expected_count_estimate
    if (est < lo || est > hi) {
      const within = q.expected_within_explored_range
      const recallTag = band ? `召回锚定=[${lo}, ${hi}](high_recall=${band.recallCount})` : `区间=[${lo}, ${hi}]`
      const tag = userClamped ? `用户目标∩召回锚定=[${lo}, ${hi}]` : recallTag
      // 低于下限 = 过度收窄(召回塌缩),这是最危险的 → 始终警告级,不接受"已说明依据"降级
      if (est < lo) {
        warnings.unshift(`⚠ ${q.database.toUpperCase()} 预估 ${est} **低于召回下限** ${tag} — 主检索可能过度收窄/漏检,系统综述应保召回,强烈建议重跑(放宽)或改用 high_recall 探查式。`)
      } else if (within === false && q.expected_count_basis) {
        // 高于上限且 LLM 已明确破例并给出依据 → 信息级提示
        warnings.push(`ℹ ${q.database.toUpperCase()} 预估 ${est} 高于 ${tag},AI 已说明依据:${q.expected_count_basis.slice(0, 100)}`)
      } else {
        // 高于上限、无破例说明 → 警告级
        warnings.unshift(`⚠ ${q.database.toUpperCase()} 预估 ${est} 偏离 ${tag} — AI 未给充分依据,真实命中可能差距较大,建议重跑或人工复核。`)
      }
    }
  }

  return {
    ok: true,
    data: {
      concept_set: conceptSet,
      optimized_queries: out,
      overall_rationale: overall,
      warnings,
      missing_databases: missingDbs,
      // 透传 evidence_analysis 给上层(展示 + audit),非必需字段
      evidence_analysis: (raw && typeof raw.evidence_analysis === 'object') ? raw.evidence_analysis : null,
    },
  }
}

// 向后兼容旧的 RECOMMEND_SYSTEM 导出名(老代码可能 import 它)— 用默认全 3 库版本
export const RECOMMEND_SYSTEM = buildRecommendSystem({ targetDatabases: ['wos', 'scopus', 'pubmed'] })
