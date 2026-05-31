/**
 * GRADE 评估算法 + 选项常量。
 *
 * GRADE(Grading of Recommendations Assessment, Development and Evaluation)
 * 是 SLR 里评估"证据可信度"的国际标准框架。
 *
 * 起始等级 → 5 维度可下调 → 3 因素可上调 → 最终 4 档:high / moderate / low / very_low
 *
 * 算法(GRADE Handbook §5):
 *   levels = high(4) > moderate(3) > low(2) > very_low(1)
 *   降级:每个 domain 'serious' → -1,'very_serious' → -2;publication_bias 同理
 *   升级(仅观察性、起始 = low):large_effect large → +1, very_large → +2;
 *                                dose_response → +1;
 *                                plausible_confounding would_reduce → +1
 *   结果 clamp 到 1..4
 */

// ───── 常量 ─────

export const CERTAINTY_LEVELS = ['very_low', 'low', 'moderate', 'high']  // 升序
const LEVEL_VALUE = { very_low: 1, low: 2, moderate: 3, high: 4 }
const VALUE_LEVEL = { 1: 'very_low', 2: 'low', 3: 'moderate', 4: 'high' }

export const DOWNGRADE_ENUM = ['not_serious', 'serious', 'very_serious']
export const PUB_BIAS_ENUM  = ['undetected', 'suspected', 'strongly_suspected']
export const UPGRADE_LARGE_EFFECT_ENUM = ['none', 'large', 'very_large']
export const UPGRADE_PLAUSIBLE_CONF_ENUM = ['none', 'would_reduce', 'would_increase']
export const IMPORTANCE_ENUM = ['critical', 'important', 'low']

const DOWNGRADE_LABELS = {
  not_serious: '不严重',
  serious: '严重 (−1)',
  very_serious: '非常严重 (−2)',
}
const PUB_BIAS_LABELS = {
  undetected: '未发现',
  suspected: '疑似 (−1)',
  strongly_suspected: '高度怀疑 (−2)',
}
const LARGE_EFFECT_LABELS = {
  none: '无',
  large: '大 (+1)',
  very_large: '非常大 (+2)',
}
const PLAUSIBLE_CONF_LABELS = {
  none: '无',
  would_reduce: '会让效应缩小 (+1)',
  would_increase: '会让效应放大 (无影响)',
}
const CERTAINTY_LABELS = {
  high: '高 ⊕⊕⊕⊕',
  moderate: '中 ⊕⊕⊕○',
  low: '低 ⊕⊕○○',
  very_low: '极低 ⊕○○○',
}

export const GRADE_LABELS = {
  downgrade: DOWNGRADE_LABELS,
  publication_bias: PUB_BIAS_LABELS,
  large_effect: LARGE_EFFECT_LABELS,
  plausible_confounding: PLAUSIBLE_CONF_LABELS,
  certainty: CERTAINTY_LABELS,
}

export const DOMAIN_META = [
  {
    key: 'risk_of_bias',
    label: '研究内偏倚 (Risk of Bias)',
    desc: '所纳入研究的内部偏倚 — 随机化 / 盲法 / 结局测量 / 选择性报告等。',
  },
  {
    key: 'inconsistency',
    label: '不一致性 (Inconsistency)',
    desc: '各研究结果是否高度异质 — 效应方向是否一致,I² 是否过大。',
  },
  {
    key: 'indirectness',
    label: '间接性 (Indirectness)',
    desc: '证据是否直接回答你的研究问题 — 人群 / 干预 / 比较 / 结局是否与目标一致。',
  },
  {
    key: 'imprecision',
    label: '不精确性 (Imprecision)',
    desc: '置信区间是否过宽、样本量是否不足。',
  },
  {
    key: 'publication_bias',
    label: '发表偏倚 (Publication Bias)',
    desc: '是否可能存在未发表的相反结果(漏斗图不对称 / 行业资助等)。',
  },
]

// ───── 计算函数 ─────

/**
 * 给定一份 grade_assessment 行(不一定有 final_manual_override),计算最终 certainty。
 * 返回 { final, steps: string[] } —— steps 是计算过程,给 UI 展示。
 */
export function computeFinalCertainty(row) {
  const start = row.starting_certainty || 'high'
  let value = LEVEL_VALUE[start] || 4
  const steps = [`起始: ${CERTAINTY_LABELS[start]} (${value})`]

  // 下调 5 个 domain
  const downgrades = [
    ['risk_of_bias', row.risk_of_bias],
    ['inconsistency', row.inconsistency],
    ['indirectness', row.indirectness],
    ['imprecision', row.imprecision],
  ]
  for (const [k, v] of downgrades) {
    if (v === 'serious') {
      value -= 1
      steps.push(`− 1  ${k} = serious`)
    } else if (v === 'very_serious') {
      value -= 2
      steps.push(`− 2  ${k} = very_serious`)
    }
  }
  // publication_bias
  if (row.publication_bias === 'suspected') {
    value -= 1
    steps.push('− 1  publication_bias = suspected')
  } else if (row.publication_bias === 'strongly_suspected') {
    value -= 2
    steps.push('− 2  publication_bias = strongly_suspected')
  }

  // 升级因素(仅起始 = low 的观察性研究才有意义,但工具允许任何时候选 — 让 LLM 处理)
  if (start === 'low' || start === 'very_low') {
    if (row.large_effect === 'large') {
      value += 1
      steps.push('+ 1  large_effect = large')
    } else if (row.large_effect === 'very_large') {
      value += 2
      steps.push('+ 2  large_effect = very_large')
    }
    if (row.dose_response) {
      value += 1
      steps.push('+ 1  dose_response')
    }
    if (row.plausible_confounding === 'would_reduce') {
      value += 1
      steps.push('+ 1  plausible_confounding = would_reduce')
    }
  }

  value = Math.max(1, Math.min(4, value))
  const final = VALUE_LEVEL[value]
  steps.push(`最终: ${CERTAINTY_LABELS[final]} (${value})`)
  return { final, steps }
}

// ───── DB helpers ─────

/**
 * 获取项目的所有 GRADE 评估 + JOIN themes。
 * 返回带 final_certainty(若 manual_override=0 则现算,=1 则用 DB 存的)、 themeName、rationales(对象)
 */
export function listAssessmentsForProject(db, projectId) {
  const rows = db.prepare(`
    SELECT g.*, t.name AS theme_name
    FROM grade_assessments g
    LEFT JOIN themes t ON t.id = g.theme_id
    WHERE g.project_id = ?
    ORDER BY t.display_order ASC, g.display_order ASC, g.created_at ASC
  `).all(projectId)
  return rows.map((r) => {
    const computed = computeFinalCertainty(r)
    const rationales = (() => {
      try { return r.rationales ? JSON.parse(r.rationales) : {} } catch { return {} }
    })()
    return {
      ...r,
      rationales,
      computed_certainty: computed.final,
      computed_steps: computed.steps,
      effective_certainty: r.final_manual_override ? r.final_certainty : computed.final,
    }
  })
}

export function getAssessment(db, { projectId, assessmentId }) {
  const r = db.prepare(`
    SELECT g.*, t.name AS theme_name
    FROM grade_assessments g
    LEFT JOIN themes t ON t.id = g.theme_id
    WHERE g.id = ? AND g.project_id = ?
  `).get(assessmentId, projectId)
  if (!r) return null
  const computed = computeFinalCertainty(r)
  const rationales = (() => {
    try { return r.rationales ? JSON.parse(r.rationales) : {} } catch { return {} }
  })()
  return {
    ...r,
    rationales,
    computed_certainty: computed.final,
    computed_steps: computed.steps,
    effective_certainty: r.final_manual_override ? r.final_certainty : computed.final,
  }
}

/**
 * Summary of Findings 表数据 — 行=outcome,列=GRADE 标准列。
 * 用于 UI 表格 + Markdown 导出。
 */
export function buildSoFRows(db, projectId) {
  return listAssessmentsForProject(db, projectId).map((g) => ({
    outcome:        g.outcome_label,
    theme:          g.theme_name || '—',
    importance:     g.importance,
    num_studies:    g.num_studies,
    num_participants: g.num_participants,
    effect_size:    g.effect_size_text || '—',
    summary:        g.summary_of_findings || '—',
    certainty:      g.effective_certainty,
    certainty_label: CERTAINTY_LABELS[g.effective_certainty] || g.effective_certainty,
    domains: {
      risk_of_bias: g.risk_of_bias,
      inconsistency: g.inconsistency,
      indirectness: g.indirectness,
      imprecision: g.imprecision,
      publication_bias: g.publication_bias,
    },
  }))
}

// 英文 certainty 标签 — 仅用于最终论文导出(export.md)
const CERTAINTY_LABELS_EN = {
  high:     'High ⊕⊕⊕⊕',
  moderate: 'Moderate ⊕⊕⊕○',
  low:      'Low ⊕⊕○○',
  very_low: 'Very Low ⊕○○○',
}

/**
 * Markdown SoF 表 — 用在 report.js 的 export.md。
 * 最终论文必须英文,所以这里所有 label 都用英文。
 */
export function renderSoFMarkdown(db, projectId) {
  const rows = buildSoFRows(db, projectId)
  if (rows.length === 0) return ''
  const lines = []
  lines.push('## Summary of Findings (GRADE)')
  lines.push('')
  lines.push('| Outcome | Studies | Participants | Effect | Certainty | Importance |')
  lines.push('|---|---:|---:|---|---|---|')
  for (const r of rows) {
    const c = CERTAINTY_LABELS_EN[r.certainty] || r.certainty
    lines.push(
      `| ${escapePipe(r.outcome)} | ${r.num_studies ?? '—'} | ${r.num_participants ?? '—'} | ${escapePipe(r.effect_size)} | ${c} | ${r.importance || '—'} |`
    )
  }
  lines.push('')
  // 2026-05-25 改:GRADE downgrade domains 标记走纯学术风
  //   旧 `⚠ −1` / `⚠⚠ −2` 在 publication-grade 论文表里显得 emoji-heavy(审稿人嫌不专业);
  //   新版输出标准 GRADE Handbook §5.2 风格(Cochrane / BMJ 评估表惯用):
  //     not_serious / undetected      → "Not serious"
  //     serious / suspected           → "Serious (−1)"
  //     very_serious / strongly_susp. → "Very serious (−2)"
  //   表头加脚注解释列含义 + 评估方向。
  lines.push('### GRADE Downgrade Domains')
  lines.push('')
  lines.push('*Each domain is rated for risk of bias serious-ness; serious = −1 GRADE level, very serious = −2. Publication bias column: strongly suspected = −2.*')
  lines.push('')
  lines.push('| Outcome | RoB | Inconsistency | Indirectness | Imprecision | Pub. bias |')
  lines.push('|---|---|---|---|---|---|')
  const map = {
    not_serious:        'Not serious',
    serious:            'Serious (−1)',
    very_serious:       'Very serious (−2)',
    undetected:         'Not detected',
    suspected:          'Suspected (−1)',
    strongly_suspected: 'Strongly suspected (−2)',
  }
  for (const r of rows) {
    lines.push(
      `| ${escapePipe(r.outcome)} | ${map[r.domains.risk_of_bias] || '—'} | ${map[r.domains.inconsistency] || '—'} | ${map[r.domains.indirectness] || '—'} | ${map[r.domains.imprecision] || '—'} | ${map[r.domains.publication_bias] || '—'} |`
    )
  }
  lines.push('')
  return lines.join('\n')
}

function escapePipe(s) {
  // 2026-05-25 P2-11:除了 \n → space, \| 也要折叠多连续空白 + trim,
  //   防止 marked.js GFM 在 cell 里出现 "  " 双空格被识别成额外 row
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
