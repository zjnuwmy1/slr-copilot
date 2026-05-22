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
用户跑完了多个库 × 3 版本的检索式,把每条的命中数报回来了。
请基于命中数 + 检索式本身的 rationale,推荐 1 条作为"主检索"(实际跑筛选用的),并解释为什么。

**输出格式 — 严格 JSON,字段名一字不差**(不要包在 result/data/output 任何 envelope 里,直接顶层输出):
{
  "primary_choice": {
    "strategy_id": "<必须**精确**复制用户输入里某条的 strategy_id 字符串,如 'str_a1b2c3d4'>",
    "reason": "≤80 字中文理由"
  },
  "secondary_choices": [
    { "strategy_id": "<另一个候选的 id>", "role": "广覆盖兜底 | 高精确度核验", "reason": "≤60 字" }
  ],
  "warnings": ["..."],
  "estimated_screening_workload": <整数 — 主检索 + 兜底去重后大概要筛的条数>
}

判断准则:
- 命中数太少(<30)→ 太窄,优先排除
- 命中数太多(>5000)→ 太宽,人工筛选不现实,排除
- 命中数 100–2000 是 SLR 常见 sweet spot
- 同库多版本时优先选"平衡"或"高召回 + 数量适中"的
- strategy_id 必须**逐字符复制**用户给定候选列表里的某一条 id,**绝对不要编造、不要改写、不要翻译、不要加引号**。
- secondary_choices 0-2 条即可,不强求
- warnings 0-3 条,如"PubMed 命中数 0,建议检查 MeSH 词"

写作风格:
- 中文,大白话,不堆术语
- 不要"赋能 / 范式 / 解构 / 路径 / 机制 / 颗粒度"这类套话
- 只输出 JSON,不要前后加解释、Markdown、代码围栏(\`\`\`)。
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
 * 把 LLM JSON 剥一层 envelope。常见的 LLM 喜欢套一个外壳:
 *   { result: { primary_choice: {...} } }
 *   { data: { primary_choice: {...} } }
 *   { output: {...} } / { recommendation: {...} } / { response: {...} }
 *
 * 如果当前对象已经有"知道的"顶层字段(primary / primary_choice / best / choice),
 * 不剥;否则尝试在常见 envelope key 下寻找。
 */
function unwrapEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  const HAS_TOP = (obj) => {
    const k = Object.keys(obj || {})
    return k.some((x) => /^(primary_choice|primary|best|recommended|choice|recommendation)$/i.test(x))
  }
  if (HAS_TOP(raw)) return raw
  for (const k of keys) {
    if (/^(result|data|output|response|recommendation|answer)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object' && !Array.isArray(v) && HAS_TOP(v)) return v
    }
  }
  return raw
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

// 在候选 ids 集合里"模糊匹配":精确 → 大小写不敏感 → 含子串
function matchIdLenient(raw, ids) {
  if (!raw) return ''
  if (ids.has(raw)) return raw
  const lower = raw.toLowerCase()
  for (const id of ids) {
    if (id.toLowerCase() === lower) return id
  }
  for (const id of ids) {
    if (id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase())) return id
  }
  return ''
}

/**
 * 标准化 LLM 输出 — 字段兜底 + 校验 strategy_id 必须在候选集合里。
 *
 * 容错策略:
 *   - 剥一层 envelope({ result: {...} } 等)
 *   - primary 字段名接受 primary_choice / primary / best / recommended / choice / recommendation
 *   - strategy_id 字段名接受 strategy_id / strategyId / id
 *   - id 不在候选集合里时,做大小写不敏感 + 子串模糊匹配兜底
 *   - 顶层 primary 缺失但 LLM 把第一条放在 secondary_choices 里 → 自动 promote
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
  raw = unwrapEnvelope(raw)

  // primary —— 尝试所有可能的字段名
  let p =
    raw.primary_choice ??
    raw.primary ??
    raw.best ??
    raw.recommended ??
    raw.choice ??
    raw.recommendation ??
    null
  // 有些 LLM 把它当成数组(放第一条)
  if (Array.isArray(p)) p = p[0] ?? null

  // 如果还没找到,但有 secondary_choices,就 promote 第一条
  let promotedFromSecondary = false
  if (!p || typeof p !== 'object') {
    const sec = raw.secondary_choices || raw.secondaries || raw.candidates
    if (Array.isArray(sec) && sec.length > 0 && typeof sec[0] === 'object') {
      p = sec[0]
      promotedFromSecondary = true
    }
  }

  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'AI 返回里没找到 primary_choice / best / recommended 字段' }
  }

  const pidRaw = readStrategyId(p)
  if (!pidRaw) {
    return { ok: false, error: 'AI 推荐结果缺少 strategy_id(也试过 id / strategyId 都没有)' }
  }
  const pid = matchIdLenient(pidRaw, ids)
  if (!pid) {
    return {
      ok: false,
      error: `AI 给的 strategy_id "${pidRaw.slice(0, 60)}" 不在本次候选列表里(可能是模型编造)`,
    }
  }
  const preason = typeof p.reason === 'string'
    ? p.reason.trim().slice(0, 240)
    : (typeof p.explanation === 'string' ? p.explanation.trim().slice(0, 240) : '')

  // secondary
  const secondary = []
  const secRaw = raw.secondary_choices || raw.secondaries || raw.candidates || []
  if (Array.isArray(secRaw)) {
    for (let i = 0; i < secRaw.length; i++) {
      // 如果上面 promote 过,跳过第 0 条(它是 primary)
      if (promotedFromSecondary && i === 0) continue
      const s = secRaw[i]
      if (!s || typeof s !== 'object') continue
      const sidRaw = readStrategyId(s)
      if (!sidRaw) continue
      const sid = matchIdLenient(sidRaw, ids)
      if (!sid) continue
      if (sid === pid) continue
      const role = typeof s.role === 'string' ? s.role.trim().slice(0, 40) : ''
      const reason = typeof s.reason === 'string'
        ? s.reason.trim().slice(0, 200)
        : (typeof s.explanation === 'string' ? s.explanation.trim().slice(0, 200) : '')
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
  const w = raw.estimated_screening_workload ?? raw.workload ?? raw.estimated_workload
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
