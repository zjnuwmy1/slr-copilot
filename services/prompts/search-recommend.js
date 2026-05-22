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
 * 在任意深度的对象树里递归查找带有"primary 类字段"的子对象。
 * BFS 优先,最大深度 6,防止环。
 *
 * 命中的字段名(任一即可,大小写不敏感):
 *   primary_choice / primary / best / recommended / choice / recommendation /
 *   chosen / pick / selected / top_choice / mainChoice
 */
const PRIMARY_KEY_RE = /^(primary[_-]?choice|primary|best|recommended|choice|recommendation|chosen|pick|selected|top[_-]?choice|main[_-]?choice)$/i

function findPrimaryContainer(root) {
  if (!root || typeof root !== 'object') return null
  const visited = new Set()
  const queue = [{ node: root, depth: 0 }]
  while (queue.length > 0) {
    const { node, depth } = queue.shift()
    if (!node || typeof node !== 'object') continue
    if (visited.has(node)) continue
    visited.add(node)
    if (depth > 6) continue

    // 对象:看自己是否含 primary-like key,否则把每个 value 入队
    if (!Array.isArray(node)) {
      for (const k of Object.keys(node)) {
        if (PRIMARY_KEY_RE.test(k)) {
          // 这个 node 自己就是 container
          return node
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    } else {
      // 数组:每个元素入队(LLM 偶尔会 wrap 成 [{primary_choice: ...}])
      for (const v of node) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    }
  }
  return null
}

/** 从 container 里取出 primary 对象(支持上面所有别名) */
function pickPrimaryFrom(container) {
  if (!container || typeof container !== 'object') return null
  for (const k of Object.keys(container)) {
    if (PRIMARY_KEY_RE.test(k)) {
      let v = container[k]
      // 数组形态:取第一个
      if (Array.isArray(v) && v.length > 0) v = v[0]
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
      // 退化:k 直接是字符串 id(例如 { best: 'str_xxx' })
      if (typeof v === 'string' && v.trim()) {
        return { strategy_id: v.trim() }
      }
    }
  }
  return null
}

/** 在任意位置找 secondary 数组 */
const SECONDARY_KEY_RE = /^(secondary[_-]?choices|secondaries|candidates|alternates?|alternatives|backups?|fallbacks?|others?)$/i
function findSecondaryArray(root) {
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
        if (SECONDARY_KEY_RE.test(k) && Array.isArray(node[k])) return node[k]
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    } else {
      for (const v of node) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    }
  }
  return null
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

// 接受 reason 的多个别名:reason / explanation / rationale / why / justification / note(s)
function readReason(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const cands = [obj.reason, obj.explanation, obj.rationale, obj.why, obj.justification, obj.note, obj.notes, obj.comment]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 240)
  }
  return ''
}

// 在任意深度找第一个含 strategy_id 的节点(BFS,最大深度 6)
function findFirstNodeWithStrategyId(root) {
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
      if (readStrategyId(node)) return node
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    } else {
      for (const v of node) {
        if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 })
      }
    }
  }
  return null
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

  // 1) 递归找到含 primary-like key 的 container
  const container = findPrimaryContainer(raw)
  let p = container ? pickPrimaryFrom(container) : null

  // 2) 兜底:如果 raw 顶层是数组,且第一项含 strategy_id,直接当 primary
  if (!p && Array.isArray(raw) && raw.length > 0 && readStrategyId(raw[0])) {
    p = raw[0]
  }

  // 3) 兜底:如果整棵树里有任何节点直接含 strategy_id(LLM 干脆没用 primary
  //    包装,只输出一条 {strategy_id, reason}),也接受
  if (!p || typeof p !== 'object') {
    p = findFirstNodeWithStrategyId(raw)
  }

  // 4) 兜底:promote 第一条 secondary
  let promotedFromSecondary = false
  if (!p || typeof p !== 'object') {
    const secArr = findSecondaryArray(raw)
    if (Array.isArray(secArr) && secArr.length > 0 && typeof secArr[0] === 'object') {
      p = secArr[0]
      promotedFromSecondary = true
    }
  }

  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'AI 返回里没找到 primary_choice / best / recommended 字段(也找不到任何含 strategy_id 的节点)' }
  }

  // 如果取到的 primary 对象自身没有 strategy_id(双层 wrapping,例如
  // {recommendation:{best:{strategy_id:...}}} — 外层 'recommendation' 匹配了
  // PRIMARY_KEY_RE,内层 'best' 也匹配,我们取到的是中间那层),
  // 在它内部再递归找一次。
  let pidRaw = readStrategyId(p)
  if (!pidRaw) {
    const innerNode = findFirstNodeWithStrategyId(p)
    if (innerNode) {
      p = innerNode
      pidRaw = readStrategyId(p)
    }
  }
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
  const preason = readReason(p)

  // secondary
  const secondary = []
  const secRaw = findSecondaryArray(raw) || []
  if (Array.isArray(secRaw)) {
    for (let i = 0; i < secRaw.length; i++) {
      if (promotedFromSecondary && i === 0) continue
      const s = secRaw[i]
      if (!s || typeof s !== 'object') continue
      const sidRaw = readStrategyId(s)
      if (!sidRaw) continue
      const sid = matchIdLenient(sidRaw, ids)
      if (!sid) continue
      if (sid === pid) continue
      const role = typeof s.role === 'string' ? s.role.trim().slice(0, 40) : ''
      const reason = readReason(s).slice(0, 200)
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
