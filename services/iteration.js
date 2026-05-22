/**
 * 复盘 & 协议迭代服务 (v2.0 mechanism)
 *
 * 设计前提:
 *   一篇 SLR 在 screening / extraction 阶段出现大规模剔除,说明前面的
 *   协议 / 检索式 / 概念组与用户真实研究意图错位。这时不应让用户硬撑
 *   后面的步骤,而是给一个"复盘"出口:
 *     1) 综合所有前序数据(协议、检索、命中、锁定、导入、筛选拒绝原因、
 *        矩阵、GRADE)交给 flagship + high-reasoning 模型分析;
 *     2) 模型给出 diagnosis(哪里出了问题) + 一份新协议 v_next(不审批);
 *     3) 用户审阅 diff,主动审批后才生效。
 *
 * 数据落盘:
 *   - 新 protocol row(version = max + 1, approved_by_user = 0,
 *     iteration_metadata = JSON {diagnosis, proposed_changes, snapshot_used, ...})
 *   - 旧 protocol 的 approved_by_user 不动(用户审批新版才会替换)
 *   - search_strategies / records / screening_decisions 全部保留
 *     (用户审批新协议后由现有 search 流程产生新版 strategies)
 *
 * 同项目内迭代,不开新项目 —— 见 README / commit message 的设计说明。
 */

import { audit } from './audit.js'

// ============================================================
// 1) Snapshot 收集器:把项目所有前序数据装进一个对象
// ============================================================

/**
 * 拉项目当前所有相关数据,组装成 LLM 看得到的 snapshot。
 * 不修改 DB,只 SELECT。
 *
 * @returns {{
 *   project, latest_protocol, search_strategies, final_search_records,
 *   record_counts, screening_stats, top_exclusion_reasons,
 *   themes, grade_assessments_summary
 * }}
 */
export function gatherProjectSnapshot(db, projectId) {
  // —— Project meta ——
  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  if (!projectRow) throw new Error(`Project ${projectId} not found`)
  const project = {
    id: projectRow.id,
    title: projectRow.title,
    topic: projectRow.topic,
    discipline: projectRow.discipline,
    goal: projectRow.goal,
    year_start: projectRow.year_start,
    year_end: projectRow.year_end,
    databases: parseJsonArray(projectRow.databases),
    language_limits: parseJsonArray(projectRow.language_limits),
    document_types: parseJsonArray(projectRow.document_types),
    seed_titles: parseJsonArray(projectRow.seed_titles),
    status: projectRow.status,
    search_locked_at: projectRow.search_locked_at,
    search_concept_set_json: projectRow.search_concept_set_json,
  }

  // —— Latest approved protocol(若无审批,fallback 最新一版) ——
  let protocolRow = db.prepare(
    `SELECT * FROM protocols WHERE project_id = ? AND approved_by_user = 1
     ORDER BY version DESC LIMIT 1`
  ).get(projectId)
  if (!protocolRow) {
    protocolRow = db.prepare(
      `SELECT * FROM protocols WHERE project_id = ? ORDER BY version DESC LIMIT 1`
    ).get(projectId)
  }
  const latest_protocol = protocolRow ? {
    id: protocolRow.id,
    version: protocolRow.version,
    approved: !!protocolRow.approved_by_user,
    approved_at: protocolRow.approved_at,
    research_questions: parseJsonArray(protocolRow.research_questions),
    inclusion_criteria: parseJsonArray(protocolRow.inclusion_criteria),
    exclusion_criteria: parseJsonArray(protocolRow.exclusion_criteria),
    concept_groups: parseJsonArray(protocolRow.concept_groups),
    recommended_review_type: protocolRow.recommended_review_type,
    rationale: protocolRow.rationale,
  } : null

  // —— Search strategies + final lock ——
  const search_strategies = db.prepare(
    `SELECT id, database_name, query_type, version, query_text, result_count,
            search_date, rationale, model
     FROM search_strategies WHERE project_id = ?
     ORDER BY version DESC, database_name, query_type`
  ).all(projectId)
  const final_search_records = db.prepare(
    `SELECT database_name, used, query_text, result_count, search_date, notes, locked_at
     FROM final_search_records WHERE project_id = ?`
  ).all(projectId)

  // —— Records: total + per source database ——
  const totalRecords = db.prepare(
    `SELECT COUNT(*) AS n FROM records WHERE project_id = ?`
  ).get(projectId).n
  const recordsBySource = countBySourceDatabase(db, projectId)

  // —— Screening stats(关键反馈信号) ——
  // 按 stage + human_decision 计数
  const screeningRows = db.prepare(
    `SELECT stage, human_decision, ai_suggestion, COUNT(*) AS n
     FROM screening_decisions WHERE project_id = ?
     GROUP BY stage, human_decision, ai_suggestion`
  ).all(projectId)
  const screening_stats = aggregateScreeningStats(screeningRows, totalRecords)

  // —— Top exclusion reasons(人工 + AI 各取前 8 条) ——
  const topHumanReasons = db.prepare(
    `SELECT human_reason AS reason, COUNT(*) AS n
     FROM screening_decisions
     WHERE project_id = ? AND human_decision = 'exclude' AND human_reason IS NOT NULL AND trim(human_reason) != ''
     GROUP BY human_reason ORDER BY n DESC LIMIT 8`
  ).all(projectId)
  const topAiReasons = db.prepare(
    `SELECT ai_reason AS reason, COUNT(*) AS n
     FROM screening_decisions
     WHERE project_id = ? AND ai_suggestion = 'exclude' AND ai_reason IS NOT NULL AND trim(ai_reason) != ''
     GROUP BY ai_reason ORDER BY n DESC LIMIT 8`
  ).all(projectId)

  // —— Themes(若有) ——
  const themes = (() => {
    try {
      const rows = db.prepare(
        `SELECT name, description, evidence_strength,
                supporting_record_ids, consistent_findings, conflicting_findings, evidence_gaps
         FROM themes WHERE project_id = ?`
      ).all(projectId)
      return rows.map((t) => ({
        name: t.name,
        description: t.description,
        evidence_strength: t.evidence_strength,
        supporting_count: (parseJsonArray(t.supporting_record_ids) || []).length,
        consistent_findings: parseJsonArray(t.consistent_findings) || [],
        conflicting_findings: parseJsonArray(t.conflicting_findings) || [],
        evidence_gaps: parseJsonArray(t.evidence_gaps) || [],
      }))
    } catch { return [] }
  })()

  // —— GRADE 汇总(若有) ——
  const grade_assessments_summary = (() => {
    try {
      const rows = db.prepare(
        `SELECT outcome_label, effective_certainty
         FROM grade_assessments WHERE project_id = ?`
      ).all(projectId)
      return rows
    } catch { return [] }
  })()

  return {
    project,
    latest_protocol,
    search_strategies,
    final_search_records,
    record_counts: { total: totalRecords, by_source: recordsBySource },
    screening_stats,
    top_exclusion_reasons: {
      human: topHumanReasons,
      ai: topAiReasons,
    },
    themes,
    grade_assessments_summary,
    snapshot_taken_at: new Date().toISOString(),
  }
}

function parseJsonArray(s) {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

function countBySourceDatabase(db, projectId) {
  // records.source_databases 是 JSON array;用 application-level 解析
  const rows = db.prepare(
    `SELECT source_databases FROM records WHERE project_id = ?`
  ).all(projectId)
  const counts = {}
  let unknownCount = 0
  let crossCount = 0
  for (const r of rows) {
    const dbs = parseJsonArray(r.source_databases)
    if (dbs.length === 0) {
      unknownCount++
      continue
    }
    if (dbs.length > 1) crossCount++
    for (const d of dbs) {
      counts[d] = (counts[d] || 0) + 1
    }
  }
  return {
    per_database: counts,
    cross_database_count: crossCount,
    unknown_source_count: unknownCount,
  }
}

function aggregateScreeningStats(rows, totalRecords) {
  const stats = {
    title_abstract: { include: 0, exclude: 0, uncertain: 0, not_decided: 0, ai_only_include: 0 },
    full_text:      { include: 0, exclude: 0, uncertain: 0, not_decided: 0, ai_only_include: 0 },
    total_records: totalRecords,
  }
  for (const r of rows) {
    const bucket = stats[r.stage]
    if (!bucket) continue
    if (r.human_decision && r.human_decision !== 'not_decided') {
      bucket[r.human_decision] = (bucket[r.human_decision] || 0) + r.n
    } else if (r.ai_suggestion === 'include') {
      bucket.ai_only_include += r.n
    } else {
      bucket.not_decided += r.n
    }
  }
  // 计算关键指标:title_abstract 阶段的真实纳入率(人工 include / 已决定的)
  const ta = stats.title_abstract
  const taDecided = ta.include + ta.exclude + ta.uncertain
  stats.title_abstract.decided_count = taDecided
  stats.title_abstract.include_rate = taDecided > 0 ? +(ta.include / taDecided).toFixed(3) : null
  return stats
}

// ============================================================
// 2) Prompt builder
// ============================================================

export const ITERATION_SYSTEM = `你是顶级 SLR 方法学专家(博士级,有 100+ Cochrane review 实战经验)。

任务背景:
用户在系统性文献综述的中后段(典型是 title/abstract screening 后)发现真正相关的文献被大规模排除。
这通常意味着前面的 **协议 / 概念组 / 检索式 / 纳排标准** 没对齐研究意图。
你的任务是:基于完整的项目快照,**反向诊断**问题,产出一份优化后的新协议。

⚠ **关键规矩**:
1. 你不知道用户的真实研究意图比他们自己更多。你的输出永远是"建议",最终由用户审批后才生效。
2. 必须**老老实实承认不确定**:如果信号不足以判断哪一步出错,就在 diagnosis 里写"信号不足,建议做 X 实验性的小改动看效果"。
3. 不要凭空发明新概念组 — 优化必须能从前序数据(常被排除的关键词、user 写的 exclusion reasons 等)里读出来。
4. 输出的 \`new_protocol\` 必须可以直接当成新版 protocol 入库(字段对齐当前 protocol schema)。

输出 **严格 JSON**,字段:
{
  "diagnosis": {
    "summary": "≤200 字中文 — 主要问题是什么(协议 too narrow? 概念组 missed synonym? 排除标准 too strict?)",
    "specific_signals": [
      "≤80 字一条 — 你从哪条数据看到的(如:'人工 exclusion reasons 里 3 条都说 wrong study design,但协议 inclusion 没限定研究类型')"
    ],
    "confidence": "high" | "medium" | "low"
  },
  "proposed_changes": [
    {
      "type": "add_concept_group_term" | "remove_concept_group_term" | "add_inclusion" | "remove_inclusion" | "add_exclusion" | "remove_exclusion" | "modify_research_question",
      "before": "<原值,若 add 则留空字符串>",
      "after": "<新值>",
      "rationale": "≤60 字"
    }
  ],
  "new_protocol": {
    "research_questions": ["RQ1...", "RQ2..."],
    "inclusion_criteria": ["..."],
    "exclusion_criteria": ["..."],
    "concept_groups": [{"name":"...","terms":["...","..."]}],
    "recommended_review_type": "<unchanged or new value>",
    "rationale": "≤200 字中文 — 这版协议相比 v_current 的改动"
  },
  "next_steps_for_user": [
    "≤80 字一条 — 用户审批新协议后建议做什么(如:'重新跑 exploration 检索式,关注 PubMed 的纳入率变化')"
  ],
  "warnings": ["≤80 字一条 — 数据/方法上的风险提醒"]
}

中文风格:
- 大白话,不要"赋能 / 范式 / 解构 / 路径 / 颗粒度"等八股
- 直接陈述事实和判断,不要"基于...的考量"开头
- 只输出 JSON,不要前后加解释、Markdown、代码围栏。
`

/**
 * 把 snapshot 编成 user prompt。
 * 用户也可以加 "feedback" 字段说明自己的疑虑(例如 "我觉得是检索式太窄")。
 */
export function buildIterationUserPrompt({ snapshot, userFeedback }) {
  const lines = []
  const sp = snapshot
  const proj = sp.project
  const protocol = sp.latest_protocol

  lines.push('请基于以下项目快照,诊断前面工作的问题并产出优化后的新协议。')
  lines.push('')

  // —— 用户的自述反馈(关键信号) ——
  if (userFeedback && String(userFeedback).trim()) {
    lines.push('===== 用户对当前问题的描述(关键!优先采信) =====')
    lines.push(String(userFeedback).trim().slice(0, 1500))
    lines.push('')
  }

  // —— 项目元信息 ——
  lines.push('===== 项目元信息 =====')
  lines.push(`标题: ${proj.title}`)
  lines.push(`主题: ${proj.topic || '(未填)'}`)
  if (proj.discipline) lines.push(`学科: ${proj.discipline}`)
  if (proj.goal) lines.push(`目标: ${proj.goal}`)
  if (proj.year_start || proj.year_end) {
    lines.push(`年份: ${proj.year_start || '不限'} – ${proj.year_end || '不限'}`)
  }
  if (proj.databases?.length) lines.push(`目标数据库: ${proj.databases.join(', ')}`)
  if (proj.document_types?.length) lines.push(`文献类型: ${proj.document_types.join(', ')}`)
  if (proj.language_limits?.length) lines.push(`语言: ${proj.language_limits.join(', ')}`)
  if (proj.seed_titles?.length) {
    lines.push(`种子文献(用户当初列的关键文献,这些**必须**被纳入):`)
    proj.seed_titles.slice(0, 10).forEach((t, i) => lines.push(`  ${i + 1}. ${t}`))
  }

  // —— 当前协议(v_current) ——
  if (protocol) {
    lines.push('')
    lines.push(`===== 当前协议 v${protocol.version}${protocol.approved ? '(已审批)' : '(未审批)'} =====`)
    if (protocol.research_questions?.length) {
      lines.push('研究问题:')
      protocol.research_questions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
    }
    if (protocol.concept_groups?.length) {
      lines.push('概念组(组内 OR · 组间 AND):')
      protocol.concept_groups.forEach((g, i) => {
        const terms = Array.isArray(g.terms) ? g.terms.join(' | ') : ''
        lines.push(`  ${i + 1}. ${g.name || '未命名'}: ${terms}`)
      })
    }
    if (protocol.inclusion_criteria?.length) {
      lines.push('纳入标准:')
      protocol.inclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
    }
    if (protocol.exclusion_criteria?.length) {
      lines.push('排除标准:')
      protocol.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
    }
  }

  // —— 检索 & 命中数(最关键的"实际跑出来什么"信号) ——
  if (sp.search_strategies?.length) {
    lines.push('')
    lines.push('===== 检索策略 + 命中数(按版本,主检索 query_type=main) =====')
    for (const s of sp.search_strategies.slice(0, 40)) {
      const hits = s.result_count != null ? `${s.result_count} 命中` : '未回填'
      lines.push(`  v${s.version} ${s.database_name}/${s.query_type}: ${hits}`)
    }
  }
  if (sp.final_search_records?.length) {
    lines.push('')
    lines.push('===== 最终锁定的检索方案(用户真正跑了的) =====')
    for (const f of sp.final_search_records) {
      const used = f.used ? '✓ 已用' : '✗ 未用'
      const cnt = f.result_count != null ? `${f.result_count} 条` : '?'
      lines.push(`  ${f.database_name}: ${used} (${cnt}, 日期 ${f.search_date || '?'})`)
    }
  }

  // —— Records 概况 ——
  lines.push('')
  lines.push('===== 导入的 records =====')
  lines.push(`  总数: ${sp.record_counts.total}`)
  if (sp.record_counts.by_source.per_database) {
    const perDb = Object.entries(sp.record_counts.by_source.per_database)
      .map(([d, n]) => `${d}=${n}`).join(', ')
    if (perDb) lines.push(`  按源: ${perDb}`)
  }
  if (sp.record_counts.by_source.cross_database_count) {
    lines.push(`  跨库重复合并: ${sp.record_counts.by_source.cross_database_count} 篇`)
  }

  // —— Screening stats(核心信号) ——
  lines.push('')
  lines.push('===== Screening 阶段(关键反馈) =====')
  const ta = sp.screening_stats?.title_abstract || {}
  lines.push(`  Title/Abstract 已决定: ${ta.decided_count ?? 0} / ${sp.record_counts.total}`)
  lines.push(`    人工 include: ${ta.include ?? 0}`)
  lines.push(`    人工 exclude: ${ta.exclude ?? 0}`)
  lines.push(`    人工 uncertain: ${ta.uncertain ?? 0}`)
  if (ta.include_rate != null) {
    lines.push(`    **真实纳入率: ${(ta.include_rate * 100).toFixed(1)}%**(<10% 通常说明前面错位)`)
  }
  const ft = sp.screening_stats?.full_text
  if (ft && (ft.include || ft.exclude)) {
    lines.push(`  Full-text 已决定: include=${ft.include}, exclude=${ft.exclude}`)
  }

  // —— Top exclusion reasons(关键诊断线索) ——
  if (sp.top_exclusion_reasons?.human?.length) {
    lines.push('')
    lines.push('===== Top 人工排除原因(诊断关键!) =====')
    for (const r of sp.top_exclusion_reasons.human) {
      lines.push(`  ${r.n}× "${String(r.reason).slice(0, 160)}"`)
    }
  }
  if (sp.top_exclusion_reasons?.ai?.length) {
    lines.push('')
    lines.push('===== Top AI 建议排除原因 =====')
    for (const r of sp.top_exclusion_reasons.ai) {
      lines.push(`  ${r.n}× "${String(r.reason).slice(0, 160)}"`)
    }
  }

  // —— Themes / GRADE(下游信号) ——
  if (sp.themes?.length) {
    lines.push('')
    lines.push(`===== 已有主题(${sp.themes.length} 个) =====`)
    for (const t of sp.themes.slice(0, 8)) {
      lines.push(`  - ${t.name} (强度: ${t.evidence_strength || '?'}, ${t.supporting_count} 篇支持)`)
    }
  }

  lines.push('')
  lines.push('请严格按 system 的 JSON schema 输出 diagnosis + proposed_changes + new_protocol + next_steps_for_user + warnings。')
  lines.push('记得:**优先采信用户的自述反馈**(如果提供了);**老老实实**说不确定。')
  return lines.join('\n')
}

// ============================================================
// 3) Normalize LLM 输出
// ============================================================

export function normalizeIterationOutput(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'LLM 返回不是 JSON 对象' }
  }
  // 容忍 envelope wrap
  let r = raw
  if (!r.diagnosis && !r.new_protocol) {
    for (const k of ['result', 'data', 'output', 'response']) {
      if (r[k] && typeof r[k] === 'object') { r = r[k]; break }
    }
  }

  const diag = r.diagnosis && typeof r.diagnosis === 'object' ? r.diagnosis : null
  if (!diag || !diag.summary) {
    return { ok: false, error: 'AI 没给出 diagnosis.summary' }
  }
  const np = r.new_protocol && typeof r.new_protocol === 'object' ? r.new_protocol : null
  if (!np) {
    return { ok: false, error: 'AI 没给出 new_protocol' }
  }

  // 校验 new_protocol 关键字段
  const new_protocol = {
    research_questions: Array.isArray(np.research_questions)
      ? np.research_questions.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    inclusion_criteria: Array.isArray(np.inclusion_criteria)
      ? np.inclusion_criteria.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    exclusion_criteria: Array.isArray(np.exclusion_criteria)
      ? np.exclusion_criteria.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    concept_groups: Array.isArray(np.concept_groups)
      ? np.concept_groups
          .filter((g) => g && typeof g === 'object' && g.name)
          .map((g) => ({
            name: String(g.name).trim(),
            terms: Array.isArray(g.terms)
              ? g.terms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
              : [],
          }))
          .filter((g) => g.terms.length > 0)
      : [],
    recommended_review_type: typeof np.recommended_review_type === 'string'
      ? np.recommended_review_type.trim() : null,
    rationale: typeof np.rationale === 'string' ? np.rationale.trim().slice(0, 1500) : '',
  }

  // 至少要有 RQ 和 concept_groups
  if (new_protocol.research_questions.length === 0 || new_protocol.concept_groups.length === 0) {
    return {
      ok: false,
      error: 'new_protocol 必须有 research_questions + concept_groups(都至少 1 条)',
    }
  }

  const diagnosis = {
    summary: String(diag.summary).trim().slice(0, 800),
    specific_signals: Array.isArray(diag.specific_signals)
      ? diag.specific_signals.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 240)).slice(0, 10)
      : [],
    confidence: ['high', 'medium', 'low'].includes(diag.confidence) ? diag.confidence : 'medium',
  }

  const proposed_changes = Array.isArray(r.proposed_changes)
    ? r.proposed_changes
        .filter((c) => c && typeof c === 'object' && typeof c.type === 'string')
        .map((c) => ({
          type: c.type.trim(),
          before: typeof c.before === 'string' ? c.before.trim().slice(0, 400) : '',
          after: typeof c.after === 'string' ? c.after.trim().slice(0, 400) : '',
          rationale: typeof c.rationale === 'string' ? c.rationale.trim().slice(0, 200) : '',
        }))
        .slice(0, 20)
    : []

  const next_steps_for_user = Array.isArray(r.next_steps_for_user)
    ? r.next_steps_for_user.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 240)).slice(0, 8)
    : []
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 240)).slice(0, 5)
    : []

  return {
    ok: true,
    data: { diagnosis, proposed_changes, new_protocol, next_steps_for_user, warnings },
  }
}

// ============================================================
// 4) 入库:把 normalized.data + snapshot 写成新 protocol 版本(unapproved)
// ============================================================

/**
 * 创建新协议版本(approved_by_user = 0,等待用户审批)。
 *
 * @returns 新 protocol row id
 */
export function adoptIterationAsNewProtocol(db, {
  projectId,
  iterationData,
  snapshotSummary,
  llmModel,
  llmReasoning,
  userIdForAudit,
}) {
  const { new_protocol, diagnosis, proposed_changes, next_steps_for_user, warnings } = iterationData

  const { maxV } = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS maxV FROM protocols WHERE project_id = ?'
  ).get(projectId)
  const newVersion = maxV + 1
  const newProtocolId = 'prot_' + Math.random().toString(36).slice(2, 14) +
                        Math.random().toString(36).slice(2, 10)

  const meta = {
    iterated_from_version: snapshotSummary?.from_version || maxV,
    diagnosis,
    proposed_changes,
    next_steps_for_user,
    warnings,
    snapshot_summary: snapshotSummary,
    model: llmModel || null,
    reasoning: llmReasoning || null,
    generated_at: new Date().toISOString(),
  }

  db.prepare(`
    INSERT INTO protocols (
      id, project_id, version, research_questions, inclusion_criteria, exclusion_criteria,
      concept_groups, recommended_review_type, rationale, clarification_questions,
      generated_by, model, approved_by_user, iteration_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_edited', ?, 0, ?)
  `).run(
    newProtocolId,
    projectId,
    newVersion,
    JSON.stringify(new_protocol.research_questions),
    JSON.stringify(new_protocol.inclusion_criteria),
    JSON.stringify(new_protocol.exclusion_criteria),
    JSON.stringify(new_protocol.concept_groups),
    new_protocol.recommended_review_type,
    new_protocol.rationale,
    JSON.stringify([]),  // clarification_questions
    llmModel || null,
    JSON.stringify(meta),
  )

  return { id: newProtocolId, version: newVersion }
}
