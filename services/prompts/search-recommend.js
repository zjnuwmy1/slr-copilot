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

export function buildRecommendSystem({ targetDatabases }) {
  const dbs = Array.isArray(targetDatabases) && targetDatabases.length
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : ['wos', 'scopus', 'pubmed']
  const N = dbs.length
  const dbList = dbs.map((k) => k.toUpperCase()).join(' / ')

  return `你是 SLR 检索式优化专家。

任务:基于"已审批协议 + 用户跑过的 exploration 检索式命中数",
为本项目用户勾选的 ${N} 个库(${dbList})合成主检索。

🔒 **严格按协议(优化只能在协议框架内,不要漂移)**:
   - **year_range 必须 = 协议给的起止年**,逐字使用。不要 "last 10 years" / "近 10 年" /
     "recent decade",不要私自把 2016-2026 改成 2016-2025 或 2020-2026。
   - **document_types 必须 = 协议允许列表**;**excluded_document_types** 包含所有协议未勾选的常见类型
     (Conference Paper / Editorial / Letter / Comment / Meeting Abstract)。
   - **language 必须 = 协议指定**。协议未指定则不写。
   - **concept_groups 以协议为骨架**,允许扩同义词 / 缩写,但不能漂移核心概念。

📊 **优化只能动以下几样(在协议框架内,基于命中数反馈)**:
   - concept_groups 内部的同义词增删 / 词形变体
   - 字段标签(全文 vs 标题/关键词,例如 high_recall 用 TITLE-ABS-KEY,
     主检索可能更偏向标题字段以收紧)
   - 截词位置 / 邻近运算符
   - **不要**:动 year_range / 动 document_types / 动 language。
     如果命中数太多 / 太少,在 rationale 里说明并 warning 给用户,**不要私自压缩或扩大协议范围**。

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
  "concept_set": {
    "concept_groups": [
      { "name": "AI 技术", "terms": ["deep learning", "neural network*", ...] },
      { "name": "医学影像", "terms": ["medical imag*", "radiolog*", ...] }
    ],
    "year_range": [起, 止],
    "document_types": ["Article", "Review"],
    "excluded_document_types": ["Conference Paper", "Editorial", "Letter"],
    "language": ["English"]
  },
  "optimized_queries": [
    {
      "database": "<必须是 ${dbs.map((k) => `'${k}'`).join(' / ')} 之一>",
      "query_text": "<concept_set 在该库语法下的完整渲染 — 必含概念组 + 年份 + 文献类型(含 NOT 排除)+ 语言>",
      "rationale": "≤80 字中文 — concept_set 比 exploration 改了什么,为什么更好",
      "based_on_strategy_ids": ["<引用了哪几条已跑过的 strategy id,可空数组>"],
      "expected_count_estimate": <整数 — 你预估该库命中数,SLR sweet spot 是 100-2000>
    }
  ],
  "overall_rationale": "1-2 句中文 — 整体优化思路",
  "warnings": ["..."]
}

**绝对规则**:
1. \`concept_set\` 是顶层必填字段,**全部 \`optimized_queries\` 共用一套**。
2. \`optimized_queries\` **数组长度必须等于 ${N}**,每个库各出现一次。
3. **${N} 条 query_text 的概念词、年份、文献类型允许/排除列表、语言必须完全一致** —
   只允许字段标签和语法不同。请自己在头脑里逐条对照检查后再输出。
4. database 字段只能是:${dbs.map((k) => `'${k}'`).join(', ')}。
5. 优化方向(全部体现在 concept_set 里,然后同步渲染到所有库):
   - 命中数 < 30 → concept_set 加同义词 / 放宽截词
   - 命中数 > 5000 → concept_set 删过宽的同义词 / 加严格的标题字段限定
   - 100-2000 → 接近 sweet spot,小幅微调
6. rationale 解释 concept_set 相比 exploration 的具体改动(加了哪个同义词、去了哪个,引用了哪条命中数)。
7. **绝对不要** 直接复制 exploration 的 query_text — 主检索是基于 concept_set 重新渲染。
8. **只输出 JSON**,不要前后加解释、Markdown、代码围栏(\`\`\`)。

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

  lines.push('')
  lines.push(`请按 system 的 JSON schema 输出 **正好 ${dbs.length} 条** optimized_queries,每个目标库 1 条。`)
  lines.push('每条 query_text 必须包含:概念组 + 年份过滤 + 文献类型过滤(含显式 NOT 排除)+ 语言过滤,缺一不可。')
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
export function normalizeRecommendOutput(raw, { targetDatabases, knownStrategyIds, protocolYearRange, protocolDocumentTypes, protocolLanguages } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'LLM 返回不是有效 JSON 对象' }
  }
  const dbs = Array.isArray(targetDatabases) && targetDatabases.length
    ? targetDatabases.filter((d) => VALID_DATABASES.includes(d))
    : VALID_DATABASES
  const known = knownStrategyIds instanceof Set ? knownStrategyIds : null

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

    out.push({
      database,
      query_text: queryText,
      rationale: readReason(item),
      based_on_strategy_ids: basedOn,
      expected_count_estimate: expected,
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
    if (Array.isArray(protocolDocumentTypes) && protocolDocumentTypes.length && Array.isArray(conceptSet.document_types)) {
      const allowedSet = new Set(protocolDocumentTypes.map((s) => String(s).toLowerCase()))
      const extra = conceptSet.document_types.filter((t) => !allowedSet.has(String(t).toLowerCase()))
      if (extra.length) {
        warnings.unshift(`⚠ AI 在 document_types 加了协议外的:${extra.join(', ')} — 已自动剔除。`)
        conceptSet.document_types = conceptSet.document_types.filter((t) => allowedSet.has(String(t).toLowerCase()))
      }
    }
    // language 私加协议外语言?
    if (Array.isArray(protocolLanguages) && protocolLanguages.length && Array.isArray(conceptSet.language)) {
      const allowedSet = new Set(protocolLanguages.map((s) => String(s).toLowerCase()))
      const extra = conceptSet.language.filter((t) => !allowedSet.has(String(t).toLowerCase()))
      if (extra.length) {
        warnings.unshift(`⚠ AI 在 language 加了协议外的:${extra.join(', ')} — 已自动剔除。`)
        conceptSet.language = conceptSet.language.filter((t) => allowedSet.has(String(t).toLowerCase()))
      }
    } else if ((!Array.isArray(protocolLanguages) || protocolLanguages.length === 0) && Array.isArray(conceptSet.language) && conceptSet.language.length) {
      warnings.unshift(`⚠ 协议未指定语言,但 AI 私加了 ${conceptSet.language.join(', ')} — 已清空。`)
      conceptSet.language = []
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
    },
  }
}

// 向后兼容旧的 RECOMMEND_SYSTEM 导出名(老代码可能 import 它)— 用默认全 3 库版本
export const RECOMMEND_SYSTEM = buildRecommendSystem({ targetDatabases: ['wos', 'scopus', 'pubmed'] })
