/**
 * GRADE 初评 prompt — 给定一个 theme + 它的 evidence_points + 关联 records 摘要,
 * 让 LLM 提议 1..N 个 outcome,每个 outcome 给 5 维度评级 + 理由 + 最终 certainty。
 */

import { cleanBilingualTitle } from '../citation-format.js'

export const GRADE_SYSTEM = `你是循证医学方法学专家,熟练应用 GRADE(Grading of Recommendations Assessment, Development and Evaluation)框架评估证据可信度。

任务:基于一个综述主题(theme)及其支撑的研究发现,提议 1-3 个**outcome(结局指标)**,并对每个 outcome 用 GRADE 5 维度评级 + 升级因素打分。

工作准则:

1. 输出**严格 JSON**,顶层是数组 outcomes,每条 outcome 包含:
   {
     "outcome_label": "<结局指标的中文名,如 学习成绩 / 学生参与度 / 知识保留率>",
     "outcome_description": "<这个 outcome 的简短解释,≤40 字>",
     "importance": "critical | important | low",
     "starting_certainty": "high | low",
     "risk_of_bias":     "not_serious | serious | very_serious",
     "inconsistency":    "not_serious | serious | very_serious",
     "indirectness":     "not_serious | serious | very_serious",
     "imprecision":      "not_serious | serious | very_serious",
     "publication_bias": "undetected | suspected | strongly_suspected",
     "rationales": {
       "risk_of_bias":     "<≤50 字理由>",
       "inconsistency":    "<≤50 字理由>",
       "indirectness":     "<≤50 字理由>",
       "imprecision":      "<≤50 字理由>",
       "publication_bias": "<≤50 字理由>"
     },
     "large_effect":          "none | large | very_large",
     "dose_response":         0 | 1,
     "plausible_confounding": "none | would_reduce | would_increase",
     "summary_of_findings":   "<这条 outcome 的 What happens 一句话总结,≤80 字>",
     "effect_size_text":      "<效应量描述,如 'RR 1.35 (95% CI 1.10–1.65)' 或 'narrative: 一致正向'>",
     "num_studies":           <int 或 null>,
     "num_participants":      <int 或 null>
   }

2. **起始等级**:RCT 默认 high;观察性研究默认 low。如果主题里既有 RCT 又有观察性,以多数研究类型为准。

3. **每个维度评级原则**:
   - risk_of_bias:研究内部偏倚 — 随机化 / 盲法 / 缺失数据 / 选择性报告
   - inconsistency:研究间异质性大 / 效应方向不一致
   - indirectness:人群 / 干预 / 比较 / 结局与综述问题不直接对应
   - imprecision:置信区间宽 / 样本量小 / 事件数少
   - publication_bias:发表偏倚怀疑(漏斗图不对称 / 行业资助 / 灰文献少)

4. **rationales 必填,且必须基于提供的研究文本**,**不要引外部知识**。

5. 输出最多 3 个 outcome,挑这个主题里最重要的几个(critical > important > low)。

6. 信息不足做不出可靠评估的 domain,标 'not_serious' + rationale 写 "证据不足以评估"。

7. **只输出 JSON 数组**,不要前后加解释、Markdown、代码围栏。

语言要求:
- 所有中文字段(outcome_label / outcome_description / rationales / summary_of_findings)用**简体中文**。
- 不要"赋能 / 范式 / 解构 / 路径 / 机制"这类八股套话。
- 一条 rationale ≤50 字,大白话。
- 效应方向直接说"正向"/"负向"/"无显著"。
`

export function buildGradeUserPrompt({ theme, evidencePoints, recordSummaries }) {
  const lines = []
  lines.push('请对下面这个主题做 GRADE 评估:')
  lines.push('')
  lines.push(`主题名:${theme.name}`)
  if (theme.description) lines.push(`主题描述:${theme.description}`)
  if (theme.evidence_strength) lines.push(`粗粒度评级(主题级):${theme.evidence_strength}`)
  lines.push('')

  if (Array.isArray(theme.consistent_findings) && theme.consistent_findings.length) {
    lines.push('一致发现:')
    theme.consistent_findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`))
    lines.push('')
  }
  if (Array.isArray(theme.conflicting_findings) && theme.conflicting_findings.length) {
    lines.push('矛盾发现:')
    theme.conflicting_findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`))
    lines.push('')
  }
  if (Array.isArray(theme.evidence_gaps) && theme.evidence_gaps.length) {
    lines.push('证据空白:')
    theme.evidence_gaps.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`))
    lines.push('')
  }

  if (Array.isArray(evidencePoints) && evidencePoints.length) {
    lines.push(`支撑该主题的具体 evidence_point(共 ${evidencePoints.length} 条):`)
    evidencePoints.slice(0, 30).forEach((ep, i) => {
      lines.push(`  [${ep.record_id}] (${ep.evidence_type || '—'}, ${ep.strength || '—'}): ${ep.finding}`)
    })
    if (evidencePoints.length > 30) lines.push(`  ...(剩余 ${evidencePoints.length - 30} 条省略)`)
    lines.push('')
  }

  if (Array.isArray(recordSummaries) && recordSummaries.length) {
    lines.push(`关联研究的设计(共 ${recordSummaries.length} 篇):`)
    recordSummaries.slice(0, 20).forEach((r, i) => {
      lines.push(`  [${r.id}] ${cleanBilingualTitle(r.title).title || '(无题)'} | ${r.study_type || '类型未抽取'} | n=${r.sample_size || '?'}`)
    })
    lines.push('')
  }

  lines.push('请按 system 指示输出 JSON 数组。')
  return lines.join('\n')
}

/**
 * 把 LLM 返回的数组规范化成 DB 行能直接 insert 的形状。
 *
 * 容错:
 *  - 顶层是 { outcomes: [...] } 或 { result: [...] } 也接受
 *  - 字段名同义词:'roB' → risk_of_bias 等
 *  - 不合法 enum 值 → fallback 到 'not_serious' / 'undetected' / 'none'
 */
export function normalizeGradeOutput(raw) {
  if (!raw) return []

  // 剥 wrapper
  let arr = null
  if (Array.isArray(raw)) {
    arr = raw
  } else if (raw && typeof raw === 'object') {
    arr = raw.outcomes || raw.result || raw.data || raw.output || raw.assessments
    if (!arr && Object.keys(raw).length === 1) {
      const v = Object.values(raw)[0]
      if (Array.isArray(v)) arr = v
    }
  }
  if (!Array.isArray(arr)) return []

  const downgrade = (v) => (['not_serious', 'serious', 'very_serious'].includes(v) ? v : 'not_serious')
  const pubBias  = (v) => (['undetected', 'suspected', 'strongly_suspected'].includes(v) ? v : 'undetected')
  const large    = (v) => (['none', 'large', 'very_large'].includes(v) ? v : 'none')
  const plaus    = (v) => (['none', 'would_reduce', 'would_increase'].includes(v) ? v : 'none')
  const start    = (v) => (['high', 'moderate', 'low', 'very_low'].includes(v) ? v : 'high')
  const importance = (v) => (['critical', 'important', 'low'].includes(v) ? v : 'critical')
  const cleanInt = (v) => {
    const n = parseInt(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  return arr
    .filter((o) => o && typeof o === 'object' && (o.outcome_label || o.outcome || o.name))
    .map((o) => ({
      outcome_label:          String(o.outcome_label || o.outcome || o.name || '').trim().slice(0, 200) || '未命名结局',
      outcome_description:    String(o.outcome_description || o.description || '').trim().slice(0, 500) || null,
      importance:             importance(o.importance),
      starting_certainty:     start(o.starting_certainty || o.start),
      risk_of_bias:           downgrade(o.risk_of_bias || o.rob),
      inconsistency:          downgrade(o.inconsistency),
      indirectness:           downgrade(o.indirectness),
      imprecision:            downgrade(o.imprecision),
      publication_bias:       pubBias(o.publication_bias || o.pubBias),
      rationales: {
        risk_of_bias:     String(o.rationales?.risk_of_bias || '').slice(0, 300),
        inconsistency:    String(o.rationales?.inconsistency || '').slice(0, 300),
        indirectness:     String(o.rationales?.indirectness || '').slice(0, 300),
        imprecision:      String(o.rationales?.imprecision || '').slice(0, 300),
        publication_bias: String(o.rationales?.publication_bias || '').slice(0, 300),
      },
      large_effect:          large(o.large_effect),
      dose_response:         o.dose_response ? 1 : 0,
      plausible_confounding: plaus(o.plausible_confounding),
      summary_of_findings:   String(o.summary_of_findings || o.summary || '').slice(0, 500) || null,
      effect_size_text:      String(o.effect_size_text || o.effect_size || '').slice(0, 200) || null,
      num_studies:           cleanInt(o.num_studies),
      num_participants:      cleanInt(o.num_participants),
    }))
}
