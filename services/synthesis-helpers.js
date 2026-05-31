/**
 * Step 6 synthesis helpers
 * ------------------------------------------------------------
 * 把 Step 1-5 的定稿数据聚合成 LLM-ready 输入,并给 LLM 输出做本地校验/补全。
 *
 * 设计原则:
 *   - 纯函数,不调 LLM,不写 DB(只读)
 *   - 上游表如果没有数据 → 返回空 / null,调用方决定是否兜底
 *   - 大对象用 .slice() 截断,LLM context 安全
 */

import crypto from 'node:crypto'
import { getMatrixForRecord } from './literature-matrix.js'
import { listRobForProject } from './rob.js'

// ============================================================
// computeUpstreamFingerprint — 上游变更检测(防重复烧 token)
// ============================================================
//
// 输入:projectId(数据库读)
// 输出:{ fingerprint, parts: {protocol_v, include_set, matrix_sig, rob_sig, overlay_sig, post_rob_excluded_n} }
//
// fingerprint = sha1 of (protocol_v + sorted include IDs + matrix max(updated_at)
//                       + rob max(updated_at) + overlay sha1 + post-RoB excluded count)
//
// 思路:任何会影响 Step 6 synthesis LLM 输入的上游字段一变 → fingerprint 变。
//   - 协议改了(version 变)
//   - include 集合(record IDs 变了)
//   - post-RoB 排除(数量变了)
//   - matrix 内容(任一行 updated_at 变 → max 变)
//   - RoB 评估(同上)
//   - overlay 文本(synthesis_master_prompt_overlay 变)
//
// 没变 = 上次 success 时存在 synthesis_run_meta.upstream_fingerprint,
//        现在重算等于上次值 → POST /run 拒绝(可 ?force=1 绕过)。

export function computeUpstreamFingerprint(db, projectId, kind = 'synthesis') {
  // kind 当前只有 'synthesis';future certainty 走另一个 helper
  const parts = {}

  try {
    const protoRow = db.prepare(
      `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
    ).get(projectId)
    parts.protocol_v = protoRow?.version || 0
  } catch { parts.protocol_v = 0 }

  try {
    const incIds = db.prepare(
      `SELECT r.id FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
          AND r.rob_excluded_at IS NULL
        ORDER BY r.id ASC`
    ).all(projectId).map((r) => r.id)
    parts.include_n = incIds.length
    parts.include_sig = crypto.createHash('sha1').update(incIds.join('|')).digest('hex').slice(0, 12)
  } catch { parts.include_n = 0; parts.include_sig = 'none' }

  try {
    const exRow = db.prepare(
      `SELECT COUNT(*) AS c FROM records r JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ? AND sd.stage='title_abstract' AND sd.human_decision='include'
          AND r.rob_excluded_at IS NOT NULL`
    ).get(projectId)
    parts.post_rob_excluded_n = exRow?.c || 0
  } catch { parts.post_rob_excluded_n = 0 }

  try {
    const mat = db.prepare(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS mx FROM literature_matrix WHERE project_id = ?`
    ).get(projectId)
    parts.matrix_sig = `${mat?.n || 0}@${mat?.mx || 'none'}`
  } catch { parts.matrix_sig = '0@none' }

  try {
    const rob = db.prepare(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS mx FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`
    ).get(projectId)
    parts.rob_sig = `${rob?.n || 0}@${rob?.mx || 'none'}`
  } catch { parts.rob_sig = '0@none' }

  try {
    const ovRow = db.prepare(
      kind === 'certainty'
        ? `SELECT certainty_master_prompt_overlay AS ov, certainty_master_prompt_at_version AS av FROM projects WHERE id = ?`
        : `SELECT synthesis_master_prompt_overlay AS ov, synthesis_master_prompt_at_version AS av FROM projects WHERE id = ?`
    ).get(projectId)
    if (ovRow?.ov) {
      parts.overlay_sig = crypto.createHash('sha1').update(String(ovRow.ov)).digest('hex').slice(0, 12) + `@v${ovRow.av || '?'}`
    } else {
      parts.overlay_sig = 'none'
    }
  } catch { parts.overlay_sig = 'none' }

  const combined = JSON.stringify(parts)
  const fingerprint = crypto.createHash('sha1').update(combined).digest('hex').slice(0, 16)
  return { fingerprint, parts }
}

// Step 7 专用上游指纹:除了 Step 6 的全部 + themes 表内容(主题改了也算上游变了)
export function computeCertaintyUpstreamFingerprint(db, projectId) {
  const base = computeUpstreamFingerprint(db, projectId, 'certainty')
  const parts = { ...base.parts }
  try {
    const themes = db.prepare(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS mx FROM themes WHERE project_id = ?`
    ).get(projectId)
    parts.themes_sig = `${themes?.n || 0}@${themes?.mx || 'none'}`
  } catch { parts.themes_sig = '0@none' }
  try {
    const sm = db.prepare(
      `SELECT generated_at FROM synthesis_meta WHERE project_id = ? LIMIT 1`
    ).get(projectId)
    parts.synthesis_meta_sig = sm?.generated_at || 'none'
  } catch { parts.synthesis_meta_sig = 'none' }
  const combined = JSON.stringify(parts)
  const fingerprint = crypto.createHash('sha1').update(combined).digest('hex').slice(0, 16)
  return { fingerprint, parts }
}

// ------------------------------------------------------------
// 协议加载(只读 approved protocol)
// ------------------------------------------------------------

function parseJsonArr(v) {
  if (!v) return []
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(x) ? x : []
  } catch { return [] }
}

function parseObj(v) {
  if (!v) return null
  try {
    return typeof v === 'string' ? JSON.parse(v) : v
  } catch { return null }
}

/**
 * 加载 approved 协议的完整结构(不只 research_questions)。
 * 返回 null 表示项目还没批协议。
 */
export function loadApprovedProtocolFull(db, projectId) {
  const row = db.prepare(
    `SELECT * FROM protocols
       WHERE project_id = ? AND approved_by_user = 1
       ORDER BY version DESC LIMIT 1`
  ).get(projectId)
  if (!row) return null

  return {
    id: row.id,
    version: row.version,
    research_questions: parseJsonArr(row.research_questions),
    inclusion_criteria: parseJsonArr(row.inclusion_criteria),
    exclusion_criteria: parseJsonArr(row.exclusion_criteria),
    concept_groups: parseJsonArr(row.concept_groups),
    review_type: row.review_type || null,
    rationale: row.rationale || null,
    notes: row.notes || null,
    approved_at: row.approved_at || null,
  }
}

// ------------------------------------------------------------
// Step 2: locked search queries
// ------------------------------------------------------------

export function listFinalSearchQueries(db, projectId) {
  try {
    const rows = db.prepare(
      `SELECT database_name, query_text, result_count, search_date, notes, locked_at
         FROM final_search_records
         WHERE project_id = ?
         ORDER BY database_name ASC`
    ).all(projectId)
    return rows || []
  } catch {
    // 表可能不存在或老 schema
    return []
  }
}

// ------------------------------------------------------------
// Step 3: screening rationale per record
// ------------------------------------------------------------

export function listScreeningReasonsByRecord(db, projectId) {
  const rows = db.prepare(
    `SELECT record_id, ai_suggestion, ai_reason, ai_confidence,
            ai_matched_inclusion, ai_matched_exclusion, ai_matched_concepts,
            human_decision, human_reason
       FROM screening_decisions
       WHERE project_id = ? AND stage = 'title_abstract' AND human_decision = 'include'`
  ).all(projectId)

  const map = new Map()
  for (const r of rows) {
    map.set(r.record_id, {
      ai_suggestion: r.ai_suggestion,
      ai_reason: r.ai_reason ? String(r.ai_reason).slice(0, 200) : null,
      ai_confidence: r.ai_confidence,
      ai_matched_inclusion: parseJsonArr(r.ai_matched_inclusion),
      ai_matched_exclusion: parseJsonArr(r.ai_matched_exclusion),
      ai_matched_concepts: parseJsonArr(r.ai_matched_concepts),
      human_decision: r.human_decision,
      human_reason: r.human_reason ? String(r.human_reason).slice(0, 200) : null,
    })
  }
  return map
}

// ------------------------------------------------------------
// Step 4: matrix fields per record
// ------------------------------------------------------------

export function listMatrixFieldsByRecord(db, projectId, recordIds) {
  const map = new Map()
  for (const rid of recordIds) {
    const row = getMatrixForRecord(db, projectId, rid)
    if (!row) continue
    let fields = null
    if (row.fields) {
      try {
        fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields
      } catch { fields = null }
    }
    if (fields && typeof fields === 'object') {
      map.set(rid, {
        fields,
        completeness: row.completeness,
        filled_by: row.filled_by,
      })
    }
  }
  return map
}

// ------------------------------------------------------------
// Step 5: RoB primary (rater_pass=1) per record
// ------------------------------------------------------------

export function listRobByRecord(db, projectId) {
  const rows = listRobForProject(db, projectId)
  const map = new Map()
  for (const r of rows) {
    // M30+ 升级:overall_rationale 从 200 char 放宽到 1500
    //   GRADE/CERQual 评估需要 "为啥 RoB 高" 的具体说明,200 char 不够
    map.set(r.record_id, {
      tool: r.tool,
      tool_version: r.tool_version,
      overall_rating: r.overall_rating,
      overall_rationale: r.overall_rationale ? String(r.overall_rationale).slice(0, 1500) : null,
      judgments_json: r.judgments_json || null,    // 单域评级(rob2 5 域 / mmat 5 项 / 等)
    })
  }
  return map
}

// ------------------------------------------------------------
// 1 篇论文的"丰富画像" — 用于 LLM 输入拼接
// ------------------------------------------------------------

/**
 * 把 Step 1-5 数据聚合成一篇论文的紧凑文本块。
 * 太长会爆 token,各字段做截断。
 *
 * 返回字符串(LLM-ready,直接拼到 user prompt)。
 */
export function formatPaperProfile({ record, matrixData, robData, screeningData, idx, skipMatrix = false }) {
  const lines = []
  lines.push(`## Paper ${idx + 1}: ${record.id}`)
  lines.push(`- Title: ${(record.title || '').slice(0, 300)}`)
  if (record.year) lines.push(`- Year: ${record.year}`)
  if (record.journal) lines.push(`- Journal: ${String(record.journal).slice(0, 100)}`)
  if (record.authors_text) lines.push(`- Authors: ${String(record.authors_text).slice(0, 150)}`)

  // Matrix(核心证据字段)
  //   2026-05-25:加 skipMatrix 选项 — 当调用方同时传 rawMatrixRows 给 buildSectionUserPrompt
  //   (results/discussion 段),paperProfiles 就只负责 metadata + RoB + screening + PDF chunks,
  //   matrix 字段完全由 rawMatrixRows 渲染(不截断、全集 121 篇)→ 避免双倍 prompt size。
  //   2026-05-25 调高单字段截断:500 → 1500(核心) / 300 → 800(custom)
  //   原因:key_findings + quantitative_results 经常 500 char 不够
  //   (e.g. 多 outcome 的 effect size + CI + N + p-value + instrument 全列时)
  if (!skipMatrix && matrixData && matrixData.fields) {
    const f = matrixData.fields
    const SHORTEN = (k, max = 1500) => {
      const v = f[k]
      if (v == null) return null
      if (typeof v === 'string' && v.trim()) return v.slice(0, max)
      if (typeof v === 'number') return String(v)
      return null
    }
    // 优先输出核心方法学字段;项目自定义字段也带,放后面
    const CORE_KEYS = [
      'study_design', 'recruitment', 'sample_size', 'setting',
      'intervention', 'comparator', 'outcomes', 'measurement_tools',
      'data_source', 'analysis_method',
      'key_findings', 'quantitative_results',
      'limitations', 'ethics_funding', 'reproducibility', 'practical_implication',
      'key_concepts_defined',
    ]
    const written = new Set()
    for (const k of CORE_KEYS) {
      const v = SHORTEN(k)
      if (v) {
        lines.push(`- ${k}: ${v}`)
        written.add(k)
      }
    }
    // 项目自定义 matrix 字段(eg. dt_phase_metacog_link / metacognitive_component 等)
    for (const k of Object.keys(f)) {
      if (written.has(k)) continue
      if (CORE_KEYS.includes(k)) continue
      const v = SHORTEN(k, 800)
      if (v) lines.push(`- ${k} (custom): ${v}`)
    }
  }

  // RoB(M30+ 升级:加 rationale 全文 + 单域评级 judgments_json)
  if (robData) {
    lines.push(`- **RoB** [${robData.tool}]: overall=${robData.overall_rating || '—'}`)
    if (robData.overall_rationale) {
      lines.push(`  ↳ rationale: ${robData.overall_rationale}`)
    }
    if (robData.judgments_json) {
      try {
        const j = typeof robData.judgments_json === 'string' ? JSON.parse(robData.judgments_json) : robData.judgments_json
        if (j && typeof j === 'object') {
          // 各工具的单域评级(MMAT 5 项 / RoB2 5 域 / ROBINS-I 7 域 / NOS 9 项 / JBI 各项)
          const items = []
          for (const [k, v] of Object.entries(j)) {
            if (v == null) continue
            // judgment 通常是 { rating: 'low'|'high'|'yes'|'no', rationale: '...' } 或简单字符串
            if (typeof v === 'string') items.push(`${k}=${v}`)
            else if (typeof v === 'object' && v.rating) items.push(`${k}=${v.rating}`)
          }
          if (items.length) lines.push(`  ↳ per-domain: ${items.slice(0, 10).join(' · ')}`)
        }
      } catch { /* ignore */ }
    }
  }

  // 数据源 fallback chain(matrix 缺失时):
  //   1. matrix(优先,已抽好的结构化字段 — 上面已渲染)
  //   2. PDF chunks(仅当 advanced_extraction 用户 + 该 record 有 PDF chunks + matrix 稀疏)
  //   3. abstract(永远兜底)
  //
  // 普通用户没 PDF 上传权限 → paper_chunks 不会有数据,自动跳到 abstract。
  // 这是用户要求:"用户没论文全文 要用矩阵代替"。

  const matrixSparse = !matrixData || !matrixData.fields || Object.keys(matrixData.fields).length < 3

  // 2026-05-25 P2-8:放宽 PDF chunks 喂给的条件
  //   老逻辑:仅 matrix-sparse 时才喂 PDF chunks → matrix-rich 论文的方法学细节
  //   也丢了。matrix 字段经常是 100-500ch 摘要,PDF chunks 是原文,Discussion
  //   写"why this method matters"靠原文细节胜过 matrix 摘要。
  //   新逻辑:
  //     - matrix-sparse + PDF chunks → 3000 char(原行为,methods+results 优先)
  //     - matrix-rich + PDF chunks → 1500 char(methods+results 各 750,补充)
  //     - matrix-sparse + 无 PDF + abstract → abstract 兜底
  const hasPdfChunks = Array.isArray(record.pdfChunks) && record.pdfChunks.length > 0

  if (hasPdfChunks) {
    const priorityOrder = ['methods', 'results', 'discussion', 'conclusion', 'abstract', 'introduction']
    const sorted = [...record.pdfChunks].sort((a, b) => {
      const ai = priorityOrder.indexOf(a.section_type) === -1 ? 99 : priorityOrder.indexOf(a.section_type)
      const bi = priorityOrder.indexOf(b.section_type) === -1 ? 99 : priorityOrder.indexOf(b.section_type)
      return ai - bi
    })
    let budget = matrixSparse ? 3000 : 1500
    const perChunkCap = matrixSparse ? 1500 : 750
    const blocks = []
    for (const c of sorted) {
      if (budget <= 0) break
      const txt = String(c.text || '').slice(0, Math.min(budget, perChunkCap))
      if (!txt.trim()) continue
      blocks.push(`  [${c.section_type || 'misc'}${c.heading ? ' · ' + c.heading.slice(0, 60) : ''}] ${txt}`)
      budget -= txt.length
    }
    if (blocks.length) {
      const tag = matrixSparse ? 'matrix-sparse · PDF chunks fallback' : 'PDF chunks supplement (matrix-rich)'
      lines.push(`- (${tag}):`)
      lines.push(blocks.join('\n'))
    }
  } else if (matrixSparse && record.abstract) {
    // 没 PDF chunks → abstract 兜底(所有用户都能用,因 abstract 来自 Zotero/CSV 导入)
    lines.push(`- (matrix-sparse · abstract fallback): ${String(record.abstract).slice(0, 800)}`)
  }

  // Screening(命中标签 + 决策原因)
  //   2026-05-25 P1-7:之前漏 ai_reason / human_reason,Discussion 写"why this
  //   paper matters / why included" 没 narrative 依据 → 现在补上(每段截 200ch)
  if (screeningData) {
    const tags = []
    if (screeningData.ai_matched_concepts?.length) tags.push(`concepts=[${screeningData.ai_matched_concepts.slice(0, 4).join(', ')}]`)
    if (screeningData.ai_matched_inclusion?.length) tags.push(`inclusion=[${screeningData.ai_matched_inclusion.slice(0, 4).join(', ')}]`)
    if (screeningData.ai_confidence != null) tags.push(`ai_conf=${Number(screeningData.ai_confidence).toFixed(2)}`)
    if (tags.length) lines.push(`- Screening: ${tags.join(' · ')}`)
    if (screeningData.ai_reason) {
      lines.push(`  ↳ AI reason: ${String(screeningData.ai_reason).slice(0, 200)}`)
    }
    if (screeningData.human_reason) {
      lines.push(`  ↳ Human reason: ${String(screeningData.human_reason).slice(0, 200)}`)
    }
  }

  return lines.join('\n')
}

// ------------------------------------------------------------
// 聚合主入口:把所有上游数据 join 成 LLM-ready 字典
// ------------------------------------------------------------

/**
 * 给定项目 + records 列表,组装所有维度数据。
 *
 * @returns {{
 *   protocol: object|null,
 *   finalQueries: array,
 *   papers: Array<{ record, matrixData, robData, screeningData }>,
 *   stats: { withMatrix: number, withRob: number, withScreening: number, total: number }
 * }}
 */
export function buildSynthesisInputs(db, projectId, records, opts = {}) {
  const protocol = loadApprovedProtocolFull(db, projectId)
  const finalQueries = listFinalSearchQueries(db, projectId)
  const screeningByRid = listScreeningReasonsByRecord(db, projectId)
  const matrixByRid = listMatrixFieldsByRecord(db, projectId, records.map((r) => r.id))
  const robByRid = listRobByRecord(db, projectId)

  // 可选:加载 PDF chunks(高级用户开启时,formatPaperProfile 在 matrix 稀疏时用作 fallback)
  //   普通用户没 PDF 上传权限 → 该表也不会有数据,即使开启 includePdfChunks 也没影响
  let chunksByRid = new Map()
  if (opts.includePdfChunks && records.length) {
    try {
      const recIds = records.map((r) => r.id)
      const placeholders = recIds.map(() => '?').join(',')
      const rows = db.prepare(
        `SELECT record_id, section_type, heading, chunk_index, text
           FROM paper_chunks
          WHERE record_id IN (${placeholders})
          ORDER BY record_id, chunk_index ASC`
      ).all(...recIds)
      for (const row of rows) {
        if (!chunksByRid.has(row.record_id)) chunksByRid.set(row.record_id, [])
        chunksByRid.get(row.record_id).push(row)
      }
    } catch { /* paper_chunks may not exist */ }
  }

  let withMatrix = 0, withRob = 0, withScreening = 0, withPdfChunks = 0
  const papers = records.map((r) => {
    const matrixData = matrixByRid.get(r.id) || null
    const robData = robByRid.get(r.id) || null
    const screeningData = screeningByRid.get(r.id) || null
    const pdfChunks = chunksByRid.get(r.id) || null
    if (matrixData) withMatrix++
    if (robData) withRob++
    if (screeningData) withScreening++
    if (pdfChunks && pdfChunks.length) withPdfChunks++
    // 把 pdfChunks 塞到 record 对象,formatPaperProfile 能读 record.pdfChunks
    if (pdfChunks) r.pdfChunks = pdfChunks
    return { record: r, matrixData, robData, screeningData }
  })

  return {
    protocol,
    finalQueries,
    papers,
    stats: {
      total: records.length,
      withMatrix,
      withRob,
      withScreening,
      withPdfChunks,
    },
  }
}

// ------------------------------------------------------------
// 本地校验/补全:LLM 输出 themes 后,补 rob_profile / study_design_mix / coverage
// ------------------------------------------------------------

/**
 * 把 overall_rating + tool 折叠到 valence: 'good' / 'middle' / 'bad' / 'unrated'
 * 与 rob.js + rob.ejs 的 ratingValenceSrv 保持一致。
 */
export function ratingValenceSyn(rating, tool) {
  if (!rating) return 'unrated'
  if (tool === 'mmat') {
    if (rating === 'screening_failed') return 'bad'
    const m = String(rating).match(/^(\d+)\/(\d+)$/)
    if (m) {
      const r = parseInt(m[1], 10) / parseInt(m[2], 10)
      if (r >= 0.8) return 'good'
      if (r >= 0.4) return 'middle'
      return 'bad'
    }
    return 'unrated'
  }
  if (tool === 'nos') {
    if (rating === 'high_quality') return 'good'
    if (rating === 'moderate_quality') return 'middle'
    return 'bad'
  }
  if (tool === 'jbi_cs') {
    if (rating === 'high') return 'good'
    if (rating === 'moderate') return 'middle'
    return 'bad'
  }
  if (rating === 'low') return 'good'
  if (rating === 'some_concerns' || rating === 'moderate') return 'middle'
  if (rating === 'high' || rating === 'serious' || rating === 'critical') return 'bad'
  return 'unrated'
}

/**
 * 给一个主题的 supporting_record_ids 计算 RoB 画像。
 *   返回 {good, middle, bad, unrated}
 */
export function computeRobProfileForTheme(supportingRecordIds, robByRid) {
  const out = { good: 0, middle: 0, bad: 0, unrated: 0 }
  for (const rid of supportingRecordIds || []) {
    const rob = robByRid.get(rid)
    if (!rob) { out.unrated++; continue }
    const v = ratingValenceSyn(rob.overall_rating, rob.tool)
    out[v] = (out[v] || 0) + 1
  }
  return out
}

/**
 * 给一个主题的 supporting_record_ids 算 study_design 分布。
 *   返回 {RCT: 2, quasi: 5, qual: 8, mixed: 12, descriptive: 3, other: 1}
 */
export function computeStudyDesignMix(supportingRecordIds, matrixByRid) {
  const out = {}
  for (const rid of supportingRecordIds || []) {
    const m = matrixByRid.get(rid)
    if (!m || !m.fields) { out.unknown = (out.unknown || 0) + 1; continue }
    const d = String(m.fields.study_design || '').toLowerCase()
    let bucket = 'other'
    if (/randomi[sz]ed\s+controlled|rct\b/.test(d)) bucket = 'RCT'
    else if (/quasi[-\s]?experimental|non[-\s]?randomi/.test(d)) bucket = 'quasi'
    else if (/qualitative|phenomenology|ethnography|grounded[-\s]theory/.test(d)) bucket = 'qual'
    else if (/mixed[-\s]?method/.test(d)) bucket = 'mixed'
    else if (/cross[-\s]?sectional|descriptive|prevalence|survey/.test(d)) bucket = 'descriptive'
    else if (/cohort|case[-\s]control|longitudinal/.test(d)) bucket = 'observational'
    else if (/case\s+study/.test(d)) bucket = 'case_study'
    else if (/design[-\s]?based\s+research|\bdbr\b/.test(d)) bucket = 'DBR'
    out[bucket] = (out[bucket] || 0) + 1
  }
  return out
}

/**
 * 反查协议覆盖:哪些 RQ 没被任何主题映射。
 *   protocol.research_questions: ["RQ1 text", "RQ2 text", ...]
 *   themes: [{ maps_to_research_questions: ["RQ1", "RQ2"], id, ... }]
 *
 * 返回 { coveredBy: { RQ1: [theme_id_1, theme_id_3], ... }, uncovered: [RQ idx string] }
 */
export function computeProtocolCoverage(themes, protocol) {
  const rqs = protocol?.research_questions || []
  const coveredBy = {}
  const allRqKeys = rqs.map((_, i) => `RQ${i + 1}`)

  for (const k of allRqKeys) coveredBy[k] = []

  for (const t of themes) {
    const maps = Array.isArray(t.maps_to_research_questions) ? t.maps_to_research_questions : []
    for (const m of maps) {
      // 接受 'RQ1' / 'RQ 1' / '1' / 'rq1' / 完整 RQ text 等多种格式
      const norm = String(m || '').trim().toUpperCase().replace(/\s+/g, '')
      let matchedKey = null
      if (/^RQ?\d+$/.test(norm)) {
        const n = norm.replace(/^RQ?/, '')
        matchedKey = `RQ${n}`
      } else {
        // 尝试匹配 RQ 文本(模糊:前 30 字符比对)
        const head = String(m || '').slice(0, 30).toLowerCase()
        for (let i = 0; i < rqs.length; i++) {
          if (String(rqs[i] || '').toLowerCase().includes(head)) {
            matchedKey = `RQ${i + 1}`
            break
          }
        }
      }
      if (matchedKey && coveredBy[matchedKey]) {
        coveredBy[matchedKey].push(t.id || t.name)
      }
    }
  }

  const uncovered = allRqKeys.filter((k) => coveredBy[k].length === 0)
  return { coveredBy, uncovered }
}

// ------------------------------------------------------------
// Token 预算
// ------------------------------------------------------------

/**
 * 粗估 token 数(4 字符 ≈ 1 token,UTF-8 中英混合)
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4)
}

/**
 * 给定 papers 列表,估算单次 LLM call 需要的 input tokens(粗略)。
 * 用于决定是否单次喂得下,还是要分批。
 */
export function tokenizeBudget(papers, { extraSystemCharsApprox = 8000 } = {}) {
  let totalChars = extraSystemCharsApprox
  for (const p of papers) {
    // 每篇 profile 估算 ~3000 char(包含 matrix 各字段截断后)
    totalChars += 3500
  }
  const inputTokensEst = estimateTokens(totalChars + '')
  return {
    chars: totalChars,
    inputTokensEst,
    fitsSingleCall: inputTokensEst < 700_000,   // Opus 4.8 1M 留 30% 给 thinking + output
    recommendBatchSize: inputTokensEst < 700_000 ? papers.length : Math.floor(papers.length * 700_000 / inputTokensEst),
  }
}
