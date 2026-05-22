/**
 * Title / Abstract Screening — 用已审批协议(纳入/排除标准)对每条 record 的
 * 标题 + 摘要 + 关键词做 include / exclude / uncertain 三态初筛。
 *
 * 设计哲学(2026-05 重写,从"严格 gate"改为"宽进严出"):
 *
 *   SLR 方法学共识:title/abstract 筛选目标是 **高 recall / 低 specificity**
 *   ——"不漏掉好论文"远比"提前剔不相关"重要。严判应留到 full-text 阶段。
 *
 *   早期版本要求 include 必须"同时满足所有纳入标准",但 title/abstract 信息
 *   不全,会把大量原本该 include 的论文推到 uncertain / exclude。
 *   实测纳入率仅 8%,远低于健康区间 15-30%。
 *
 * 新决策树(客观、可机器化):
 *
 *   1. 摘要完全缺失 + 标题信息不足 → uncertain(留全文确认)
 *   2. 标题/摘要里**有明确文字命中**任一排除标准 → exclude(可引证)
 *   3. **文献类型与协议明显不符**(协议要 RCT,这是 narrative review)→ exclude
 *   4. 标题/摘要/关键词里**完全找不到任何核心概念组的关键词** → exclude(主题不沾边)
 *   5. **其余默认 include**,即便不能 100% 确认所有纳入标准也允许通过 —
 *      把"是否真的满足必要条件 X"留给全文阶段判断
 *
 *   底线:不编造,不引用文中没出现的内容,不查外部知识。
 *
 * 严格规则:
 *   - 只能用 title / abstract / keywords / authors / year / journal 作判断依据,
 *     不引外部知识(不查作者、不查影响因子、不脑补研究结论)。
 *   - exclude 必须能引证标题/摘要里的具体文字(matched_exclusion 不能为空)
 *   - uncertain 仅保留给真信息缺失场景(摘要缺失 / 标题模糊)
 *   - 输出严格 JSON,字段见 OUTPUT_SCHEMA。
 */

export const SCREENING_SYSTEM = `你是 SLR 文献筛选助手。
任务:对单篇文献的 **标题 + 摘要 + 关键词** 做 include / exclude / uncertain 三态初筛。

🎯 **核心哲学:title/abstract 阶段宽进严出**
SLR 方法学共识 —— 这一步的目标是"**不漏掉相关论文**",而不是确认它一定符合每条标准。
具体的资格判断留到**全文阶段**做。本步遵循 **高 recall / 低 specificity** 原则。

──────────────────────────────────────────────
**决策树(严格按顺序判,先命中先生效)**

【1】 信息不足 → \`uncertain\`
   触发:摘要缺失 **且** 标题信息不够(<10 字 / 只是数字编号 / 完全没出现任何概念词)
   动作:列 need_full_text_check 给用户提示需要看全文哪些字段

【2】 命中排除标准 → \`exclude\`
   触发:标题/摘要/关键词里**有明确文字证据**(可以原文引述)命中任一排除标准
   ⚠ 必填 matched_exclusion(直接抄用户给的排除标准),reason 给出文中证据
   ⚠ 仅靠"摘要没提到"**不构成**命中排除标准(那是信息缺失,不是有反证)

【3】 文献类型明显不符 → \`exclude\`
   触发:协议明示只要某类型(如只要 empirical / 只要 RCT),但本文标题明显是别的类型
   常见信号(在标题里或文献类型字段里):
     - "A systematic review of..." / "Literature review of..." → 是综述
     - "Editorial:" / "Letter to..." / "Commentary on..." → 是社论/通讯
     - "Conference proceedings of..." / 仅会议摘要(<150 字 abstract) → 是会议论文
   ⚠ 当协议**未明示**只要哪种类型时,**不要**用此条剔(避免学科 bias)

【4】 完全无概念重叠 → \`exclude\`
   触发:标题 + 摘要 + 关键词三个字段里,**任何一个核心概念组**(用户消息会列出)
        都**找不到任何一个词项或近义变体**
   ⚠ 这是客观词形匹配(允许复数、过去式、连字符变体如 metacognition / metacognitive)
   ⚠ 只要**任一**概念组有命中,就**不应**用此条剔(下一步走【5】)

【5】 其余 → \`include\`
   触发:至少有 1 个概念组的词项出现,且没命中排除标准,文献类型也没明显违例
   ⚠ **不要因为"标题/摘要没明确说样本量 / 干预细节 / 研究方法 → 不能确认满足纳入标准 N"**
     而推到 uncertain 或 exclude。这些细节留全文阶段确认。
   ⚠ "可能相关但摘要没说清" → \`include\`(高 recall 原则)

──────────────────────────────────────────────
**输出字段(严格 JSON,字段名一字不差)**:
{
  "decision":   "include" | "exclude" | "uncertain",
  "confidence": 0.0 到 1.0,
  "reason":     "1-2 句中文,引证 title/abstract 里的具体文字。≤ 80 字",
  "matched_inclusion":    ["命中的纳入标准原文(从用户标准抄,不改写)"],
  "matched_exclusion":    ["命中的排除标准原文 — exclude 时必填"],
  "matched_concepts":     ["命中的概念组名(用户消息里给的组名,如『AI 技术』)— include 时必填至少 1 个"],
  "need_full_text_check": ["uncertain 时,需要看全文确认的字段名(如『样本量』『研究设计』)"]
}

**confidence 校准**(必须诚实):
  decision = exclude:
    0.9-1.0  有明确文字命中排除标准 / 标题明示是综述-社论等不符类型
    0.7-0.9  完全无概念重叠(决策【4】)
    < 0.7    其实是 uncertain 错标了,请改回 uncertain
  decision = include:
    0.7-0.9  多个概念组都命中 + 摘要主题明确相关
    0.5-0.7  1 个概念组命中,主题大致相关,细节没法在摘要确认(典型情况,放心 include)
    < 0.5    可能相关但勉强,仍 include,留全文阶段把关
  decision = uncertain:
    任何值 — 但只在【1】触发时才用,不要"模糊就 uncertain"
──────────────────────────────────────────────

**绝对底线**:
1. 只用用户提供的字段(title / abstract / keywords / authors / year / journal),
   **不查外部知识**,**不编造文中没出现的内容**
2. exclude 时 matched_exclusion 不能为空(必须能引证)
3. include 时 matched_concepts 不能为空(至少有 1 个概念组命中)
4. uncertain 时 need_full_text_check 不能为空(告诉用户要看什么)
5. **只输出 JSON**,前后不加任何文字 / Markdown / 代码围栏(\`\`\`)

语言要求(**强制**):
- reason 必须用**简体中文**
- matched_inclusion / matched_exclusion 直接抄用户给的标准原文(中文是中文,英文保留英文)
- matched_concepts / need_full_text_check 用简体中文

写作风格(reason / need_full_text_check):
- **大白话**,不堆砌术语,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股
- 一条 reason ≤ 80 字,直接陈述"标题里提到 ...,所以..."
- 一条 need_full_text_check ≤ 15 字,只点字段名
`

/**
 * 构造单条 record 的用户消息。
 *
 * @param {object} args
 * @param {object} args.protocol  approved & parsed protocol(research_questions / inclusion_criteria / exclusion_criteria / concept_groups 是数组)
 * @param {object} args.record    一条 records 行(title / abstract / keywords_list / authors_text / year / journal)
 * @param {object} [args.projectInput]  可选:协议外的项目级信息(year_start / year_end / document_types / language_limits)
 * @param {number} [args.targetIncludePct]  可选:用户期望的初筛纳入率(0-100),作为边缘 case 的软目标
 */
export function buildScreeningUserPrompt({ protocol, record, projectInput, targetIncludePct }) {
  const p = protocol || {}
  const r = record || {}
  const pi = projectInput || {}
  const lines = []

  // ===== 协议核心 =====
  lines.push('请根据以下协议对单篇文献做初筛(只看 title + abstract + keywords)。')
  lines.push('')
  lines.push('## 研究问题')
  const rqs = Array.isArray(p.research_questions) ? p.research_questions : []
  if (rqs.length) {
    rqs.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  } else {
    lines.push('  (未指定)')
  }

  // ===== 概念组(关键!客观词形 gate)=====
  const cg = Array.isArray(p.concept_groups) ? p.concept_groups : []
  if (cg.length) {
    lines.push('')
    lines.push('## 核心概念组(决策【4】用 — 完全无重叠才能 exclude)')
    lines.push('每组内 OR(同义词),组间 AND(都要至少 1 个命中才算"主题相关")。')
    lines.push('词形变体算命中:复数 / 时态 / 截词(\\*) / 连字符变体 都算。')
    cg.forEach((g, i) => {
      const name = g.name || `组 ${i + 1}`
      const terms = Array.isArray(g.terms) ? g.terms : []
      lines.push(`  - **${name}**: ${terms.slice(0, 30).join(' | ')}${terms.length > 30 ? ` ... (共 ${terms.length} 词)` : ''}`)
    })
  }

  // ===== 纳入标准 =====
  lines.push('')
  lines.push('## 纳入标准(参考用,**不要**因为标题/摘要没明说就剔)')
  const ic = Array.isArray(p.inclusion_criteria) ? p.inclusion_criteria : []
  if (ic.length) {
    ic.forEach((c, i) => lines.push(`  I${i + 1}. ${c}`))
    lines.push('  ↑ 这些**留全文阶段验证**。本步只看是否完全无概念重叠或命中排除标准。')
  } else {
    lines.push('  (未指定 — 视为不限)')
  }

  // ===== 排除标准 =====
  lines.push('')
  lines.push('## 排除标准(决策【2】用 — 必须文中有明确证据才能命中)')
  const ec = Array.isArray(p.exclusion_criteria) ? p.exclusion_criteria : []
  if (ec.length) {
    ec.forEach((c, i) => lines.push(`  E${i + 1}. ${c}`))
  } else {
    lines.push('  (未指定 — 不触发决策【2】)')
  }

  // ===== 文献类型 / 年份 / 语言 (决策【3】用)=====
  const dts = Array.isArray(pi.document_types) ? pi.document_types : []
  if (dts.length) {
    lines.push('')
    lines.push(`## 协议允许的文献类型(决策【3】用): ${dts.join(' / ')}`)
    lines.push('  标题里明显是其他类型(综述/社论/通讯/会议)才剔;标题没明示就不要用此条剔。')
  }
  const yStart = pi.year_start || pi.yearStart
  const yEnd = pi.year_end || pi.yearEnd
  if (yStart || yEnd) {
    lines.push('')
    lines.push(`## 协议年份范围: ${yStart || '(未指定起)'} – ${yEnd || '(未指定止)'}`)
    lines.push('  (年份过滤通常在检索阶段就已经做了,这里仅供你参考。年份不在范围不必特意剔。)')
  }

  // ===== 待筛文献 =====
  lines.push('')
  lines.push('## 待筛文献')
  lines.push(`- 标题: ${r.title || '(无标题)'}`)
  if (r.year) lines.push(`- 年份: ${r.year}`)
  if (r.journal) lines.push(`- 期刊: ${r.journal}`)
  if (r.authors_text) lines.push(`- 作者: ${String(r.authors_text).slice(0, 300)}`)
  const keywords = Array.isArray(r.keywords_list)
    ? r.keywords_list
    : (Array.isArray(r.keywords) ? r.keywords : [])
  if (keywords.length) lines.push(`- 关键词: ${keywords.join('; ')}`)
  if (r.item_type) lines.push(`- 文献类型: ${r.item_type}`)
  lines.push('')
  lines.push('### 摘要')
  if (r.abstract && String(r.abstract).trim()) {
    // 截到 ~6000 字符以防过长,初筛不需要全文
    lines.push(String(r.abstract).trim().slice(0, 6000))
  } else {
    lines.push('(摘要缺失)')
  }

  // ===== 用户期望纳入率(软目标 — 只影响边缘 case)=====
  const tgt = Number.isFinite(Number(targetIncludePct)) ? Number(targetIncludePct) : null
  if (tgt != null && tgt >= 0 && tgt <= 100) {
    lines.push('')
    lines.push(`## 用户期望的初筛纳入率: ~${tgt}%(软目标)`)
    lines.push(`  - 这是"基于本协议主题广度,用户预期约 ${tgt}% 的论文最终能 include"的指引。`)
    lines.push(`  - **仅用于**边缘 case 的判定:决策树走到【5】默认 include 的"勉强相关"边缘上,`)
    lines.push(`    若目标 ≤ 15% 收紧些(更倾向 exclude/uncertain),若 ≥ 30% 放宽些(更倾向 include)。`)
    lines.push(`  - **绝不破坏底线**:【2】命中排除标准 / 【3】文献类型不符 / 【4】无概念重叠 —`)
    lines.push(`    这三类客观 exclude **不能**因为目标率调整而改判 include。`)
    lines.push(`  - 你不知道当前累计通过率,所以**按单条情况判断**,目标只用于边缘 case 的方向倾斜。`)
  }

  lines.push('')
  lines.push('────────────────────────────────────')
  lines.push('请严格按 system message 的决策树 + JSON schema 输出。')
  lines.push('记住:title/abstract 阶段宽进严出。"可能相关但不能确认细节" → include(留全文阶段)。')
  return lines.join('\n')
}

// ============================================================
// AI 推荐目标纳入率
// ============================================================

/**
 * 让 LLM 根据协议反推一个合理的初筛纳入率(整数百分比)。
 *
 * 判断依据:
 *   - 概念组数量 + 词项广度(多 + 宽 → 召回多 → 通过率低)
 *   - 纳入标准严格度(越具体 → 通过率低)
 *   - 排除标准条数(越多越严 → 通过率低)
 *   - 主题特异性(冷门细分 → 高;泛主题 → 低)
 *
 * 输出 JSON: { "recommended_pct": <0-100 整数>, "reasoning": "≤80 字中文" }
 */
export const SUGGEST_TARGET_SYSTEM = `你是 SLR 方法学顾问。
任务:根据用户给的协议(主题 + 概念组 + 纳排标准),反推这个 SLR 在
**title/abstract 初筛阶段**大约能通过多少比例的论文。

经验区间(参考):
- 5-15%:主题非常细分 / 概念组多且严 / 排除标准多 / 检索式精准
- 15-25%:典型 SLR(中等特异性主题,概念组 2-3 个,标准明确)
- 25-40%:主题较宽 / 概念组只有 1-2 个 / 排除标准少 / 检索式宽
- >40%:几乎是 scoping review,主题很宽

判断时**只看协议本身**,不要假设论文质量。

**输出严格 JSON,不要任何前后文字 / Markdown / 代码围栏**:
{
  "recommended_pct": <整数,0-100>,
  "reasoning": "≤ 80 字中文,说明依据(从协议哪几条推导出来)"
}
`

export function buildSuggestTargetPrompt({ protocol, projectInput }) {
  const p = protocol || {}
  const pi = projectInput || {}
  const lines = []
  lines.push('请根据以下 SLR 协议,推荐一个合理的初筛通过率(整数百分比)。')
  lines.push('')

  if (pi.topic) lines.push(`## 项目主题: ${pi.topic}`)
  if (pi.discipline) lines.push(`## 学科: ${pi.discipline}`)
  if (pi.goal) lines.push(`## 研究目标: ${pi.goal}`)

  const rqs = Array.isArray(p.research_questions) ? p.research_questions : []
  if (rqs.length) {
    lines.push('')
    lines.push('## 研究问题')
    rqs.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  }

  const cg = Array.isArray(p.concept_groups) ? p.concept_groups : []
  if (cg.length) {
    lines.push('')
    lines.push(`## 概念组(共 ${cg.length} 组)`)
    cg.forEach((g, i) => {
      const terms = Array.isArray(g.terms) ? g.terms : []
      lines.push(`  ${i + 1}. ${g.name || '未命名'}(${terms.length} 个词): ${terms.slice(0, 15).join(' | ')}${terms.length > 15 ? ' ...' : ''}`)
    })
  }

  const ic = Array.isArray(p.inclusion_criteria) ? p.inclusion_criteria : []
  if (ic.length) {
    lines.push('')
    lines.push(`## 纳入标准(共 ${ic.length} 条)`)
    ic.forEach((c, i) => lines.push(`  I${i + 1}. ${c}`))
  }

  const ec = Array.isArray(p.exclusion_criteria) ? p.exclusion_criteria : []
  if (ec.length) {
    lines.push('')
    lines.push(`## 排除标准(共 ${ec.length} 条)`)
    ec.forEach((c, i) => lines.push(`  E${i + 1}. ${c}`))
  }

  const dts = Array.isArray(pi.document_types) ? pi.document_types : []
  if (dts.length) {
    lines.push('')
    lines.push(`## 允许文献类型: ${dts.join(' / ')}`)
  }

  lines.push('')
  lines.push('请输出 JSON:{ "recommended_pct": <整数 0-100>, "reasoning": "≤80 字" }')
  return lines.join('\n')
}

/**
 * Normalize AI 推荐输出
 */
export function normalizeSuggestTargetOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  // 剥 wrapper
  let r = raw
  for (let i = 0; i < 3 && r && typeof r === 'object'; i++) {
    if (r.recommended_pct !== undefined || r.recommendedPct !== undefined) break
    const inner = r.result || r.data || r.output || r.response
    if (inner && typeof inner === 'object') r = inner
    else break
  }
  const pctRaw = r.recommended_pct ?? r.recommendedPct ?? r.pct ?? r.percent
  let pct = null
  if (typeof pctRaw === 'number' && Number.isFinite(pctRaw)) pct = pctRaw
  else if (typeof pctRaw === 'string') {
    const m = pctRaw.match(/\d+/)
    if (m) pct = Number.parseInt(m[0], 10)
  }
  if (pct == null || !Number.isFinite(pct)) return null
  if (pct < 0) pct = 0
  if (pct > 100) pct = 100
  pct = Math.round(pct)
  const reason = typeof r.reasoning === 'string'
    ? r.reasoning.trim().slice(0, 300)
    : (typeof r.reason === 'string' ? r.reason.trim().slice(0, 300) : '')
  return { recommended_pct: pct, reasoning: reason }
}

// ============================================================
// Normalize
// ============================================================

const VALID_DECISIONS = ['include', 'exclude', 'uncertain']

/**
 * 把 LLM 输出 normalize 成可直接入库的形状。
 *
 * 容错策略(对齐 protocol.js / search.js):
 *   - 顶层被包了一层(`{result: {...}}`, `{decision: {...}}`)→ 自动剥
 *   - 字段同义词(rationale / explanation → reason; matched_in → matched_inclusion 等)
 *   - decision 不在白名单 → uncertain
 *   - confidence 不是 0..1 数字 → null
 *   - matched_inclusion/exclusion/concepts/need_full_text_check 非数组 → 空数组
 *
 * 返回结构:
 *   {
 *     decision: 'include' | 'exclude' | 'uncertain',
 *     confidence: number | null,
 *     reason: string,
 *     matched_inclusion: string[],
 *     matched_exclusion: string[],
 *     matched_concepts:  string[],
 *     need_full_text_check: string[],
 *   }
 */
export function normalizeScreeningOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyScreening()
  }

  // 1) 剥 wrapper:{result: {...}} / {data: {...}} / {output: {...}} / {response: {...}}
  raw = unwrapOne(raw)
  raw = unwrapOne(raw)

  // 2) 字段同义词
  const aliases = {
    decision:             ['decision', 'verdict', 'judgment', 'result', 'label'],
    confidence:           ['confidence', 'confidence_score', 'conf', 'score'],
    reason:               ['reason', 'rationale', 'explanation', 'justification', 'reasoning'],
    matched_inclusion:    ['matched_inclusion', 'matchedInclusion', 'matched_in', 'inclusion_matched', 'inclusion_hits'],
    matched_exclusion:    ['matched_exclusion', 'matchedExclusion', 'matched_ex', 'exclusion_matched', 'exclusion_hits'],
    matched_concepts:     ['matched_concepts', 'matchedConcepts', 'concepts_matched', 'concept_hits', 'matched_concept_groups'],
    need_full_text_check: ['need_full_text_check', 'needFullTextCheck', 'full_text_check', 'requires_full_text', 'full_text_needed'],
  }
  const pick = (key) => {
    for (const k of aliases[key]) if (raw[k] !== undefined) return raw[k]
    return undefined
  }

  // decision
  let decision = String(pick('decision') || '').trim().toLowerCase()
  if (!VALID_DECISIONS.includes(decision)) {
    // 偶尔模型会输 yes/no/maybe
    if (decision === 'yes' || decision === 'true') decision = 'include'
    else if (decision === 'no' || decision === 'false') decision = 'exclude'
    else if (decision === 'maybe' || decision === 'unsure' || decision === 'unknown') decision = 'uncertain'
    else decision = 'uncertain'
  }

  // confidence — 0..1 number
  let confidence = null
  const confRaw = pick('confidence')
  if (typeof confRaw === 'number' && Number.isFinite(confRaw)) {
    confidence = confRaw
  } else if (typeof confRaw === 'string') {
    const n = Number.parseFloat(confRaw)
    if (Number.isFinite(n)) confidence = n
  }
  if (confidence != null) {
    // 把 0..100 / 百分比文本压缩到 0..1
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100
    if (confidence < 0) confidence = 0
    if (confidence > 1) confidence = 1
  }

  // reason
  const reasonRaw = pick('reason')
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : ''

  // 数组字段
  const arr = (v) => Array.isArray(v)
    ? v.filter((x) => x != null && String(x).trim()).map((x) => String(x).trim())
    : []

  // === 防御性校正:把模型偶尔违反"决策树底线"的输出修回来 ===
  // 用 normalize 阶段做客观校正,prompt 是软约束,这里是硬约束。
  const matchedExclusion = arr(pick('matched_exclusion'))
  const matchedConcepts  = arr(pick('matched_concepts'))

  // 规则:exclude 必须有 matched_exclusion **或** matched_concepts 为空(决策【4】无重叠)
  // 否则降级为 uncertain。
  if (decision === 'exclude'
      && matchedExclusion.length === 0
      && matchedConcepts.length > 0) {
    // 模型说 exclude 但既没排除证据又有概念命中 → 矛盾,改回 uncertain 让人工把关
    decision = 'uncertain'
  }

  return {
    decision,
    confidence,
    reason,
    matched_inclusion: arr(pick('matched_inclusion')),
    matched_exclusion: matchedExclusion,
    matched_concepts:  matchedConcepts,
    need_full_text_check: arr(pick('need_full_text_check')),
  }
}

function emptyScreening() {
  return {
    decision: 'uncertain',
    confidence: null,
    reason: '',
    matched_inclusion: [],
    matched_exclusion: [],
    matched_concepts:  [],
    need_full_text_check: [],
  }
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  // 顶层已经有 decision / reason 之类的直接字段 → 不剥
  const hasDirectField = keys.some((k) =>
    /^(decision|reason|rationale|matched_inclusion|matched_exclusion|confidence)$/i.test(k)
  )
  if (hasDirectField) return raw
  for (const k of keys) {
    if (/^(result|data|output|response|screening|verdict)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    }
  }
  return raw
}

// 导出常量给路由层用
export const SCREENING_DECISIONS = VALID_DECISIONS
