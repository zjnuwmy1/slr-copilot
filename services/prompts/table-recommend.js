/**
 * Table-Recommend — Phase A5 prompt 套件
 *
 * 用途:针对本项目这篇综述论文,Opus 看完所有已派生表 + 项目数据 + 协议 + themes
 *       后给出"该用哪几张表 / 哪些章节 / 推荐 caption / 还可考虑哪些 registry 外的表"。
 *
 * 架构原则(与已有 5 处 overlay 同):
 *   - 通用 SYSTEM(本文件 export,跨学科,SYSTEM_VERSION 维护)
 *   - 项目专用 USER prompt(运行时把项目数据塞进去)
 *   - LLM 输出只回 JSON,parseTableRecommendOutput 做校验 + 标准化
 *
 * 通用 SYSTEM 绝不能写"教育研究 / metacognition / MAI" 之类项目特定内容。
 */

// SYSTEM_VERSION:本文件 SYSTEM 字符串任意修改 → bump 这个常量。
//   生成 recommendation 时记录 at_system_version;后续 stale 检测对比当前值 → 自动失效引导用户重生成。
//   格式:YYYY-MM-DD-vN
// v2 (2026-05-25):T1 P0 prompt fix — user prompt 新接 themeCertainty + outcomeGrades +
//                  rawMatrixRows 样本 + searchStrategies,让 LLM 推荐 captions 时
//                  能引具体数字 + align Methods database list。
//                  bump 让旧 recommendation 标 stale,引导重生成。
// v4 (2026-05-25 Phase B):加 OVER-RECOMMENDATION CAP(journal table_count + 1)+ SoF GRADE mandate
export const TABLE_RECOMMEND_SYSTEM_VERSION = '2026-05-25-v4'

// ============================================================
// TABLE_RECOMMEND_SYSTEM — 通用骨架(跨学科)
// ============================================================
export const TABLE_RECOMMEND_SYSTEM = `# Role
You are an SLR methodology consultant advising which tables should appear in this systematic review's manuscript. You are cross-disciplinary (medical / education / engineering / HCI / social sciences) — interpret "intervention" / "participants" / "outcome" broadly.

# Task
Given (a) the approved protocol, (b) the project's themes + synthesis meta, (c) the journal template (if any), and (d) a manifest of ALL derived tables (already computed, key + label + intended_section + row_count + cochrane_required), recommend:
1. Which tables from the manifest MUST appear in the final manuscript (priority: critical / important / supplementary)
2. For each, suggest:
   - intended_section (methods / results / discussion / conclusion / limitations / future_research / supplementary)
   - suggested_caption (English, one sentence, manuscript-ready)
   - why_recommended (1-2 sentences anchored to THIS project's data — e.g. cite a theme name, an RQ number, an N value, a discipline pattern — NOT generic methodology lecture)
3. (Optional) Proposed custom tables NOT yet in registry that this project would benefit from — name + key columns + derive_hint (where data would come from in this project's already-collected data) + why
4. combination_strategy — should some tables become supplementary appendix? Any tables to merge? Any to split per theme?

# Hard constraints
- OUTPUT LANGUAGE: academic English ONLY (even if protocol / themes / sample papers are non-English — translate concepts)
- DO NOT recommend a table whose key does not appear in the input manifest (put novel ideas under "proposed_custom_tables" instead)
- "why_recommended" MUST reference this project's actual data (a theme name, RQ number, N value, study-design mix, RoB pattern, evidence gap, etc.) — vague methodology lecture is rejected
- DO NOT recommend any table whose row_count is 0 with priority "critical" (those tables are empty; downgrade or omit)
- Cochrane-required tables (cochrane_required=true) with row_count > 0 should generally be at least "important" unless the manuscript type explicitly excludes them
- Be honest about supplementary status — not every table needs to be in the main paper
- STRICT JSON output (see schema). No prose, no markdown fence, no commentary.

★ **OVER-RECOMMENDATION CAP (2026-05-25 Phase B)**: A common LLM failure is
  recommending 10+ tables for the main manuscript when the target journal
  typically uses 3. Apply this cap rule:
  - If the user prompt's journal template specifies \`table_count = N\`, cap
    main-manuscript recommendations (priority "critical" + "important") at
    **N + 1**. Push the rest to "supplementary".
  - If no journal table_count is supplied, default cap: **≤ 8 main tables +
    ≤ 4 supplementary**.
  - Priority order when deciding which to keep main: characteristics table
    (always main) > Summary of Findings if Step 7 GRADE exists (always main)
    > RoB summary (main if >0 rated) > theme × evidence direction crosstab
    (main if N themes ≥ 3) > per-theme detail tables (supplementary unless
    theme is the manuscript's central contribution).

★ **SUMMARY OF FINDINGS (SoF) MANDATE — when GRADE exists (2026-05-25 Phase B)**:
  If the user prompt shows ≥1 outcome with a non-null \`final_certainty\`
  rating (i.e. Step 7 outcome-level GRADE has been completed for at least
  one outcome), you MUST recommend a "Summary of Findings" table as
  **"critical"** priority for the main manuscript. This is a Cochrane /
  GRADE Handbook §5.1 requirement: SoF tables are the canonical way to
  communicate certainty + effect-size + sample-size + key findings in one
  place, and reviewers EXPECT them in any GRADE-using review. The SoF
  table key in the manifest is typically \`sof\` or \`summary_of_findings\`;
  if the manifest does not include such a table, add one under
  \`proposed_custom_tables\` with columns: outcome / N studies (N participants) /
  effect / certainty (GRADE) / interpretation.

# Output schema (STRICT JSON)
{
  "recommended_for_paper": [
    {
      "table_key": "table1",
      "priority": "critical",
      "intended_section": "methods",
      "suggested_caption": "Characteristics of the 47 included studies, grouped by thematic synthesis cluster.",
      "why_recommended": "Table 1 is the canonical reader entry point and this corpus spans 5 themes with N=47 papers, so a per-theme subtable structure (already produced by table1) is the clearest way to convey heterogeneity."
    }
  ],
  "proposed_custom_tables": [
    {
      "name": "Scaffolding Strategy × Outcome Direction",
      "columns": ["scaffolding_strategy", "n_studies", "positive", "negative", "mixed"],
      "derive_hint": "from matrix.scaffolding_strategy and matrix.effect_direction fields per included study",
      "why": "This project's RQ2 specifically asks about which scaffolding type works; without this crosstab the result is buried in narrative."
    }
  ],
  "combination_strategy": "Tables 1-4 in the main manuscript; tables 5-7 as supplementary appendix; merge tables 9 and 10 into one design-and-sample table to save space.",
  "discipline_inference": "This is an education/learning-sciences review — recommendations weight per-theme subtables (table1) and qualitative evidence gaps (table14) over forest-plot style outputs."
}

# Output format rules
- The VERY FIRST character of your response MUST be \`{\`
- The VERY LAST character MUST be \`}\`
- DO NOT wrap in \`\`\`json … \`\`\` markdown fence
- DO NOT include explanatory prose before or after the JSON
`

// ============================================================
// buildTableRecommendUserPrompt — 构造项目专属 USER prompt
// ============================================================
//
// 输入:
//   protocol:         loadApprovedProtocolFull 返回(可能为 null)
//   themes:           loadAllThemesWithMeta 返回 array(可能空)
//   synthesisMeta:    synthesis_meta 行(cross_cutting_observations / protocol_coverage),可能为 null
//   journalTemplate:  getJournalTemplate 返回,可能为 null
//   tablesManifest:   [{ key, label, description, intended_section, row_count, cochrane_required, multi_subtable }]
//                     由 routes 层从 table-registry getAllTableDefs() + buildAllRegisteredTables 拼。
//
// 设计:
//   不强求所有数据齐全。每段都做空兜底,空段就跳过。最低限度可只有 tablesManifest。
//
export function buildTableRecommendUserPrompt({
  protocol = null,
  themes = [],
  synthesisMeta = null,
  journalTemplate = null,
  tablesManifest = [],
  // T1 P0 fix: 4 new data sources
  themeCertainty = null,
  outcomeGrades = null,
  rawMatrixRows = null,
  searchStrategies = null,
}) {
  if (!Array.isArray(tablesManifest)) tablesManifest = []
  const lines = []

  lines.push('# Recommend manuscript tables for this systematic review')
  lines.push('')
  lines.push('**OUTPUT LANGUAGE (HARD CONSTRAINT)**: Recommendations, captions, rationales — ALL in academic English. Translate non-English source terms into standard scholarly English.')
  lines.push('')

  // ---- 1. Approved protocol ----
  if (protocol) {
    lines.push('## Approved Protocol')
    lines.push(`- Version: v${protocol.version || '?'}`)
    if (protocol.review_type) lines.push(`- Review type: ${protocol.review_type}`)
    if (protocol.rationale)    lines.push(`- Rationale: ${String(protocol.rationale).slice(0, 400)}`)
    lines.push('')
    if (Array.isArray(protocol.research_questions) && protocol.research_questions.length) {
      lines.push('### Research Questions')
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 400)}`)
      })
      lines.push('')
    }
    if (Array.isArray(protocol.concept_groups) && protocol.concept_groups.length) {
      lines.push('### PICO concept groups')
      protocol.concept_groups.slice(0, 10).forEach((cg) => {
        const label = cg?.label || cg?.name || cg?.role || '(unnamed)'
        const terms = cg?.terms || cg?.keywords || cg?.synonyms || []
        const head = Array.isArray(terms)
          ? terms.slice(0, 6).map((t) => typeof t === 'string' ? t : (t?.text || '')).filter(Boolean).join(' | ')
          : ''
        lines.push(`- ${label}: ${head}`)
      })
      lines.push('')
    }
  } else {
    lines.push('## Approved Protocol')
    lines.push('(no approved protocol yet — recommendations should be conservative)')
    lines.push('')
  }

  // ---- 2. Themes ----
  if (themes.length) {
    lines.push(`## Themes (${themes.length} from Step 6 synthesis)`)
    themes.slice(0, 12).forEach((t, i) => {
      const name = t?.name || t?.theme || `(theme ${i + 1})`
      const n = Array.isArray(t?.supporting_record_ids) ? t.supporting_record_ids.length
              : (t?.supporting_count || 0)
      const strength = t?.evidence_strength || t?.strength || '?'
      const rqs = Array.isArray(t?.maps_to_research_questions) ? t.maps_to_research_questions.join(', ') : ''
      lines.push(`- Theme ${i + 1}: ${String(name).slice(0, 120)} (N=${n}, strength=${strength}${rqs ? `, maps_to=${rqs}` : ''})`)
      if (t?.description) lines.push(`  - desc: ${String(t.description).slice(0, 200)}`)
    })
    if (themes.length > 12) lines.push(`- … and ${themes.length - 12} more themes (truncated)`)
    lines.push('')
  } else {
    lines.push('## Themes')
    lines.push('(no themes generated yet)')
    lines.push('')
  }

  // ---- 3. Synthesis meta (cross-cutting + RQ coverage) ----
  if (synthesisMeta) {
    const cco = (() => {
      try {
        if (Array.isArray(synthesisMeta.cross_cutting_observations)) return synthesisMeta.cross_cutting_observations
        if (typeof synthesisMeta.cross_cutting_observations === 'string') {
          return JSON.parse(synthesisMeta.cross_cutting_observations)
        }
      } catch {}
      return []
    })()
    const pc = (() => {
      try {
        if (synthesisMeta.protocol_coverage && typeof synthesisMeta.protocol_coverage === 'object'
            && !Array.isArray(synthesisMeta.protocol_coverage)) return synthesisMeta.protocol_coverage
        if (typeof synthesisMeta.protocol_coverage === 'string') {
          return JSON.parse(synthesisMeta.protocol_coverage)
        }
      } catch {}
      return null
    })()
    if (Array.isArray(cco) && cco.length) {
      lines.push('## Cross-cutting observations (Step 6 synthesis_meta)')
      cco.slice(0, 8).forEach((o) => lines.push(`- ${String(o).slice(0, 300)}`))
      lines.push('')
    }
    if (pc) {
      lines.push('## RQ coverage (which RQs are covered by which themes)')
      Object.entries(pc).slice(0, 10).forEach(([rq, val]) => {
        const v = Array.isArray(val) ? val.join(', ') : String(val).slice(0, 200)
        lines.push(`- ${rq}: ${v}`)
      })
      lines.push('')
    }
  }

  // ---- 3b. Theme-level certainty rollup (T1 P0 fix) ----
  //   Strong-evidence themes deserve more table real estate (e.g. dedicated
  //   subtables); low-certainty themes can be folded into supplementary.
  {
    const certEntries = themeCertainty instanceof Map
      ? Array.from(themeCertainty.values())
      : (Array.isArray(themeCertainty) ? themeCertainty : [])
    if (certEntries.length) {
      lines.push(`## Theme-level certainty rollup (${certEntries.length} themes — informs which themes deserve dedicated tables vs. supplementary)`)
      const certDist = { high: 0, moderate: 0, low: 0, very_low: 0 }
      certEntries.forEach((tc) => {
        const lvl = tc.overall_certainty
        if (lvl && certDist[lvl] != null) certDist[lvl] += 1
      })
      lines.push(`- certainty distribution: ${JSON.stringify(certDist)}`)
      certEntries.slice(0, 10).forEach((tc) => {
        const body = String(tc.body_of_evidence_summary || '').slice(0, 200)
        lines.push(`- theme_id=${tc.theme_id} · framework=${tc.grading_framework || '?'} · overall=${tc.overall_certainty || '?'}${body ? ' — ' + body : ''}`)
      })
      lines.push('')
    }
  }

  // ---- 3c. Outcome-level GRADE SoF count (T1 P0 fix) ----
  //   If outcomes exist with quantitative effect_size_text, the project SHOULD have
  //   a Table 2 Summary of Findings; LLM should recommend this with HIGH priority.
  if (Array.isArray(outcomeGrades) && outcomeGrades.length) {
    const quantN = outcomeGrades.filter((g) => g && g.effect_size_text && String(g.effect_size_text).trim()).length
    lines.push(`## Step 7 outcome-level GRADE (${outcomeGrades.length} outcomes, ${quantN} with quantitative effect_size_text)`)
    lines.push(`- If ${quantN > 0 ? 'quantitative outcomes exist' : 'all outcomes are narrative'}, ${quantN > 0 ? 'a Summary of Findings (SoF) table is strongly recommended' : 'an SoF table can still be useful but downgrade priority'}.`)
    outcomeGrades.slice(0, 8).forEach((g) => {
      const cert = g.final_certainty || g.effective_certainty || '?'
      const eff = g.effect_size_text ? ` · effect=${String(g.effect_size_text).slice(0, 140)}` : ''
      const studies = g.num_studies != null ? ` · ${g.num_studies} studies` : ''
      lines.push(`- [${cert}] ${g.outcome_label || '?'}${studies}${eff}`)
    })
    if (outcomeGrades.length > 8) lines.push(`- … and ${outcomeGrades.length - 8} more outcomes (truncated)`)
    lines.push('')
  }

  // ---- 3d. Raw matrix sample (T1 P0 fix) ----
  //   5-8 papers' real verbatim matrix fields — lets LLM cite concrete numbers
  //   inside suggested_caption (e.g. "N=47 studies, SMD range 0.2-0.8"). Without
  //   this the captions go generic.
  if (Array.isArray(rawMatrixRows) && rawMatrixRows.length) {
    const sample = rawMatrixRows.slice(0, 6)
    lines.push(`## Raw literature matrix sample (${sample.length} of ${rawMatrixRows.length} — anchor concrete numbers in suggested_caption)`)
    sample.forEach((row, i) => {
      const rid = row.record_id || row.id || `?${i}`
      const fields = row.fields || row
      if (!fields || typeof fields !== 'object') return
      lines.push(`### [${rid}]`)
      let printed = 0
      for (const [k, v] of Object.entries(fields)) {
        if (v == null) continue
        const text = typeof v === 'object' ? JSON.stringify(v) : String(v).trim()
        if (!text) continue
        lines.push(`- **${k}**: ${text.length > 180 ? text.slice(0, 180) + '…' : text}`)
        printed += 1
        if (printed >= 10) break
      }
    })
    lines.push('')
  }

  // ---- 3e. Search strategies (T1 P0 fix) ----
  //   Methods alignment — Table 1's caption should match which databases were
  //   searched; LLM also uses this to gauge whether an "executed searches" table
  //   is worth recommending separately.
  if (Array.isArray(searchStrategies) && searchStrategies.length) {
    lines.push(`## Step 2 search strategies (${searchStrategies.length} — align Methods-section table captions with databases actually searched)`)
    const locked = searchStrategies.filter((s) => s && s.is_locked)
    if (locked.length) lines.push(`- ${locked.length} of ${searchStrategies.length} are LOCKED (final executed queries)`)
    const byDb = new Map()
    searchStrategies.forEach((s) => {
      if (!s) return
      const db_ = s.database || s.database_name || '?'
      if (!byDb.has(db_)) byDb.set(db_, [])
      byDb.get(db_).push(s)
    })
    for (const [db_, rows] of byDb.entries()) {
      const totalHits = rows.reduce((acc, r) => acc + (Number(r.result_count) || 0), 0)
      const lockedFlag = rows.some((r) => r.is_locked) ? ' [has LOCKED]' : ''
      lines.push(`- **${db_}**${lockedFlag} — ${rows.length} strateg${rows.length === 1 ? 'y' : 'ies'} · total hits ≈ ${totalHits}`)
    }
    lines.push('')
  }

  // ---- 4. Journal template ----
  if (journalTemplate) {
    lines.push('## Journal template (target venue)')
    if (journalTemplate.journal_name)  lines.push(`- Journal: ${journalTemplate.journal_name}`)
    if (journalTemplate.template_type) lines.push(`- Template type: ${journalTemplate.template_type}`)
    let structure = null
    try {
      structure = typeof journalTemplate.extracted_structure === 'string'
        ? JSON.parse(journalTemplate.extracted_structure)
        : (journalTemplate.extracted_structure || null)
    } catch {}
    if (structure && Array.isArray(structure.sections) && structure.sections.length) {
      lines.push(`- Sections in target template (${structure.sections.length}):`)
      structure.sections.slice(0, 12).forEach((s) => {
        const name = s?.name || s?.label || s?.section || '?'
        const max = s?.max_tables != null ? `, max_tables=${s.max_tables}` : ''
        lines.push(`  · ${name}${max}`)
      })
    }
    // 2026-05-25 P1-15:期刊原文表数 / 图数 作为 soft anchor
    //   反 LLM 默认推 15 张的倾向 — 如果期刊原文只用 3 张表,建议别推超过 5
    if (structure && Number.isFinite(Number(structure.table_count)) && Number(structure.table_count) >= 0) {
      lines.push(`- Reference article in this journal uses ~${structure.table_count} tables (soft anchor — do not wildly exceed this; e.g. recommending 15 tables when journal averages 3 is over-recommendation).`)
    }
    if (structure && Number.isFinite(Number(structure.figure_count)) && Number(structure.figure_count) >= 0) {
      lines.push(`- Reference article uses ~${structure.figure_count} figures (informational).`)
    }
    lines.push('')
  } else {
    lines.push('## Journal template')
    lines.push('(no journal template provided — recommend a generic Cochrane / JBI-aligned table layout)')
    lines.push('')
  }

  // ---- 5. Tables manifest (THE CORE INPUT) ----
  lines.push(`## Tables Manifest — ALL ${tablesManifest.length} derived tables already computed for this project`)
  lines.push('(these are the ONLY table_keys you may put under "recommended_for_paper")')
  lines.push('')
  tablesManifest.forEach((t) => {
    const parts = []
    parts.push(`row_count=${t.row_count != null ? t.row_count : '?'}`)
    if (t.intended_section) parts.push(`intended_section=${t.intended_section}`)
    if (t.cochrane_required) parts.push('cochrane_required=true')
    if (t.multi_subtable) parts.push('multi_subtable=true')
    lines.push(`- \`${t.key}\` — ${t.label} [${parts.join(', ')}]`)
    if (t.description) lines.push(`  · ${String(t.description).slice(0, 200)}`)
  })
  lines.push('')

  // ---- 6. Closing instruction ----
  lines.push('---')
  lines.push('Output the recommendation JSON per system schema. Be specific to THIS project — anchor every why_recommended to a real theme name / RQ number / N value / discipline-specific pattern from above. Do NOT recycle generic SLR advice.')
  return lines.join('\n')
}

// ============================================================
// parseTableRecommendOutput — 校验 + 标准化 Opus 输出
// ============================================================
//
// 输入:
//   raw            — runLlm 返回的 data(应该是 object)
//   { knownKeys }  — 已注册表的 key 白名单(防 LLM 编造 key)
//
// 输出:
//   { ok: true,  recommendation: { ... 标准化后的 4 段 ... } }
//   { ok: false, error: '...' }
//
const VALID_PRIORITY = new Set(['critical', 'important', 'supplementary'])
const VALID_SECTION  = new Set([
  'methods', 'results', 'discussion', 'conclusion',
  'limitations', 'future_research', 'supplementary',
  'introduction', 'abstract',
])

export function parseTableRecommendOutput(raw, { knownKeys = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'empty or non-object output' }
  }
  // 解 wrapper
  let obj = raw
  if (obj.output && typeof obj.output === 'object') obj = obj.output
  if (obj.result && typeof obj.result === 'object') obj = obj.result
  if (obj.data && typeof obj.data === 'object'
      && (obj.data.recommended_for_paper || obj.data.proposed_custom_tables)) {
    obj = obj.data
  }

  const known = (knownKeys instanceof Set) ? knownKeys
              : (Array.isArray(knownKeys) ? new Set(knownKeys) : null)

  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const arr       = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : [])

  // 1) recommended_for_paper
  const rfp = arr(obj.recommended_for_paper || obj.recommendations || obj.tables)
  const recommended = []
  const droppedUnknown = []
  rfp.forEach((r, idx) => {
    if (!r || typeof r !== 'object') return
    const key = strOrNull(r.table_key || r.key)
    if (!key) return
    if (known && !known.has(key)) {
      droppedUnknown.push(key)
      return
    }
    let priority = strOrNull(r.priority)?.toLowerCase()
    if (!priority || !VALID_PRIORITY.has(priority)) priority = 'important'
    let section = strOrNull(r.intended_section || r.section)?.toLowerCase()
    if (section && !VALID_SECTION.has(section)) section = section.split(/[+/\s]/)[0]
    if (section && !VALID_SECTION.has(section)) section = null
    recommended.push({
      table_key: key,
      priority,
      intended_section: section || null,
      suggested_caption: strOrNull(r.suggested_caption || r.caption) || '',
      why_recommended:   strOrNull(r.why_recommended || r.why || r.rationale) || '',
    })
  })

  // 2) proposed_custom_tables
  const pct = arr(obj.proposed_custom_tables || obj.proposed_tables || obj.custom_tables)
  const proposed = pct.map((p) => {
    if (!p || typeof p !== 'object') return null
    const name = strOrNull(p.name || p.title)
    if (!name) return null
    const cols = arr(p.columns || p.fields).map((c) => {
      if (typeof c === 'string') return c.trim()
      if (c && typeof c === 'object') return strOrNull(c.name || c.label || c.key) || ''
      return ''
    }).filter(Boolean)
    return {
      name,
      columns: cols,
      derive_hint: strOrNull(p.derive_hint || p.deriveHint || p.source_hint) || '',
      why:         strOrNull(p.why || p.rationale) || '',
    }
  }).filter(Boolean)

  // 3) combination_strategy
  const combination_strategy = strOrNull(obj.combination_strategy || obj.combinationStrategy) || ''
  // 4) discipline_inference
  const discipline_inference = strOrNull(obj.discipline_inference || obj.disciplineInference) || ''

  if (recommended.length === 0 && proposed.length === 0 && !combination_strategy) {
    return { ok: false, error: 'no recommendations parsed from output' }
  }

  return {
    ok: true,
    recommendation: {
      recommended_for_paper: recommended,
      proposed_custom_tables: proposed,
      combination_strategy,
      discipline_inference,
    },
    warnings: droppedUnknown.length
      ? [`dropped ${droppedUnknown.length} unknown table_key(s): ${droppedUnknown.slice(0, 5).join(', ')}`]
      : [],
  }
}
