/**
 * services/prisma-flow.js — PRISMA 2020 flow diagram 数字计算 + Mermaid 渲染。
 *
 * **绝对不让 LLM 生成 PRISMA 数字**:全部从数据库精确算。
 *
 * 数据来源:
 *   - records_identified:    zotero_packages.total_records 聚合(按数据库来源,
 *     如果 source_kind 或 source_filename 能识别出 wos/scopus/pubmed 就分组,否则归 'other')
 *   - duplicates_removed:    zotero_packages.total_duplicates 聚合
 *   - records_screened:      total_records - duplicates
 *   - excluded_title_abstract: screening_decisions where stage='title_abstract' AND human_decision='exclude'
 *   - full_text_assessed:    screening_decisions where stage='title_abstract' AND human_decision IN ('include','uncertain')
 *                            或 records 上有 stage='full_text' 的 screening_decisions 记录数
 *   - full_text_excluded:    screening_decisions where stage='full_text' AND human_decision='exclude'
 *   - studies_included:      records 同时满足:
 *                              title_abstract 阶段 human_decision='include' 且
 *                              full_text 阶段 human_decision IN ('include','not_decided')(或没记 full_text)
 *                            或者有 extractions.human_verified=1 的记录数
 */

/**
 * 计算项目的 PRISMA flow 计数。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @returns {{
 *   records_identified: Object<string, number>,  // { wos:N, scopus:N, pubmed:N, ...other:N }
 *   records_identified_total: number,
 *   duplicates_removed: number,
 *   records_screened: number,
 *   excluded_title_abstract: number,
 *   full_text_assessed: number,
 *   full_text_excluded: number,
 *   studies_included: number,
 *   has_screening: boolean,
 *   has_extractions: boolean,
 * }}
 */
export function computePrismaFlow(db, projectId) {
  if (!db || !projectId) {
    return emptyFlow()
  }

  // ---- 1. 来源(M32-a 修复:优先 Step 2 锁定的 final_search_records,
  //         per-database 聚合;无锁定 query 时回退到 zotero_packages,保持兼容) ----
  //   PRISMA 2020 Identification 框需要的是 "Records identified from databases"
  //   = 你的最终检索式在每个库的命中数(用户在 Step 2 锁定时填的 result_count)
  //   不是 import 进来的去重前论文数(zotero CSV 可能有部分,可能去重前等),也不是 search_strategies 的探索 query 命中数。
  //
  //   `final_search_records` 表已存在(services/search-lock.js 写的),
  //   每库一行:database_name + query_text + result_count + locked_at + used (0/1)
  //   只取 used=1 的 row 算 Identification 来源。
  //
  //   新规则:
  //     A. 如果 final_search_records 有 used=1 + result_count > 0 的 row → 优先用,per-database 聚合
  //     B. 否则 fallback 到 zotero_packages 聚合(向后兼容,老项目继续可看)
  let byDb = {}
  let dupTotal = 0
  let identifiedTotal = 0
  let identifiedSource = 'zotero_packages'   // 'locked_final_search' | 'zotero_packages'

  try {
    const lockedRows = db.prepare(`
      SELECT database_name, result_count
      FROM final_search_records
      WHERE project_id = ? AND used = 1 AND result_count IS NOT NULL AND result_count > 0
    `).all(projectId)
    if (lockedRows.length) {
      identifiedSource = 'locked_final_search'
      for (const r of lockedRows) {
        const tag = String(r.database_name || 'other').toLowerCase()
        const n = Number(r.result_count || 0)
        identifiedTotal += n
        byDb[tag] = (byDb[tag] || 0) + n
      }
    }
  } catch { /* table 可能不存在(老 DB)→ fallback */ }

  // fallback 到 zotero_packages(无锁定 final search 时;也用于计算 duplicates_removed)
  let packages = []
  try {
    packages = db.prepare(`
      SELECT id, source_filename, total_records, total_duplicates
      FROM zotero_packages
      WHERE project_id = ?
        AND status IN ('ingested', 'parsed')
    `).all(projectId)
  } catch {
    packages = []
  }
  if (identifiedSource === 'zotero_packages') {
    for (const p of packages) {
      const tag = guessDatabaseTag(p.source_filename)
      const n = Number(p.total_records || 0)
      identifiedTotal += n
      byDb[tag] = (byDb[tag] || 0) + n
    }
  }
  // duplicates 总是从 zotero_packages 取(只有 import 时知道 dedup 数)
  for (const p of packages) dupTotal += Number(p.total_duplicates || 0)

  // ---- 2. screening 计数 ----
  let totalScreening = 0
  let taExcluded = 0
  let taIncludedOrUncertain = 0
  let ftAssessed = 0
  let ftExcluded = 0
  let finalIncluded = 0
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM screening_decisions WHERE project_id = ?
    `).get(projectId)
    totalScreening = r?.n || 0
  } catch { /* table may not exist yet during early phases */ }

  if (totalScreening > 0) {
    // 优化打磨包(2026-05-24 fix):全部用 COUNT(DISTINCT record_id) + JOIN records 过滤 dedup。
    // 之前 COUNT(*) 会把同一篇 record 的多条 screening_decisions(多 rater / AI+人工 / 再决定)
    // 重复计数,导致 35 (excluded) + 121 (include/uncertain) = 156 ≠ 128 (records_screened)。
    // 加 dedup 过滤(duplicate_of_record_id IS NULL)— 跟 finalIncluded fallback 对齐。
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT sd.record_id) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ?
           AND sd.stage = 'title_abstract'
           AND sd.human_decision = 'exclude'
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      taExcluded = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT sd.record_id) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ?
           AND sd.stage = 'title_abstract'
           AND sd.human_decision IN ('include', 'uncertain')
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      taIncludedOrUncertain = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT sd.record_id) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ?
           AND sd.stage = 'full_text'
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      ftAssessed = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT sd.record_id) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ?
           AND sd.stage = 'full_text'
           AND sd.human_decision = 'exclude'
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      ftExcluded = r?.n || 0
    } catch {}
    // 最终纳入:full_text 阶段 include(去 dup)
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT sd.record_id) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ?
           AND sd.stage = 'full_text'
           AND sd.human_decision = 'include'
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      finalIncluded = r?.n || 0
    } catch {}
  }

  // 如果 full_text 阶段没填(项目还没分两阶段),用 title_abstract 的 include 数兜底
  if (ftAssessed === 0) ftAssessed = taIncludedOrUncertain
  if (finalIncluded === 0) {
    // 退而求其次:title_abstract include 数 — 必须过滤 dedup 副本,
    //   否则 PRISMA 流程图的"最终纳入"会比实际多(123 vs 真正 121)
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n
          FROM screening_decisions sd
          JOIN records r ON r.id = sd.record_id
         WHERE sd.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
           AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      `).get(projectId)
      finalIncluded = r?.n || 0
    } catch {}
  }

  // ---- 3. extractions 数(再兜底) ----
  let extractionCount = 0
  let extractionVerifiedCount = 0
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM extractions WHERE project_id = ?`).get(projectId)
    extractionCount = r?.n || 0
    const r2 = db.prepare(`SELECT COUNT(*) AS n FROM extractions WHERE project_id = ? AND human_verified = 1`).get(projectId)
    extractionVerifiedCount = r2?.n || 0
  } catch {}

  // 如果还没记 final include 但 extractions 已有 verified,用 verified 数作 final include
  if (finalIncluded === 0 && extractionVerifiedCount > 0) {
    finalIncluded = extractionVerifiedCount
  }

  // ---- 4. Step 5 RoB 排除阶段(records.rob_excluded_at 非空 = 用户在 RoB 后剔除)----
  //   PRISMA 2020 没强制要求 RoB 排除为独立阶段,但 Cochrane Handbook 建议显式列出
  //   "studies removed after RoB assessment" 时把它放在 full-text 之后 / 综合之前。
  //   我们用一个独立计数 + 在最终 included 里扣掉,保证流程图最终数与 Step 6/7 一致。
  let robExcluded = 0
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM records
        WHERE project_id = ?
          AND rob_excluded_at IS NOT NULL
          AND (duplicate_of_record_id IS NULL OR duplicate_of_record_id = '')`
    ).get(projectId)
    robExcluded = r?.n || 0
  } catch {}

  // 流程图 / 文档里 "Studies included in synthesis" = 通过 RoB 评估的 = finalIncluded - robExcluded
  const studiesAfterRob = Math.max(0, (finalIncluded || 0) - robExcluded)

  // 优化打磨包(2026-05-24 数学一致性 fix):
  //   之前 records_screened = identifiedTotal - dupTotal(zotero 元数据上报的去重数),
  //   但 zotero 的 total_duplicates 跟 records 表 duplicate_of_record_id 标记数不一定相等
  //   (zotero RDF parser 可能把跨 package 的 BibTeX-key 重复也算 dup,但实际 records 表里没 mark)。
  //   结果 35 (TA exclude) + 121 (TA include/uncertain) = 156 ≠ 128 (screened),math 不平衡。
  //
  //   改用 records 表真值:records_screened = COUNT(DISTINCT records WHERE NOT duplicate AND in this project)。
  //   这是真正进入 TA 筛选的去重后论文池。duplicates_removed 同步用 identifiedTotal - records_screened
  //   重新算(zotero 元数据值降级为 audit-only,不再驱动流程图)。
  let recordsUniqueInDb = 0
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM records WHERE project_id = ? AND (duplicate_of_record_id IS NULL OR duplicate_of_record_id = '')`
    ).get(projectId)
    recordsUniqueInDb = r?.n || 0
  } catch {}
  // 兜底:records 表为空(早期 phase)时回退老逻辑;否则用 records 真值
  const screenedTotal = recordsUniqueInDb > 0
    ? recordsUniqueInDb
    : Math.max(0, identifiedTotal - dupTotal)
  // 同步重算 duplicates_removed:差 = identified - 真实唯一论文
  const duplicatesRemovedDerived = recordsUniqueInDb > 0
    ? Math.max(0, identifiedTotal - recordsUniqueInDb)
    : dupTotal

  return {
    records_identified: byDb,
    records_identified_total: identifiedTotal,
    records_identified_source: identifiedSource,    // M32-a:'locked_search_strategies' | 'zotero_packages'
    duplicates_removed: duplicatesRemovedDerived,
    duplicates_removed_zotero_metadata: dupTotal,   // 诊断:zotero RDF 自报的 dup 数(可能 ≠ records 表真值)
    records_screened: screenedTotal,
    excluded_title_abstract: taExcluded,
    full_text_assessed: ftAssessed,
    full_text_excluded: ftExcluded,
    studies_eligible_for_rob: finalIncluded,    // 通过全文筛但还没做 RoB 排除前的数(常等于 Step 5 评估总数)
    rob_excluded: robExcluded,                  // 新:Step 5 RoB 排除数
    studies_included: studiesAfterRob,          // 修复:扣掉 RoB 排除后的最终纳入(与 Step 6/7 视图一致)
    has_screening: totalScreening > 0,
    has_extractions: extractionCount > 0,
  }
}

function emptyFlow() {
  return {
    records_identified: {},
    records_identified_total: 0,
    duplicates_removed: 0,
    records_screened: 0,
    excluded_title_abstract: 0,
    full_text_assessed: 0,
    full_text_excluded: 0,
    studies_eligible_for_rob: 0,
    rob_excluded: 0,
    studies_included: 0,
    has_screening: false,
    has_extractions: false,
  }
}

/** 从 source_filename 猜数据库标签(wos/scopus/pubmed/other) */
function guessDatabaseTag(filename) {
  if (!filename) return 'other'
  const s = String(filename).toLowerCase()
  if (/\bwos\b|web.?of.?science|savedrecs|web_?of_?science/.test(s)) return 'wos'
  if (/\bscopus\b/.test(s)) return 'scopus'
  if (/\bpubmed\b|\bmedline\b/.test(s)) return 'pubmed'
  if (/\bieee\b/.test(s)) return 'ieee'
  if (/\beric\b/.test(s)) return 'eric'
  return 'other'
}

/**
 * 渲染 PRISMA flow 为 Mermaid flowchart 字符串(PRISMA 2020 标准格式)。
 *
 * 2026-05-26 重写:四个 subgraph swimlane(Identification / Screening / Eligibility /
 *   Included)严格按 PRISMA 2020 Flow Diagram Page et al. (BMJ 2021;372:n71) 标准布局。
 *   - 数据流主线用粗实线 + 蓝绿色调
 *   - 排除流用虚线 + 琥珀色 dashed border
 *   - 阶段标签:左侧带配色的"Identification" / "Screening" / "Eligibility" / "Included"
 *   - 节点 caption 含 (n = N) 学术写法(不是 n=N)
 *
 * 注:Mermaid 节点文本里不能有未转义的 `[` `]` `(` `)`(在 [...] 节点声明里),
 *   所以用 <br/> 换行 + 把括号写在节点 text 字符串里(mermaid 支持)。
 */
export function renderPrismaMermaid(counts) {
  const c = counts || emptyFlow()

  // ── 1. 数据源 — db entries ──
  const dbEntries = (c.records_identified && typeof c.records_identified === 'object')
    ? Object.entries(c.records_identified).filter(([_, n]) => typeof n === 'number' && n > 0)
    : []

  // 节点声明(放 subgraph 外面,后面用 id 在 subgraph 里引用)
  const nodeDecls = []     // 全部节点定义
  const sourceIds = []     // S0, S1, ... 用于 classDef
  if (dbEntries.length > 1) {
    dbEntries.forEach(([tag, n], i) => {
      const nodeId = `S${i}`
      nodeDecls.push(`  ${nodeId}["${escapeMermaid(dbLabel(tag))}<br/>(n = ${n})"]`)
      sourceIds.push(nodeId)
    })
  } else if (dbEntries.length === 1) {
    const [tag, n] = dbEntries[0]
    nodeDecls.push(`  S0["${escapeMermaid(dbLabel(tag))}<br/>(n = ${n})"]`)
    sourceIds.push('S0')
  } else {
    nodeDecls.push(`  S0["Records identified<br/>(n = ${c.records_identified_total})"]`)
    sourceIds.push('S0')
  }
  nodeDecls.push(`  AGG["Records identified from databases<br/><b>(combined n = ${c.records_identified_total})</b>"]`)
  nodeDecls.push(`  DEDUP["Records after duplicates removed<br/>(n = ${c.records_screened})<br/><i>${c.duplicates_removed} duplicates removed</i>"]`)
  nodeDecls.push(`  SCR["Records screened<br/>by title/abstract<br/>(n = ${c.records_screened})"]`)
  nodeDecls.push(`  FT["Full-text articles assessed<br/>for eligibility<br/>(n = ${c.full_text_assessed})"]`)

  const taExcludedCount = c.excluded_title_abstract || 0
  const ftExcludedCount = c.full_text_excluded || 0
  const robExcludedCount = c.rob_excluded || 0

  if (taExcludedCount > 0) nodeDecls.push(`  EX_TA["Records excluded<br/>by title/abstract<br/>(n = ${taExcludedCount})"]`)
  if (ftExcludedCount > 0) nodeDecls.push(`  EX_FT["Full-text articles excluded<br/>(n = ${ftExcludedCount})"]`)
  if (robExcludedCount > 0) nodeDecls.push(`  EX_ROB["Excluded after Risk-of-Bias<br/>assessment<br/>(n = ${robExcludedCount})"]`)

  const eligibleN = c.studies_eligible_for_rob || c.studies_included || 0
  const needsElig = robExcludedCount > 0 && ftExcludedCount > 0
  if (needsElig) nodeDecls.push(`  ELIG["Studies eligible<br/>(post-full-text)<br/>(n = ${eligibleN})"]`)
  nodeDecls.push(`  INC["<b>Studies included in synthesis</b><br/><b>(n = ${c.studies_included})</b>"]`)

  // ── 2. 边(主流程实线 + 排除虚线)──
  const edges = []
  sourceIds.forEach(id => edges.push(`  ${id} --> AGG`))
  edges.push('  AGG --> DEDUP')
  edges.push('  DEDUP --> SCR')
  if (taExcludedCount > 0) edges.push('  SCR -.-> EX_TA')
  edges.push('  SCR --> FT')
  if (ftExcludedCount > 0) edges.push('  FT -.-> EX_FT')
  if (robExcludedCount > 0) {
    if (needsElig) {
      edges.push('  FT --> ELIG')
      edges.push('  ELIG -.-> EX_ROB')
      edges.push('  ELIG --> INC')
    } else {
      edges.push('  FT -.-> EX_ROB')
      edges.push('  FT --> INC')
    }
  } else {
    edges.push('  FT --> INC')
  }

  // ── 3. Subgraph groupings(只用 id 引用,不重声明节点)──
  const identMembers = [...sourceIds, 'AGG']
  const scrnMembers = ['DEDUP', 'SCR']
  if (taExcludedCount > 0) scrnMembers.push('EX_TA')
  const elgMembers = ['FT']
  if (ftExcludedCount > 0) elgMembers.push('EX_FT')
  if (needsElig) elgMembers.push('ELIG')
  if (robExcludedCount > 0 && !needsElig) elgMembers.push('EX_ROB')
  const inclMembers = ['INC']
  if (needsElig) inclMembers.push('EX_ROB')   // ELIG 在 ELG,EX_ROB 视情况

  const subgraphs = [
    `  subgraph IDENT [" Identification "]\n    direction TB\n${identMembers.map(m => `    ${m}`).join('\n')}\n  end`,
    `  subgraph SCRN [" Screening "]\n    direction TB\n${scrnMembers.map(m => `    ${m}`).join('\n')}\n  end`,
    `  subgraph ELG [" Eligibility "]\n    direction TB\n${elgMembers.map(m => `    ${m}`).join('\n')}\n  end`,
    `  subgraph INCL [" Included "]\n    direction TB\n${inclMembers.map(m => `    ${m}`).join('\n')}\n  end`,
  ]

  // ── 4. classDef + class assignments ──
  const stageClass = [...sourceIds, 'DEDUP', 'SCR', 'FT']
  if (needsElig) stageClass.push('ELIG')
  const excludedNodes = []
  if (taExcludedCount > 0) excludedNodes.push('EX_TA')
  if (ftExcludedCount > 0) excludedNodes.push('EX_FT')
  if (robExcludedCount > 0) excludedNodes.push('EX_ROB')

  const classLines = [
    `  class ${stageClass.join(',')} stage`,
    `  class AGG agg`,
    `  class INC included`,
  ]
  if (excludedNodes.length) classLines.push(`  class ${excludedNodes.join(',')} excluded`)

  return `flowchart TD
  %% PRISMA 2020 Flow Diagram (Page et al., BMJ 2021;372:n71)
  %% 4 swimlanes: Identification → Screening → Eligibility → Included

${nodeDecls.join('\n')}

${subgraphs.join('\n\n')}

${edges.join('\n')}

  %% Class definitions — publication-grade PRISMA 2020 styling
  classDef stage fill:#eef2ff,stroke:#4338ca,color:#1e1b4b,stroke-width:1.5px
  classDef agg fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px
  classDef included fill:#dcfce7,stroke:#15803d,color:#064e3b,stroke-width:2.5px
  classDef excluded fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:1px,stroke-dasharray: 5 3
  classDef swimlane fill:#f8fafc,stroke:#94a3b8,color:#1e293b,stroke-width:1px

${classLines.join('\n')}
  class IDENT,SCRN,ELG,INCL swimlane
`
}

function escapeMermaid(s) {
  if (typeof s !== 'string') return ''
  // 双引号 → 转义为 #quot;(mermaid 解析器支持)
  return s.replace(/"/g, '#quot;')
}

function dbLabel(tag) {
  return {
    wos: 'Web of Science',
    scopus: 'Scopus',
    pubmed: 'PubMed',
    ieee: 'IEEE Xplore',
    eric: 'ERIC',
    other: 'Other sources',
  }[tag] || tag
}

/**
 * 渲染纯文本版 PRISMA flow(用作 Mermaid 的 fallback / 工作页摘要)。
 *
 * @param {object} counts
 * @param {object} [opts]
 * @param {'zh' | 'en'} [opts.lang='zh']  导出最终论文用 'en';UI 摘要默认 'zh'
 */
export function renderPrismaTextSummary(counts, { lang = 'zh' } = {}) {
  const c = counts || emptyFlow()
  const L = lang === 'en' ? PRISMA_LABELS_EN : PRISMA_LABELS_ZH
  const lines = [`## ${L.heading}`, '']
  lines.push(`| ${L.col_stage} | ${L.col_count} |`)
  lines.push('| --- | --- |')

  const idParts = []
  if (c.records_identified && typeof c.records_identified === 'object') {
    for (const [k, n] of Object.entries(c.records_identified)) {
      if (typeof n === 'number' && n > 0) idParts.push(`${dbLabel(k)}=${n}`)
    }
  }
  lines.push(`| ${L.identified} | ${c.records_identified_total}${idParts.length ? '(' + idParts.join(', ') + ')' : ''} |`)
  lines.push(`| ${L.duplicates} | ${c.duplicates_removed} |`)
  lines.push(`| ${L.screened} | ${c.records_screened} |`)
  // 优化打磨包:0 的排除阶段跳过(保持表格简洁,跟 Mermaid 一致)
  if ((c.excluded_title_abstract || 0) > 0) {
    lines.push(`| ${L.excluded_ta} | ${c.excluded_title_abstract} |`)
  }
  lines.push(`| ${L.full_text} | ${c.full_text_assessed} |`)
  if ((c.full_text_excluded || 0) > 0) {
    lines.push(`| ${L.excluded_ft} | ${c.full_text_excluded} |`)
  }
  if ((c.rob_excluded || 0) > 0) {
    const eligibleLabel = lang === 'en' ? 'Studies eligible (post full-text)' : '通过全文筛(待 RoB 评)'
    const robLabel = lang === 'en' ? 'Excluded after Risk-of-Bias' : 'RoB 阶段排除'
    lines.push(`| ${eligibleLabel} | ${c.studies_eligible_for_rob} |`)
    lines.push(`| ${robLabel} | ${c.rob_excluded} |`)
  }
  lines.push(`| **${L.included}** | **${c.studies_included}** |`)
  return lines.join('\n')
}

const PRISMA_LABELS_ZH = {
  heading:     'PRISMA Flow',
  col_stage:   '阶段',
  col_count:   '计数',
  identified:  '检索命中(去重前)',
  duplicates:  '去重移除',
  screened:    '待筛选(去重后)',
  excluded_ta: '标题/摘要排除',
  full_text:   '全文评估',
  excluded_ft: '全文排除',
  included:    '最终纳入',
}
const PRISMA_LABELS_EN = {
  heading:     'PRISMA Flow',
  col_stage:   'Stage',
  col_count:   'Count',
  identified:  'Records identified',
  duplicates:  'Duplicates removed',
  screened:    'Records screened (after duplicates)',
  excluded_ta: 'Excluded by title/abstract',
  full_text:   'Full-text articles assessed',
  excluded_ft: 'Full-text excluded',
  included:    'Studies included',
}
