/**
 * Search recommendation — 用户跑完 3 库 × 3 版本检索式后,把每条的命中数报回来。
 * LLM 基于命中数 + 每条 rationale,推荐 1 条作为"主检索"(实际跑筛选用的),并解释为什么。
 *
 * 这是 SLR Copilot Step 2 的"检索式增强"环节 — 纯 ephemeral,
 * 推荐结果不入库,通过 session 字段传给 view。
 *
 * Phase 9 Agent T。
 */

const DB_LABEL = {
  wos: 'Web of Science',
  scopus: 'Scopus',
  pubmed: 'PubMed',
}

const QT_LABEL = {
  high_recall: '高召回',
  balanced: '平衡',
  high_precision: '高精确',
}

export const RECOMMEND_SYSTEM = `你是 SLR 检索专家。
用户跑完了 3 库 × 3 版本的检索式,把每条的命中数报回来了。
请基于命中数 + 检索式本身的 rationale,推荐 1 条作为"主检索"(实际跑筛选用的),并解释为什么。

输出严格 JSON:
{
  "primary_choice": { "strategy_id": "...", "reason": "≤80 字理由(中文)" },
  "secondary_choices": [{ "strategy_id": "...", "role": "广覆盖兜底 | 高精确度核验", "reason": "≤60 字" }],
  "warnings": ["..."],
  "estimated_screening_workload": "<整数 — 主检索 + 兜底去重后大概要筛的条数>"
}

判断准则:
- 命中数太少(<30)→ 太窄,优先排除
- 命中数太多(>5000)→ 太宽,人工筛选不现实,排除
- 命中数 100–2000 是 SLR 常见 sweet spot
- 同库多版本时优先选"平衡"或"高召回 + 数量适中"的
- rationale 言简意赅,不要"基于...考量"八股开头
- strategy_id 必须**严格**从用户给定的候选列表里挑,不能编造
- secondary_choices 0-2 条即可,不强求
- warnings 0-3 条,如"PubMed 命中数 0,建议检查 MeSH 词"

写作风格:
- 中文,大白话,不堆术语
- 不要"赋能 / 范式 / 解构 / 路径 / 机制 / 颗粒度"这类套话
- 只输出 JSON,不要前后加解释、Markdown、代码围栏。
`

/**
 * 构造用户消息 — 把"已填命中数的检索式集合"拼成 LLM 输入。
 *
 * @param {object} args
 * @param {string} args.topic       项目主题
 * @param {Array}  args.strategies  形如 [{ id, database_name, query_type, result_count, rationale, query_text }]
 *                                  调用前应已过滤"result_count != null"的条目
 */
export function buildRecommendPrompt({ topic, strategies }) {
  const lines = []
  lines.push('请基于以下检索式实测命中数,推荐 1 条作为"主检索"。')
  lines.push('')
  if (topic) lines.push(`项目主题: ${topic}`)
  lines.push('')
  lines.push('候选检索式(每条都标了 strategy_id,你必须严格从这些 id 里挑):')
  lines.push('')

  for (const s of strategies) {
    const dbLabel = DB_LABEL[s.database_name] || s.database_name || '?'
    const qtLabel = QT_LABEL[s.query_type] || s.query_type || '?'
    lines.push(`- strategy_id: ${s.id}`)
    lines.push(`  数据库: ${dbLabel}  版本: ${qtLabel}  命中数: ${s.result_count}`)
    if (s.rationale) {
      // 截断防超长
      const r = String(s.rationale).slice(0, 200)
      lines.push(`  设计理由: ${r}`)
    }
    // query_text 给一个截断版,供 LLM 参考但不要太占 token
    if (s.query_text) {
      const qt = String(s.query_text).slice(0, 240)
      lines.push(`  检索式预览: ${qt}${s.query_text.length > 240 ? '…' : ''}`)
    }
    lines.push('')
  }

  lines.push('请按 system 的 JSON schema 输出,不要解释,不要 Markdown。')
  return lines.join('\n')
}

/**
 * 标准化 LLM 输出 — 字段兜底 + 校验 strategy_id 必须在候选集合里。
 *
 * @param {*} raw                    LLM JSON
 * @param {Set<string>} validIds     合法 strategy_id 集合
 * @returns {{ ok: boolean, error?: string, data?: object }}
 */
export function normalizeRecommendOutput(raw, validIds) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'LLM 返回不是有效 JSON 对象' }
  }
  const ids = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds : [])

  // primary
  const p = raw.primary_choice
  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'primary_choice 缺失或格式错误' }
  }
  const pid = typeof p.strategy_id === 'string' ? p.strategy_id.trim() : ''
  if (!pid) {
    return { ok: false, error: 'primary_choice.strategy_id 缺失' }
  }
  if (!ids.has(pid)) {
    return { ok: false, error: `primary_choice.strategy_id "${pid}" 不在候选列表里` }
  }
  const preason = typeof p.reason === 'string' ? p.reason.trim().slice(0, 240) : ''

  // secondary
  const secondary = []
  if (Array.isArray(raw.secondary_choices)) {
    for (const s of raw.secondary_choices) {
      if (!s || typeof s !== 'object') continue
      const sid = typeof s.strategy_id === 'string' ? s.strategy_id.trim() : ''
      if (!sid || !ids.has(sid)) continue
      if (sid === pid) continue // 别把 primary 也塞进 secondary
      const role = typeof s.role === 'string' ? s.role.trim().slice(0, 40) : ''
      const reason = typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : ''
      secondary.push({ strategy_id: sid, role, reason })
      if (secondary.length >= 3) break
    }
  }

  // warnings
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter((w) => typeof w === 'string' && w.trim())
        .map((w) => w.trim().slice(0, 240))
        .slice(0, 5)
    : []

  // estimated workload — 可能是数字或字符串
  let workload = null
  const w = raw.estimated_screening_workload
  if (typeof w === 'number' && Number.isFinite(w)) {
    workload = Math.max(0, Math.round(w))
  } else if (typeof w === 'string') {
    const m = w.match(/-?\d+/)
    if (m) {
      const n = Number.parseInt(m[0], 10)
      if (Number.isFinite(n)) workload = Math.max(0, n)
    }
  }

  return {
    ok: true,
    data: {
      primary_choice: { strategy_id: pid, reason: preason },
      secondary_choices: secondary,
      warnings,
      estimated_screening_workload: workload,
    },
  }
}
