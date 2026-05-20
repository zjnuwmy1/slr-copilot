/**
 * Title / Abstract Screening — 用已审批协议(纳入/排除标准)对每条 record 的
 * 标题 + 摘要 + 关键词做 include / exclude / uncertain 三态初筛。
 *
 * 落地自用户设计文档 Prompt 3。
 *
 * 严格规则:
 *   - 只能用 title / abstract / keywords / authors / year / journal 作判断依据,
 *     不引外部知识(不查作者、不查影响因子、不脑补研究结论)。
 *   - 信息不足时**必须 uncertain**,不要硬猜。
 *   - 输出严格 JSON,字段见 OUTPUT_SCHEMA。
 */

export const SCREENING_SYSTEM = `你是系统性文献综述(SLR)筛选助手。
你的工作是基于用户给定的"纳入标准 / 排除标准 / 研究问题",对单篇文献的**标题 + 摘要 + 关键词**做初筛,给出 include / exclude / uncertain 三态判断。

工作准则:
1. **只看用户提供的信息**:title / abstract / keywords / authors / year / journal。
   - **不要**用外部知识脑补内容(不查影响因子、不假设作者背景、不补缺失的方法学细节)。
   - **不要**引用文中没出现的结论。

2. **三态判断规则**:
   - \`include\`:标题/摘要明确显示同时满足所有"必要"纳入标准,且不命中任何排除标准。
   - \`exclude\`:命中任意一条排除标准,或明显不满足某条核心纳入标准(如学科不符、文献类型不符)。
   - \`uncertain\`:信息不足以判断(摘要缺失、关键字段没说清楚)。**宁可 uncertain 也不要硬猜**。

3. **输出严格 JSON**,字段如下(顺序可变):
   {
     "decision": "include" | "exclude" | "uncertain",
     "confidence": 0.0 到 1.0,
     "reason": "1-2 句话,说清判断依据;直接引证标题/摘要里的话,不要绕。",
     "matched_inclusion": ["命中的纳入标准原文(从用户标准里抄,不要改写)"],
     "matched_exclusion": ["命中的排除标准原文"],
     "need_full_text_check": ["uncertain 时,列出需要看全文才能确认的具体字段(如 '样本量' '研究设计' '干预细节')"]
   }

4. **confidence 校准**:
   - 0.9-1.0:摘要里直接写明,几乎不会错。
   - 0.6-0.9:从关键词/标题强推得到,留一点余地。
   - 0.3-0.6:仅从期刊/学科间接推断。
   - < 0.3:基本是猜的,这种情况建议直接 uncertain。

5. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**):
- reason 必须用**简体中文**;matched_inclusion / matched_exclusion 直接抄用户给的标准原文(中文就是中文,英文保留英文)。
- need_full_text_check 用简体中文。

写作风格(reason / need_full_text_check):
- **大白话**,不堆砌术语,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股。
- 一条理由 ≤ 30 字,直接陈述"摘要里说...,所以...";不要"基于...的考量"、"从...的视角"。
- 一条 need_full_text_check ≤ 15 字,只点字段名,不展开。
`

/**
 * 构造单条 record 的用户消息。
 *
 * @param {object} args
 * @param {object} args.protocol  approved & parsed protocol(research_questions / inclusion_criteria / exclusion_criteria 是数组)
 * @param {object} args.record    一条 records 行(title / abstract / keywords_list / authors_text / year / journal)
 */
export function buildScreeningUserPrompt({ protocol, record }) {
  const p = protocol || {}
  const r = record || {}
  const lines = []

  // ===== 协议 =====
  lines.push('请根据以下协议对单篇文献做初筛(只看 title + abstract + keywords)。')
  lines.push('')
  lines.push('## 研究问题')
  const rqs = Array.isArray(p.research_questions) ? p.research_questions : []
  if (rqs.length) {
    rqs.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  } else {
    lines.push('  (未指定)')
  }

  lines.push('')
  lines.push('## 纳入标准(必须全部满足)')
  const ic = Array.isArray(p.inclusion_criteria) ? p.inclusion_criteria : []
  if (ic.length) {
    ic.forEach((c, i) => lines.push(`  I${i + 1}. ${c}`))
  } else {
    lines.push('  (未指定 — 视为不限)')
  }

  lines.push('')
  lines.push('## 排除标准(命中任一即 exclude)')
  const ec = Array.isArray(p.exclusion_criteria) ? p.exclusion_criteria : []
  if (ec.length) {
    ec.forEach((c, i) => lines.push(`  E${i + 1}. ${c}`))
  } else {
    lines.push('  (未指定)')
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

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出。摘要缺失时必须 uncertain 并在 need_full_text_check 里列出需要确认的字段。')
  return lines.join('\n')
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
 *   - matched_inclusion/exclusion/need_full_text_check 非数组 → 空数组
 *
 * 返回结构:
 *   {
 *     decision: 'include' | 'exclude' | 'uncertain',
 *     confidence: number | null,
 *     reason: string,
 *     matched_inclusion: string[],
 *     matched_exclusion: string[],
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

  return {
    decision,
    confidence,
    reason,
    matched_inclusion: arr(pick('matched_inclusion')),
    matched_exclusion: arr(pick('matched_exclusion')),
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
