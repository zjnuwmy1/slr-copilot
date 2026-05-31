/**
 * services/figures.js — Phase 9 Agent W
 * ------------------------------------------------------------
 * 综述插图生成模块。分两类:
 *
 * 一、"程序生成"(平台可直接出图,不调 LLM 也不依赖外部图像服务):
 *   - PRISMA flow diagram(Mermaid,已有 prisma-flow.js,这里直接转发)
 *   - 年度趋势(纳入论文按发表年聚合)— 返回 { years, counts },前端用纯 SVG 渲染
 *   - Evidence map(主题 × 纳入论文数 bubble)— 同样返回数据,前端 SVG
 *
 * 二、"AI 生成提示词"(平台拿不到 image gen 后端,只能输出 prompt 让用户去 ChatGPT
 *   / Midjourney / DALL-E 网页版自己生图):
 *   - Conceptual framework
 *   - Theme-relationship diagram
 *   - 美化版 selection process funnel(PRISMA flow 的演示版)
 *
 * ⚠️ 重要前提:
 *   本平台后端目前只接 Anthropic / OpenAI 的"文本模型"(claude-sonnet / gpt-5.x),
 *   通过 codex / claude CLI 或 API 调用,**文本模型不能直接画图**。
 *   真正的图像生成走 OpenAI 的 DALL-E / gpt-image-1 endpoint,需要单独的 API 和配额。
 *   因此本模块只为这类图片生成"提示词",由用户自己拿去 ChatGPT(自带 DALL-E)生成。
 */

import {
  computePrismaFlow,
  renderPrismaMermaid,
  renderPrismaTextSummary,
} from './prisma-flow.js'

// ────────────────────────────────────────────────────────────
// 一、程序可直接生成的图
// ────────────────────────────────────────────────────────────

/**
 * PRISMA flow diagram(Mermaid 文本)— 转发 prisma-flow.js 的渲染。
 * 调用方:report.ejs 已经直接用 renderPrismaMermaid;这里提供给"插图"区统一汇总用。
 */
export function generateMermaidPrismaFlow(db, projectId) {
  const counts = computePrismaFlow(db, projectId)
  return {
    counts,
    mermaid: renderPrismaMermaid(counts),
    text_summary: renderPrismaTextSummary(counts),
  }
}

/**
 * 年度发表趋势:基于"已纳入"的 records(human_verified extraction 或 final include screening)。
 * 返回 { years: [...], counts: [...], total }。years 升序连续(中间缺的年份补 0)。
 */
export function generateYearTrendData(db, projectId) {
  if (!db || !projectId) return { years: [], counts: [], total: 0 }
  let rows = []
  try {
    rows = db.prepare(`
      SELECT r.year AS year, COUNT(DISTINCT r.id) AS n
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
        AND sd.stage = 'full_text' AND sd.human_decision = 'include'
      WHERE r.project_id = ?
        AND r.year IS NOT NULL
        AND (e.human_verified = 1 OR sd.id IS NOT NULL)
      GROUP BY r.year
      ORDER BY r.year ASC
    `).all(projectId)
  } catch {
    rows = []
  }

  // 若 full_text 阶段还没用,退而其次:title_abstract include
  if (rows.length === 0) {
    try {
      rows = db.prepare(`
        SELECT r.year AS year, COUNT(DISTINCT r.id) AS n
        FROM records r
        JOIN screening_decisions sd ON sd.record_id = r.id
          AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
        WHERE r.project_id = ? AND r.year IS NOT NULL
        GROUP BY r.year
        ORDER BY r.year ASC
      `).all(projectId)
    } catch {
      rows = []
    }
  }

  if (rows.length === 0) return { years: [], counts: [], total: 0 }

  // 填补中间缺的年份
  const map = new Map()
  for (const r of rows) {
    const y = Number(r.year)
    if (!Number.isFinite(y)) continue
    map.set(y, Number(r.n) || 0)
  }
  if (map.size === 0) return { years: [], counts: [], total: 0 }

  const minY = Math.min(...map.keys())
  const maxY = Math.max(...map.keys())
  const years = []
  const counts = []
  let total = 0
  for (let y = minY; y <= maxY; y++) {
    years.push(y)
    const c = map.get(y) || 0
    counts.push(c)
    total += c
  }
  return { years, counts, total }
}

/**
 * Evidence map 数据:每个主题 × 纳入论文数。
 * 返回 [{ theme_id, name, count, description }]。
 */
export function generateEvidenceMapData(db, projectId) {
  if (!db || !projectId) return { themes: [], total_records: 0 }
  let themes = []
  try {
    themes = db.prepare(`
      SELECT id, name, description, evidence_strength, supporting_record_ids
      FROM themes
      WHERE project_id = ?
      ORDER BY COALESCE(display_order, 9999), created_at ASC
    `).all(projectId)
  } catch {
    return { themes: [], total_records: 0 }
  }

  let totalRecords = 0
  const out = themes.map((t) => {
    let ids = []
    try {
      const x = JSON.parse(t.supporting_record_ids || '[]')
      if (Array.isArray(x)) ids = x
    } catch {}
    totalRecords += ids.length
    return {
      theme_id: t.id,
      name: t.name || '(未命名主题)',
      description: t.description || '',
      evidence_strength: t.evidence_strength || null,
      count: ids.length,
    }
  })

  return { themes: out, total_records: totalRecords }
}

// ────────────────────────────────────────────────────────────
// 二、AI 生成提示词(给用户拿去 ChatGPT 自己跑)
// ────────────────────────────────────────────────────────────

/**
 * 根据项目实际数据(主题 / 关键 findings)生成 3 类常见 SLR 插图的提示词。
 * 这些提示词专门为"扔进 ChatGPT 网页版(自带 DALL-E)/ Midjourney / Stable Diffusion"
 * 设计,所以风格说明是"学术插图 / 黑白线条 / 不要 cartoon",输出建议 SVG 矢量。
 *
 * @returns Array<{ id, title, prompt, when_to_use, copy_hint }>
 */
// ============================================================
// AI 一键优化插图 prompt — mirrors matrix optimize-master-prompt
// 通用模板 system + 项目协议/主题/findings → Opus 生成项目专属插图 prompt
// 输出:replaces generic templates,或与之并列 stored in DB
//
// Phase 8.C(2026-05-24 v2):
//   1. Drops "DALL-E generic" figure menu — pivots to "advanced SLR figure
//      types" (analytical framework / theme network / quality heatmap /
//      forest plot / Sankey) that look like real systematic-review papers.
//   2. Each figure now carries BOTH an LLM-generatable mermaid_code AND a
//      detailed external_tool_prompt (for BioRender / draw.io / Lucidchart
//      / DALL-E when the user wants the polished version).
//   3. Parser is backward-compat — old { prompt, copy_hint } still accepted.
// ============================================================
// v3 (2026-05-24): English-only enforcement — removed "Chinese title OK" loopholes,
//                   added hard constraint that external_tool_prompt instructs image LLM
//                   to render all on-figure labels in English (translate any non-English
//                   project terms into English first).
// v4 (2026-05-24, Phase B): user prompt now carries 10 enriched data sources
//                   (themes-with-Step6-v2 fields, theme certainty rollup, outcome-level
//                   quantitative count, synthesis_meta cross-cutting + coverage, sample
//                   paper profiles, journal template, uploaded figure assets). System
//                   prompt gets one extra rule line tying figure-type choice to those
//                   fields. Bump triggers downstream stale detection.
// v9 (2026-05-25 信息量大补):
//   - outcomeGrades 从 count 升级到完整 27 outcomes(effect_size / certainty / SoF / theme)
//   - 加 robPerPaper / dateRangeAlignment / searchStrategiesSummary /
//     methodologyCapabilities / availableTables 5 个数据源
//   - samplePapers 4 → 8 sample
//   - rawMatrixRows 全集 250(不再 8 sample)
//   - figure types 6 → 8(加 timeline + evidence_gap_map 作为可选第 7/8)
//   - 加 VERBATIM PROJECT DATA RULE(每图必须含 ≥3 真实项目数据 anchor)
export const FIGURE_SYSTEM_VERSION = '2026-05-25-v9'

export const OPTIMIZE_FIGURE_PROMPTS_SYSTEM = `# Role
You are a scientific illustration architect for systematic review (SLR) manuscripts. You design **advanced, publication-grade figures** that go beyond bar charts — the kind that appear in Cochrane reviews, JBI evidence syntheses, and BMJ / Lancet methodology papers.

# Task
Design **at least 5 advanced, project-specific figures** for THIS systematic review. For each figure you output:
- A short title and figure_type
- When in the manuscript to use it (which section)
- A mermaid_code block (if the figure CAN be expressed as a mermaid diagram — flowcharts, graphs, sankey, mindmap, etc.)
- A detailed external_tool_prompt — a self-contained briefing the user can paste into BioRender, draw.io, Lucidchart, or DALL-E / ChatGPT image mode to produce the polished publication version

# Required figure types (you MUST include the first 5; ADD a 6th–8th if the data supports it — total 5–8 figures depending on richness)
1. **PRISMA 2020 Flow Diagram (id: 'prisma_flow', figure_type: 'prisma_flow')** — required by PRISMA 2020 reporting guideline. Use the verbatim counts in the user prompt's PRISMA block (Identification → Screening → Eligibility → Included). Publication-grade layout in draw.io / Figma / BioRender style: three vertical swimlanes labelled on the left, rounded-rectangle stage boxes, solid black connecting arrows, dashed grey exclusion arrows to right-side "excluded" boxes with reasons. NOT the default mermaid flowchart — produce a draw.io / image-LLM prompt the user can paste to make a clean publication figure. If methodology_capabilities shows dual_reviewer_screening = false, DO NOT draw "two independent reviewers" boxes — single reviewer + AI-triage flow.
2. **Analytical framework diagram** — boxes + arrows showing how protocol concepts (PICO / antecedents / mediators) connect theory to the evidence base. Must be specific to THIS project's research questions and concept groups, not a generic flowchart.
3. **Theme network graph** — themes as nodes, edges drawn whenever two themes share supporting papers; node color encodes dominant RoB tier (low / some-concerns / high). Node size encodes number of supporting papers. Edge weights = N of shared papers.
4. **Quality heatmap** — matrix where rows are themes (or papers), columns are RoB tiers (low / some-concerns / high / unclear), cells encode the count of papers. Reveals where evidence is strong vs fragile. Use the supplied per-paper RoB block (if present) for paper-level granularity.
5. **Forest plot / Harvest plot** — see system prompt's FOREST PLOT DATA-COMPLETENESS SAFETY RULE. Forest plot ONLY if ≥4 quantitative outcomes with reported 95% CIs / SDs (audit the per-outcome detail in user prompt + raw matrix sample). Otherwise harvest plot or effect-direction plot. List the actual outcome names verbatim from the user-prompt outcomeGrades block in the external_tool_prompt.

# Optional figure types (recommend when the supplied data supports them — increase information content of the manuscript)
6. **Concept-evidence Sankey** — flow from protocol PICO concepts (left) → themes (middle) → key findings (right). Width encodes paper-count flow. Recommend when there are ≥3 concept groups AND ≥4 themes (otherwise the Sankey is sparse and uninformative).
7. **Timeline / Publication-year trend** — bar chart showing N papers per year, optionally split / stacked by theme or study design. Recommend when (a) the date-range block is supplied AND (b) the actual coverage spans ≥4 years. Captions should cite the protocol search window AND the actual coverage span, especially if dateRangeAlignment.has_gap = true.
8. **Evidence gap map (RQ × outcome / RQ × theme heatmap)** — rows = research questions, columns = themes (or outcomes), cell colour = paper count (cool=sparse, warm=dense). Recommend when there are ≥3 RQs AND the protocol_coverage block (in synthesisMeta) flags ≥1 uncovered RQ. Powerful for visualising where the literature is missing.

# Cross-discipline note
These figure types apply across disciplines (medical, education, engineering, social sciences, policy). DO NOT assume a specific domain — adapt the framing language so it works whether the review is about clinical interventions, educational programs, engineering systems, or social policies.

# Style baseline (apply to ALL figures)
- Academic / journal-grade. NO cartoon, NO 3D, NO photorealistic people, NO emoji in the figure itself.
- Color palette: neutral base (slate / grey) + 2 accent colors. Suggested: #1e40af (deep blue), #047857 (deep green). For RoB use: #047857 (low), #d97706 (some concerns), #b91c1c (high), #94a3b8 (unclear).
- Font: sans-serif (Inter / Helvetica / Source Sans).
- **ALL on-figure labels MUST be in English** for publication-readiness. If any project term arrives in Chinese (or any other language) via the user prompt, translate it to its standard English scholarly equivalent **before** writing it into mermaid_code or external_tool_prompt. The rendered figure must contain no Chinese characters.
- Output format suggestion: SVG vector preferred, fallback 300 DPI PNG. Aspect ratio 16:9 or 4:3.

# Output schema (STRICT JSON)
{
  "figures": [
    {
      "id": "<short_snake_id like 'analytical_framework' / 'theme_network' / 'quality_heatmap' / 'forest_plot' / 'concept_sankey'>",
      "title": "<figure short title in English, suitable as a navigation label — e.g. 'Analytical framework of …', 'Theme network across RoB tiers'. NO 'Figure N.' numbering prefix (the manuscript will renumber). NO Chinese, no parenthetical translations. <= 120 chars.>",
      "caption": "<publication-grade figure caption in English, the FULL caption that will print under the figure in the manuscript. Format: one short anchor sentence stating what the figure shows (use present tense, e.g. 'Network of N themes with edges weighted by shared supporting papers.'), followed by 1-2 sentences explaining the visual encoding (color = RoB tier, node size = paper count, line thickness = overlap weight, etc.). 60-180 words. Self-contained — the reader must understand the figure without reading body text. Cite numeric anchors from the project data where applicable (e.g. theme count, RoB counts). NO Chinese.>",
      "alt_text": "<short accessibility description in English (for screen readers / journal accessibility checks). 1-2 sentences, ~30-60 words. Plain-language summary of WHAT the figure depicts, NOT the visual encoding details. NO Chinese.>",
      "figure_type": "<one of: prisma_flow | analytical_framework | theme_network | quality_heatmap | forest_plot | harvest_plot | concept_sankey | timeline | evidence_gap_map | other>",
      "intended_section": "<one of: introduction | methods | results | discussion | conclusion>",
      "when_to_use": "<2-3 sentences explaining when in the manuscript to use this figure and what it tells the reader>",
      "mermaid_code": "<a complete mermaid v10 diagram if the figure CAN be expressed in mermaid (flowchart / graph / sankey-beta / mindmap). If NOT representable in mermaid (e.g. true forest plot), leave as empty string ''>",
      "external_tool_prompt": "<a detailed, immediately-pasteable briefing for BioRender / draw.io / Lucidchart / Figma / DALL-E / gpt-image-1 / Midjourney / Stable Diffusion. Must include: (a) figure purpose, (b) the actual project content to draw — theme names, RoB counts, PICO concepts (translate any non-English project terms into English before insertion; the rendered figure MUST be English-only), (c) layout (which side which element), (d) visual style (color palette, font, line weight), (e) an explicit instruction line saying 'ALL labels in the rendered figure MUST be in English; do NOT include Chinese or other-language characters', (f) export format suggestion (SVG vector or 300 DPI PNG). ~250-500 words.>"
    }
  ],
  "style_baseline_used": "<one-line note about the style baseline applied (color palette + font)>"
}

# Hard constraints
- At least 5 figures (prisma_flow + analytical_framework + theme_network + quality_heatmap + forest_plot/harvest_plot). 6th = concept_sankey (if supported). 7th = timeline (if year coverage ≥ 4 years). 8th = evidence_gap_map (if ≥3 RQs + protocol_coverage shows gaps).

★ **VERBATIM PROJECT DATA RULE (2026-05-25 — critical for figure quality)**:
  Every figure's \`title\`, \`caption\`, AND \`external_tool_prompt\` MUST embed AT LEAST 3 verbatim numeric or named anchors from the supplied data. Examples of qualifying anchors:
  - A specific theme name (e.g. "GenAI as Metacognitive Scaffold")
  - A specific PRISMA count (e.g. "N = 121 included studies")
  - A specific outcome name (e.g. "Cohen's d = 0.45 on metacognitive regulation")
  - A specific RoB count (e.g. "12 of 121 studies low-RoB on outcome measurement")
  - A specific RQ verbatim from protocol (e.g. "RQ3: effect of GenAI on creative outcomes")
  - A specific date range (e.g. "2022–2026")
  - A specific database (e.g. "Web of Science")
  - A specific paper author + year (e.g. "Smith 2024")
  **Forbidden**: generic placeholders like "studies", "the literature", "various RoB tiers",
  "[insert theme name here]", "[N]", "[your studies]". These signal lazy LLM output and make
  the figure unusable until the user manually edits.
  **Self-check**: before returning, count the verbatim anchors in each figure's external_tool_prompt.
  If < 3, regenerate that figure with more project-specific content.
- Each external_tool_prompt MUST be immediately pasteable — NO "[insert your themes here]" placeholders. Inject actual theme names, RoB counts, concept group labels.
- mermaid_code must be syntactically valid (test mentally: starts with 'flowchart TD' / 'graph LR' / 'sankey-beta' / 'mindmap' etc.) OR be empty string.
- NO bar charts, NO pie charts — those are beneath the bar for an SLR manuscript.
- **English-only output, no exceptions.** Title, mermaid_code, external_tool_prompt — all in English. If the project topic or theme names arrive in Chinese, translate them to standard English scholarly equivalents before embedding. The rendered figure must contain ZERO Chinese (or other non-English) characters.
- Every external_tool_prompt MUST contain an explicit single-line instruction telling the downstream image generator: "ALL labels in the rendered figure MUST be in English." Do not skip this even if the rest of the prompt seems clear.

# Grounding figure-type choices in the enriched data the user prompt provides
When recommending figure types, ground choices in the provided enriched data fields:
- Prefer **forest plot** when outcome-level quantitative evidence count (n_outcomes_quantitative) is >= 4; otherwise replace that slot with a **harvest plot** / **effect-direction plot** and say so in when_to_use.

★ **FOREST PLOT DATA-COMPLETENESS SAFETY RULE (2026-05-25 Phase B)**:
  A forest plot REQUIRES point estimates AND confidence intervals (or
  standard errors / 95% CI bounds) for each outcome. If the supplied
  outcomeGrades or rawMatrixRows shows that many quantitative outcomes
  lack reported CIs / SDs (e.g. > 30% of outcomes have effect_size_text
  like "improvement" / "significant" without numerical CIs), do NOT
  recommend a forest plot — recommend a **harvest plot** or **effect-direction
  plot** instead. In when_to_use, explicitly note: "Forest plot avoided
  because [N of M] outcomes lack reported 95% CIs / SDs; harvest plot
  shows direction without false precision." Inventing CIs to make a
  forest plot work is forbidden and a research-integrity violation.

- Prefer a denser **theme network graph** when synthesis_meta.cross_cutting_observations highlights overlap or shared papers across themes.
- Prefer an **evidence gap map** (or call it out inside the analytical framework) when protocol_coverage shows one or more RQs with no theme coverage.
- Color/encode quality heatmap and theme network nodes using each theme's rob_profile counts (low / some-concerns / high / unclear) and study_design_mix when those fields are present.
- If a target_journal_template specifies preferred_figure_count, do not exceed that count; if it specifies voice_register, mirror that register in titles and captions.
- If uploaded_figure_assets already cover a figure_type, DO NOT recommend a duplicate of the same type — propose a complementary one instead.
`

// ============================================================
// buildOptimizeFigurePromptsUserPrompt — Phase B (v4)
// ============================================================
//
// Signature 扩展为 10 段数据源(老调用方只传 5 段也可用 — 新字段全 optional):
//   project          — project row(title / topic / discipline / goal)
//   protocol         — loadApprovedProtocolFull(含 research_questions + concept_groups)
//   themes           — loadAllThemesWithMeta(含 Step 6 v2 字段:study_design_mix /
//                      rob_profile / methodological_note / grading_framework /
//                      maps_to_research_questions / maps_to_pico_concepts)
//   themeCertainty   — Map<theme_id, certainty_row> from indexLatestCertaintyByTheme,
//                      或 Array(任选,两种都会被吃)。每行至少有 overall_certainty +
//                      grading_framework + body_of_evidence_summary
//   synthesisMeta    — loadSynthesisMetaForCertainty 返回的
//                      { cross_cutting_observations, protocol_coverage }
//   outcomeGrades    — Array of grade_assessments rows(只需 effect_size_text 来分
//                      "narrative" vs "quantitative")。也接受 { total, quantitative }
//                      预计算对象
//   prismaCounts     — computePrismaFlow
//   samplePapers     — Array<{ id, title, authors_text, year, design, sample_size,
//                      intervention, key_finding } | similar> 3-5 篇
//   journalTemplate  — getJournalTemplate 返回(含 extracted_structure)
//   uploadedFigures  — listFigureAssets 返回数组(figure_key, original_filename,
//                      caption 等)
//
// 旧字段 evidencePoints 仍接受但忽略(向后兼容老 caller)。
export function buildOptimizeFigurePromptsUserPrompt(args = {}) {
  const {
    project,
    protocol,
    themes,
    themeCertainty,
    synthesisMeta,
    outcomeGrades,
    prismaCounts,
    samplePapers,
    journalTemplate,
    uploadedFigures,
    rawMatrixRows,
    // 2026-05-25 新加 5 个数据源 — 让 figure prompts 信息量翻倍
    robPerPaper,                 // [{record_id, tool, overall_rating}] per-paper RoB
    dateRangeAlignment,          // { protocol_start/end, actual_earliest/latest, has_gap } — timeline figure 用
    searchStrategiesSummary,     // { databases, n_queries, n_locked, total_raw_hits } — PRISMA flow 用
    methodologyCapabilities,     // M36 capabilities — PRISMA flow 是否含 dual reviewer 框
    availableTables,             // [{key,label,intended_section,row_count}] — 防图跟表重复
    outcomeGradesStats,          // { total, quantitative } — 沿用计数(builder 已有 fallback)
  } = args

  const lines = []
  lines.push('# Generate publication-grade figure prompts for this systematic review')
  lines.push('')
  lines.push('Use the enriched data below to ground every figure recommendation in THIS')
  lines.push('project — not in generic SLR vocabulary. Every figure title, caption and')
  lines.push('external_tool_prompt should reference these exact theme names, RoB counts,')
  lines.push('design-mix counts, RQ mappings, and sample-paper findings.')
  lines.push('')

  // ── 1. Project info ───────────────────────────────────────
  if (project) {
    lines.push('## Project info')
    if (project.title) lines.push(`- Title: ${String(project.title).slice(0, 200)}`)
    if (project.topic) lines.push(`- Topic: ${String(project.topic).slice(0, 300)}`)
    if (project.discipline) lines.push(`- Discipline: ${project.discipline}`)
    if (project.goal) lines.push(`- Goal: ${String(project.goal).slice(0, 300)}`)
    lines.push('')
  }

  // ── 2. Research questions ─────────────────────────────────
  if (protocol?.research_questions?.length) {
    lines.push('## Research Questions')
    protocol.research_questions.slice(0, 8).forEach((q, i) => {
      const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
      lines.push(`- RQ${i + 1}: ${String(t).slice(0, 300)}`)
    })
    lines.push('')
  }

  // ── 3. Concept groups ─────────────────────────────────────
  if (Array.isArray(protocol?.concept_groups) && protocol.concept_groups.length) {
    lines.push('## Concept Groups (PICO / domain)')
    protocol.concept_groups.slice(0, 8).forEach((cg) => {
      const label = cg?.label || cg?.name || cg?.role || '(unnamed)'
      const terms = cg?.terms || cg?.keywords || cg?.synonyms || []
      const head = Array.isArray(terms)
        ? terms.slice(0, 6).map((t) => (typeof t === 'string' ? t : (t?.text || ''))).filter(Boolean).join(' | ')
        : ''
      lines.push(`- ${label}: ${head}`)
    })
    lines.push('')
  }

  // ── 4. Themes (enriched per Step 6) ───────────────────────
  // Normalize themeCertainty to a Map<theme_id, row> for quick lookup
  const certMap = (() => {
    const m = new Map()
    if (!themeCertainty) return m
    if (themeCertainty instanceof Map) {
      for (const [k, v] of themeCertainty.entries()) m.set(k, v)
      return m
    }
    if (Array.isArray(themeCertainty)) {
      // pick latest by iteration_n per theme
      for (const r of themeCertainty) {
        if (!r?.theme_id) continue
        const cur = m.get(r.theme_id)
        if (!cur || (Number(r.iteration_n || 0) > Number(cur.iteration_n || 0))) m.set(r.theme_id, r)
      }
    }
    return m
  })()

  if (Array.isArray(themes) && themes.length) {
    lines.push(`## Themes (enriched per Step 6) — ${themes.length} total`)
    themes.slice(0, 14).forEach((t, i) => {
      const supportN = (t.supporting_record_ids || []).length || t.count || 0
      const framework = t.grading_framework || '—'
      lines.push(`T${i + 1}. ${t.name} (N=${supportN}; framework=${framework})`)
      const rqs = Array.isArray(t.maps_to_research_questions) ? t.maps_to_research_questions : []
      const picos = Array.isArray(t.maps_to_pico_concepts) ? t.maps_to_pico_concepts : []
      if (rqs.length || picos.length) {
        const rqStr = rqs.length ? `RQs=[${rqs.slice(0, 5).map((x) => String(x).slice(0, 40)).join(', ')}]` : 'RQs=[]'
        const picoStr = picos.length ? `PICO=[${picos.slice(0, 5).map((x) => String(x).slice(0, 40)).join(', ')}]` : 'PICO=[]'
        lines.push(`   maps_to: ${rqStr} · ${picoStr}`)
      }
      const designMix = t.study_design_mix && typeof t.study_design_mix === 'object' ? t.study_design_mix : null
      if (designMix && Object.keys(designMix).length) {
        const inner = Object.entries(designMix).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(', ')
        lines.push(`   study_design_mix: {${inner}}  -- helps decide forest plot vs network`)
      }
      const rob = t.rob_profile && typeof t.rob_profile === 'object' ? t.rob_profile : null
      if (rob && Object.keys(rob).length) {
        const inner = Object.entries(rob).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(', ')
        lines.push(`   rob_profile: {${inner}}  -- helps color heatmap nodes`)
      }
      if (t.methodological_note) {
        lines.push(`   methodological_note: ${String(t.methodological_note).slice(0, 200)}`)
      }
      if (t.evidence_strength) {
        lines.push(`   evidence_strength: ${t.evidence_strength}`)
      }
      if (t.description) {
        lines.push(`   description: ${String(t.description).slice(0, 220)}`)
      }
    })
    lines.push('')

    // ── 5. Theme certainty (Step 7 GRADE / CERQual rollup) ──
    if (certMap.size > 0) {
      lines.push('## Theme certainty (Step 7 GRADE / CERQual rollup)')
      themes.slice(0, 14).forEach((t, i) => {
        const c = certMap.get(t.id)
        if (!c) return
        const overall = c.overall_certainty || c.final_certainty || c.overall || 'unclear'
        const fw = c.grading_framework || t.grading_framework || '—'
        const sum = (c.body_of_evidence_summary || c.summary_of_findings || '').toString().slice(0, 150).replace(/\s+/g, ' ').trim()
        lines.push(`T${i + 1}: overall=${overall} (${fw})${sum ? ' — ' + sum : ''}`)
      })
      lines.push('')
    }
  }

  // ── 6. Outcome-level evidence (count only, decides if forest plot) ──
  if (outcomeGrades) {
    let total = 0
    let quantitative = 0
    if (Array.isArray(outcomeGrades)) {
      total = outcomeGrades.length
      const NARR = /^(\s*)(narrative\b|n\/?a\b|—|qual)/i
      for (const g of outcomeGrades) {
        const eff = (g?.effect_size_text || '').toString().trim()
        if (eff && !NARR.test(eff)) quantitative += 1
      }
    } else if (typeof outcomeGrades === 'object') {
      total = Number(outcomeGrades.total || 0)
      quantitative = Number(outcomeGrades.quantitative || 0)
    }
    lines.push('## Outcome-level evidence (Step 7 GRADE/CERQual rollup) — full per-outcome list')
    lines.push(`Counts: n_outcomes_with_grade = ${total}, of which n_outcomes_quantitative (effect_size_text non-narrative) = ${quantitative}`)
    lines.push(quantitative >= 4
      ? `Rule: ${quantitative} >= 4 → a forest plot MAY be valuable (audit effect-size data completeness below before deciding).`
      : `Rule: ${quantitative} < 4 → skip forest plot; prefer narrative / harvest plot / effect-direction figures.`)
    lines.push('')
    // 2026-05-25:从 count-only 升级到完整 per-outcome 列表 — LLM 写 forest plot prompt
    //   能直接列具体 outcome name + effect + certainty(论文级精度)
    if (Array.isArray(outcomeGrades) && outcomeGrades.length) {
      lines.push('Per-outcome detail (cite these outcome names verbatim in figure captions / forest plot rows):')
      outcomeGrades.slice(0, 30).forEach((g, i) => {
        const label   = (g?.outcome_label || g?.label || `(outcome ${i + 1})`).toString().slice(0, 160)
        const theme   = (g?.theme_name || '').toString().slice(0, 80)
        const cert    = (g?.effective_certainty || g?.final_certainty || g?.computed_certainty || '?').toString()
        const effect  = (g?.effect_size_text || '').toString().slice(0, 220)
        const n_st    = g?.num_studies != null ? g.num_studies : (g?.n_studies != null ? g.n_studies : '?')
        const n_par   = g?.num_participants != null ? g.num_participants : (g?.n_participants != null ? g.n_participants : '?')
        const sof     = (g?.summary_of_findings || '').toString().slice(0, 200)
        const importance = g?.importance ? ` · importance=${g.importance}` : ''
        lines.push(`- **${label}**${theme ? ` (theme: ${theme})` : ''}: certainty=${cert} · N studies=${n_st} · N participants=${n_par}${importance}`)
        if (effect) lines.push(`  effect: ${effect}`)
        if (sof) lines.push(`  SoF: ${sof}`)
      })
      if (outcomeGrades.length > 30) lines.push(`- … and ${outcomeGrades.length - 30} more outcomes (truncated for prompt size)`)
      lines.push('')
    }
  }

  // ── 6.6 RoB per-paper distribution (for quality heatmap precision) ──
  //   2026-05-25:per-paper RoB → quality heatmap can encode each paper's rating
  //   precisely instead of theme-level rollup-only.
  if (Array.isArray(robPerPaper) && robPerPaper.length) {
    lines.push('## RoB per-paper (full set — for quality heatmap precision)')
    const byTool = new Map()
    for (const r of robPerPaper) {
      if (!r) continue
      const t = r.tool || 'unknown'
      if (!byTool.has(t)) byTool.set(t, { good: 0, middle: 0, bad: 0, unclear: 0, total: 0 })
      const b = byTool.get(t)
      b.total += 1
      const rating = String(r.overall_rating || '').toLowerCase()
      if (['low', 'low_risk', 'good', 'yes'].includes(rating)) b.good += 1
      else if (['some_concerns', 'moderate', 'middle', 'unclear'].includes(rating)) b.middle += 1
      else if (['high', 'high_risk', 'critical', 'bad', 'serious'].includes(rating)) b.bad += 1
      else b.unclear += 1
    }
    for (const [tool, b] of byTool) {
      lines.push(`- ${tool} (n=${b.total}): low=${b.good}, some_concerns/moderate=${b.middle}, high/critical=${b.bad}, unclear=${b.unclear}`)
    }
    lines.push('Quality heatmap rows can encode each paper individually (rows = papers ordered by theme) using these per-paper ratings.')
    lines.push('')
  }

  // ── 6.7 Date range alignment (for timeline figure) ──
  //   2026-05-25:protocol search window vs actual coverage → timeline figure 数据
  if (dateRangeAlignment && (dateRangeAlignment.actual_earliest || dateRangeAlignment.protocol_start)) {
    lines.push('## Date range alignment (for timeline / publication-year figure)')
    if (dateRangeAlignment.protocol_start || dateRangeAlignment.protocol_end) {
      lines.push(`- Protocol-defined search window: ${dateRangeAlignment.protocol_start || '?'} to ${dateRangeAlignment.protocol_end || '?'}`)
    }
    if (dateRangeAlignment.actual_earliest || dateRangeAlignment.actual_latest) {
      lines.push(`- Actual eligible studies span: ${dateRangeAlignment.actual_earliest || '?'} to ${dateRangeAlignment.actual_latest || '?'}`)
    }
    if (dateRangeAlignment.has_gap) {
      lines.push(`- ★ has_gap = true (protocol window > actual span). Timeline figure should show actual coverage, NOT pretend the gap years had data.`)
    }
    if (Array.isArray(dateRangeAlignment.year_counts)) {
      lines.push('- year counts (yr: N):')
      dateRangeAlignment.year_counts.slice(0, 30).forEach((yc) => {
        if (yc?.year != null && yc?.count != null) lines.push(`  - ${yc.year}: ${yc.count}`)
      })
    }
    lines.push('')
  }

  // ── 6.8 Search strategies summary (for PRISMA flow figure accuracy) ──
  if (searchStrategiesSummary && typeof searchStrategiesSummary === 'object') {
    lines.push('## Search strategies summary (for PRISMA flow figure)')
    if (Array.isArray(searchStrategiesSummary.databases) && searchStrategiesSummary.databases.length) {
      lines.push(`- Databases searched: ${searchStrategiesSummary.databases.join(', ')} (${searchStrategiesSummary.databases.length} total)`)
    }
    if (searchStrategiesSummary.n_queries != null) {
      lines.push(`- Queries: ${searchStrategiesSummary.n_queries} (${searchStrategiesSummary.n_locked || 0} locked / final-executed)`)
    }
    if (searchStrategiesSummary.total_raw_hits != null) {
      lines.push(`- Total raw hits across all queries (before deduplication): ${searchStrategiesSummary.total_raw_hits}`)
    }
    lines.push('Use these in the PRISMA flow figure Identification stage boxes (e.g. "Records from 6 databases: N=X").')
    lines.push('')
  }

  // ── 6.9 Methodology capabilities (M36) — affects PRISMA flow "dual reviewer" boxes ──
  if (methodologyCapabilities && typeof methodologyCapabilities === 'object') {
    const caps = methodologyCapabilities
    const hasAny = caps.dual_reviewer_screening || caps.dual_reviewer_extraction || caps.third_adjudicator
      || (caps.cohens_kappa_value !== null && caps.cohens_kappa_value !== undefined)
      || caps.prospero_id || caps.publication_bias_assessed || caps.follows_prisma_p
    if (hasAny) {
      lines.push('## Methodology capabilities (USER-DECLARED — render only what is ✓ in figures)')
      lines.push(`- Dual screening: ${caps.dual_reviewer_screening ? '✓' : '✗ (NOT performed — do NOT draw "two reviewers" boxes in PRISMA flow)'}`)
      lines.push(`- Dual extraction: ${caps.dual_reviewer_extraction ? '✓' : '✗'}`)
      lines.push(`- Third-reviewer adjudication: ${caps.third_adjudicator ? '✓' : '✗'}`)
      if (caps.cohens_kappa_value !== null && caps.cohens_kappa_value !== undefined) {
        lines.push(`- Cohen's kappa = ${caps.cohens_kappa_value}${caps.kappa_outcome_label ? ` (for ${caps.kappa_outcome_label})` : ''}`)
      }
      if (caps.prospero_id) lines.push(`- PROSPERO: ${caps.prospero_id}`)
      if (caps.publication_bias_assessed) lines.push(`- Publication bias assessed: ✓ ${caps.publication_bias_method || ''}`)
      if (caps.follows_prisma_p) lines.push(`- Follows PRISMA-P 2015: ✓`)
      lines.push('')
    } else {
      lines.push('## Methodology capabilities — DEFAULT: single rater + AI triage; no kappa; no PROSPERO; no publication-bias assessment.')
      lines.push('The PRISMA flow figure MUST NOT show "two independent reviewers" boxes or kappa values. Default single-rater + AI-triage flow.')
      lines.push('')
    }
  }

  // ── 6.10 Available tables manifest (avoid figure / table redundancy) ──
  if (Array.isArray(availableTables) && availableTables.length) {
    lines.push('## Available tables in the manuscript (do NOT propose figures that duplicate these tables)')
    lines.push('Each table already conveys structured data. Figures should COMPLEMENT, not duplicate.')
    availableTables.slice(0, 15).forEach((t) => {
      lines.push(`- [${t.key}] ${t.label} (${t.row_count} rows, intended_section=${t.intended_section || '?'})`)
    })
    if (availableTables.length > 15) lines.push(`- … and ${availableTables.length - 15} more`)
    lines.push('')
  }

  // ── 6.5 Raw matrix sample (data completeness audit for forest plot decision) ──
  //   2026-05-25 Phase C:8-row sample for the LLM to audit whether reported effect
  //   sizes contain enough numeric detail (CI / SD / N) for a defensible forest plot.
  //   If most outcomes are reported as "improvement" / "significant" without CIs,
  //   the LLM should switch to harvest plot per the forest plot safety rule.
  if (Array.isArray(rawMatrixRows) && rawMatrixRows.length) {
    const sample = rawMatrixRows.slice(0, 8)
    lines.push('## Raw matrix sample — data completeness audit (for forest plot vs harvest plot decision)')
    lines.push('Below is a sample of matrix rows. Read the effect_size / quantitative_results / sample_size fields to decide whether a forest plot has enough data, or whether a harvest plot / effect-direction plot is safer (see "FOREST PLOT DATA-COMPLETENESS SAFETY RULE" in the system prompt).')
    sample.forEach((row, i) => {
      const rid = row.record_id || row.id || `?${i}`
      const f = row.fields || row
      if (!f || typeof f !== 'object') return
      lines.push('')
      lines.push(`### Matrix sample for [${rid}]`)
      const SHOW_KEYS = [
        'study_design', 'sample_size', 'outcome', 'outcomes',
        'effect_size', 'effect_sizes', 'quant_results', 'quantitative_results',
        'p_value', 'confidence_interval', 'ci', 'measurement_tools', 'instrument',
        'key_findings', 'findings',
      ]
      for (const k of SHOW_KEYS) {
        const v = f[k]
        if (v == null || (typeof v === 'string' && !v.trim())) continue
        const txt = typeof v === 'string' ? v.slice(0, 400) : JSON.stringify(v).slice(0, 400)
        lines.push(`- ${k}: ${txt}`)
      }
    })
    lines.push('')
  }

  // ── 7. Synthesis meta (Step 6) ────────────────────────────
  if (synthesisMeta && (synthesisMeta.cross_cutting_observations?.length || synthesisMeta.protocol_coverage)) {
    lines.push('## Synthesis meta (Step 6)')
    const xc = Array.isArray(synthesisMeta.cross_cutting_observations) ? synthesisMeta.cross_cutting_observations : []
    if (xc.length) {
      lines.push('cross_cutting_observations (top 3):')
      xc.slice(0, 3).forEach((o) => {
        const txt = typeof o === 'string' ? o : (o?.text || o?.observation || JSON.stringify(o))
        lines.push(`- ${String(txt).slice(0, 200)}`)
      })
    }
    const cov = synthesisMeta.protocol_coverage
    if (cov && typeof cov === 'object') {
      lines.push('protocol_coverage:')
      // cov shape may vary: { RQ1: [theme_ids], ... } OR { rq1: { covered_by: [...] } } OR array
      if (Array.isArray(cov)) {
        cov.slice(0, 8).forEach((row, i) => {
          const rq = row?.rq || row?.research_question || `RQ${i + 1}`
          const covered = Array.isArray(row?.covered_by) ? row.covered_by : (Array.isArray(row?.themes) ? row.themes : [])
          lines.push(`- ${rq} → ${covered.length ? '[' + covered.slice(0, 6).map((x) => String(x).slice(0, 30)).join(', ') + ']' : '"no theme covers (gap)"'}`)
        })
      } else {
        Object.entries(cov).slice(0, 8).forEach(([rq, v]) => {
          const covered = Array.isArray(v) ? v
            : (Array.isArray(v?.covered_by) ? v.covered_by : (Array.isArray(v?.themes) ? v.themes : []))
          lines.push(`- ${rq} → ${covered.length ? '[' + covered.slice(0, 6).map((x) => String(x).slice(0, 30)).join(', ') + ']' : '"no theme covers (gap)"'}`)
        })
      }
    }
    lines.push('')
  }

  // ── 8. Sample paper profiles ─────────────────────────────
  if (Array.isArray(samplePapers) && samplePapers.length) {
    lines.push('## Sample paper profiles (random 3-5 included papers — project-specific vocabulary)')
    samplePapers.slice(0, 5).forEach((p) => {
      const id = p?.id || p?.record_id || '(no id)'
      const author = (p?.authors_text || p?.authors || '').toString().split(/[,;]/)[0].trim().slice(0, 30)
      const year = p?.year || '?'
      const title = (p?.title || '').toString().slice(0, 100).replace(/\s+/g, ' ').trim()
      // matrix snippet — fields may live in p.fields (loadIncludedWithMatrix shape) or flat on p
      const f = p?.fields && typeof p.fields === 'object' ? p.fields : p
      const parts = []
      const designVal = f?.design || f?.study_design || f?.method || ''
      if (designVal) parts.push(`design=${String(designVal).slice(0, 40)}`)
      const nVal = f?.sample_size || f?.n || f?.participants || ''
      if (nVal) parts.push(`N=${String(nVal).slice(0, 30)}`)
      const intVal = f?.intervention || f?.exposure || ''
      if (intVal) parts.push(`intervention=${String(intVal).slice(0, 60)}`)
      const findingVal = f?.key_finding || f?.findings || f?.main_findings || f?.results_summary || ''
      if (findingVal) parts.push(`key_finding="${String(findingVal).slice(0, 120).replace(/"/g, "'")}"`)
      const head = `[${id}] ${author ? author + ' ' : ''}${year}${title ? ' — ' + title : ''}`
      lines.push(parts.length ? `${head} — ${parts.join(' · ')}` : head)
    })
    lines.push('(These give project-specific vocabulary; do NOT lapse into generic "AI in education" / generic medical phrasing.)')
    lines.push('')
  }

  // ── 9. Target journal template ────────────────────────────
  if (journalTemplate) {
    const ex = journalTemplate.extracted_structure && typeof journalTemplate.extracted_structure === 'object'
      ? journalTemplate.extracted_structure : {}
    lines.push('## Target journal template (if loaded)')
    if (journalTemplate.source_filename) lines.push(`- source: ${String(journalTemplate.source_filename).slice(0, 80)}`)
    if (ex.voice_register) lines.push(`- voice_register: ${String(ex.voice_register).slice(0, 120)}`)
    if (ex.typical_section_count) lines.push(`- typical_section_count: ${ex.typical_section_count}`)
    if (ex.citation_density_per_100w) lines.push(`- citation_density_per_100w: ${ex.citation_density_per_100w}`)
    if (ex.preferred_figure_count) lines.push(`- preferred_figure_count: ${ex.preferred_figure_count}  (HARD CAP on number of figures you recommend)`)
    // 2026-05-25 P1-15:补 figure_count(journal-template 抽取的字段名)和 table_count
    if (Number.isFinite(Number(ex.figure_count)) && Number(ex.figure_count) >= 0) {
      lines.push(`- Reference article uses ~${ex.figure_count} figures (soft anchor — do not wildly exceed; recommending 10 figures when journal averages 3 is over-recommendation)`)
    }
    if (Number.isFinite(Number(ex.table_count)) && Number(ex.table_count) >= 0) {
      lines.push(`- Reference article uses ~${ex.table_count} tables (informational — tables are handled separately, just for context)`)
    }
    if (ex.figure_style_notes) lines.push(`- figure_style_notes: ${String(ex.figure_style_notes).slice(0, 200)}`)
    lines.push('')
  }

  // ── 10. Already-uploaded figure assets ────────────────────
  if (Array.isArray(uploadedFigures) && uploadedFigures.length) {
    lines.push('## Already-uploaded figure assets (avoid recommending duplicates of these types)')
    uploadedFigures.slice(0, 12).forEach((a) => {
      const key = a?.figure_key || a?.figure_id || '(no_key)'
      const cap = (a?.caption || a?.original_filename || '').toString().slice(0, 120).replace(/\s+/g, ' ').trim()
      lines.push(`- ${key}${cap ? ' — caption=' + cap : ''}`)
    })
    lines.push('')
  }

  // ── PRISMA counts (always last, short) ────────────────────
  if (prismaCounts) {
    lines.push(`## PRISMA counts: included ${prismaCounts.studies_included || 0} studies (total identified ${prismaCounts.records_identified_total || 0})`)
    lines.push('')
  }

  lines.push('---')
  lines.push('Generate the JSON object per the system schema. Ground every figure title, caption,')
  lines.push('mermaid_code and external_tool_prompt in the enriched data above — reference actual')
  lines.push('theme names, study_design_mix counts, rob_profile counts, RQ mappings, and the')
  lines.push('sample paper vocabulary. Respect the journal template caps if provided.')
  return lines.join('\n')
}

export function parseFigurePromptsOutput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'empty output' }
  let obj = raw
  if (obj.output && typeof obj.output === 'object') obj = obj.output
  if (obj.result && typeof obj.result === 'object') obj = obj.result
  const figs = Array.isArray(obj.figures) ? obj.figures : []
  if (figs.length === 0) return { ok: false, error: 'no figures in output' }
  const out = []
  for (const f of figs) {
    if (!f || typeof f !== 'object') continue
    const id = String(f.id || '').trim() || `fig_${out.length + 1}`
    const title = String(f.title || '').trim()
    // v2 fields(Phase 8.C):external_tool_prompt + mermaid_code
    // v1 fields(legacy):prompt + copy_hint
    const externalToolPrompt = String(f.external_tool_prompt || '').trim()
    const legacyPrompt = String(f.prompt || '').trim()
    const effectivePrompt = externalToolPrompt || legacyPrompt
    // 至少需要 title + (external_tool_prompt OR legacy prompt)≥ 80 chars
    if (!title || effectivePrompt.length < 80) continue
    // 2026-05-25 v6:LLM 现在给出 caption(publication-grade,60-180w)+ alt_text
    //   (accessibility,30-60w);老字段 description / copy_hint 保留兼容。
    //   下游 saveFigureAsset 在用户上传时,如果没填 caption/altText,会自动用这里
    //   的 caption / alt_text 作为默认 —— 用户无需每次手填。
    const caption = String(f.caption || f.description || '').trim()
    const altText = String(f.alt_text || '').trim()
    out.push({
      id: id.slice(0, 50),
      title: title.slice(0, 200),
      caption: caption.slice(0, 2000),
      alt_text: altText.slice(0, 1000),
      figure_type: String(f.figure_type || '').trim().slice(0, 50),
      intended_section: String(f.intended_section || '').trim().slice(0, 50),
      when_to_use: String(f.when_to_use || '').trim().slice(0, 800),
      mermaid_code: String(f.mermaid_code || '').trim().slice(0, 6000),
      external_tool_prompt: externalToolPrompt.slice(0, 6000),
      // Backward-compat:保留老字段(老 view / export 路径还会读)
      copy_hint: String(f.copy_hint || '').trim().slice(0, 200),
      prompt: (externalToolPrompt || legacyPrompt).slice(0, 6000),
      description: caption.slice(0, 800),
    })
  }
  if (out.length === 0) return { ok: false, error: 'all figures failed validation' }
  return { ok: true, figures: out, style_baseline_used: String(obj.style_baseline_used || '').trim().slice(0, 300) }
}

export function generateFigurePrompts(db, projectId) {
  // ────────────────────────────────────────────────────────────────────
  // Generic English fallback figure prompts (cross-discipline).
  //   优化打磨包 / Prompt audit fix:之前是中文 + ChatGPT 特定提法的硬编码 fallback。
  //   现在改成跨学科 / 英文 / 工具中立(可粘到任意 image-LLM 或 vector editor)。
  //   仍然只在 LLM-optimized 版本(aiOptimizedFigures)缺失时显示。
  // ────────────────────────────────────────────────────────────────────
  let project = null
  try {
    project = db.prepare(
      `SELECT id, title, topic, discipline FROM projects WHERE id = ?`
    ).get(projectId)
  } catch {}

  const ev = generateEvidenceMapData(db, projectId)
  const themes = ev.themes
  const counts = computePrismaFlow(db, projectId)
  const yt = generateYearTrendData(db, projectId)

  const topic = (project?.topic || project?.title || '(project topic not set)').slice(0, 200)
  const discipline = project?.discipline || ''
  const themeNames = themes.length
    ? themes.slice(0, 8).map((t, i) => `${i + 1}. ${t.name}${t.count ? ` (n=${t.count} studies)` : ''}`).join('\n   ')
    : '(themes not generated yet — run Step 6 first)'
  // Pre-format year trend for prompt injection
  const yearTrendBullets = (yt.years || []).length
    ? yt.years.map((y, i) => `${y}: n=${yt.counts[i] || 0}`).join('  ·  ')
    : '(no included studies with year metadata — Step 3 dedup may not have run yet)'
  // Cumulative count by year (helps prompts that want both bars + line)
  let cum = 0
  const yearTrendCumulative = (yt.years || []).map((y, i) => {
    cum += (yt.counts[i] || 0)
    return `${y}: cum=${cum}`
  }).join('  ·  ') || '(none)'
  // Theme name + count, for evidence-map prompt
  const themeMapRows = themes.length
    ? themes.slice(0, 12).map((t, i) =>
        `${i + 1}. ${(t.name || '(unnamed)').slice(0, 80)} — supports=${t.count || 0}${t.evidence_strength ? ` · strength=${t.evidence_strength}` : ''}`
      ).join('\n   ')
    : '(themes not generated yet — run Step 6 first)'

  const stylePreamble = `
Style requirements:
- Scholarly figure style, predominantly black / dark grey with 1-2 accent colours (e.g. #1e40af blue, #047857 green).
- Avoid cartoon / emoji / 3D / anthropomorphic elements.
- Sans-serif typeface (Inter, Helvetica, Arial).
- Output as SVG vector (preferred) or 300 DPI PNG; aspect ratio 16:9 or 4:3.

LANGUAGE — HARD CONSTRAINT:
- ALL labels in the rendered figure MUST be in English.
- If any theme name, concept term, or study label arrives in Chinese (or any other non-English language) in the brief above, translate it to its standard English scholarly equivalent BEFORE rendering. The final figure must contain ZERO Chinese / non-Latin characters.
- This applies to titles, axis labels, legend text, node text, captions — everything visible in the figure.
`.trim()

  const copyHintGeneric = 'Paste into any image-LLM (gpt-image-1, DALL·E, Midjourney, Stable Diffusion, BioRender prompt) OR a vector editor (draw.io, Lucidchart, Figma)'

  // PRISMA flow counts pretty-formatted for prompt injection
  const prismaFlowText = [
    `Identification: ${counts.records_identified || 0} records from ${(counts.records_identified_databases_n || 0)} database(s)${counts.records_identified_other_n ? ` + ${counts.records_identified_other_n} from other sources` : ''}`,
    `Duplicates removed: ${counts.duplicates_removed || 0}`,
    `Records screened (title/abstract): ${counts.records_screened || 0}`,
    `Records excluded after title/abstract: ${counts.excluded_title_abstract || 0}`,
    `Full-text articles assessed: ${counts.full_text_assessed || 0}`,
    `Full-text articles excluded: ${counts.full_text_excluded || 0}`,
    `Studies included in qualitative synthesis: ${counts.studies_included || 0}`,
  ].filter(Boolean).join('\n   ')

  return [
    {
      id: 'prisma_flow',
      title: 'PRISMA 2020 Flow Diagram',
      when_to_use:
        'Methods section, near the start (right after search-strategy description). ' +
        'Required by PRISMA 2020 reporting guideline — visualises identification → screening → eligibility → included pipeline with verbatim counts.',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw the PRISMA 2020 Flow Diagram for this systematic review (Page et al., BMJ 2021; 372:n71).`,
        ``,
        `Review topic: ${topic}`,
        discipline ? `Discipline: ${discipline}` : '',
        ``,
        `Use the actual counts from this review (verbatim — do NOT round or invent):`,
        `   ${prismaFlowText}`,
        ``,
        `Layout requirements (publication-grade — the default mermaid render is plain and not journal-quality):`,
        `- Three vertical swimlanes from top to bottom labelled "Identification", "Screening", "Eligibility", "Included".`,
        `- Each stage is a rounded rectangle with the count + brief label inside (e.g. "Records identified through database search (n = ${counts.records_identified || '?'})").`,
        `- Side branches showing exclusions (with reasons) using dashed arrows to a smaller "excluded" box on the right.`,
        `- Use a clean academic style — no shading, no 3D effects, no decorative icons.`,
        `- Connecting arrows are solid black with arrowheads; exclusion arrows are dashed grey.`,
        `- Stage labels (Identification / Screening / etc.) on the left in a vertical band (light grey background, black text).`,
        ``,
        `Hints for tool:`,
        `- Best produced in draw.io / Lucidchart / Figma using rounded rectangles + connectors.`,
        `- Alternative: paste prompt to gpt-image-1 / DALL-E 3 in "high quality, scientific journal figure" mode.`,
        `- For Word docs: BioRender has a PRISMA 2020 template you can fork.`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'conceptual_framework',
      title: 'Conceptual Framework',
      when_to_use:
        'End of Introduction or start of Methods. Visualises the core constructs, relationships and boundaries the review addresses. ' +
        'Especially useful when the review touches multiple interacting constructs (e.g. antecedents → mediators → outcomes).',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw a "conceptual framework" diagram for a systematic literature review.`,
        ``,
        `Review topic: ${topic}`,
        discipline ? `Discipline: ${discipline}` : '',
        ``,
        `Core constructs to visualise (derived from this review's synthesised themes):`,
        `   ${themeNames}`,
        ``,
        `Requirements:`,
        `- Place the themes as "mediators" or "dimensions" in the centre.`,
        `- Place antecedents on the left, outcomes on the right.`,
        `- Use arrows to indicate hypothesised causal or associative directions.`,
        `- Add a small caption at the bottom: "Adapted from a systematic review, n=${counts.studies_included} studies".`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'theme_relationship',
      title: 'Theme Relationship Diagram',
      when_to_use:
        'Place in Results / Discussion to visualise how themes relate to each other. ' +
        'Helpful when themes are nested / parallel / contradictory — more persuasive than a plain list.',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw a "theme relationship diagram" for a systematic literature review.`,
        ``,
        `Review topic: ${topic}`,
        ``,
        `Themes identified:`,
        `   ${themeNames}`,
        ``,
        `Requirements:`,
        `- Each theme is a circular or rounded-rectangle node; node size reflects the number of supporting studies.`,
        `- Solid lines = strong relationship; dashed lines = weak or contradictory relationship.`,
        `- Place semantically close themes near each other; distant themes apart (cluster-map style).`,
        `- Inside each node, use 1-3 English keywords.`,
        `- Leave space at the bottom (no built-in title) so a caption can be added externally.`,
        ``,
        stylePreamble,
      ].join('\n'),
    },
    {
      id: 'selection_map',
      title: 'Study Selection Funnel (PRISMA visualised)',
      when_to_use:
        'Optional — when targeting a high-impact journal, replace the plain Mermaid PRISMA flow with a polished funnel illustration in Methods / Results. ' +
        'A standard Mermaid PRISMA is already generated programmatically; this prompt is for the camera-ready version.',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw a "study selection funnel" for a systematic literature review, visualising the PRISMA 2020 numbers:`,
        ``,
        `1. Records identified: ${counts.records_identified_total}`,
        `2. After duplicates removed: ${counts.records_screened} (removed ${counts.duplicates_removed})`,
        `3. Title / abstract excluded: ${counts.excluded_title_abstract}`,
        `4. Full-text assessed: ${counts.full_text_assessed}`,
        `5. Full-text excluded: ${counts.full_text_excluded}`,
        (counts.rob_excluded || 0) > 0 ? `6. Excluded after Risk-of-Bias: ${counts.rob_excluded}` : '',
        `${(counts.rob_excluded || 0) > 0 ? '7' : '6'}. Studies included: ${counts.studies_included}`,
        ``,
        `Requirements:`,
        `- Funnel narrows top to bottom; label the count at each level.`,
        `- On the right, annotate "excluded: n=X" for each exclusion stage.`,
        `- If multiple source databases, show them as small inlets at the top funnelling in.`,
        `- No built-in title.`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'year_trend',
      title: 'Year-of-Publication Trend (enhanced)',
      when_to_use:
        'Place in Results overview to show the temporal evolution of the field. ' +
        'Pairs especially well as "Figure 1" right after PRISMA. The platform already auto-renders a basic bar inside the UI; this prompt is for the camera-ready upgraded version (combo bar+line, theme composition, peak annotation).',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw a combination chart titled "Annual Publication Trend of Included Studies" for a systematic literature review.`,
        ``,
        `Review topic: ${topic}`,
        ``,
        `Annual counts (n=${yt.total || 0} studies total):`,
        `   ${yearTrendBullets}`,
        ``,
        `Cumulative growth:`,
        `   ${yearTrendCumulative}`,
        ``,
        themes.length
          ? `Themes that contribute to the corpus (for the stacked-bar variant): ${themes.slice(0, 6).map((t) => t.name).join(' | ')}`
          : `(themes not yet generated; render as a single-series chart)`,
        ``,
        `Requirements:`,
        `- Combo chart: vertical bars = per-year count + an overlaid line = cumulative count (right Y-axis).`,
        `- If themes exist, prefer a stacked-bar variant where each year's bar is segmented by the dominant theme(s) — use a small categorical palette (≤ 6 distinct hues), not rainbow.`,
        `- X-axis: every year from earliest to latest (fill gaps with 0).`,
        `- Annotate the peak year with an arrow + label "Peak: n=X (YYYY)".`,
        `- Annotate the most recent year with "(in progress)" if the count looks truncated by the search cut-off date.`,
        `- Left Y-axis = absolute count (integer ticks). Right Y-axis = cumulative count.`,
        `- Add a horizontal dotted line at the average n/year with a small label "mean=N.N".`,
        `- Caption (place below): "Figure 1. Annual publication trend of N=${yt.total || 0} included studies (${(yt.years || [])[0] || '?'}–${(yt.years || []).slice(-1)[0] || '?'}). Stacked bars show theme composition; line shows cumulative count."`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'evidence_map',
      title: 'Evidence Map / Theme-by-Strength Matrix (enhanced)',
      when_to_use:
        'Place at the start of Results to summarise the entire body of evidence at a glance. ' +
        'Typically more useful than a plain bar chart — let readers see which themes are dense / sparse, and which are well- vs poorly-supported.',
      copy_hint: copyHintGeneric,
      prompt: [
        `Draw an "evidence map" (heatmap matrix style) for a systematic literature review.`,
        ``,
        `Review topic: ${topic}`,
        `Total included studies: ${counts.studies_included || 0}`,
        `Number of themes: ${themes.length}`,
        ``,
        `Themes and their supporting-study counts (use these EXACT labels and numbers):`,
        `   ${themeMapRows}`,
        ``,
        `Requirements:`,
        `- Render as a 2-axis matrix:`,
        `    Y-axis (rows) = themes (in the order listed above).`,
        `    X-axis (columns) = a small set of evidence dimensions: ["# studies", "RoB profile", "Design diversity", "Recency"]`,
        `      If you don't have these per-cell numbers, fall back to a single-column horizontal bubble plot where bubble size = "# studies" and bubble colour intensity = evidence_strength (strong → dark, weak → light).`,
        `- Use a 3-tier diverging colour scale anchored on evidence strength:`,
        `    strong = saturated green (#047857), moderate = neutral grey (#9ca3af), weak = saturated amber (#b45309).`,
        `- Inside each cell or bubble, print the supporting-study count.`,
        `- Sort themes top-to-bottom by descending support count (largest cluster at top).`,
        `- Right-side legend explaining the colour scale.`,
        `- Below the matrix, draw a small horizontal bar showing the dominant study designs across the whole corpus (e.g. "RCT / quasi-experimental / qualitative / mixed").`,
        `- Caption: "Figure 2. Evidence map: distribution of N=${counts.studies_included || 0} included studies across ${themes.length} themes. Cell colour encodes synthesised evidence strength; cell number is the count of supporting studies."`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
  ]
}

// ────────────────────────────────────────────────────────────
// SVG helpers — 供 ejs 调用,在视图层直接 <%- ... %>
// ────────────────────────────────────────────────────────────

/**
 * 渲染年度趋势条形图为 inline SVG 字符串。
 * 简洁实现:不依赖前端图表库,直接生成 SVG。
 */
export function renderYearTrendSvg(data, { width = 520, height = 180 } = {}) {
  if (!data || !Array.isArray(data.years) || data.years.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '"><text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="sans-serif">暂无年度数据(尚无已纳入论文)</text></svg>'
  }
  const { years, counts } = data
  const max = Math.max(1, ...counts)
  const pad = { l: 28, r: 12, t: 14, b: 28 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const barW = Math.max(4, Math.floor(innerW / years.length) - 4)
  const step = innerW / years.length

  const bars = years
    .map((y, i) => {
      const c = counts[i]
      const h = (c / max) * innerH
      const x = pad.l + i * step + (step - barW) / 2
      const yPos = pad.t + (innerH - h)
      return `<rect x="${x.toFixed(1)}" y="${yPos.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="#1e40af" rx="2"/>` +
        (c > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(yPos - 2).toFixed(1)}" text-anchor="middle" fill="#1e40af" font-size="9" font-family="sans-serif">${c}</text>` : '')
    })
    .join('')

  // x 轴标签:稀疏化避免重叠(每 N 个一标)
  const labelStride = Math.max(1, Math.floor(years.length / 8))
  const labels = years
    .map((y, i) => {
      if (i % labelStride !== 0 && i !== years.length - 1) return ''
      const x = pad.l + i * step + step / 2
      return `<text x="${x.toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" fill="#64748b" font-size="10" font-family="sans-serif">${y}</text>`
    })
    .join('')

  // y 轴最大值
  const yLabel = `<text x="${pad.l - 4}" y="${(pad.t + 8).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="sans-serif">${max}</text>` +
                 `<text x="${pad.l - 4}" y="${(pad.t + innerH).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="sans-serif">0</text>`

  // 基线
  const axis = `<line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="#cbd5e1" stroke-width="1"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    axis + yLabel + bars + labels +
    '</svg>'
}

/**
 * 渲染 evidence map 为 inline SVG(简化版:横条 + 数字标注)。
 */
export function renderEvidenceMapSvg(data, { width = 520 } = {}) {
  const themes = (data && Array.isArray(data.themes)) ? data.themes : []
  if (themes.length === 0) {
    const h = 80
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}"><text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="sans-serif">暂无主题(Step 7 主题聚类尚未运行)</text></svg>`
  }
  const rowH = 22
  const pad = { l: 8, r: 8, t: 8, b: 8 }
  const labelW = Math.min(180, Math.floor(width * 0.4))
  const barAreaW = width - pad.l - pad.r - labelW - 40
  const max = Math.max(1, ...themes.map((t) => t.count || 0))
  const height = pad.t + pad.b + themes.length * rowH

  const rows = themes
    .map((t, i) => {
      const y = pad.t + i * rowH
      const w = ((t.count || 0) / max) * barAreaW
      const labelText = (t.name || '').slice(0, 26)
      const strengthColor = ({
        strong: '#047857',
        moderate: '#1e40af',
        weak: '#a16207',
        mixed: '#7c2d12',
      })[t.evidence_strength] || '#475569'
      return [
        `<text x="${pad.l + labelW - 6}" y="${y + 14}" text-anchor="end" fill="#334155" font-size="11" font-family="sans-serif">${escapeXml(labelText)}</text>`,
        `<rect x="${pad.l + labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" fill="${strengthColor}" opacity="0.85" rx="2"/>`,
        `<text x="${(pad.l + labelW + w + 4).toFixed(1)}" y="${y + 14}" fill="#475569" font-size="10" font-family="sans-serif">${t.count}</text>`,
      ].join('')
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${rows}</svg>`
}

function escapeXml(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
