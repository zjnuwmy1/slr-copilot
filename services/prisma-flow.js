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

  // ---- 1. 来源(zotero_packages 聚合按数据库分组) ----
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

  const byDb = {}
  let dupTotal = 0
  let identifiedTotal = 0
  for (const p of packages) {
    const tag = guessDatabaseTag(p.source_filename)
    const n = Number(p.total_records || 0)
    identifiedTotal += n
    byDb[tag] = (byDb[tag] || 0) + n
    dupTotal += Number(p.total_duplicates || 0)
  }

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
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'title_abstract' AND human_decision = 'exclude'
      `).get(projectId)
      taExcluded = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'title_abstract' AND human_decision IN ('include', 'uncertain')
      `).get(projectId)
      taIncludedOrUncertain = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'full_text'
      `).get(projectId)
      ftAssessed = r?.n || 0
    } catch {}
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'full_text' AND human_decision = 'exclude'
      `).get(projectId)
      ftExcluded = r?.n || 0
    } catch {}
    // 最终纳入:full_text 阶段 include
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'full_text' AND human_decision = 'include'
      `).get(projectId)
      finalIncluded = r?.n || 0
    } catch {}
  }

  // 如果 full_text 阶段没填(项目还没分两阶段),用 title_abstract 的 include 数兜底
  if (ftAssessed === 0) ftAssessed = taIncludedOrUncertain
  if (finalIncluded === 0) {
    // 退而求其次:title_abstract include 数
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM screening_decisions
        WHERE project_id = ? AND stage = 'title_abstract' AND human_decision = 'include'
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

  const screenedTotal = Math.max(0, identifiedTotal - dupTotal)

  return {
    records_identified: byDb,
    records_identified_total: identifiedTotal,
    duplicates_removed: dupTotal,
    records_screened: screenedTotal,
    excluded_title_abstract: taExcluded,
    full_text_assessed: ftAssessed,
    full_text_excluded: ftExcluded,
    studies_included: finalIncluded,
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
 * 渲染 PRISMA flow 为 Mermaid flowchart 字符串。
 *
 * Mermaid 4 列布局:Identification → Screening → Eligibility → Included
 *
 * 注意:Mermaid 节点文本里不能有未转义的 `[` `]` `(` `)`,所以这里用 \\n 换行 + 用 "" 包文本。
 */
export function renderPrismaMermaid(counts) {
  const c = counts || emptyFlow()
  const idLines = []
  if (c.records_identified && typeof c.records_identified === 'object') {
    const entries = Object.entries(c.records_identified).filter(([_, n]) => typeof n === 'number' && n > 0)
    for (const [k, n] of entries) {
      idLines.push(`${dbLabel(k)}: ${n}`)
    }
  }
  const idText = idLines.length
    ? `Records identified\\n${idLines.join('\\n')}\\nTotal n=${c.records_identified_total}`
    : `Records identified\\nn=${c.records_identified_total}`

  return `flowchart TD
    A["${escapeMermaid(idText)}"] --> B["Records after duplicates removed\\nn=${c.records_screened}\\n(Duplicates removed: ${c.duplicates_removed})"]
    B --> C["Records screened by title/abstract\\nn=${c.records_screened}"]
    C --> D["Excluded by title/abstract\\nn=${c.excluded_title_abstract}"]
    C --> E["Full-text articles assessed\\nn=${c.full_text_assessed}"]
    E --> F["Full-text excluded\\nn=${c.full_text_excluded}"]
    E --> G["Studies included in qualitative synthesis\\nn=${c.studies_included}"]

    style A fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    style B fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    style C fill:#ecfdf5,stroke:#10b981,color:#064e3b
    style E fill:#ecfdf5,stroke:#10b981,color:#064e3b
    style G fill:#fef3c7,stroke:#f59e0b,color:#78350f
    style D fill:#fee2e2,stroke:#ef4444,color:#7f1d1d
    style F fill:#fee2e2,stroke:#ef4444,color:#7f1d1d
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
 * 渲染纯文本版 PRISMA flow(导出 Markdown 时用,作为 Mermaid 的 fallback)
 */
export function renderPrismaTextSummary(counts) {
  const c = counts || emptyFlow()
  const lines = ['## PRISMA Flow', '']
  lines.push('| 阶段 | 计数 |')
  lines.push('| --- | --- |')

  const idParts = []
  if (c.records_identified && typeof c.records_identified === 'object') {
    for (const [k, n] of Object.entries(c.records_identified)) {
      if (typeof n === 'number' && n > 0) idParts.push(`${dbLabel(k)}=${n}`)
    }
  }
  lines.push(`| 检索命中(去重前) | ${c.records_identified_total}${idParts.length ? '(' + idParts.join(', ') + ')' : ''} |`)
  lines.push(`| 去重移除 | ${c.duplicates_removed} |`)
  lines.push(`| 待筛选(去重后) | ${c.records_screened} |`)
  lines.push(`| 标题/摘要排除 | ${c.excluded_title_abstract} |`)
  lines.push(`| 全文评估 | ${c.full_text_assessed} |`)
  lines.push(`| 全文排除 | ${c.full_text_excluded} |`)
  lines.push(`| **最终纳入** | **${c.studies_included}** |`)
  return lines.join('\n')
}
