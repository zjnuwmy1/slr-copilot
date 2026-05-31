/**
 * Step 7 certainty helpers (M30)
 * ------------------------------------------------------------
 * 把 Step 1-6 的定稿数据聚合成 LLM-ready 输入,供主题级 GRADE / CERQual rollup 评估用。
 * 也提供本地 framework 分流 + theme_certainty 表的读写小工具。
 *
 * 设计原则:
 *   - 纯函数,不调 LLM
 *   - 复用 services/synthesis-helpers.js 的 protocol/papers/matrix/RoB 聚合
 *   - 通用骨架 — classifyThemeForGrading 只看 design family,跨学科适用
 */

import { buildSynthesisInputs, loadApprovedProtocolFull } from './synthesis-helpers.js'

// ============================================================
// classifyThemeForGrading — 主题分流 GRADE / CERQual / Hybrid
// ============================================================
//
// 输入:theme.study_design_mix(由 Step 6 LLM 跨学科填出来的 JSON,例:
//        {RCT: 2, quasi: 5, qual: 8, mixed: 3, descriptive: 1})
// 输出:'grade' | 'cerqual' | 'hybrid'
//
// 规则(通用,不绑领域):
//   - 量化主导(RCT/quasi/cohort/cross-sectional/case-control/observational 占 ≥ 60%) → 'grade'
//   - 质性主导(qual/phenomenology/ethnography/case-study/grounded-theory/narrative   ≥ 60%) → 'cerqual'
//   - 都不主导(各家 30-60%)→ 'hybrid'(两套并出,UI 折叠展示)
//   - 空 / 无法判断 → 'hybrid' (兜底:让 LLM 两套都跑,后续用户可手动收窄)

const QUANT_FAMILIES = new Set([
  'rct', 'randomized', 'randomised', 'randomized_controlled_trial',
  'quasi', 'quasi_experimental', 'quasi-experimental',
  'cohort', 'prospective_cohort', 'retrospective_cohort',
  'cross_sectional', 'cross-sectional', 'cross sectional',
  'case_control', 'case-control',
  'observational', 'survey', 'descriptive',
  'experiment', 'experimental', 'pre_post', 'pre-post',
  'comparative', 'benchmark', 'simulation',
])

const QUAL_FAMILIES = new Set([
  'qual', 'qualitative', 'qualitative_study',
  'phenomenology', 'phenomenological',
  'ethnography', 'ethnographic',
  'case_study', 'case-study', 'case study',
  'grounded_theory', 'grounded-theory',
  'narrative', 'narrative_inquiry', 'narrative_review',
  'interview', 'focus_group', 'document_analysis',
  'content_analysis', 'thematic_analysis',
  'design_based_research', 'dbr',
  'action_research',
])

function normalizeDesignKey(k) {
  return String(k || '').trim().toLowerCase().replace(/\s+/g, '_')
}

export function classifyThemeForGrading(theme) {
  let mix = theme?.study_design_mix
  if (mix && typeof mix === 'string') {
    try { mix = JSON.parse(mix) } catch { mix = null }
  }
  if (!mix || typeof mix !== 'object') return 'hybrid'

  let total = 0, quant = 0, qual = 0
  for (const [k, v] of Object.entries(mix)) {
    const n = Number(v) || 0
    if (n <= 0) continue
    total += n
    const key = normalizeDesignKey(k)
    if (QUANT_FAMILIES.has(key)) quant += n
    else if (QUAL_FAMILIES.has(key)) qual += n
    // mixed / unknown 不计入任何一侧,推向 hybrid
  }
  if (total === 0) return 'hybrid'

  const quantRatio = quant / total
  const qualRatio = qual / total

  if (quantRatio >= 0.6) return 'grade'
  if (qualRatio >= 0.6) return 'cerqual'
  return 'hybrid'
}

// ============================================================
// loadAllThemesWithMeta — 读项目所有主题(含 Step 6 v2 字段)
// ============================================================

function tryParseArr(v) {
  if (!v) return []
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(x) ? x : []
  } catch { return [] }
}
function tryParseObj(v) {
  if (!v) return null
  try {
    return typeof v === 'string' ? JSON.parse(v) : v
  } catch { return null }
}

export function loadAllThemesWithMeta(db, projectId) {
  const rows = db.prepare(
    `SELECT id, name, description, supporting_record_ids,
            consistent_findings, conflicting_findings, evidence_gaps,
            evidence_strength, display_order,
            maps_to_research_questions, maps_to_pico_concepts,
            study_design_mix, rob_profile, methodological_note,
            iteration_n,
            outcome_run_started_at, outcome_run_finished_at,
            outcome_run_status, outcome_run_error, outcome_run_meta
       FROM themes
      WHERE project_id = ?
      ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
  ).all(projectId)
  return rows.map((t) => {
    const out = {
      ...t,
      supporting_record_ids: tryParseArr(t.supporting_record_ids),
      consistent_findings: tryParseArr(t.consistent_findings),
      conflicting_findings: tryParseArr(t.conflicting_findings),
      evidence_gaps: tryParseArr(t.evidence_gaps),
      maps_to_research_questions: tryParseArr(t.maps_to_research_questions),
      maps_to_pico_concepts: tryParseArr(t.maps_to_pico_concepts),
      study_design_mix: tryParseObj(t.study_design_mix) || {},
      rob_profile: tryParseObj(t.rob_profile) || {},
    }
    out.grading_framework = classifyThemeForGrading(out)
    // M31 outcome run state
    out.outcome_run_meta_parsed = tryParseObj(t.outcome_run_meta) || null
    out.outcome_run_in_flight = !!(
      t.outcome_run_status === 'running' &&
      t.outcome_run_started_at &&
      (Date.now() - new Date(t.outcome_run_started_at + ' UTC').getTime() < 20 * 60 * 1000)
    )
    return out
  })
}

// ============================================================
// loadSynthesisMeta — 读 Step 6 synthesis_meta(cross_cutting + coverage)
// ============================================================

export function loadSynthesisMetaForCertainty(db, projectId) {
  try {
    const row = db.prepare(
      `SELECT cross_cutting_observations, protocol_coverage, generated_at, model_used
         FROM synthesis_meta WHERE project_id = ? LIMIT 1`
    ).get(projectId)
    if (!row) return null
    return {
      cross_cutting_observations: tryParseArr(row.cross_cutting_observations),
      protocol_coverage: tryParseObj(row.protocol_coverage) || {},
      generated_at: row.generated_at,
      model_used: row.model_used,
    }
  } catch {
    return null
  }
}

// ============================================================
// loadEvidencePointsByTheme — 全量(无截断)
// ============================================================

export function loadEvidencePointsByTheme(db, projectId) {
  try {
    const rows = db.prepare(
      `SELECT id, record_id, theme_id, finding, evidence_type, strength
         FROM evidence_points WHERE project_id = ?`
    ).all(projectId)
    const by = new Map()
    for (const r of rows) {
      if (!by.has(r.theme_id)) by.set(r.theme_id, [])
      by.get(r.theme_id).push(r)
    }
    return by
  } catch {
    return new Map()
  }
}

// ============================================================
// buildCertaintyInputs — 一次性聚合所有 Step 7 LLM 需要的数据
// ============================================================
//
// 返回 dict:
//   {
//     protocol:        approved protocol(loadApprovedProtocolFull)
//     themes:          所有主题(含 grading_framework + 全部 Step 6 v2 字段)
//     papersByRid:     Map<record_id, { record, matrixData, robData, screeningData }>
//                      (复用 buildSynthesisInputs)
//     evidenceByTheme: Map<theme_id, [{record_id, finding, evidence_type, strength}, ...]>
//     synthesisMeta:   { cross_cutting_observations, protocol_coverage }
//     stats:           { themes_n, papers_n, evidence_n, with_matrix, with_rob,
//                        framework_split: { grade, cerqual, hybrid } }
//   }
//
// 上游 includedRecords 由调用方传入(用刚改完的 listIncludedRecordsForRob,
// 或 routes/projects/synthesis.js 用的同一 include query)。

export function buildCertaintyInputs(db, projectId, includedRecords, opts = {}) {
  // 复用 Step 6 的 protocol + matrix + RoB 聚合(只取 papers/stats)
  //   opts.includePdfChunks=true(高级用户开启时)→ 加载 paper_chunks 给 formatPaperProfile fallback 用
  const synth = buildSynthesisInputs(db, projectId, includedRecords, { includePdfChunks: !!opts.includePdfChunks })
  const protocol = synth.protocol || loadApprovedProtocolFull(db, projectId)

  // 主题(含 Step 6 v2 全字段 + grading_framework label)
  const themes = loadAllThemesWithMeta(db, projectId)
  const synthesisMeta = loadSynthesisMetaForCertainty(db, projectId)
  const evidenceByTheme = loadEvidencePointsByTheme(db, projectId)

  // papersByRid 索引(给 prompt builder 按 supporting_record_ids 快速查)
  const papersByRid = new Map()
  for (const p of synth.papers || []) {
    if (p?.record?.id) papersByRid.set(p.record.id, p)
  }

  const frameworkSplit = { grade: 0, cerqual: 0, hybrid: 0 }
  for (const t of themes) frameworkSplit[t.grading_framework] = (frameworkSplit[t.grading_framework] || 0) + 1

  let evidenceTotal = 0
  for (const arr of evidenceByTheme.values()) evidenceTotal += arr.length

  return {
    protocol,
    themes,
    papersByRid,
    evidenceByTheme,
    synthesisMeta,
    stats: {
      themes_n: themes.length,
      papers_n: synth.stats?.total || 0,
      with_matrix: synth.stats?.withMatrix || 0,
      with_rob: synth.stats?.withRob || 0,
      with_screening: synth.stats?.withScreening || 0,
      evidence_n: evidenceTotal,
      framework_split: frameworkSplit,
    },
  }
}

// ============================================================
// tokenizeBudgetForCertainty — 估算 LLM input 大小
// ============================================================
//
// 主题级 rollup 比 synthesis 输入小很多:
//   每主题约 8K char(name + desc + findings + papers profile slice + rob_profile)
//   × 7 主题 ≈ 56K char ≈ 14K tokens(远小于 synthesis 的 ~90K)
// 这里给个保守 token 估算 + safety gate(> 700K tokens 不让跑,后续 Phase 2 才分批)

export function tokenizeBudgetForCertainty(inputs) {
  if (!inputs?.themes) return { inputTokensEst: 0, fitsSingleCall: true }
  let chars = 0
  // 协议
  if (inputs.protocol) {
    chars += JSON.stringify(inputs.protocol).length
  }
  // synthesis_meta
  if (inputs.synthesisMeta) {
    chars += JSON.stringify(inputs.synthesisMeta).length
  }
  // 每主题 + 该主题论文 profile + evidence points
  for (const t of inputs.themes) {
    chars += JSON.stringify({
      name: t.name, description: t.description,
      study_design_mix: t.study_design_mix, rob_profile: t.rob_profile,
      methodological_note: t.methodological_note,
      consistent_findings: t.consistent_findings,
      conflicting_findings: t.conflicting_findings,
      evidence_gaps: t.evidence_gaps,
    }).length
    // 该主题支持论文(从 papersByRid 拉)
    for (const rid of t.supporting_record_ids || []) {
      const p = inputs.papersByRid?.get(rid)
      if (!p) continue
      chars += 2000  // 平均每篇 profile ~ 2K char
    }
    // 该主题 evidence points
    const eps = inputs.evidenceByTheme?.get(t.id) || []
    for (const ep of eps) chars += (ep.finding || '').length + 50
  }
  const inputTokensEst = Math.round(chars / 4)
  return {
    inputTokensEst,
    chars,
    fitsSingleCall: inputTokensEst < 700_000,
  }
}

// ============================================================
// theme_certainty 表读写 helpers
// ============================================================

export function loadAllThemeCertainty(db, projectId) {
  try {
    const rows = db.prepare(
      `SELECT * FROM theme_certainty WHERE project_id = ? ORDER BY iteration_n DESC, updated_at DESC`
    ).all(projectId)
    return rows.map((r) => ({
      ...r,
      grade_rationales: tryParseObj(r.grade_rationales) || {},
      cerqual_rationales: tryParseObj(r.cerqual_rationales) || {},
    }))
  } catch {
    return []
  }
}

// 给定 themes 列表 + theme_certainty rows,返回 themeId → latest certainty Map
export function indexLatestCertaintyByTheme(rows) {
  const by = new Map()
  for (const r of rows) {
    const cur = by.get(r.theme_id)
    if (!cur || r.iteration_n > cur.iteration_n) by.set(r.theme_id, r)
  }
  return by
}

// ============================================================
// Overlay load helpers
// ============================================================

export function loadCertaintyOverlay(project) {
  if (!project?.certainty_master_prompt_overlay) return null
  try {
    return JSON.parse(project.certainty_master_prompt_overlay)
  } catch {
    return null
  }
}
