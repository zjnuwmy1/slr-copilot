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
为本项目用户勾选的 ${N} 个库(${dbList})**各重新生成 1 条优化后的主检索**。
主检索是正式拿去筛选用的、覆盖最合理的版本 —— 不是从已有 exploration 里挑赢家,
而是 **新合成** 一条:吸收命中数过多/过少的教训,严格按协议过滤。

**输出格式 — 严格 JSON,字段名一字不差**(不要包在 result/data/output 任何 envelope 里,直接顶层输出):
{
  "optimized_queries": [
    {
      "database": "<必须是 ${dbs.map((k) => `'${k}'`).join(' / ')} 之一>",
      "query_text": "<可直接粘贴执行的完整检索式 — 必含概念组 + 年份 + 文献类型(含 NOT 排除)+ 语言>",
      "rationale": "≤80 字中文 — 这条相比 exploration 改了什么,为什么更好",
      "based_on_strategy_ids": ["<引用了哪几条已跑过的 strategy id,可空数组>"],
      "expected_count_estimate": <整数 — 你预估命中数,SLR sweet spot 是 100-2000>,
      "filters": { "year_range": [起,止], "document_types": [...], "language": [...] }
    }
  ],
  "overall_rationale": "1-2 句中文 — 整体优化思路",
  "warnings": ["..."]
}

**绝对规则**:
1. \`optimized_queries\` **数组长度必须等于 ${N}**,且每个库各出现一次(不能重复、不能缺漏)。
2. database 字段只能是这几个值:${dbs.map((k) => `'${k}'`).join(', ')}。
3. query_text 必须包含以下 4 类过滤,缺一不可(参考下面"语法块"):
   a) 概念组的逻辑组合(组内 OR,组间 AND)
   b) **协议给的年份范围**,用各库原生语法
   c) **协议允许的文献类型 + 显式 NOT 排除未勾选的**(尤其会议论文 / 摘要 / 社论 / 通讯)
   d) **协议指定的语言**(若有)
4. rationale 必须解释"基于哪些 exploration 命中数 + 协议规则做了什么调整"。
   不要"基于...考量"八股开头,要具体:"Scopus high_recall 3200 太宽,去掉外层同义词;
   保留 balanced 的标题字段限定 → 预估 ~800"。
5. **绝对不要** 把任何 exploration 的 strategy_id 直接当成主检索抄过来 —
   主检索是 *新合成* 的 query_text,只是吸收前面命中数的反馈。
6. **基于反馈优化**:
   - 命中数 < 30 的版本 → 太窄,补同义词 / 放宽截词
   - 命中数 > 5000 的版本 → 太宽,加标题字段限定 / 严格 AND / 减少同义词
   - 100-2000 的版本 → 接近 sweet spot,主检索向这个方向靠
7. **只输出 JSON**,不要前后加解释、Markdown、代码围栏(\`\`\`)。

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

  // —— 协议(必带 4 类过滤的依据) ——
  const yStart = pi.year_start || pi.yearStart
  const yEnd = pi.year_end || pi.yearEnd
  if (yStart || yEnd) {
    lines.push(`**时间范围(必须写进每条 query_text)**: ${yStart || '(协议未指定)'} - ${yEnd || '(协议未指定)'}`)
  }
  if (Array.isArray(pi.document_types) && pi.document_types.length) {
    lines.push('')
    lines.push(`**文献类型限定(必须写进每条 query_text,且必须显式 NOT 排除未列出的类型)**:`)
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
      if (!isAllowed) lines.push(`  - **排除**: ${label}(在 query_text 里显式写 NOT/AND NOT)`)
    }
  }
  if (Array.isArray(pi.language_limits) && pi.language_limits.length) {
    lines.push('')
    lines.push(`**语言限定(必须写进每条 query_text)**: ${pi.language_limits.join(', ')}`)
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
export function normalizeRecommendOutput(raw, { targetDatabases, knownStrategyIds } = {}) {
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

  return {
    ok: true,
    data: {
      optimized_queries: out,
      overall_rationale: overall,
      warnings,
      missing_databases: missingDbs,
    },
  }
}

// 向后兼容旧的 RECOMMEND_SYSTEM 导出名(老代码可能 import 它)— 用默认全 3 库版本
export const RECOMMEND_SYSTEM = buildRecommendSystem({ targetDatabases: ['wos', 'scopus', 'pubmed'] })
