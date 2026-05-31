/**
 * GRADE Outcome-level prompt — 给定 1 个 theme + 它的 evidence + 完整 matrix + RoB,
 * 让 LLM 提议 1-3 个 outcome,每个 outcome 用 GRADE 5 域 + 3 上调因素评级。
 *
 * 跨学科通用:适用医学 / 教育 / 工程 / HCI / 社会科学。
 * 强制英文输出(对齐 Step 4 matrix + Step 6 synthesis + Step 7 主题级)。
 */

import { cleanBilingualTitle } from '../citation-format.js'

// SYSTEM_VERSION:本 prompt 任何变更 → bump,触发现有 outcome assessment overlay stale
export const GRADE_SYSTEM_VERSION = '2026-05-24-v2'   // v2:全英文 + 跨学科声明 + 强化 SoF 表标准

export const GRADE_SYSTEM = `# Role
You are a systematic review methodologist applying the GRADE (Grading of Recommendations Assessment, Development and Evaluation) framework to specific OUTCOMES within one synthesis theme, following Cochrane Handbook Ch. 14.

# Task
Given one theme and its supporting evidence (papers with full matrix + RoB + screening data), PROPOSE 1-3 critical outcomes and grade each one with GRADE 5 downgrade domains + 3 upgrade factors. The output feeds a Cochrane "Summary of Findings" (SoF) table — one row per outcome.

# Cross-discipline applicability
This framework applies to all SLR disciplines. Interpret "outcome" broadly:
  - Medical: clinical endpoint (mortality, recovery time, HbA1c reduction)
  - Education: learning measure (test score, retention rate, engagement index)
  - Engineering / HCI: system metric (task completion time, error rate, satisfaction)
  - Social sciences: behavioral measure, attitude change, policy adoption
Do NOT use external clinical / domain knowledge — reason from the provided evidence only.

# How to pick outcomes
Pick 1-3 outcomes that are:
  1. **Critical** to the review's research question (importance = critical)
  2. **Measured comparably** across ≥2 supporting papers (so effect comparison is possible)
  3. **Have a clear effect estimate** OR a clear narrative direction
If the theme is heavily qualitative with no quantitative outcomes, output a single outcome with effect_size_text="narrative: qualitative theme, no quantitative outcome measured" and explain in summary_of_findings.

# Output schema (STRICT JSON ARRAY)
[
  {
    "outcome_label": "<short English noun phrase; e.g. 'Post-test knowledge retention', 'Task completion time', 'Engagement self-report (Likert 1-7)'>",
    "outcome_description": "<≤25 words English; what is measured and how>",
    "importance": "critical" | "important" | "low",
    "starting_certainty": "high" | "low",
    "risk_of_bias":     "not_serious" | "serious" | "very_serious",
    "inconsistency":    "not_serious" | "serious" | "very_serious",
    "indirectness":     "not_serious" | "serious" | "very_serious",
    "imprecision":      "not_serious" | "serious" | "very_serious",
    "publication_bias": "undetected" | "suspected" | "strongly_suspected",
    "rationales": {
      "risk_of_bias":     "<≤60 words English; cite which papers / which RoB tool / which limitation>",
      "inconsistency":    "<≤60 words English; cite specific quantitative_results that disagree>",
      "indirectness":     "<≤60 words English; cite PICO mismatch with protocol>",
      "imprecision":      "<≤60 words English; cite N + CI width>",
      "publication_bias": "<≤60 words English; cite search coverage / grey literature / funding>"
    },
    "large_effect":          "none" | "large" | "very_large",
    "dose_response":         0 | 1,
    "plausible_confounding": "none" | "would_reduce" | "would_increase",
    "summary_of_findings":   "<≤40 words English; 'In <N> studies (<N total participants>), <intervention> <verb> <outcome> by <effect> compared with <comparator>'>",
    "effect_size_text":      "<English; e.g. 'SMD 0.45 (95% CI 0.10-0.80)' or 'RR 1.35 (95% CI 1.10-1.65)' or 'narrative: directionally positive across 4 studies, magnitude not pooled'>",
    "num_studies":           <int or null>,
    "num_participants":      <int or null>
  }
]

# Starting certainty rule
- RCT-dominant (≥60% of supporting papers are RCT / randomized) → \`high\`
- Observational / quasi-experimental / qualitative dominant → \`low\`
- Mixed methods themes → \`low\` (most conservative)

# Per-domain reasoning principles
- risk_of_bias: study-level limitations using the actual RoB ratings provided (MMAT / RoB2 / ROBINS-I / NOS / JBI). NEVER drop high-RoB papers from the outcome's evidence pool — downgrade the body of evidence instead.
- inconsistency: heterogeneity in effect direction / magnitude across supporting papers. Cite specific quantitative_results that disagree if available.
- indirectness: PICO mismatch — population / intervention / comparator / outcome / setting differ from the review's question. Compare against the project's protocol shown in user prompt.
- imprecision: small N, wide CIs, few events, narrative-only with directionally weak signal.
- publication_bias: based on search source coverage, grey literature inclusion, language, funding patterns. Mark \`undetected\` if no specific signal; \`suspected\` only with concrete evidence.

# Upgrade factors (only matter if starting tier was \`low\`)
- large_effect: \`large\` if effect is unusually big (e.g., RR > 2 or SMD > 0.8 consistently); \`very_large\` if RR > 5; else \`none\`
- dose_response: 1 if monotonic gradient observed across exposure levels
- plausible_confounding: would residual confounding reduce or increase the observed effect?

# Hard constraints
- **OUTPUT FORMAT**: ENTIRE response is a single raw JSON ARRAY (\`[ ... ]\`). No prose, no markdown fence. First char \`[\`, last char \`]\`.
- **LANGUAGE (HARD CONSTRAINT)**: ALL text fields in **academic English**, regardless of protocol or source-paper language. Translate non-English terms. Keep instrument names (NASA-TLX, MAI, MSLQ, etc.) in canonical English. Source-paper titles stay in original form when cited.
- Rationales must reference the actual evidence (paper IDs / RoB ratings / matrix fields). Do NOT invoke external clinical knowledge.
- Insufficient evidence for a domain → \`not_serious\` + rationale "insufficient data to assess".
- Output at most 3 outcomes (pick the most critical).
- If a theme has no quantitative outcomes at all → output exactly 1 narrative outcome (effect_size_text="narrative: ..."), don't fabricate.
- Avoid buzzword padding: "AI improves learning" is not an outcome — "Post-test knowledge retention" is.
`

/**
 * @param {object} args
 *  - theme: 主题对象
 *  - evidencePoints: 该主题的 evidence_points
 *  - recordSummaries: 关联 records 摘要(title / study_type / sample_size)— 老路径
 *  - paperProfiles (M30+): Map<record_id, paper> 完整 paper data;若提供 + formatPaperProfile,
 *      则用它取代 recordSummaries 输出完整 matrix + RoB + screening 画像(每篇 ~2-3KB)
 *  - formatPaperProfile (M30+): function(paper, idx) -> string,从 synthesis-helpers 传入
 *  - robByRid: Map<record_id, {tool, overall_rating, overall_rationale}> — 给 GRADE 真实 RoB
 *  - suggestedRobDowngrade: {level, rationale} 本地预算
 */
export function buildGradeUserPrompt({ theme, evidencePoints, recordSummaries, paperProfiles = null, formatPaperProfile = null, robByRid = null, suggestedRobDowngrade = null, overlay = '', protocol = null }) {
  const lines = []
  lines.push('# GRADE outcome-level assessment input (one theme)')
  lines.push('')
  lines.push('**OUTPUT LANGUAGE (HARD CONSTRAINT)**: ALL output text fields in academic English. Translate any non-English terms. This matches Step 4 matrix + Step 6 synthesis + Step 7 theme-level English policy.')
  lines.push('')

  // 协议(给 LLM 判 indirectness 用)
  if (protocol) {
    lines.push('## Approved protocol context')
    lines.push(`- Version v${protocol.version}; type=${protocol.review_type || '?'}`)
    if (protocol.research_questions?.length) {
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 400)}`)
      })
    }
    if (Array.isArray(protocol.inclusion_criteria) && protocol.inclusion_criteria.length) {
      lines.push(`- Inclusion: ${protocol.inclusion_criteria.slice(0, 4).map((c) => String(typeof c === 'string' ? c : c?.text || '').slice(0, 150)).join(' | ')}`)
    }
    lines.push('')
  }

  // Theme 信息
  lines.push('## Theme')
  lines.push(`- name: ${theme.name}`)
  if (theme.description) lines.push(`- description: ${theme.description}`)
  if (theme.evidence_strength) lines.push(`- Step 6 coarse rating: ${theme.evidence_strength}`)
  if (theme.rob_profile) {
    try {
      const rp = typeof theme.rob_profile === 'string' ? JSON.parse(theme.rob_profile) : theme.rob_profile
      lines.push(`- theme rob_profile: good=${rp.good || 0} middle=${rp.middle || 0} bad=${rp.bad || 0} unrated=${rp.unrated || 0}`)
    } catch {}
  }
  if (theme.study_design_mix) {
    try {
      const sd = typeof theme.study_design_mix === 'string' ? JSON.parse(theme.study_design_mix) : theme.study_design_mix
      lines.push(`- study_design_mix: ${JSON.stringify(sd)}`)
    } catch {}
  }
  if (theme.methodological_note) lines.push(`- methodological_note (Step 6): ${theme.methodological_note}`)
  if (suggestedRobDowngrade) {
    lines.push('')
    lines.push(`**Local RoB downgrade suggestion** (computed from Step 5 RoB profile; you may confirm or adjust per outcome):`)
    lines.push(`  → ${suggestedRobDowngrade.level}  (${suggestedRobDowngrade.rationale})`)
    lines.push(`  Note: an individual outcome may warrant different RoB judgment if it is supported mostly by low-RoB papers vs the theme average.`)
  }
  lines.push('')

  if (Array.isArray(theme.consistent_findings) && theme.consistent_findings.length) {
    lines.push('## Consistent findings (Step 6 narrative)')
    theme.consistent_findings.forEach((f, i) => {
      const txt = typeof f === 'string' ? f : (f?.finding || JSON.stringify(f).slice(0, 300))
      lines.push(`  ${i + 1}. ${String(txt).slice(0, 400)}`)
    })
    lines.push('')
  }
  if (Array.isArray(theme.conflicting_findings) && theme.conflicting_findings.length) {
    lines.push('## Conflicting findings')
    theme.conflicting_findings.forEach((f, i) => {
      const txt = typeof f === 'string' ? f : JSON.stringify(f).slice(0, 400)
      lines.push(`  ${i + 1}. ${String(txt).slice(0, 500)}`)
    })
    lines.push('')
  }
  if (Array.isArray(theme.evidence_gaps) && theme.evidence_gaps.length) {
    lines.push('## Evidence gaps')
    theme.evidence_gaps.forEach((f, i) => lines.push(`  ${i + 1}. ${String(f).slice(0, 300)}`))
    lines.push('')
  }

  if (Array.isArray(evidencePoints) && evidencePoints.length) {
    lines.push(`## Evidence points (${evidencePoints.length} atomic findings, no truncation)`)
    evidencePoints.forEach((ep) => {
      lines.push(`  - [${ep.record_id}] (${ep.evidence_type || '—'}, ${ep.strength || '—'}): ${String(ep.finding || '').slice(0, 500)}`)
    })
    lines.push('')
  }

  // M30+ 优先用 paperProfiles + formatPaperProfile 输出完整 matrix + RoB + screening 画像
  //   只有当 paperProfiles 没传时才退回老 recordSummaries(title + study_type + sample_size)
  if (paperProfiles && typeof formatPaperProfile === 'function') {
    const profilesArr = Array.isArray(paperProfiles) ? paperProfiles : Array.from(paperProfiles.values())
    if (profilesArr.length) {
      lines.push(`## Supporting papers (${profilesArr.length}, full matrix + RoB rationale + per-domain ratings + screening tags)`)
      lines.push('')
      profilesArr.forEach((p, idx) => {
        if (!p) return
        lines.push(formatPaperProfile({ record: p.record, matrixData: p.matrixData, robData: p.robData, screeningData: p.screeningData, idx }))
        lines.push('')
      })
      lines.push(`**Critical reasoning anchors**:`)
      lines.push(`- risk_of_bias: use the actual per-paper RoB ratings + rationales above, not generic guess`)
      lines.push(`- inconsistency / indirectness / imprecision: cite specific matrix fields (quantitative_results / measurement_tools / intervention / outcomes / sample_size / limitations) of named paper IDs`)
      lines.push(`- DO NOT exclude high-RoB papers from the outcome's evidence pool — downgrade the body of evidence via risk_of_bias domain instead`)
      lines.push('')
    }
  } else if (Array.isArray(recordSummaries) && recordSummaries.length) {
    // 老路径:简洁 summary(向后兼容)
    lines.push(`## Supporting papers (${recordSummaries.length}, abridged — no full matrix)`)
    recordSummaries.forEach((r) => {
      const rob = robByRid && robByRid.get ? robByRid.get(r.id) : null
      const robTxt = rob ? `RoB[${rob.tool}]=${rob.overall_rating}` : 'RoB=unrated'
      lines.push(`  - [${r.id}] ${cleanBilingualTitle(r.title).title || '(no title)'} | ${r.study_type || 'design ?'} | n=${r.sample_size || '?'} | ${robTxt}`)
    })
    lines.push('')
  }

  // 项目专用 overlay(沿用 certainty 主题级 overlay,因 outcome 级评估也吃同一项目特定知识)
  if (overlay && String(overlay).trim()) {
    lines.push('---')
    lines.push('')
    lines.push('## Project-specific certainty grading overlay')
    lines.push('(generated by Opus from this project\'s protocol + sample themes; treat as auxiliary indirectness / RoB / outcome-naming anchors specific to THIS project — do not override generic GRADE methodology)')
    lines.push('')
    lines.push(String(overlay))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('Output the JSON array per system schema. Remember: STRICT JSON array starting with `[`, ending with `]`, no markdown fence, no prose. ALL English text fields.')
  return lines.join('\n')
}

// ============================================================
// normalizeGradeOutput — 语言抽检 + enum 规范化(M31+ 加英文 warning)
// ============================================================
export function normalizeOutcomesLangAudit(outcomes) {
  // 非 ASCII 比例 > 10% → 标 warning
  let total = 0, nonAscii = 0
  for (const o of outcomes || []) {
    const collect = (s) => { if (typeof s !== 'string') return; for (const ch of s) { total++; if (ch.charCodeAt(0) > 127) nonAscii++ } }
    collect(o.outcome_label); collect(o.outcome_description); collect(o.summary_of_findings); collect(o.effect_size_text)
    if (o.rationales) for (const v of Object.values(o.rationales)) collect(v)
  }
  if (total > 0 && (nonAscii / total) > 0.10) {
    return `Non-English ratio ${((nonAscii/total)*100).toFixed(1)}% > 10% — LLM did not respect English-only constraint`
  }
  return null
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
