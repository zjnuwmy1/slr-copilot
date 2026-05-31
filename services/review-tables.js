// services/review-tables.js
// ────────────────────────────────────────────────────────────────────────
// 数据型表派生服务 — 0 token,纯 SQL + 模板渲染
// ────────────────────────────────────────────────────────────────────────
//
// 4 张标准 SLR 表(Cochrane Handbook + JBI 推荐):
//   Table 1: Characteristics of Included Studies(按主题分子表)
//   Table 2: Summary of Findings (SoF) — outcome 级
//   Table 3a: RoB Traffic Light(逐 study × domain)
//   Table 3b: RoB Domain Summary(跨项目 domain 汇总,GRADEpro 风格)
//   Table 4: Evidence Profile(主题级 GRADE/CERQual)
//
// 全部从 DB 直接派生,不烧 LLM token,毫秒内出表。
// 渲染器:HTML(UI 用)/ Markdown(.md 导出 + LaTeX inline)/ CSV / LaTeX(longtable / tabular)
//
// 表 1 关键决策(2026-05-24,用户拍板):
//   - 不一次性出全 121 行 → 按主题拆子表(Table 1a/1b/1c…),与正文 themes 一一呼应
//   - 通用 8 列(跨学科 Cochrane 推荐最小集),不带项目特异字段(那些字段去文献矩阵主页看)
//   - 主题外的论文归到 "Unassigned" 子表

// ============================================================
// 内部:JSON 解析
// ============================================================

function tryParseObj(v) {
  if (!v) return {}
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v
    return (x && typeof x === 'object' && !Array.isArray(x)) ? x : {}
  } catch { return {} }
}
function tryParseArr(v) {
  if (!v) return []
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(x) ? x : []
  } catch { return [] }
}

// 字符串截断 + 简单清洁
function truncate(s, n = 200) {
  if (s == null) return ''
  const str = String(s).replace(/\s+/g, ' ').trim()
  if (str.length <= n) return str
  return str.slice(0, n).replace(/\s+\S*$/, '') + '…'
}

// authors_text 截短(取第一作者 et al.)
function shortAuthors(authors_text) {
  if (!authors_text) return 'Unknown'
  const parts = String(authors_text).split(/[,;]/).map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return 'Unknown'
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`
  return `${parts[0]} et al.`
}

// ============================================================
// Table 1: Characteristics of Included Studies(按主题分子表)
// ============================================================
//
// 返回结构:
//   {
//     subtables: [
//       { theme_id, theme_name, theme_count, columns, rows },
//       ...,
//       { theme_id: '__unassigned__', theme_name: '...', ... }
//     ],
//     total_studies: N
//   }
// rows[i] = { record_id, study, country, design, sample, intervention, comparator, outcomes, key_findings }

// #250 (2026-05-31) 表格瘦身:正文 per-theme Table 1 从 8 列 → 5 列(去掉
//   Intervention / Comparator / Outcomes —— Outcomes 已由 Table 2 SoF 覆盖,
//   Intervention/Comparator 完整信息保留在附录全表 Table S1)。
const TABLE1_COLUMNS = [
  { key: 'study',         label: 'Study',             width_em: 16 },
  { key: 'country',       label: 'Country / Setting', width_em: 12 },
  { key: 'design',        label: 'Design',            width_em: 14 },
  { key: 'sample',        label: 'Sample (N)',        width_em: 14 },
  { key: 'key_findings',  label: 'Key Findings',      width_em: 24 },
]

// 附录全表(Table S1)列:单张扁平表列"全部纳入研究",含 Theme + RoB 列,
//   满足 PRISMA/Cochrane "列出所有纳入研究" 的惯例(正文只放核心研究)。
const TABLE1_FULL_COLUMNS = [
  { key: 'study',         label: 'Study',             width_em: 16 },
  { key: 'theme',         label: 'Theme(s)',          width_em: 12 },
  { key: 'country',       label: 'Country / Setting', width_em: 10 },
  { key: 'design',        label: 'Design',            width_em: 12 },
  { key: 'sample',        label: 'Sample (N)',        width_em: 12 },
  { key: 'rob',           label: 'RoB / Quality',     width_em: 10 },
  { key: 'key_findings',  label: 'Key Findings',      width_em: 20 },
]

// #250 配置(可由 admin 在 system_settings 覆盖,默认值如下):
//   table1_core_max_rows   每主题正文表最多列几篇核心研究(默认 8)
//   table1_exclude_weak    正文表是否剔除 RoB 弱(weak)的研究(默认 '1' = 剔除,仅进附录)
const TABLE1_CORE_MAX_DEFAULT = 8

function getStrSetting(db, key, fallback) {
  try {
    const r = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)
    return (r && r.value != null) ? String(r.value) : fallback
  } catch { return fallback }
}

// 按 RoB 工具把 overall_rating 归一成质量桶:good | moderate | weak | unrated。
//   注意各工具极性不同('high' 对 RoB2 = 高偏倚=weak,对 JBI/MMAT = 高质量=good)。
function robOverallQuality(tool, rating) {
  if (rating == null) return 'unrated'
  const s = String(rating).toLowerCase().trim()
  if (tool === 'rob2') {
    if (s === 'low') return 'good'
    if (s === 'some_concerns') return 'moderate'
    if (s === 'high') return 'weak'
    return 'unrated'
  }
  if (tool === 'robins_i') {
    if (s === 'low') return 'good'
    if (s === 'moderate') return 'moderate'
    if (s === 'serious' || s === 'critical') return 'weak'
    return 'unrated'   // no_information / screening_failed
  }
  if (tool === 'nos') {
    if (s === 'high_quality') return 'good'
    if (s === 'moderate_quality') return 'moderate'
    if (s === 'low_quality') return 'weak'
    return 'unrated'
  }
  if (tool === 'jbi_cs' || tool === 'mmat') {
    if (s === 'high') return 'good'
    if (s === 'moderate') return 'moderate'
    if (s === 'low') return 'weak'
    return 'unrated'
  }
  return 'unrated'
}

// 质量桶 → 给附录 RoB 列显示的短标签
const QUALITY_LABEL = { good: 'Low risk / High', moderate: 'Moderate', weak: 'High risk / Low', unrated: '—' }
// 排序优先级:good 最前,weak 最后
const QUALITY_RANK = { good: 0, moderate: 1, unrated: 2, weak: 3 }

// 共享数据加载:include records(去 dup,排除 post-RoB)+ matrix + themes 归属 + RoB 质量。
//   供 buildCharacteristicsTablesByTheme(正文核心表)与 buildFullCharacteristicsAppendix(附录全表)复用。
function _loadCharacteristicsData(db, projectId) {
  let records = []
  try {
    records = db.prepare(
      `SELECT DISTINCT r.id, r.title, r.authors_text, r.year
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE sd.project_id = ? AND sd.stage = 'full_text' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
          AND r.rob_excluded_at IS NULL
        ORDER BY r.year DESC, r.authors_text ASC`
    ).all(projectId)
  } catch {}
  if (records.length === 0) {
    try {
      records = db.prepare(
        `SELECT DISTINCT r.id, r.title, r.authors_text, r.year
           FROM records r
           JOIN screening_decisions sd ON sd.record_id = r.id
          WHERE sd.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
            AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
            AND r.rob_excluded_at IS NULL
          ORDER BY r.year DESC, r.authors_text ASC`
      ).all(projectId)
    } catch {}
  }
  const recById = new Map(records.map((r) => [r.id, r]))

  const matrixByRid = new Map()
  try {
    for (const m of db.prepare(`SELECT record_id, fields FROM literature_matrix WHERE project_id = ?`).all(projectId)) {
      matrixByRid.set(m.record_id, tryParseObj(m.fields))
    }
  } catch {}

  // RoB 质量(rater_pass=1)→ 归一桶
  const robQualityByRid = new Map()
  let anyRob = false
  try {
    for (const a of db.prepare(`SELECT record_id, tool, overall_rating FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`).all(projectId)) {
      anyRob = true
      robQualityByRid.set(a.record_id, robOverallQuality(a.tool, a.overall_rating))
    }
  } catch {}

  const themes = db.prepare(
    `SELECT id, name, display_order, supporting_record_ids
       FROM themes WHERE project_id = ?
      ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
  ).all(projectId)

  const inAnyTheme = new Set()
  const themeNamesByRid = new Map()
  const themeBuckets = themes.map((t) => {
    const recordIds = []
    for (const rid of tryParseArr(t.supporting_record_ids)) {
      const ridStr = String(rid).trim()
      if (!ridStr) continue
      inAnyTheme.add(ridStr)
      recordIds.push(ridStr)
      const arr = themeNamesByRid.get(ridStr) || []
      arr.push(t.name)
      themeNamesByRid.set(ridStr, arr)
    }
    return { theme_id: t.id, theme_name: t.name, record_ids: recordIds }
  })
  const unassigned = records.filter((r) => !inAnyTheme.has(r.id)).map((r) => r.id)

  return { records, recById, matrixByRid, themeBuckets, unassigned, robQualityByRid, anyRob, themeNamesByRid }
}

export function buildCharacteristicsTablesByTheme(db, projectId) {
  const { recById, matrixByRid, themeBuckets, unassigned, robQualityByRid } = _loadCharacteristicsData(db, projectId)

  // #250 配置
  const CORE_MAX = parseInt(getStrSetting(db, 'table1_core_max_rows', String(TABLE1_CORE_MAX_DEFAULT)), 10) || TABLE1_CORE_MAX_DEFAULT
  const EXCLUDE_WEAK = getStrSetting(db, 'table1_exclude_weak', '1') !== '0'

  // 构造行(slim 5 列;Study 列嵌 [rec_xxx] 引用占位,三端渲染保持可点)
  function buildRow(rid) {
    const r = recById.get(rid)
    if (!r) return null
    const m = matrixByRid.get(rid) || {}
    const yearTxt = r.year ? String(r.year) : 'n.d.'
    const study = `${shortAuthors(r.authors_text)}, ${yearTxt} [${r.id}]`
    const sample = m.sample_size_total
      ? `N=${m.sample_size_total}${m.population ? ` · ${truncate(m.population, 60)}` : ''}`
      : truncate(m.population || '—', 80)
    const quality = robQualityByRid.get(rid) || 'unrated'
    return {
      record_id: r.id,
      study,
      country:      truncate(m.country_region || '—', 60),
      design:       truncate(m.study_design || '—', 100),
      sample,
      key_findings: truncate(m.key_findings || '—', 180),
      rob_quality:  quality,             // 非列,用于筛选/排序
      _year:        Number(r.year) || 0, // 非列,用于排序
    }
  }

  // 每主题:挑 RoB 强的核心研究(剔 weak,按 good→moderate→unrated 排,同档年份新→旧),封顶 CORE_MAX。
  //   全 weak / 无 RoB 的主题:回退展示全部(仍封顶),不出空表。
  function selectCore(recordIds) {
    let rows = recordIds.map(buildRow).filter(Boolean)
    const total = rows.length
    rows.sort((a, b) => {
      const qa = QUALITY_RANK[a.rob_quality] ?? 2, qb = QUALITY_RANK[b.rob_quality] ?? 2
      if (qa !== qb) return qa - qb
      return b._year - a._year
    })
    let eligible = EXCLUDE_WEAK ? rows.filter((r) => r.rob_quality !== 'weak') : rows
    if (eligible.length === 0) eligible = rows
    const core = eligible.slice(0, CORE_MAX)
    return { core, total, omitted: total - core.length }
  }

  const subtables = []
  function pushSubtable(themeId, themeName, recordIds) {
    const { core, total, omitted } = selectCore(recordIds)
    if (core.length === 0) return
    subtables.push({
      theme_id:    themeId,
      theme_label: `Table 1${String.fromCharCode(97 + subtables.length)}`,   // 1a, 1b, ...
      theme_name:  themeName,
      theme_count: core.length,
      total_in_theme: total,
      omitted_count: omitted,
      // 给渲染端的提示:正文是核心子集,全表见附录 Table S1
      note: omitted > 0
        ? `Showing ${core.length} of ${total} studies (highest methodological quality first; full list of all ${total} in Supplementary Table S1).`
        : null,
      columns:     TABLE1_COLUMNS,
      rows:        core,
    })
  }

  themeBuckets.forEach((b) => pushSubtable(b.theme_id, b.theme_name, b.record_ids))
  if (unassigned.length > 0) pushSubtable('__unassigned__', 'Studies not assigned to any theme', unassigned)

  return {
    subtables,
    total_studies: recById.size,
    columns: TABLE1_COLUMNS,
    core_max: CORE_MAX,
    exclude_weak: EXCLUDE_WEAK,
  }
}

// #250 附录全表 Table S1 —— 单张扁平表,列"全部纳入研究"(满足 PRISMA/Cochrane 惯例)。
//   含 Theme(s) + RoB/Quality 列。不分主题、不筛选、不封顶。
export function buildFullCharacteristicsAppendix(db, projectId) {
  const { records, matrixByRid, robQualityByRid, themeNamesByRid } = _loadCharacteristicsData(db, projectId)
  const rows = records.map((r) => {
    const m = matrixByRid.get(r.id) || {}
    const yearTxt = r.year ? String(r.year) : 'n.d.'
    const sample = m.sample_size_total
      ? `N=${m.sample_size_total}${m.population ? ` · ${truncate(m.population, 50)}` : ''}`
      : truncate(m.population || '—', 70)
    const themeNames = themeNamesByRid.get(r.id) || []
    const quality = robQualityByRid.get(r.id) || 'unrated'
    return {
      record_id: r.id,
      study:        `${shortAuthors(r.authors_text)}, ${yearTxt} [${r.id}]`,
      theme:        themeNames.length ? truncate(themeNames.join('; '), 60) : '—',
      country:      truncate(m.country_region || '—', 50),
      design:       truncate(m.study_design || '—', 80),
      sample,
      rob:          QUALITY_LABEL[quality] || '—',
      key_findings: truncate(m.key_findings || '—', 160),
    }
  })
  return {
    columns: TABLE1_FULL_COLUMNS,
    rows,
    total_studies: rows.length,
  }
}

// ============================================================
// Table 2: Summary of Findings (SoF) — outcome 级
// ============================================================
//
// 列(Cochrane SoF 标准):
//   Outcome | Theme | N Studies | N Participants | Effect | Certainty (GRADE) | Importance | Comment

const TABLE2_COLUMNS = [
  { key: 'outcome',      label: 'Outcome',         width_em: 14 },
  { key: 'theme',        label: 'Theme',           width_em: 10 },
  { key: 'n_studies',    label: '№ Studies',       width_em: 6 },
  { key: 'n_participants', label: '№ Participants', width_em: 8 },
  { key: 'effect',       label: 'Effect',          width_em: 16 },
  { key: 'certainty',    label: 'Certainty (GRADE)', width_em: 10 },
  { key: 'importance',   label: 'Importance',      width_em: 8 },
  { key: 'comment',      label: 'Comment',         width_em: 14 },
]

const CERTAINTY_LABEL = {
  high:     'High ⊕⊕⊕⊕',
  moderate: 'Moderate ⊕⊕⊕○',
  low:      'Low ⊕⊕○○',
  very_low: 'Very low ⊕○○○',
}

export function buildSoFTable(db, projectId) {
  const grades = db.prepare(
    `SELECT g.id, g.theme_id, g.outcome_label, g.outcome_description,
            g.importance, g.final_certainty, g.starting_certainty,
            g.summary_of_findings, g.effect_size_text,
            g.num_studies, g.num_participants,
            g.display_order,
            t.name AS theme_name
       FROM grade_assessments g
       JOIN themes t ON t.id = g.theme_id
      WHERE g.project_id = ?
      ORDER BY t.display_order ASC, g.display_order ASC`
  ).all(projectId)

  const rows = grades.map((g) => ({
    grade_id:        g.id,
    outcome:         g.outcome_label || '—',
    outcome_desc:    g.outcome_description || '',
    theme:           truncate(g.theme_name || '—', 50),
    n_studies:       g.num_studies != null ? String(g.num_studies) : '—',
    n_participants:  g.num_participants != null ? String(g.num_participants) : '—',
    effect:          truncate(g.effect_size_text || '—', 100),
    certainty:       CERTAINTY_LABEL[g.final_certainty] || CERTAINTY_LABEL[g.starting_certainty] || '—',
    certainty_raw:   g.final_certainty || g.starting_certainty || 'unclear',
    importance:      g.importance || 'critical',
    comment:         truncate(g.summary_of_findings || '—', 140),
  }))

  return {
    columns: TABLE2_COLUMNS,
    rows,
    total_outcomes: rows.length,
  }
}

// ============================================================
// Table 3a: RoB Traffic Light(逐 study × domain)
// ============================================================
//
// 不同 RoB tool 的 domain 不同 → 按 tool 分组,每组一张子表。
// rating 值统一映射到 { tone: 'good' | 'middle' | 'bad' | 'unclear' }(同 rob-helpers)
// 渲染时:tone → 圆点颜色(绿/黄/红/灰)
//
// 返回:
//   { tools: [{ tool, label, domains: [...], studies: [{study, record_id, cells, overall}] }] }

// 5 个 RoB tool 的 domain 集合
// key 与 rob_assessments.judgments_json[].domain 字段精确匹配。
// label 是给 UI / 导出用的人类可读名(短)。
const ROB_TOOL_DOMAINS = {
  rob2: [
    { key: 'D1_randomization',       short: 'D1', label: 'D1. Randomization process' },
    { key: 'D2_deviations',          short: 'D2', label: 'D2. Deviations from intended interventions' },
    { key: 'D3_missing_data',        short: 'D3', label: 'D3. Missing outcome data' },
    { key: 'D4_measurement',         short: 'D4', label: 'D4. Measurement of outcome' },
    { key: 'D5_selective_reporting', short: 'D5', label: 'D5. Selection of reported result' },
  ],
  robins_i: [
    { key: 'D1_confounding',         short: 'D1', label: 'D1. Confounding' },
    { key: 'D2_selection',           short: 'D2', label: 'D2. Selection of participants' },
    { key: 'D3_classification',      short: 'D3', label: 'D3. Classification of intervention' },
    { key: 'D4_deviations',          short: 'D4', label: 'D4. Deviations from intended intervention' },
    { key: 'D5_missing_data',        short: 'D5', label: 'D5. Missing data' },
    { key: 'D6_measurement',         short: 'D6', label: 'D6. Measurement of outcome' },
    { key: 'D7_selective_reporting', short: 'D7', label: 'D7. Selection of reported result' },
  ],
  nos: [
    { key: 'selection',     short: 'Sel', label: 'Selection' },
    { key: 'comparability', short: 'Cmp', label: 'Comparability' },
    { key: 'outcome',       short: 'Out', label: 'Outcome' },
  ],
  jbi_cs: [
    { key: 'Q1_inclusion_criteria',     short: 'Q1', label: 'Q1. Inclusion criteria' },
    { key: 'Q2_subjects_setting',       short: 'Q2', label: 'Q2. Subjects/setting described' },
    { key: 'Q3_exposure_measured',      short: 'Q3', label: 'Q3. Exposure measured' },
    { key: 'Q4_objective_criteria',     short: 'Q4', label: 'Q4. Objective criteria' },
    { key: 'Q5_confounders_identified', short: 'Q5', label: 'Q5. Confounders identified' },
    { key: 'Q6_confounders_addressed',  short: 'Q6', label: 'Q6. Confounders addressed' },
    { key: 'Q7_outcomes_measured',      short: 'Q7', label: 'Q7. Outcomes measured' },
    { key: 'Q8_statistical_analysis',   short: 'Q8', label: 'Q8. Statistical analysis' },
  ],
  mmat: [
    { key: 'S1_clear_research_question',  short: 'S1', label: 'S1. Clear research question' },
    { key: 'S2_data_addresses_question',  short: 'S2', label: 'S2. Data addresses question' },
    { key: 'Q1', short: 'Q1', label: 'Q1. Methodology criterion 1' },
    { key: 'Q2', short: 'Q2', label: 'Q2. Methodology criterion 2' },
    { key: 'Q3', short: 'Q3', label: 'Q3. Methodology criterion 3' },
    { key: 'Q4', short: 'Q4', label: 'Q4. Methodology criterion 4' },
    { key: 'Q5', short: 'Q5', label: 'Q5. Methodology criterion 5' },
  ],
}

const ROB_TOOL_LABEL = {
  rob2:     'Cochrane RoB 2 (RCTs)',
  robins_i: 'ROBINS-I (non-randomized interventions)',
  nos:      'Newcastle-Ottawa Scale (cohort/case-control)',
  jbi_cs:   'JBI (case study / qualitative)',
  mmat:     'MMAT (mixed methods)',
}

// rating → tone 映射(与 services/rob-helpers.js 同源,加 cant_tell 等真实数据形态)
function ratingToTone(rating) {
  if (rating == null) return 'unclear'
  const s = String(rating).toLowerCase().trim().replace(/[\s'_-]/g, '')
  // 🟢 good
  if (['low','yes','y','noorminor','noorminorconcerns','5','4','+','good','high'].includes(s)) return 'good'
  // 🟡 middle
  if (['someconcerns','moderate','minor','3','middle','canttell','probablyyes','partially','partial'].includes(s)) return 'middle'
  // 🔴 bad
  if (['highrisk','no','n','serious','veryserious','critical','1','0','bad','probablyno'].includes(s)) return 'bad'
  // ⬜ unclear
  if (['unclear','unknown','na','n/a','notapplicable','notreported','nr'].includes(s)) return 'unclear'
  // 数值兜底
  const n = Number(rating)
  if (!isNaN(n)) {
    if (n >= 4) return 'good'
    if (n >= 3) return 'middle'
    if (n >= 0) return 'bad'
  }
  return 'unclear'
}

export function buildRobTrafficLight(db, projectId) {
  const rob = db.prepare(
    `SELECT a.id, a.record_id, a.tool, a.judgments_json, a.overall_rating,
            a.overall_rationale, r.authors_text, r.year, r.title
       FROM rob_assessments a
       JOIN records r ON r.id = a.record_id
      WHERE a.project_id = ?
        AND a.rater_pass = 1
        AND r.duplicate_of_record_id IS NULL
      ORDER BY r.year DESC NULLS LAST, r.authors_text ASC`
  ).all(projectId)

  // 按 tool 分组
  const byTool = {}
  for (const a of rob) {
    if (!byTool[a.tool]) byTool[a.tool] = []
    byTool[a.tool].push(a)
  }

  const tools = []
  for (const toolKey of Object.keys(byTool)) {
    const domains = ROB_TOOL_DOMAINS[toolKey] || []
    const studies = byTool[toolKey].map((a) => {
      // judgments_json 是 { tool, judgments: [{ domain, judgment, rationale, ... }] }
      const parsed = tryParseObj(a.judgments_json)
      const judArr = Array.isArray(parsed?.judgments) ? parsed.judgments : []
      // 建 domain → judgment map(支持 key 精确匹配 + short 匹配 + label 包含)
      const byDomain = {}
      for (const j of judArr) {
        if (!j || !j.domain) continue
        byDomain[String(j.domain)] = j.judgment
      }
      const cells = domains.map((d) => {
        // 优先级:精确 key → short 前缀 → label
        let rating = byDomain[d.key]
        if (rating == null && d.short) {
          // 退而求其次 — 找以 d.short 开头的 key(如 "D1_xxx" 匹 "D1")
          for (const k of Object.keys(byDomain)) {
            if (k.startsWith(d.short + '_') || k === d.short) { rating = byDomain[k]; break }
          }
        }
        return {
          domain_key:   d.key,
          domain_short: d.short || d.key,
          rating: rating || null,
          tone:   ratingToTone(rating),
        }
      })
      return {
        record_id: a.record_id,
        // 2026-05-26 同 Table 1:嵌 [<record_id>] 占位让导出 markdown / LaTeX / preview 都能识别为可点引用
        //   注意:a.record_id 已经是 "rec_xxx" 格式,不要再加 "rec_" 前缀(否则双前缀 [rec_rec_xxx] 失效)
        study:     `${shortAuthors(a.authors_text)}, ${a.year || 'n.d.'} [${a.record_id}]`,
        title:     truncate(a.title, 100),
        cells,
        overall: {
          rating: a.overall_rating || null,
          tone:   ratingToTone(a.overall_rating),
          rationale: truncate(a.overall_rationale, 200),
        },
      }
    })
    tools.push({
      tool: toolKey,
      label: ROB_TOOL_LABEL[toolKey] || toolKey,
      domains,
      studies,
      study_count: studies.length,
    })
  }

  return { tools, total_studies: rob.length }
}

// ============================================================
// Table 3b: RoB Domain Summary(跨研究汇总,GRADEpro stacked bar)
// ============================================================
//
// 同 3a 的 tool 分组,每个 domain 汇总 good/middle/bad/unclear 数量
//
// 返回:
//   { tools: [{ tool, label, domains: [{key, label, good, middle, bad, unclear, total}] }] }

export function buildRobDomainSummary(db, projectId) {
  const t3a = buildRobTrafficLight(db, projectId)
  const tools = t3a.tools.map((toolGroup) => {
    const domainSummary = toolGroup.domains.map((d) => {
      const counts = { good: 0, middle: 0, bad: 0, unclear: 0 }
      for (const s of toolGroup.studies) {
        const cell = s.cells.find((c) => c.domain_key === d.key)
        if (!cell) continue
        counts[cell.tone] = (counts[cell.tone] || 0) + 1
      }
      const total = counts.good + counts.middle + counts.bad + counts.unclear
      return {
        domain_key: d.key,
        domain_label: d.label,
        ...counts,
        total,
        pct_good:    total ? (counts.good    / total * 100).toFixed(1) : '0.0',
        pct_middle:  total ? (counts.middle  / total * 100).toFixed(1) : '0.0',
        pct_bad:     total ? (counts.bad     / total * 100).toFixed(1) : '0.0',
        pct_unclear: total ? (counts.unclear / total * 100).toFixed(1) : '0.0',
      }
    })
    return {
      tool:  toolGroup.tool,
      label: toolGroup.label,
      domain_summary: domainSummary,
      study_count:    toolGroup.study_count,
    }
  })
  return { tools }
}

// ============================================================
// Table 4: Evidence Profile(主题级 GRADE/CERQual)
// ============================================================
//
// 列(GRADE Evidence Profile 标准 + CERQual 扩展):
//   Theme | Framework | N studies | Risk of Bias | Inconsistency | Indirectness | Imprecision | Pub Bias
//        | (CERQual: Meth Lim | Relevance | Coherence | Adequacy)
//        | Overall Certainty
//
// 单表,所有主题一行行铺开(framework 不同行通过 framework chip 区分)。

const TABLE4_COLUMNS = [
  { key: 'theme',              label: 'Theme',          width_em: 14 },
  { key: 'framework',          label: 'Framework',      width_em: 8 },
  { key: 'n_studies',          label: '№ Studies',      width_em: 6 },
  { key: 'risk_of_bias',       label: 'RoB',            width_em: 8 },
  { key: 'inconsistency',      label: 'Inconsist.',     width_em: 8 },
  { key: 'indirectness',       label: 'Indirect.',      width_em: 8 },
  { key: 'imprecision',        label: 'Imprec.',        width_em: 8 },
  { key: 'pub_bias',           label: 'Pub Bias',       width_em: 8 },
  { key: 'cerqual_meth_lim',   label: 'CQ Meth Lim',    width_em: 8 },
  { key: 'cerqual_relevance',  label: 'CQ Relev.',      width_em: 8 },
  { key: 'cerqual_coherence',  label: 'CQ Coher.',      width_em: 8 },
  { key: 'cerqual_adequacy',   label: 'CQ Adeq.',       width_em: 8 },
  { key: 'overall_certainty',  label: 'Overall',        width_em: 8 },
]

export function buildEvidenceProfileTable(db, projectId) {
  const cert = db.prepare(
    `SELECT c.id, c.theme_id, c.grading_framework,
            c.grade_risk_of_bias, c.grade_inconsistency, c.grade_indirectness,
            c.grade_imprecision, c.grade_publication_bias,
            c.cerqual_methodological_limitations, c.cerqual_relevance,
            c.cerqual_coherence, c.cerqual_adequacy_of_data,
            c.overall_certainty, c.body_of_evidence_summary,
            c.iteration_n,
            t.name AS theme_name, t.display_order, t.supporting_record_ids
       FROM theme_certainty c
       JOIN themes t ON t.id = c.theme_id
      WHERE c.project_id = ?
      ORDER BY t.display_order ASC`
  ).all(projectId)

  // 每个主题取 iteration_n 最大的那行(latest)
  const byTheme = new Map()
  for (const c of cert) {
    const cur = byTheme.get(c.theme_id)
    if (!cur || (c.iteration_n || 0) > (cur.iteration_n || 0)) byTheme.set(c.theme_id, c)
  }

  const rows = []
  for (const c of byTheme.values()) {
    const isGrade   = c.grading_framework === 'grade'   || c.grading_framework === 'hybrid'
    const isCerqual = c.grading_framework === 'cerqual' || c.grading_framework === 'hybrid'
    rows.push({
      theme:             truncate(c.theme_name, 60),
      framework:         c.grading_framework || '—',
      n_studies:         tryParseArr(c.supporting_record_ids).length || 0,
      risk_of_bias:      isGrade   ? (c.grade_risk_of_bias || '—') : 'n/a',
      inconsistency:     isGrade   ? (c.grade_inconsistency || '—') : 'n/a',
      indirectness:      isGrade   ? (c.grade_indirectness || '—') : 'n/a',
      imprecision:       isGrade   ? (c.grade_imprecision || '—') : 'n/a',
      pub_bias:          isGrade   ? (c.grade_publication_bias || '—') : 'n/a',
      cerqual_meth_lim:  isCerqual ? (c.cerqual_methodological_limitations || '—') : 'n/a',
      cerqual_relevance: isCerqual ? (c.cerqual_relevance || '—') : 'n/a',
      cerqual_coherence: isCerqual ? (c.cerqual_coherence || '—') : 'n/a',
      cerqual_adequacy:  isCerqual ? (c.cerqual_adequacy_of_data || '—') : 'n/a',
      overall_certainty: CERTAINTY_LABEL[c.overall_certainty] || c.overall_certainty || '—',
      overall_raw:       c.overall_certainty || 'unclear',
      summary:           truncate(c.body_of_evidence_summary, 220),
    })
  }

  return {
    columns: TABLE4_COLUMNS,
    rows,
    total_themes: rows.length,
  }
}

// ============================================================
// 共用 helpers — 给 Table 5-14 用
// ============================================================
//
// loadIncludedWithMatrix(db, projectId) → [{ id, title, authors_text, year, fields, theme_ids }]
// 一次性把"全部 include 的 records + 各自 matrix.fields + 所属主题 id list" 加载出来。
// 后续 Table 5-14 都基于这个数据集做派生 — 避免每张表都跑一遍 JOIN。
function loadIncludedWithMatrix(db, projectId) {
  // 1) records(去 dup,full_text include)
  let records = []
  try {
    records = db.prepare(
      `SELECT DISTINCT r.id, r.title, r.authors_text, r.year, r.journal
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE sd.project_id = ?
          AND sd.stage         = 'full_text'
          AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
    ).all(projectId)
  } catch {}
  if (records.length === 0) {
    try {
      records = db.prepare(
        `SELECT DISTINCT r.id, r.title, r.authors_text, r.year, r.journal
           FROM records r
           JOIN screening_decisions sd ON sd.record_id = r.id
          WHERE sd.project_id = ?
            AND sd.stage          = 'title_abstract'
            AND sd.human_decision = 'include'
            AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
      ).all(projectId)
    } catch {}
  }

  // 2) matrix(record_id → fields)
  const matrixByRid = new Map()
  try {
    const rows = db.prepare(
      `SELECT record_id, fields FROM literature_matrix WHERE project_id = ?`
    ).all(projectId)
    for (const m of rows) matrixByRid.set(m.record_id, tryParseObj(m.fields))
  } catch {}

  // 3) theme_id list per record
  let themes = []
  try {
    themes = db.prepare(
      `SELECT id, name, display_order, supporting_record_ids FROM themes WHERE project_id = ?
        ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    ).all(projectId)
  } catch {}
  const themesByRid = new Map()
  for (const t of themes) {
    const supporting = tryParseArr(t.supporting_record_ids)
    for (const rid of supporting) {
      const k = String(rid).trim()
      if (!k) continue
      if (!themesByRid.has(k)) themesByRid.set(k, [])
      themesByRid.get(k).push({ id: t.id, name: t.name, display_order: t.display_order })
    }
  }

  // 4) merge
  return records.map((r) => ({
    ...r,
    fields:    matrixByRid.get(r.id) || {},
    themes:    themesByRid.get(r.id) || [],
    theme_ids: (themesByRid.get(r.id) || []).map((t) => t.id),
  }))
}

// loadThemesMeta(db, projectId) — 给只需要 theme 列表的表用
function loadThemesMeta(db, projectId) {
  try {
    return db.prepare(
      `SELECT id, name, display_order, supporting_record_ids,
              maps_to_research_questions, maps_to_pico_concepts,
              evidence_gaps, consistent_findings, conflicting_findings,
              study_design_mix, rob_profile
         FROM themes WHERE project_id = ?
        ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    ).all(projectId).map((t) => ({
      ...t,
      supporting_record_ids:       tryParseArr(t.supporting_record_ids),
      maps_to_research_questions:  tryParseArr(t.maps_to_research_questions),
      maps_to_pico_concepts:       tryParseArr(t.maps_to_pico_concepts),
      evidence_gaps:               tryParseArr(t.evidence_gaps),
      consistent_findings:         tryParseArr(t.consistent_findings),
      conflicting_findings:        tryParseArr(t.conflicting_findings),
      study_design_mix:            tryParseObj(t.study_design_mix),
      rob_profile:                 tryParseObj(t.rob_profile),
    }))
  } catch { return [] }
}

// loadSynthesisMeta(db, projectId)
function loadSynthesisMeta(db, projectId) {
  try {
    const row = db.prepare(
      `SELECT cross_cutting_observations, protocol_coverage FROM synthesis_meta WHERE project_id = ? LIMIT 1`
    ).get(projectId)
    if (!row) return null
    return {
      cross_cutting_observations: tryParseArr(row.cross_cutting_observations),
      protocol_coverage:          tryParseObj(row.protocol_coverage),
    }
  } catch { return null }
}

// loadProtocolApproved(db, projectId) — 拉协议 + 把字段集装成 obj
function loadProtocolApproved(db, projectId) {
  try {
    const row = db.prepare(
      `SELECT version, research_questions, inclusion_criteria, exclusion_criteria,
              concept_groups, recommended_review_type
         FROM protocols
        WHERE project_id = ? AND approved_by_user = 1
        ORDER BY version DESC LIMIT 1`
    ).get(projectId)
    if (!row) return null
    return {
      version:            row.version,
      research_questions: tryParseArr(row.research_questions),
      inclusion_criteria: tryParseArr(row.inclusion_criteria),
      exclusion_criteria: tryParseArr(row.exclusion_criteria),
      concept_groups:     tryParseArr(row.concept_groups),
      review_type:        row.recommended_review_type || null,
    }
  } catch { return null }
}

// 统计辅助:从字段值粗略提取关键词(分隔符 / 大小写归一)
function extractTokens(text) {
  if (!text) return []
  return String(text)
    .split(/[;,\n·•|/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s.length > 1 && s !== '—' && s !== 'n/a')
}

// 把 country_region 字段归一(取国家名,丢弃括号 + 上下文)
//   "Chile (data collection); contextualized to Latin America" → ["Chile"]
//   "USA and Canada"                                            → ["USA", "Canada"]
//   "Multiple (UK, Australia, USA)"                             → ["UK", "Australia", "USA"]
function extractCountries(raw) {
  if (!raw) return []
  let s = String(raw).trim()
  if (!s || s === '—' || s === 'n/a') return []
  // 把括号内的国家也拉出来 — 但先把 "context", "data collection" 等噪声词的括号去掉
  const inParen = []
  s = s.replace(/\(([^)]+)\)/g, (_, inside) => {
    if (/data collection|context|setting|study site|location/i.test(inside)) return ''
    inParen.push(inside)
    return ''
  })
  // 一并切:; , / · | 和 "and"
  const parts = [s, ...inParen]
    .join(',')
    .split(/[;,/·|]|\s+and\s+/i)
    .map((x) => x.trim())
    .filter((x) => {
      if (!x || x.length < 2 || x.length > 50) return false
      // 排除明显非国家名
      if (/^(data|study|sample|n=|context|setting|located|conducted|across|multiple|various|n\/a)$/i.test(x)) return false
      return true
    })
  // 常见国家名归一(US/USA/United States → United States,UK/U.K. → United Kingdom 等)
  // + 常见省/市/邦/直辖市归到国家(用户要求:Hubei Province / Ankara / Atlanta 等地名要合到国家)
  // 政策规则(所有项目硬约束):台湾 / 香港 / 澳门一律归入 China
  const NORMALIZE = {
    'us': 'United States', 'usa': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'america': 'United States',
    'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
    'prc': 'China', 'mainland china': 'China', 'p.r.c.': 'China',
    // 政策:台港澳归中国
    'taiwan':            'China',
    'taiwan, china':     'China',
    'roc':               'China',
    'republic of china': 'China',
    'chinese taipei':    'China',
    'hong kong':         'China',
    'hk':                'China',
    'hong kong sar':     'China',
    'hong kong, china':  'China',
    'macao':             'China',
    'macau':             'China',
    'macao sar':         'China',
    'macao, china':      'China',
    'south korea': 'Korea', 'republic of korea': 'Korea', 'rok': 'Korea',
    'uae': 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates',

    // ── 中国的省 / 直辖市 / 自治区 ──
    'beijing': 'China', 'shanghai': 'China', 'tianjin': 'China', 'chongqing': 'China',
    'guangdong': 'China', 'guangzhou': 'China', 'shenzhen': 'China',
    'zhejiang': 'China', 'hangzhou': 'China', 'ningbo': 'China',
    'jiangsu': 'China', 'nanjing': 'China', 'suzhou': 'China', 'wuxi': 'China',
    'shandong': 'China', 'qingdao': 'China', 'jinan': 'China',
    'sichuan': 'China', 'chengdu': 'China',
    'hubei': 'China', 'hubei province': 'China', 'wuhan': 'China',
    'hunan': 'China', 'changsha': 'China',
    'fujian': 'China', 'xiamen': 'China', 'fuzhou': 'China',
    'liaoning': 'China', 'shenyang': 'China', 'dalian': 'China',
    'heilongjiang': 'China', 'harbin': 'China',
    'jilin': 'China', 'changchun': 'China',
    'henan': 'China', 'zhengzhou': 'China',
    'hebei': 'China', 'shijiazhuang': 'China',
    'shanxi': 'China', 'taiyuan': 'China',
    'shaanxi': 'China', 'xian': 'China', "xi'an": 'China',
    'gansu': 'China', 'lanzhou': 'China',
    'qinghai': 'China', 'xinjiang': 'China', 'tibet': 'China', 'xizang': 'China',
    'anhui': 'China', 'hefei': 'China',
    'jiangxi': 'China', 'nanchang': 'China',
    'guangxi': 'China', 'nanning': 'China',
    'yunnan': 'China', 'kunming': 'China',
    'guizhou': 'China', 'guiyang': 'China',
    'hainan': 'China', 'haikou': 'China',
    'inner mongolia': 'China', 'hohhot': 'China',
    'ningxia': 'China',

    // ── 美国的州 / 大城市 ──
    'california': 'United States', 'los angeles': 'United States', 'san francisco': 'United States', 'san diego': 'United States',
    'new york': 'United States', 'new york city': 'United States', 'nyc': 'United States', 'brooklyn': 'United States',
    'texas': 'United States', 'houston': 'United States', 'dallas': 'United States', 'austin': 'United States',
    'florida': 'United States', 'miami': 'United States', 'orlando': 'United States',
    'illinois': 'United States', 'chicago': 'United States',
    'massachusetts': 'United States', 'boston': 'United States', 'cambridge ma': 'United States',
    'georgia': 'United States', 'atlanta': 'United States',
    'pennsylvania': 'United States', 'philadelphia': 'United States', 'pittsburgh': 'United States',
    'washington': 'United States', 'seattle': 'United States', 'washington dc': 'United States', 'd.c.': 'United States',
    'oregon': 'United States', 'portland': 'United States',
    'colorado': 'United States', 'denver': 'United States',
    'michigan': 'United States', 'detroit': 'United States', 'ann arbor': 'United States',
    'ohio': 'United States', 'columbus': 'United States', 'cleveland': 'United States',
    'arizona': 'United States', 'phoenix': 'United States',
    'minnesota': 'United States', 'minneapolis': 'United States',
    'wisconsin': 'United States', 'madison wi': 'United States',
    'north carolina': 'United States', 'raleigh': 'United States', 'durham': 'United States',
    'virginia': 'United States', 'richmond': 'United States',
    'maryland': 'United States', 'baltimore': 'United States',
    'tennessee': 'United States', 'nashville': 'United States',
    'indiana': 'United States', 'indianapolis': 'United States',
    'missouri': 'United States', 'st louis': 'United States', 'st. louis': 'United States',
    'utah': 'United States', 'salt lake city': 'United States',
    'hawaii': 'United States', 'honolulu': 'United States',

    // ── 英国 / 加拿大 / 澳洲常见地区 ──
    'london': 'United Kingdom', 'manchester': 'United Kingdom', 'cambridge': 'United Kingdom', 'oxford': 'United Kingdom',
    'edinburgh': 'United Kingdom', 'glasgow': 'United Kingdom', 'scotland': 'United Kingdom',
    'wales': 'United Kingdom', 'cardiff': 'United Kingdom',
    'northern ireland': 'United Kingdom', 'belfast': 'United Kingdom',
    'birmingham': 'United Kingdom', 'leeds': 'United Kingdom', 'bristol': 'United Kingdom',
    'ontario': 'Canada', 'toronto': 'Canada', 'ottawa': 'Canada',
    'quebec': 'Canada', 'montreal': 'Canada',
    'british columbia': 'Canada', 'vancouver': 'Canada',
    'alberta': 'Canada', 'calgary': 'Canada', 'edmonton': 'Canada',
    'new south wales': 'Australia', 'sydney': 'Australia',
    'victoria au': 'Australia', 'melbourne': 'Australia',
    'queensland': 'Australia', 'brisbane': 'Australia',
    'western australia': 'Australia', 'perth': 'Australia',

    // ── 印度的邦 / 大城市 ──
    'gujarat': 'India', 'ahmedabad': 'India', 'surat': 'India',
    'maharashtra': 'India', 'mumbai': 'India', 'pune': 'India',
    'tamil nadu': 'India', 'chennai': 'India',
    'karnataka': 'India', 'bangalore': 'India', 'bengaluru': 'India',
    'delhi': 'India', 'new delhi': 'India',
    'west bengal': 'India', 'kolkata': 'India',
    'kerala': 'India', 'kochi': 'India',
    'rajasthan': 'India', 'jaipur': 'India',
    'punjab': 'India', 'punjab in': 'India', 'chandigarh': 'India', 'ludhiana': 'India', 'amritsar': 'India',
    'andhra pradesh': 'India', 'hyderabad': 'India', 'telangana': 'India',
    'uttar pradesh': 'India', 'lucknow': 'India',

    // ── 土耳其的城市 ──
    'turkey': 'Türkiye',
    'ankara': 'Türkiye', 'istanbul': 'Türkiye', 'izmir': 'Türkiye', 'bursa': 'Türkiye',

    // ── 韩国 / 日本 / 东南亚常见地点 ──
    'seoul': 'Korea', 'busan': 'Korea',
    'tokyo': 'Japan', 'osaka': 'Japan', 'kyoto': 'Japan', 'yokohama': 'Japan',
    'kuala lumpur': 'Malaysia', 'penang': 'Malaysia',
    'bangkok': 'Thailand', 'chiang mai': 'Thailand',
    'jakarta': 'Indonesia', 'surabaya': 'Indonesia', 'bandung': 'Indonesia', 'yogyakarta': 'Indonesia',
    'hanoi': 'Vietnam', 'ho chi minh': 'Vietnam', 'ho chi minh city': 'Vietnam', 'saigon': 'Vietnam',
    'manila': 'Philippines',

    // ── 欧洲 / 中东 / 非洲 / 拉美常见地点 ──
    'madrid': 'Spain', 'barcelona': 'Spain', 'valencia': 'Spain', 'seville': 'Spain',
    'paris': 'France', 'lyon': 'France', 'marseille': 'France',
    'berlin': 'Germany', 'munich': 'Germany', 'frankfurt': 'Germany', 'hamburg': 'Germany',
    'rome': 'Italy', 'milan': 'Italy', 'florence': 'Italy',
    'amsterdam': 'Netherlands', 'rotterdam': 'Netherlands', 'the hague': 'Netherlands',
    'stockholm': 'Sweden', 'gothenburg': 'Sweden',
    'oslo': 'Norway', 'bergen': 'Norway', 'trondheim': 'Norway',
    'helsinki': 'Finland', 'oulu': 'Finland', 'tampere': 'Finland', 'turku': 'Finland', 'espoo': 'Finland', 'jyväskylä': 'Finland', 'jyvaskyla': 'Finland',
    'copenhagen': 'Denmark', 'aarhus': 'Denmark', 'odense': 'Denmark',
    'reykjavik': 'Iceland',
    'prague': 'Czech Republic', 'czechia': 'Czech Republic',
    'warsaw': 'Poland', 'krakow': 'Poland',
    'vienna': 'Austria', 'budapest': 'Hungary',
    'zurich': 'Switzerland', 'geneva': 'Switzerland', 'lausanne': 'Switzerland',
    'brussels': 'Belgium', 'antwerp': 'Belgium', 'leuven': 'Belgium',
    'dublin': 'Ireland',
    'lisbon': 'Portugal', 'porto': 'Portugal',
    'athens': 'Greece',
    'tel aviv': 'Israel', 'jerusalem': 'Israel', 'haifa': 'Israel',
    'dubai': 'United Arab Emirates', 'abu dhabi': 'United Arab Emirates',
    'riyadh': 'Saudi Arabia',
    'cairo': 'Egypt', 'alexandria': 'Egypt',
    'cape town': 'South Africa', 'johannesburg': 'South Africa', 'pretoria': 'South Africa',
    'mexico city': 'Mexico', 'guadalajara': 'Mexico', 'monterrey': 'Mexico',
    'sao paulo': 'Brazil', 'são paulo': 'Brazil', 'rio de janeiro': 'Brazil', 'rio': 'Brazil',
    'buenos aires': 'Argentina',
    'santiago': 'Chile', 'valparaiso': 'Chile',
    'lima': 'Peru',
    'bogota': 'Colombia', 'bogotá': 'Colombia', 'medellin': 'Colombia',
  }
  // 出口前 strip 标点 + 折叠空格,确保跨记录 byCountry Map 能稳定 key
  function stripPunctuation(s) {
    return String(s).replace(/[.,;:'"()\[\]]/g, '').replace(/\s+/g, ' ').trim()
  }
  function normKey(s) { return stripPunctuation(s).toLowerCase() }

  // 机构 → 国家:用户报 "University of Oulu" 进了 country 列;LLM 在 matrix
  // 抽取时偶尔会把所属机构名当地理位置写下来。这里做兜底:
  //   (a) 把 "University of X" / "X University" / "X College" / "X Institute"
  //       这种 pattern 剥掉机构修饰,把 X 拿出来再走一次 NORMALIZE map
  //       (X 通常是国家 / 邦 / 市,如 Oulu → Finland)
  //   (b) 如果剥完还是机构名(没匹配到任何国家),返回 null → 上游会落到
  //       "Not reported" 而不是污染 country 列
  function institutionToCountry(raw) {
    let s = normKey(raw)
    if (!s) return null
    // 一些直接命中的著名大学(可补充)
    const KNOWN_UNI = {
      'mit': 'United States', 'harvard': 'United States', 'stanford': 'United States',
      'caltech': 'United States', 'cmu': 'United States',
      'tsinghua': 'China', 'peking university': 'China', 'fudan': 'China', 'zhejiang university': 'China',
      'national university of singapore': 'Singapore', 'nus': 'Singapore', 'ntu singapore': 'Singapore',
      'kaist': 'Korea', 'snu': 'Korea',
      'eth zurich': 'Switzerland', 'epfl': 'Switzerland',
      'imperial college london': 'United Kingdom', 'ucl': 'United Kingdom', 'oxford': 'United Kingdom',
      'sorbonne': 'France',
      'tum': 'Germany', 'rwth aachen': 'Germany',
      'university of tokyo': 'Japan', 'kyoto university': 'Japan',
      'unam': 'Mexico',
      'kth': 'Sweden',
    }
    if (KNOWN_UNI[s]) return KNOWN_UNI[s]
    // 剥常见机构前后缀:university of/from X, X university/college/institute/polytechnic/academy
    // \w* 吃复数(universities, colleges, institutes 等) + 多语言变体
    const INST_RE = /\b(universit\w*|colleg\w*|institut\w*|polytechnic\w*|academ\w*|school\w*|facult\w*|department\w*|laborator\w*|lab)\b/gi
    if (!INST_RE.test(s)) return null
    INST_RE.lastIndex = 0  // reset global regex state after test()
    let rest = s
      .replace(/\b(universit\w*)\s+of\s+/gi, '')
      .replace(/\bof\s+(universit\w*|colleg\w*|institut\w*)\s+/gi, '')
      .replace(INST_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!rest) return null
    // rest 现在通常是城市 / 邦 / 国家名,再去 NORMALIZE / KNOWN_UNI 找一遍
    if (NORMALIZE[rest]) return NORMALIZE[rest]
    if (KNOWN_UNI[rest]) return KNOWN_UNI[rest]
    // 仍找不到 → 放弃,不污染表
    return null
  }

  // 过滤:剩下"明显是机构 / 无效"的 token 也要丢
  function looksInvalid(token) {
    const k = normKey(token)
    if (!k) return true
    // 太短(纯字母 1 个) / 全数字 / 纯标点
    if (k.length < 2) return true
    if (/^[\d\s.,;:()-]+$/.test(k)) return true
    // 机构 / 系所类描述无法 resolve 的(含复数,如 "Multiple universities", "Various schools")
    if (/\b(universit\w*|colleg\w*|institut\w*|polytechnic\w*|academ\w*|department\w*|laborator\w*|school\w*|faculty\w*)\b/i.test(k)) return true
    // 模糊量词("multiple", "various", "several" 单独出现)
    if (/^(multiple|various|several|many|some|other|misc|unknown)$/i.test(k)) return true
    return false
  }

  const seen = new Set()
  const out = []
  for (const c of parts) {
    const k = normKey(c)
    // 先归一(NORMALIZE map);若无映射,尝试 institution → country;
    // 再失败就丢(避免污染);
    let norm = NORMALIZE[k]
    if (!norm) norm = institutionToCountry(c)
    if (!norm) {
      if (looksInvalid(c)) continue       // 明显垃圾 / 机构,丢
      norm = stripPunctuation(c)          // 其他保留原形(可能是冷门小国名)
    }
    const key = normKey(norm)
    if (!seen.has(key)) { seen.add(key); out.push(norm) }
  }
  return out.length > 0 ? out : []
}

// ============================================================
// Table 5: Geographic Distribution
// ============================================================
// 列:Country/Region · N studies · 主题分布(Theme N1/N2/...)
// 数据源:matrix.country_region
// 注意:一篇可能涉及多国 → 多计数(rowsByCountry)
const TABLE5_COLUMNS_BASE = [
  { key: 'country',    label: 'Country / Region', width_em: 12 },
  { key: 'n_studies',  label: '№ Studies',        width_em: 6 },
  { key: 'pct',        label: '% of total',       width_em: 6 },
  { key: 'theme_dist', label: 'By Theme',         width_em: 24 },
]

export function buildGeographicDistribution(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  if (papers.length === 0) return { columns: TABLE5_COLUMNS_BASE, rows: [], total_studies: 0 }

  const byCountry = new Map()   // country → { records: Set<rid>, themes: Map<theme_id, Set<rid>>, theme_names: Map<theme_id, name> }
  for (const p of papers) {
    let countries = extractCountries(p.fields.country_region)
    if (countries.length === 0) countries = ['Not reported']
    for (const c of countries) {
      if (!byCountry.has(c)) byCountry.set(c, { records: new Set(), themesMap: new Map() })
      const e = byCountry.get(c)
      e.records.add(p.id)
      for (const th of p.themes) {
        if (!e.themesMap.has(th.id)) e.themesMap.set(th.id, { name: th.name, rids: new Set() })
        e.themesMap.get(th.id).rids.add(p.id)
      }
    }
  }

  const totalStudies = papers.length
  const rows = []
  for (const [country, e] of byCountry.entries()) {
    const n = e.records.size
    // 2026-05-25 BUG FIX:不再 truncate(30) + slice(0,4) — 论文里"GenAI as Co-Designer in..."
    //   这种省略号让审稿人摸不到头脑。完整名 + 按 paper count 排序,投稿表保留学术完整性。
    const themeParts = []
    for (const [, info] of e.themesMap.entries()) {
      themeParts.push({ label: info.name, count: info.rids.size })
    }
    themeParts.sort((a, b) => b.count - a.count)
    const themeDistStr = themeParts.length
      ? themeParts.map(t => `${t.label} (${t.count})`).join('; ')
      : '—'
    rows.push({
      country:    country,
      n_studies:  n,
      pct:        ((n / totalStudies) * 100).toFixed(1) + '%',
      theme_dist: themeDistStr,
      n_raw:      n,
    })
  }
  rows.sort((a, b) => b.n_raw - a.n_raw)
  const top = rows.slice(0, 20)
  return {
    columns: TABLE5_COLUMNS_BASE,
    rows: top,
    total_studies: totalStudies,
    total_unique_countries: rows.length,
  }
}

// ============================================================
// Table 6: Timeline / Year Trend
// ============================================================
// 列:Year · Total studies · 主题分布
const TABLE6_COLUMNS = [
  { key: 'year',       label: 'Year',          width_em: 6 },
  { key: 'n_studies',  label: '№ Studies',     width_em: 6 },
  { key: 'bar',        label: 'Trend',         width_em: 20 },
  { key: 'theme_dist', label: 'By Theme',      width_em: 24 },
]

export function buildTimelineTrend(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  if (papers.length === 0) return { columns: TABLE6_COLUMNS, rows: [], total_studies: 0 }

  const byYear = new Map()
  for (const p of papers) {
    const y = p.year || 'Unknown'
    if (!byYear.has(y)) byYear.set(y, { records: [], themesMap: new Map() })
    const e = byYear.get(y)
    e.records.push(p.id)
    for (const th of p.themes) {
      if (!e.themesMap.has(th.id)) e.themesMap.set(th.id, { name: th.name, count: 0 })
      e.themesMap.get(th.id).count++
    }
  }

  const totalStudies = papers.length
  const yearsSorted = [...byYear.keys()].sort((a, b) => {
    if (a === 'Unknown') return 1
    if (b === 'Unknown') return -1
    return Number(b) - Number(a)
  })
  const maxN = Math.max(...[...byYear.values()].map((e) => e.records.length))

  const rows = []
  for (const y of yearsSorted) {
    const e = byYear.get(y)
    const n = e.records.length
    const themeParts = []
    for (const [, info] of e.themesMap.entries()) {
      themeParts.push(`${truncate(info.name, 30)}: ${info.count}`)
    }
    const barWidth = maxN > 0 ? Math.round((n / maxN) * 20) : 0
    rows.push({
      year:       String(y),
      n_studies:  n,
      bar:        '█'.repeat(barWidth) + '░'.repeat(20 - barWidth),
      theme_dist: themeParts.slice(0, 4).join(' · ') + (themeParts.length > 4 ? ` · +${themeParts.length - 4}…` : '') || '—',
    })
  }

  return { columns: TABLE6_COLUMNS, rows, total_studies: totalStudies }
}

// ============================================================
// Table 7: Theoretical Framework Usage
// ============================================================
// 列:Framework · N studies · % · Themes anchored
const TABLE7_COLUMNS = [
  { key: 'framework',  label: 'Theoretical Framework', width_em: 24 },
  { key: 'n_studies',  label: '№ Studies',             width_em: 6 },
  { key: 'pct',        label: '%',                     width_em: 5 },
  { key: 'themes',     label: 'Themes Anchored',       width_em: 20 },
]

// 从 theoretical_framework 文本提取主要"框架家族"(避免长尾噪声)
//   "Self-Regulated Learning (SRL) — integrated three-phase ... Zimmerman (2000)"
//     → "Self-Regulated Learning (SRL)"
//   匹配规则:取第一个 "Name (Acronym)" / 第一个 "Name —" / 第一个分号前 / 截 60 字符
function extractFrameworkName(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  if (!s || s === '—' || s === 'n/a' || /^not.*reported$/i.test(s)) return null
  // 删年份引文,如 "(Zimmerman, 2000)" → ""
  s = s.replace(/\([A-Z][a-z]+(?:\s*&?\s*[A-Z][a-z]+)*(?:\s+et\s+al\.?)?\s*,?\s*\d{4}[a-z]?\)/g, '')
  // 取第一个 "Name (Acronym)" 整体
  const nameAcr = s.match(/^([A-Z][\w\s'-]{2,50}\([A-Z]{2,8}\))/)
  if (nameAcr) return nameAcr[1].trim()
  // 取破折号 / 分号 / 句号前
  const dash = s.split(/[—–\-]\s/)[0]
  const semi = dash.split(/[;.]/)[0]
  const out = semi.trim()
  return truncate(out, 60) || null
}

export function buildTheoreticalFrameworkUsage(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  if (papers.length === 0) return { columns: TABLE7_COLUMNS, rows: [], total_studies: 0, no_framework_n: 0 }

  const byFramework = new Map()
  let noFrameworkN = 0
  for (const p of papers) {
    const fwName = extractFrameworkName(p.fields.theoretical_framework)
    if (!fwName) { noFrameworkN++; continue }
    if (!byFramework.has(fwName)) byFramework.set(fwName, { records: new Set(), themes: new Map() })
    const e = byFramework.get(fwName)
    e.records.add(p.id)
    for (const th of p.themes) {
      if (!e.themes.has(th.id)) e.themes.set(th.id, th.name)
    }
  }

  const totalStudies = papers.length
  const rows = []
  for (const [fw, e] of byFramework.entries()) {
    const n = e.records.size
    rows.push({
      framework: fw,
      n_studies: n,
      pct:       ((n / totalStudies) * 100).toFixed(1) + '%',
      themes:    [...e.themes.values()].slice(0, 3).map((s) => truncate(s, 30)).join(' · ') + (e.themes.size > 3 ? `…(+${e.themes.size - 3})` : ''),
      n_raw:     n,
    })
  }
  rows.sort((a, b) => b.n_raw - a.n_raw)
  const top = rows.slice(0, 25)
  // 顶部加 "No framework reported"(如果有)
  if (noFrameworkN > 0) {
    top.push({
      framework: 'No framework reported',
      n_studies: noFrameworkN,
      pct:       ((noFrameworkN / totalStudies) * 100).toFixed(1) + '%',
      themes:    '—',
      n_raw:     -1,
    })
  }

  return {
    columns: TABLE7_COLUMNS,
    rows: top,
    total_studies: totalStudies,
    no_framework_n: noFrameworkN,
    total_unique_frameworks: rows.length,
  }
}

// ============================================================
// Table 8: Measurement Instruments
// ============================================================
// 列:Instrument · N studies · % · Themes used in
const TABLE8_COLUMNS = [
  { key: 'instrument', label: 'Measurement Instrument', width_em: 24 },
  { key: 'n_studies',  label: '№ Studies',              width_em: 6 },
  { key: 'pct',        label: '%',                      width_em: 5 },
  { key: 'themes',     label: 'Themes Used In',         width_em: 20 },
]

export function buildMeasurementInstruments(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  if (papers.length === 0) return { columns: TABLE8_COLUMNS, rows: [], total_studies: 0 }

  const byInstrument = new Map()
  for (const p of papers) {
    const raw = p.fields.measurement_tools
    const tools = extractTokens(raw)
    for (const tool of tools) {
      const k = truncate(tool, 80)
      if (!byInstrument.has(k)) byInstrument.set(k, { records: new Set(), themes: new Map() })
      const e = byInstrument.get(k)
      e.records.add(p.id)
      for (const th of p.themes) {
        if (!e.themes.has(th.id)) e.themes.set(th.id, th.name)
      }
    }
  }

  const totalStudies = papers.length
  const rows = []
  for (const [inst, e] of byInstrument.entries()) {
    const n = e.records.size
    rows.push({
      instrument: inst,
      n_studies:  n,
      pct:        ((n / totalStudies) * 100).toFixed(1) + '%',
      themes:     [...e.themes.values()].slice(0, 3).map((s) => truncate(s, 30)).join(' · ') + (e.themes.size > 3 ? `…(+${e.themes.size - 3})` : ''),
      n_raw:      n,
    })
  }
  rows.sort((a, b) => b.n_raw - a.n_raw)
  // 只保留 top 20(避免长尾)
  const top = rows.slice(0, 20)
  return { columns: TABLE8_COLUMNS, rows: top, total_studies: totalStudies, total_unique_instruments: rows.length }
}

// ============================================================
// Table 9: Methodology Distribution(study_design × theme)
// ============================================================
// 列:Theme · 设计类型 1 · 设计类型 2 · ... · Total
//   动态列:横向是各 study_design family,纵向是 theme
//   families 由实际数据派生(归一化常见值:RCT / quasi / cohort / cross-sectional / qual / mixed / case-study / DBR / other)
const DESIGN_FAMILIES = [
  { key: 'rct',           label: 'RCT',                 match: /\b(rct|randomi[sz]ed)\b/i },
  { key: 'quasi',         label: 'Quasi-experiment',    match: /\bquasi/i },
  { key: 'cohort',        label: 'Cohort',              match: /\bcohort/i },
  { key: 'cross_sect',    label: 'Cross-sectional',     match: /cross[\s-]?sectional/i },
  { key: 'case_control',  label: 'Case-control',        match: /case[\s-]?control/i },
  { key: 'qualitative',   label: 'Qualitative',         match: /\b(qualitative|phenomenolog|ethnograph|grounded[\s-]?theory|case[\s-]?study|interview|focus[\s-]?group)\b/i },
  { key: 'mixed',         label: 'Mixed-methods',       match: /mixed[\s-]?method/i },
  { key: 'dbr',           label: 'Design-based',        match: /design[\s-]?based|DBR/i },
  { key: 'review',        label: 'Review / Meta',       match: /\b(systematic[\s-]?review|meta[\s-]?analysis|scoping[\s-]?review|review)\b/i },
  { key: 'experiment',    label: 'Lab experiment',      match: /experiment(?!.*quasi)/i },
  { key: 'other',         label: 'Other',               match: /./ },
]

function classifyDesign(designText) {
  if (!designText) return 'other'
  const s = String(designText)
  for (const f of DESIGN_FAMILIES) {
    if (f.key === 'other') continue
    if (f.match.test(s)) return f.key
  }
  return 'other'
}

export function buildMethodologyDistribution(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  const themes = loadThemesMeta(db, projectId)
  if (papers.length === 0) return { columns: [], rows: [], total_studies: 0, families: [] }

  // 各 theme × family 计数
  const counts = new Map()   // theme_id → { [familyKey]: n, total: n }
  for (const t of themes) counts.set(t.id, {})
  const unassigned = {}

  // 找哪些 family 在数据中真出现
  const familiesUsed = new Set()
  for (const p of papers) {
    const fam = classifyDesign(p.fields.study_design)
    familiesUsed.add(fam)
    if (p.themes.length === 0) {
      unassigned[fam] = (unassigned[fam] || 0) + 1
      continue
    }
    for (const th of p.themes) {
      const bucket = counts.get(th.id) || {}
      bucket[fam] = (bucket[fam] || 0) + 1
      counts.set(th.id, bucket)
    }
  }

  // 只保留出现过的 families(按 DESIGN_FAMILIES 顺序)
  const familyList = DESIGN_FAMILIES.filter((f) => familiesUsed.has(f.key))
  const columns = [
    { key: 'theme', label: 'Theme', width_em: 20 },
    ...familyList.map((f) => ({ key: f.key, label: f.label, width_em: 8 })),
    { key: 'total', label: 'Total', width_em: 6 },
  ]

  const rows = []
  for (const t of themes) {
    const bucket = counts.get(t.id) || {}
    const row = { theme: truncate(t.name, 60), total: 0 }
    for (const f of familyList) {
      const n = bucket[f.key] || 0
      row[f.key] = n
      row.total += n
    }
    rows.push(row)
  }
  if (Object.keys(unassigned).length > 0) {
    const row = { theme: '(Unassigned to theme)', total: 0 }
    for (const f of familyList) {
      const n = unassigned[f.key] || 0
      row[f.key] = n
      row.total += n
    }
    rows.push(row)
  }

  return { columns, rows, total_studies: papers.length, families: familyList }
}

// ============================================================
// Table 10: Sample Size Descriptives
// ============================================================
// 列:Theme · N studies(with N data) · Min · Median · Max · IQR · Total participants
const TABLE10_COLUMNS = [
  { key: 'theme',      label: 'Theme',                       width_em: 20 },
  { key: 'n_studies',  label: '№ Studies (with N)',          width_em: 6 },
  { key: 'min',        label: 'Min',                         width_em: 6 },
  { key: 'median',     label: 'Median',                      width_em: 6 },
  { key: 'max',        label: 'Max',                         width_em: 6 },
  { key: 'iqr',        label: 'IQR (Q1-Q3)',                 width_em: 8 },
  { key: 'total',      label: 'Σ Participants',              width_em: 8 },
]

function parseSampleN(raw) {
  if (raw == null) return null
  const s = String(raw).replace(/[,\s]/g, '')
  // 取第一个数字片段
  const m = s.match(/\d+/)
  if (!m) return null
  const n = Number(m[0])
  return (n > 0 && n < 1e7) ? n : null
}

function descriptiveStats(nums) {
  if (!nums.length) return { min: null, median: null, max: null, q1: null, q3: null, total: 0 }
  const sorted = [...nums].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const total = sorted.reduce((a, b) => a + b, 0)
  const q = (p) => {
    const pos = (sorted.length - 1) * p
    const lo = Math.floor(pos), hi = Math.ceil(pos)
    return sorted[lo] === sorted[hi] ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
  }
  return { min, median: Math.round(q(0.5)), max, q1: Math.round(q(0.25)), q3: Math.round(q(0.75)), total }
}

export function buildSampleSizeDescriptives(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  const themes = loadThemesMeta(db, projectId)
  if (papers.length === 0) return { columns: TABLE10_COLUMNS, rows: [], total_studies: 0 }

  const byTheme = new Map()   // theme_id → { name, sizes: [] }
  for (const t of themes) byTheme.set(t.id, { name: t.name, sizes: [] })
  const overall = []
  const unassigned = []
  for (const p of papers) {
    const n = parseSampleN(p.fields.sample_size_total)
    if (n == null) continue
    overall.push(n)
    if (p.themes.length === 0) unassigned.push(n)
    for (const th of p.themes) {
      if (byTheme.has(th.id)) byTheme.get(th.id).sizes.push(n)
    }
  }

  function fmtRow(label, sizes) {
    const s = descriptiveStats(sizes)
    return {
      theme:     truncate(label, 60),
      n_studies: sizes.length,
      min:       s.min ?? '—',
      median:    s.median ?? '—',
      max:       s.max ?? '—',
      iqr:       (s.q1 != null && s.q3 != null) ? `${s.q1}-${s.q3}` : '—',
      total:     s.total > 0 ? s.total.toLocaleString() : '—',
    }
  }

  const rows = []
  rows.push(fmtRow('All themes (overall)', overall))
  for (const [, info] of byTheme.entries()) {
    if (info.sizes.length > 0) rows.push(fmtRow(info.name, info.sizes))
  }
  if (unassigned.length > 0) rows.push(fmtRow('(Unassigned to theme)', unassigned))

  return { columns: TABLE10_COLUMNS, rows, total_studies: papers.length, with_n_data: overall.length }
}

// ============================================================
// Table 11: Effect Direction Summary
// ============================================================
// 启发式从 key_findings / quantitative_results 文字判效应方向
// 列:Theme · Positive · Negative · Mixed · No-effect · Unclear · Total
const TABLE11_COLUMNS = [
  { key: 'theme',     label: 'Theme',     width_em: 18 },
  { key: 'positive',  label: 'Positive',  width_em: 6 },
  { key: 'negative',  label: 'Negative',  width_em: 6 },
  { key: 'mixed',     label: 'Mixed',     width_em: 6 },
  { key: 'no_effect', label: 'No effect', width_em: 6 },
  { key: 'unclear',   label: 'Unclear',   width_em: 6 },
  { key: 'total',     label: 'Total',     width_em: 5 },
]

const RE_POS = /\b(improv|increas|enhanc|positive|benefici|effective|significant.*(?!.*(no|not|in)significant))|signif.*(higher|better|greater|stronger)|effective.*\b/i
const RE_NEG = /\b(decreas|reduc|worse|negative|harmful|adverse|detriment|signif.*(lower|worse))\b/i
const RE_NULL= /\b(no.*(significant|effect|difference|change)|not.*signif|null|insignificant|no improvement)\b/i
const RE_MIX = /\b(mixed|contradict|inconsist|varied|both positive and negative|partial|moderating)\b/i

function classifyEffect(text) {
  if (!text) return 'unclear'
  const s = String(text)
  const isMixed = RE_MIX.test(s)
  const isPos   = RE_POS.test(s)
  const isNeg   = RE_NEG.test(s)
  const isNull  = RE_NULL.test(s)
  if (isMixed) return 'mixed'
  if (isPos && isNeg) return 'mixed'
  if (isPos && !isNeg) return 'positive'
  if (isNeg && !isPos) return 'negative'
  if (isNull) return 'no_effect'
  return 'unclear'
}

export function buildEffectDirectionSummary(db, projectId) {
  const papers = loadIncludedWithMatrix(db, projectId)
  const themes = loadThemesMeta(db, projectId)
  if (papers.length === 0) return { columns: TABLE11_COLUMNS, rows: [], total_studies: 0 }

  const byTheme = new Map()
  for (const t of themes) byTheme.set(t.id, { name: t.name, positive: 0, negative: 0, mixed: 0, no_effect: 0, unclear: 0 })
  const overall = { positive: 0, negative: 0, mixed: 0, no_effect: 0, unclear: 0 }
  for (const p of papers) {
    const text = [p.fields.key_findings || '', p.fields.quantitative_results || ''].join(' · ')
    const cls = classifyEffect(text)
    overall[cls]++
    for (const th of p.themes) {
      const bucket = byTheme.get(th.id)
      if (bucket) bucket[cls]++
    }
  }

  function row(name, b) {
    return {
      theme:     truncate(name, 60),
      positive:  b.positive,
      negative:  b.negative,
      mixed:     b.mixed,
      no_effect: b.no_effect,
      unclear:   b.unclear,
      total:     b.positive + b.negative + b.mixed + b.no_effect + b.unclear,
    }
  }

  const rows = [row('All themes (overall)', overall)]
  for (const [, info] of byTheme.entries()) {
    rows.push(row(info.name, info))
  }
  return { columns: TABLE11_COLUMNS, rows, total_studies: papers.length }
}

// ============================================================
// Table 12: Cross-Theme Overlap Matrix
// ============================================================
// 列:行 = theme A,列 = theme B,cell = 重叠论文数
// 对称矩阵,对角线 = 该 theme 的论文数
export function buildCrossThemeOverlap(db, projectId) {
  const themes = loadThemesMeta(db, projectId)
  if (themes.length === 0) return { columns: [], rows: [], total_themes: 0 }

  // 各 theme 论文集合
  const setMap = new Map()
  for (const t of themes) setMap.set(t.id, new Set(t.supporting_record_ids))

  const columns = [
    { key: 'theme', label: 'Theme', width_em: 18 },
    ...themes.map((t, i) => ({ key: `t_${t.id}`, label: `T${i + 1}`, full_label: t.name, width_em: 6 })),
  ]

  const rows = []
  themes.forEach((tA, i) => {
    const row = { theme: `T${i + 1}. ${truncate(tA.name, 50)}` }
    themes.forEach((tB, j) => {
      const setA = setMap.get(tA.id)
      const setB = setMap.get(tB.id)
      let n = 0
      for (const rid of setA) if (setB.has(rid)) n++
      row[`t_${tB.id}`] = n
      // 对角线特殊标记
      if (i === j) row[`t_${tB.id}`] = `${n}*`
    })
    rows.push(row)
  })

  return { columns, rows, total_themes: themes.length, note: '* 对角线 = 该主题的论文数(不是重叠)' }
}

// ============================================================
// Table 13: PICO ↔ Theme Coverage Matrix
// ============================================================
// 行 = research question;列 = theme;cell = 是否覆盖(✓ / —)+ 主题该 RQ 关联强度
// 用 themes.maps_to_research_questions(Step 6 已填) + protocol.research_questions
export function buildPicoThemeCoverage(db, projectId) {
  const protocol = loadProtocolApproved(db, projectId)
  const themes = loadThemesMeta(db, projectId)
  if (!protocol || !themes.length) return { columns: [], rows: [], total_themes: 0, total_rqs: 0 }

  const rqs = Array.isArray(protocol.research_questions) ? protocol.research_questions : []
  if (!rqs.length) return { columns: [], rows: [], total_themes: 0, total_rqs: 0 }

  // RQ key 归一(简短 label)
  //   修 bug:原始 RQ 文本若已经以 "RQ1." / "RQ 1:" / "Q1." 等开头(协议生成器写的形式),
  //   strip 掉那个前缀,避免 row.rq 拼成 "RQ1. RQ1. In what learning..." 双前缀。
  const rqLabels = rqs.map((q, i) => {
    let txt = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
    txt = String(txt).replace(/^\s*(RQ|Q|R)\s*\d+\s*[.:、:]\s*/i, '').trim()
    return { key: `RQ${i + 1}`, label: `RQ${i + 1}`, full: truncate(txt, 200) }
  })

  const columns = [
    { key: 'rq',       label: 'Research Question', width_em: 24 },
    ...themes.map((t, i) => ({ key: `t_${t.id}`, label: `T${i + 1}`, full_label: t.name, width_em: 6 })),
    { key: 'coverage', label: '№ Themes',          width_em: 6 },
  ]

  const rows = []
  for (const rq of rqLabels) {
    const row = { rq: `${rq.key}. ${rq.full}`, coverage: 0 }
    for (const t of themes) {
      const maps = t.maps_to_research_questions || []
      const matched = maps.some((m) => {
        const ms = String(m || '').toLowerCase()
        return ms === rq.key.toLowerCase() || ms.includes(rq.key.toLowerCase())
      })
      row[`t_${t.id}`] = matched ? '✓' : '—'
      if (matched) row.coverage++
    }
    rows.push(row)
  }

  return { columns, rows, total_themes: themes.length, total_rqs: rqs.length }
}

// ============================================================
// Table 14: Evidence Gaps Registry
// ============================================================
// 列:Source(Theme name | Cross-cutting | Uncovered RQ) · Gap statement · Priority
const TABLE14_COLUMNS = [
  { key: 'source',   label: 'Source',          width_em: 16 },
  { key: 'type',     label: 'Type',            width_em: 10 },
  { key: 'gap',      label: 'Gap statement',   width_em: 36 },
]

export function buildEvidenceGapsRegistry(db, projectId) {
  const themes = loadThemesMeta(db, projectId)
  const meta = loadSynthesisMeta(db, projectId)
  const protocol = loadProtocolApproved(db, projectId)

  const rows = []
  // 1) 主题级 evidence_gaps
  for (const t of themes) {
    const gaps = t.evidence_gaps || []
    for (const g of gaps) {
      const text = typeof g === 'string' ? g : (g?.text || g?.gap || JSON.stringify(g))
      rows.push({
        source: `Theme: ${truncate(t.name, 60)}`,
        type:   'Theme-internal',
        gap:    truncate(text, 300),
      })
    }
  }
  // 2) 跨主题观察(若被识别为 gap)
  if (meta?.cross_cutting_observations) {
    for (const o of meta.cross_cutting_observations) {
      const txt = typeof o === 'string' ? o : (o?.text || JSON.stringify(o))
      // 仅当包含 gap/missing/lack/未研究 等词时纳入
      if (/\b(gap|missing|lack|absent|unclear|uncertain|no.*evidence|未.*研究|缺.*研究|有限)\b/i.test(txt)) {
        rows.push({
          source: 'Cross-cutting observation',
          type:   'Cross-cutting',
          gap:    truncate(txt, 300),
        })
      }
    }
  }
  // 3) 未覆盖的 RQ(从 protocol_coverage 反查)
  if (meta?.protocol_coverage && protocol?.research_questions) {
    const cov = meta.protocol_coverage
    protocol.research_questions.forEach((q, i) => {
      const key = `RQ${i + 1}`
      const entry = cov[key] || cov[`RQ${i + 1}`] || cov[`rq${i + 1}`] || null
      const isUncovered = entry == null || (typeof entry === 'string' && /uncovered|no.*paper|no.*evidence|gap/i.test(entry))
      if (isUncovered) {
        const qText = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        rows.push({
          source: `${key} (no theme covers)`,
          type:   'Uncovered RQ',
          gap:    truncate(qText, 300),
        })
      }
    })
  }

  return { columns: TABLE14_COLUMNS, rows, total_gaps: rows.length }
}

// ============================================================
// 渲染器:Markdown / CSV / LaTeX
// ============================================================

// Markdown table
// 2026-05-26:加 headingLevel 选项(默认 'h3')
//   - 'h3' = `### Title` —— 单文件下载场景,作主标题
//   - 'h4' = `#### Title` —— 当 caller(如 appendix)已包了外层 `### Table N.` 时,
//                            子表用 h4 让层级正确,不再撞同级 heading
//   - 'none' / falsy title:完全不输出 heading 行(单表 appendix 用,wrapper 已提供 ###)
export function renderTableMd({ columns, rows, title, headingLevel = 'h3' }) {
  const out = []
  if (title && headingLevel !== 'none') {
    const prefix = headingLevel === 'h4' ? '####' : '###'
    out.push(`${prefix} ${title}`, '')
  }
  out.push('| ' + columns.map((c) => c.label).join(' | ') + ' |')
  out.push('| ' + columns.map(() => '---').join(' | ') + ' |')
  for (const r of rows) {
    out.push('| ' + columns.map((c) => String(r[c.key] ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |')
  }
  return out.join('\n')
}

// CSV table
export function renderTableCsv({ columns, rows }) {
  function esc(v) {
    const s = String(v ?? '')
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const out = [columns.map((c) => esc(c.label)).join(',')]
  for (const r of rows) {
    out.push(columns.map((c) => esc(r[c.key])).join(','))
  }
  return out.join('\n')
}

// LaTeX table(longtable + booktabs)
// 2026-05-26:cell 内 [rec_<id>] 占位先转 \citep{rec_<id>} 再走 escapeLatex,
//   否则方括号/下划线会被当字面量,citation 全死。 同步处理 [fig:xxx]
//   [tbl:xxx](与文中段一致),前面已有 sanitizeLatexPlaceholders 但表格
//   走的是单独 escapeLatex 路径,这里复刻最小子集。
function escapeCellWithPlaceholders(raw) {
  const s = String(raw ?? '—')
  // 把所有 [rec_xxx] / [fig:xxx] / [tbl:xxx] 切出来,分别处理
  const parts = s.split(/(\[(?:rec_[A-Za-z0-9_]+|(?:fig|tbl):[A-Za-z0-9_\-]+)\])/g)
  return parts.map((p) => {
    let m
    if ((m = p.match(/^\[rec_([A-Za-z0-9_]+)\]$/))) return `\\citep{rec_${m[1]}}`
    if ((m = p.match(/^\[fig:([A-Za-z0-9_\-]+)\]$/))) return `\\ref{fig:${m[1]}}`
    if ((m = p.match(/^\[tbl:([A-Za-z0-9_\-]+)\]$/))) return `\\ref{tab:${m[1]}}`
    return escapeLatex(p)
  }).join('')
}

export function renderTableLatex({ columns, rows, title, caption, label }) {
  const out = []
  const cspec = columns.map((c) => 'l').join(' ')  // 简单 left-align;实际可按 width_em 调
  if (caption || label) {
    out.push('\\begin{table}[!htbp]')
    out.push('\\centering')
    if (caption) out.push(`\\caption{${escapeLatex(caption)}}`)
    if (label) out.push(`\\label{${label}}`)
  }
  out.push(`\\begin{tabular}{${cspec}}`)
  out.push('\\toprule')
  out.push(columns.map((c) => '\\textbf{' + escapeLatex(c.label) + '}').join(' & ') + ' \\\\')
  out.push('\\midrule')
  for (const r of rows) {
    out.push(columns.map((c) => escapeCellWithPlaceholders(r[c.key])).join(' & ') + ' \\\\')
  }
  out.push('\\bottomrule')
  out.push('\\end{tabular}')
  if (caption || label) out.push('\\end{table}')
  return out.join('\n')
}

function escapeLatex(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/⊕/g, '$\\oplus$')
    .replace(/○/g, '$\\circ$')
}

// ============================================================
// 主合并入口:跑全部 4 张表(供 GET /report 一次性渲染)
// ============================================================

export function buildAllReviewTables(db, projectId) {
  return {
    table1: buildCharacteristicsTablesByTheme(db, projectId),
    table2: buildSoFTable(db, projectId),
    table3a: buildRobTrafficLight(db, projectId),
    table3b: buildRobDomainSummary(db, projectId),
    table4: buildEvidenceProfileTable(db, projectId),
  }
}

// ============================================================
// 单表导出助手(给 GET /report/tables/:tableKey.md/.csv/.tex 用)
// ============================================================

// 给 [table1, table2, table3a, table3b, table4] 各自的 .md / .csv / .latex 字符串
// 2026-05-26:加 opts.numberPrefix(默认 true):
//   - true(单表下载 GET /report/tables/:key.md):title 含 "Table 2. Xxx" — 用户拿到 .md 文件
//     单独看能识别这是 Table 2。
//   - false(报告 Tables appendix 拼装时):routes/report.js 的 tablesAppendix 生成器
//     已经按动态首现顺序加了 `### Table {n}. {label}` 包装,所以这里再加 "Table 2."
//     会导致 **双 heading**(用户看到的"多个 Table 2/Table 5"P0 bug)。
//     appendix 调用时传 numberPrefix: false,只输出描述性 title(如 "Summary of
//     Findings (N=18 outcomes)"),不带 "Table N." 前缀。
export function renderTableExport(tables, tableKey, format, opts = {}) {
  const numberPrefix = opts.numberPrefix !== false   // 默认 true(向后兼容)

  // 2026-05-26 修每张表的双 heading:
  //   - numberPrefix=true(单文件 .md/.csv/.tex 下载):title 含 "Table N." 前缀 + h3 inner heading,
  //     用户单独看 .md 文件能识别。
  //   - numberPrefix=false(报告 appendix 拼装):wrapper 已加 `### Table N. {label}`,
  //     这里的 inner heading 必须避让:
  //       · 单表 (table2/4/5-14)        → 完全不输 inner heading,只输表体(h4='none')
  //       · 多子表 (table1/3a/3b)        → 子表用 h4 `#### (a) ...`,层级低于 wrapper 的 h3
  function r(t, fmt, title, headingLevel = 'h3') {
    if (fmt === 'md')    return renderTableMd({ ...t, title, headingLevel })
    if (fmt === 'csv')   return renderTableCsv(t)
    if (fmt === 'latex') return renderTableLatex({ ...t, caption: title, label: `tab:${tableKey}` })
    return ''
  }
  const innerHeading = numberPrefix ? 'h3' : 'none'  // 单表 inner heading 等级
  const subHeading   = numberPrefix ? 'h3' : 'h4'    // 多子表 inner heading 等级

  if (tableKey === 'table1') {
    // Table 1 是 multi-subtable
    const parts = []
    tables.table1.subtables.forEach((sub, i) => {
      const letter = String.fromCharCode(97 + i)   // a, b, c, ...
      // #250:正文是核心子集 —— caption 注明 "X of Y shown; full list in Table S1"
      const shown = (sub.rows || []).length
      const total = sub.total_in_theme || shown
      const countTxt = (sub.omitted_count > 0)
        ? `${shown} of ${total} studies shown — full list in Supplementary Table S1`
        : `N=${total}`
      const title = numberPrefix
        ? `${sub.theme_label}. Characteristics of core studies in theme: ${sub.theme_name} (${countTxt})`
        : `(${letter}) ${sub.theme_name} (${countTxt})`
      parts.push(r({ columns: sub.columns, rows: sub.rows }, format, title, subHeading))
    })
    if (format === 'csv') return parts.join('\n\n')
    return parts.join('\n\n')
  }

  if (tableKey === 'table2') {
    const title = numberPrefix
      ? `Table 2. Summary of Findings (N=${tables.table2.total_outcomes} outcomes)`
      : ''   // appendix 已有 wrapper,无 inner heading
    return r({ columns: tables.table2.columns, rows: tables.table2.rows }, format, title, innerHeading)
  }

  if (tableKey === 'table3a') {
    // 按 tool 分组,每组一表
    const parts = []
    tables.table3a.tools.forEach((toolGroup, i) => {
      const cols = [
        { key: 'study', label: 'Study', width_em: 14 },
        ...toolGroup.domains.map((d) => ({ key: d.key, label: d.label, width_em: 8 })),
        { key: 'overall_rating', label: 'Overall', width_em: 8 },
      ]
      const rows = toolGroup.studies.map((s) => {
        const row = { study: s.study, overall_rating: s.overall.rating || '—' }
        for (const c of s.cells) row[c.domain_key] = (c.rating || '—')
        return row
      })
      const letter = String.fromCharCode(97 + i)
      const title = numberPrefix
        ? `Table 3a (${toolGroup.label}). Risk of Bias — per-study (N=${toolGroup.study_count})`
        : `(${letter}) ${toolGroup.label} — per-study (N=${toolGroup.study_count})`
      parts.push(r({ columns: cols, rows }, format, title, subHeading))
    })
    return parts.join('\n\n')
  }

  if (tableKey === 'table3b') {
    // 按 tool 分组,每组一表
    const parts = []
    tables.table3b.tools.forEach((toolGroup, i) => {
      const cols = [
        { key: 'domain_label', label: 'Domain', width_em: 14 },
        { key: 'good',    label: 'Low',     width_em: 6 },
        { key: 'middle',  label: 'Some',    width_em: 6 },
        { key: 'bad',     label: 'High',    width_em: 6 },
        { key: 'unclear', label: 'Unclear', width_em: 6 },
        { key: 'pct_good',   label: '% Low',     width_em: 6 },
        { key: 'pct_middle', label: '% Some',    width_em: 6 },
        { key: 'pct_bad',    label: '% High',    width_em: 6 },
      ]
      const rows = toolGroup.domain_summary
      const letter = String.fromCharCode(97 + i)
      const title = numberPrefix
        ? `Table 3b (${toolGroup.label}). RoB Domain Summary (N=${toolGroup.study_count} studies)`
        : `(${letter}) ${toolGroup.label} — RoB Domain Summary (N=${toolGroup.study_count} studies)`
      parts.push(r({ columns: cols, rows }, format, title, subHeading))
    })
    return parts.join('\n\n')
  }

  if (tableKey === 'table4') {
    const title = numberPrefix
      ? `Table 4. Evidence Profile — GRADE / CERQual (N=${tables.table4.total_themes} themes)`
      : ''   // appendix 已有 wrapper
    return r({ columns: tables.table4.columns, rows: tables.table4.rows }, format, title, innerHeading)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Table 5-14:通用 fallback — 都是 {columns, rows} 单表结构
  //   numberPrefix=true → 含 "Table N." 前缀 + h3 heading(单文件下载用)
  //   numberPrefix=false → 完全无 inner heading(appendix 用,wrapper 已提供 ###)
  // ────────────────────────────────────────────────────────────────────────
  const td = tables[tableKey]
  if (!td || !td.columns || !td.rows) return ''
  const labelMap = {
    table1_full: 'Table S1. Characteristics of All Included Studies (Supplementary)',
    table5:  'Table 5. Geographic Distribution',
    table6:  'Table 6. Timeline / Year Trend',
    table7:  'Table 7. Theoretical Framework Usage',
    table8:  'Table 8. Measurement Instruments',
    table9:  'Table 9. Methodology Distribution (Theme × Design family)',
    table10: 'Table 10. Sample Size Descriptives',
    table11: 'Table 11. Effect Direction Summary',
    table12: 'Table 12. Cross-Theme Overlap Matrix',
    table13: 'Table 13. PICO ↔ Theme Coverage Matrix',
    table14: 'Table 14. Evidence Gaps Registry',
  }
  const title = numberPrefix ? (labelMap[tableKey] || tableKey) : ''
  return r({ columns: td.columns, rows: td.rows }, format, title, innerHeading)
}
