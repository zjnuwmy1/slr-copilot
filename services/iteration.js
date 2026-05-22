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
  // AI 给 include 建议时引用的"理由 / 匹配到的纳入标准"也是关键信号
  // (协议哪几条 inclusion 频繁命中 → 哪几条不命中 → 协议是否过窄)
  const topAiIncludeReasons = db.prepare(
    `SELECT ai_reason AS reason, COUNT(*) AS n
     FROM screening_decisions
     WHERE project_id = ? AND ai_suggestion = 'include' AND ai_reason IS NOT NULL AND trim(ai_reason) != ''
     GROUP BY ai_reason ORDER BY n DESC LIMIT 6`
  ).all(projectId)

  // —— AI 筛选意见的整体分布 + AI vs human 一致性矩阵 ——
  const aiScreeningDetails = gatherAiScreeningDetails(db, projectId)

  // —— 每条 record 的 AI 判断细节(按信号价值排序) ——
  // LLM 拿这个能直接看到 "哪几条 AI 错过了" / "哪几条 AI 过纳了" 的原文
  //
  // cap 设 2000 足以覆盖绝大多数真实 SLR 项目(典型 200-1500 条已筛 records),
  // 即便顶到 cap,排序保证最有诊断价值的(disagree)永远进得去。
  // opus-4-7 / gpt-5.5 都有 1M context 窗口,2000 条 × ~400 字 ≈ 800K 字符
  // ≈ 200K tokens,在窗口内且不会触发 lost-in-the-middle。
  const PER_RECORD_CAP = 2000
  const perRecordDecisions = gatherPerRecordDecisions(db, projectId, PER_RECORD_CAP)

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
    ai_screening: aiScreeningDetails,
    per_record_decisions: perRecordDecisions,
    top_exclusion_reasons: {
      human: topHumanReasons,
      ai: topAiReasons,
    },
    top_ai_include_reasons: topAiIncludeReasons,
    themes,
    grade_assessments_summary,
    snapshot_taken_at: new Date().toISOString(),
  }
}

/**
 * AI 筛选意见的整体细节:
 *   - 分布:include / exclude / uncertain / not_run 各多少
 *   - AI vs human 一致性矩阵(2x2):
 *       AI include  ↔  human include: agree_in / disagree_in_h_excluded
 *       AI exclude  ↔  human include: AI 错过的潜在纳入(disagreement_ai_missed)
 *       AI include  ↔  human exclude: AI 过纳(disagreement_ai_over_inclusive)
 *   - 平均 ai_confidence
 *   - 频繁被 AI 引用的"matched inclusion / exclusion criterion"(协议哪条经常被命中)
 */
function gatherAiScreeningDetails(db, projectId) {
  // 整体分布
  const distRows = db.prepare(
    `SELECT ai_suggestion, COUNT(*) AS n
     FROM screening_decisions
     WHERE project_id = ? AND stage = 'title_abstract'
     GROUP BY ai_suggestion`
  ).all(projectId)
  const ai_distribution = {
    include: 0, exclude: 0, uncertain: 0, not_run: 0,
  }
  for (const r of distRows) {
    if (ai_distribution[r.ai_suggestion] != null) {
      ai_distribution[r.ai_suggestion] = r.n
    }
  }

  // 一致性矩阵(只在 AI 和人工都决定了的 records 上算)
  const agreementRows = db.prepare(
    `SELECT ai_suggestion, human_decision, COUNT(*) AS n
     FROM screening_decisions
     WHERE project_id = ? AND stage = 'title_abstract'
       AND ai_suggestion IN ('include','exclude','uncertain')
       AND human_decision IN ('include','exclude','uncertain')
     GROUP BY ai_suggestion, human_decision`
  ).all(projectId)
  const matrix = {
    // 行 = AI, 列 = human
    ai_include_human_include: 0,
    ai_include_human_exclude: 0,    // AI 过纳
    ai_include_human_uncertain: 0,
    ai_exclude_human_include: 0,    // AI 错过(关键信号:协议太严或概念组缺词)
    ai_exclude_human_exclude: 0,
    ai_exclude_human_uncertain: 0,
    ai_uncertain_human_include: 0,
    ai_uncertain_human_exclude: 0,
    ai_uncertain_human_uncertain: 0,
  }
  for (const r of agreementRows) {
    const k = `ai_${r.ai_suggestion}_human_${r.human_decision}`
    if (matrix[k] != null) matrix[k] = r.n
  }
  // 总体一致度 = 对角线 / 全部已决
  const totalDecided = Object.values(matrix).reduce((s, n) => s + n, 0)
  const agreed = matrix.ai_include_human_include + matrix.ai_exclude_human_exclude + matrix.ai_uncertain_human_uncertain
  const agreement_rate = totalDecided > 0 ? +(agreed / totalDecided).toFixed(3) : null

  // 平均 ai_confidence
  const confRow = db.prepare(
    `SELECT AVG(ai_confidence) AS avg_conf, COUNT(*) AS n_conf
     FROM screening_decisions
     WHERE project_id = ? AND ai_confidence IS NOT NULL`
  ).get(projectId)
  const avg_ai_confidence = confRow.n_conf > 0 ? +(confRow.avg_conf).toFixed(3) : null

  // 频繁命中的 matched inclusion / exclusion criterion
  // ai_matched_inclusion 是 JSON array;application-level aggregate
  const matchedRows = db.prepare(
    `SELECT ai_matched_inclusion, ai_matched_exclusion
     FROM screening_decisions
     WHERE project_id = ? AND (ai_matched_inclusion IS NOT NULL OR ai_matched_exclusion IS NOT NULL)`
  ).all(projectId)
  const incCounts = new Map()
  const excCounts = new Map()
  for (const r of matchedRows) {
    for (const it of parseJsonArray(r.ai_matched_inclusion)) {
      if (typeof it === 'string' && it.trim()) {
        const k = it.trim().slice(0, 200)
        incCounts.set(k, (incCounts.get(k) || 0) + 1)
      }
    }
    for (const it of parseJsonArray(r.ai_matched_exclusion)) {
      if (typeof it === 'string' && it.trim()) {
        const k = it.trim().slice(0, 200)
        excCounts.set(k, (excCounts.get(k) || 0) + 1)
      }
    }
  }
  const top_matched_inclusion = [...incCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([criterion, n]) => ({ criterion, n }))
  const top_matched_exclusion = [...excCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([criterion, n]) => ({ criterion, n }))

  return {
    ai_distribution,
    agreement_matrix: matrix,
    agreement_rate,
    avg_ai_confidence,
    top_matched_inclusion,
    top_matched_exclusion,
  }
}

/**
 * 每条 record 的 AI ↔ human 决策细节(按信号价值排序,cap 至 maxRows)。
 *
 * 信号优先级(决定排序 + 取舍):
 *   tier 1: AI 与 human 分歧的 records(AI exclude & human include,或 AI include & human exclude)
 *   tier 2: AI uncertain 但 human 已决的(AI 不确定时人工怎么判 — 揭示协议边界)
 *   tier 3: AI 与 human 一致(取最多 80 条采样,带 ai_reason 的优先)
 *   tier 4: 仅 AI 已跑但 human 还没决(代表性 30 条,只在 tier 1-3 不够时填充)
 *
 * 每条压缩成 1 行紧凑表示,方便 LLM 处理大量 records。
 */
function gatherPerRecordDecisions(db, projectId, maxRows = 300) {
  const rows = db.prepare(
    `SELECT
       r.id, r.title, r.year, r.journal, r.doi, r.abstract, r.source_databases,
       sd.ai_suggestion, sd.ai_reason, sd.ai_confidence,
       sd.ai_matched_inclusion, sd.ai_matched_exclusion,
       sd.human_decision, sd.human_reason
     FROM records r
     LEFT JOIN screening_decisions sd
       ON sd.record_id = r.id AND sd.project_id = r.project_id AND sd.stage = 'title_abstract'
     WHERE r.project_id = ?
     ORDER BY r.created_at ASC`
  ).all(projectId)

  // 给每条打分,分桶
  const tier1 = [] // 分歧
  const tier2 = [] // AI uncertain + human decided
  const tier3 = [] // 一致
  const tier4 = [] // 只有 AI 跑了 / 都没跑

  for (const r of rows) {
    const ai = r.ai_suggestion || 'not_run'
    const hu = r.human_decision || 'not_decided'

    const aiDecided = ['include', 'exclude', 'uncertain'].includes(ai)
    const huDecided = ['include', 'exclude', 'uncertain'].includes(hu)

    if (aiDecided && huDecided) {
      const isDisagree =
        (ai === 'include' && hu === 'exclude') ||
        (ai === 'exclude' && hu === 'include')
      const isUncertain = (ai === 'uncertain' || hu === 'uncertain') && ai !== hu
      if (isDisagree) tier1.push(r)
      else if (isUncertain || ai === 'uncertain') tier2.push(r)
      else tier3.push(r)
    } else if (ai === 'uncertain' && huDecided) {
      tier2.push(r)
    } else if (aiDecided || huDecided) {
      tier4.push(r)
    }
    // 都没跑的 records 直接跳过(对复盘没信号)
  }

  // 在每个 tier 内部进一步排序:带 ai_reason 的优先,ai_confidence 极端的优先
  function sortInTier(arr) {
    return arr.sort((a, b) => {
      const aHasReason = (a.ai_reason || '').trim() ? 1 : 0
      const bHasReason = (b.ai_reason || '').trim() ? 1 : 0
      if (aHasReason !== bHasReason) return bHasReason - aHasReason
      // confidence 离 0.5 越远越有"代表性"(很自信但错了 / 很不自信)
      const ac = typeof a.ai_confidence === 'number' ? Math.abs(a.ai_confidence - 0.5) : -1
      const bc = typeof b.ai_confidence === 'number' ? Math.abs(b.ai_confidence - 0.5) : -1
      return bc - ac
    })
  }

  // tier 配额(在总 cap 内)
  const t1 = sortInTier(tier1)  // 不限,但一般也不会太多
  const t2 = sortInTier(tier2)
  const t3 = sortInTier(tier3)
  const t4 = sortInTier(tier4)

  // 配额:tier1 + tier2 全进;tier3 优先;tier4 兜底。总 cap = maxRows。
  // 真实使用上 maxRows=2000 几乎不会触顶,但代码仍按优先级排序确保上限内总是
  // 最有诊断价值的先进。
  const candidates = [...t1, ...t2, ...t3, ...t4]
  const totalCandidates = candidates.length
  const picked = candidates.slice(0, maxRows)
  const truncated = totalCandidates > picked.length
  const truncatedCount = totalCandidates - picked.length

  // 压缩输出形状(每条只留 LLM 需要的字段,title 截断 160,reason 240)
  const out = picked.map((r, idx) => ({
    idx: idx + 1,
    record_id: r.id,
    title: truncate(r.title, 160),
    year: r.year,
    journal: truncate(r.journal, 60),
    doi: r.doi || null,
    source_databases: parseJsonArray(r.source_databases),
    abstract_snippet: truncate(r.abstract, 240),
    ai_suggestion: r.ai_suggestion || 'not_run',
    ai_confidence: typeof r.ai_confidence === 'number' ? +r.ai_confidence.toFixed(2) : null,
    ai_reason: truncate(r.ai_reason, 240),
    ai_matched_inclusion: parseJsonArray(r.ai_matched_inclusion).slice(0, 5),
    ai_matched_exclusion: parseJsonArray(r.ai_matched_exclusion).slice(0, 5),
    human_decision: r.human_decision || 'not_decided',
    human_reason: truncate(r.human_reason, 240),
    tier: tier1.includes(r) ? 'disagree' : tier2.includes(r) ? 'uncertain' : tier3.includes(r) ? 'agree' : 'ai_only',
  }))

  // 用 Object.defineProperty 给数组挂 metadata,view/route 用得到但不污染 JSON
  out.totalCandidates = totalCandidates
  out.truncated = truncated
  out.truncatedCount = truncatedCount
  return out
}

function truncate(s, n) {
  if (!s) return null
  const t = String(s).trim()
  if (t.length <= n) return t
  return t.slice(0, n) + '…'
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
2. 必须老老实实承认不确定:如果信号不足以判断哪一步出错,就在 diagnosis 里写"信号不足,建议做 X 实验性的小改动看效果"。
3. 不要凭空发明新概念组 — 优化必须能从前序数据(常被排除的关键词、user 写的 exclusion reasons 等)里读出来。
4. 输出的 \`new_protocol\` 必须可以直接当成新版 protocol 入库(字段对齐当前 protocol schema)。

🔍 **重点利用以下信号**(按优先级):
1. **用户自述反馈**(如果提供了)— 最高优先级,优先采信。
2. **逐条 records 的 AI ↔ 人工判断**(prompt 里 "🔴 分歧" 段)— 这是最细粒度的诊断信号。
   特别看 disagree 这一组:逐条扫 title + abstract + ai_reason + human_reason,
   找出**系统性模式**(如:"10 条 AI exclude 但 human include 的论文标题里都有
   'large language model',说明概念组缺这个同义词")。
3. **AI ↔ 人工一致性矩阵** — 全局总览,验证 (2) 推断的模式范围。
4. **Top 人工排除原因** — 用户自己写的话最直接说明协议哪里没对上他的意图。
5. **Top AI 建议 include / exclude 原因 + matched criterion 命中频次** —
   AI 解释自己的判断逻辑,反推协议哪几条 criteria 频繁触发、哪几条几乎不被
   命中(可能是死条款)。
6. **检索式命中数 vs 真实纳入率** — 命中多但纳入率低 = 检索式过宽或概念组
   漂移;命中少 + 纳入率仍低 = 概念组核心词错了。

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

  // —— AI 筛选意见整体分布 + AI vs human 一致性矩阵(关键!) ——
  if (sp.ai_screening) {
    const ai = sp.ai_screening
    const dist = ai.ai_distribution || {}
    const matrix = ai.agreement_matrix || {}
    lines.push('')
    lines.push('===== AI 筛选意见整体分布(title/abstract) =====')
    lines.push(`  AI 建议 include: ${dist.include || 0}`)
    lines.push(`  AI 建议 exclude: ${dist.exclude || 0}`)
    lines.push(`  AI 建议 uncertain: ${dist.uncertain || 0}`)
    lines.push(`  AI 还没跑: ${dist.not_run || 0}`)
    if (ai.avg_ai_confidence != null) {
      lines.push(`  AI 平均 confidence: ${ai.avg_ai_confidence}(0-1)`)
    }

    // 一致性矩阵(只有 AI 和人工都决定的 records)
    const decided = Object.values(matrix).reduce((s, n) => s + n, 0)
    if (decided > 0) {
      lines.push('')
      lines.push('===== AI ↔ 人工 一致性矩阵(总 ' + decided + ' 条都决定的)=====')
      lines.push(`  AI include & human include:  ${matrix.ai_include_human_include}   ← AI 命中`)
      lines.push(`  AI exclude & human exclude:  ${matrix.ai_exclude_human_exclude}   ← AI 命中`)
      lines.push(`  AI uncertain & human uncert: ${matrix.ai_uncertain_human_uncertain}`)
      lines.push(`  AI exclude & human INCLUDE:  ${matrix.ai_exclude_human_include}   ← AI 错过(信号:协议太严 / 概念组缺词)`)
      lines.push(`  AI include & human EXCLUDE:  ${matrix.ai_include_human_exclude}   ← AI 过纳(信号:协议判断标准不严)`)
      if (ai.agreement_rate != null) {
        lines.push(`  整体一致率: ${(ai.agreement_rate * 100).toFixed(1)}%`)
        if (ai.agreement_rate < 0.7) {
          lines.push(`    (< 70% 说明 AI 和人工系统性不一致,通常是协议描述不够精确)`)
        }
      }
    }

    if (ai.top_matched_inclusion?.length) {
      lines.push('')
      lines.push('===== AI 在 include 建议里频繁引用的纳入标准(协议哪几条在被命中) =====')
      for (const m of ai.top_matched_inclusion) {
        lines.push(`  ${m.n}× "${m.criterion}"`)
      }
    }
    if (ai.top_matched_exclusion?.length) {
      lines.push('')
      lines.push('===== AI 在 exclude 建议里频繁引用的排除标准(协议哪几条在剔除文献) =====')
      for (const m of ai.top_matched_exclusion) {
        lines.push(`  ${m.n}× "${m.criterion}"`)
      }
    }
  }

  // —— Top exclusion reasons(关键诊断线索) ——
  if (sp.top_exclusion_reasons?.human?.length) {
    lines.push('')
    lines.push('===== Top 人工排除原因(诊断关键 — 用户自己写的话最直接说明问题) =====')
    for (const r of sp.top_exclusion_reasons.human) {
      lines.push(`  ${r.n}× "${String(r.reason).slice(0, 160)}"`)
    }
  }
  if (sp.top_exclusion_reasons?.ai?.length) {
    lines.push('')
    lines.push('===== Top AI 建议排除原因(AI 自己解释的拒绝逻辑) =====')
    for (const r of sp.top_exclusion_reasons.ai) {
      lines.push(`  ${r.n}× "${String(r.reason).slice(0, 160)}"`)
    }
  }
  if (sp.top_ai_include_reasons?.length) {
    lines.push('')
    lines.push('===== Top AI 建议 include 原因(AI 自己解释的纳入逻辑)=====')
    for (const r of sp.top_ai_include_reasons) {
      lines.push(`  ${r.n}× "${String(r.reason).slice(0, 160)}"`)
    }
  }

  // —— 每条 record 的 AI 判断细节(超关键 — LLM 能从这里看到具体哪些判错了) ——
  if (Array.isArray(sp.per_record_decisions) && sp.per_record_decisions.length) {
    // 按 tier 分组,先列分歧的(信号最强),再 uncertain,再 agree,再 ai_only
    const byTier = { disagree: [], uncertain: [], agree: [], ai_only: [] }
    for (const r of sp.per_record_decisions) {
      if (byTier[r.tier]) byTier[r.tier].push(r)
    }
    lines.push('')
    const cov = sp.per_record_decisions.truncated
      ? `共 ${sp.per_record_decisions.totalCandidates} 条已筛 records,本次给你看 ${sp.per_record_decisions.length} 条(按信号强度排了序,被截断的 ${sp.per_record_decisions.truncatedCount} 条是 tier 较低的 agree / ai_only)`
      : `共 ${sp.per_record_decisions.length} 条(全部已筛 records 都给你)`
    lines.push(`===== 逐条 records 的 AI ↔ 人工判断 — ${cov} =====`)
    lines.push('  格式: #idx AI=X(conf) Human=Y · "title" · doi · AI: "reason" · matched_inc/exc · Human: "reason"')

    const sections = [
      ['🔴 分歧(disagree) — 这些最关键,直接揭示协议描述对 AI 不够精确', byTier.disagree],
      ['🟡 不确定(uncertain) — 协议边界模糊的案例,看人工怎么判', byTier.uncertain],
      ['🟢 一致(agree) — 代表性样本,确认 AI 在协议核心上判得对',     byTier.agree],
      ['⚪ 仅 AI 跑了(ai_only) — 人工还没复核,供参考',              byTier.ai_only],
    ]
    for (const [label, items] of sections) {
      if (!items.length) continue
      lines.push('')
      lines.push(`  --- ${label}(${items.length} 条)---`)
      for (const r of items) {
        const conf = r.ai_confidence != null ? ` conf=${r.ai_confidence}` : ''
        const mi = r.ai_matched_inclusion?.length ? ` matched_inc=[${r.ai_matched_inclusion.join('; ').slice(0, 100)}]` : ''
        const me = r.ai_matched_exclusion?.length ? ` matched_exc=[${r.ai_matched_exclusion.join('; ').slice(0, 100)}]` : ''
        const aiR = r.ai_reason ? ` · AI: "${r.ai_reason}"` : ''
        const huR = r.human_reason ? ` · Human: "${r.human_reason}"` : ''
        const doi = r.doi ? ` doi=${r.doi}` : ''
        const yr = r.year ? ` (${r.year})` : ''
        lines.push(`  #${r.idx} AI=${r.ai_suggestion}${conf} Human=${r.human_decision} · "${r.title}"${yr}${doi}${aiR}${mi}${me}${huR}`)
      }
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
