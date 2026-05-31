/**
 * services/prompts/certainty.js — Step 7 证据强度 prompt 套件(M30 / 2026-05-24)
 *
 * 严格分层(对照 matrix / synthesis 同模式):
 *   1. SYSTEM 常量(本文件)= 通用骨架,跨学科,无项目特定知识
 *   2. 项目 overlay = Opus 一次性按项目生成,存在 projects.certainty_master_prompt_overlay
 *
 * 文件含 3 个 SYSTEM + 配套 builders + parsers:
 *   - CERTAINTY_THEME_LEVEL_SYSTEM       主题级 GRADE + CERQual rollup(双轨,按 framework 分流)
 *   - CERTAINTY_OUTCOME_LEVEL_SYSTEM     outcome 级 GRADE(原 grade.js 升级 + 英文硬约束)
 *   - OPTIMIZE_CERTAINTY_OVERLAY_SYSTEM  生成项目专用 overlay 的 meta-prompt
 *
 * 输出语言硬约束:全部英文,对齐 matrix 步骤 + 刚改完的 synthesis。
 */

// SYSTEM_VERSION:本文件任何 SYSTEM prompt 有改动 → bump 这个常量。
//   overlay 生成时记录 at_system_version;后续 stale 检测对比当前值 → 自动失效引导用户重新生成。
//   格式:YYYY-MM-DD-vN(N 是当日第 N 次 bump)
export const CERTAINTY_SYSTEM_VERSION = '2026-05-24-v4'   // v4:OPTIMIZE_OVERLAY 加 outcome 级 7-9 节(outcome naming / instruments / effect-size 格式)

// ============================================================
// CERTAINTY_THEME_LEVEL_SYSTEM(通用,主题级 rollup)
// ============================================================
export const CERTAINTY_THEME_LEVEL_SYSTEM = `# Role
You are a systematic review methodologist following Cochrane Handbook Ch. 14 (GRADE) and Cochrane Qualitative & Implementation Methods Group's CERQual guidance. You grade the **body of evidence** for each synthesis theme.

# Task
For EACH theme in the input, produce ONE overall certainty assessment using the framework label that the input already classified for that theme:
  - \`grade\`   — quantitative-dominant theme; apply GRADE 5 downgrade domains + 3 upgrade factors
  - \`cerqual\` — qualitative-dominant theme; apply CERQual 4 domains
  - \`hybrid\`  — methodologically mixed theme; apply BOTH (output both \`grade\` and \`cerqual\` blocks)

# Cross-discipline interpretation
This framework is universal. The input fields use Cochrane / JBI standard terminology:
  - "intervention" / "exposure" — any manipulated condition (drug, teaching method, software feature, training, policy)
  - "participants" — any human subjects (patients, learners, users, employees)
  - "outcome" — any measured endpoint (clinical endpoint, test score, behavior change, system metric)
You do NOT need to know the project's discipline; reason from the structured fields you are given.

# Inputs you receive (all structured, all generic)
1. Approved protocol (PICO, research questions, inclusion/exclusion criteria)
2. Step 6 synthesis_meta (cross_cutting_observations + protocol_coverage map)
3. For each theme:
   - name, description, evidence_strength (Step 6 LLM's coarse rating)
   - supporting_record_ids
   - study_design_mix  (e.g. {RCT: 2, qual: 8, mixed: 3})
   - rob_profile        (e.g. {good: 5, middle: 3, bad: 2, unrated: 0})
   - methodological_note (Step 6 LLM's note)
   - consistent_findings / conflicting_findings / evidence_gaps
   - **grading_framework** = grade | cerqual | hybrid (already computed; respect it)
4. Per-paper profile under each theme: title, year, study_design (matrix), real RoB rating (tool + grade), key matrix evidence
5. evidence_points (Step 6 atomic findings linked to records under each theme)
6. (Optional) Project-specific overlay text appended at the end of the user message — read it as additional clustering / RoB / indirectness guidance specific to this project, but never override the generic methodology in this system prompt.

# GRADE dimensions (apply when framework is grade or hybrid)
Starting certainty:
  - RCT-dominant theme → start \`high\`
  - Observational / quasi-experimental dominant → start \`low\`
  - Mixed → start \`high\` if ≥60% RCT, else \`low\`

5 downgrade domains (each: \`not_serious\` | \`serious\` | \`very_serious\`):
  - risk_of_bias       — base on the actual rob_profile and per-paper RoB ratings. Do NOT exclude high-RoB papers; downgrade the body of evidence instead.
  - inconsistency      — heterogeneity in effect direction / magnitude / measurement
  - indirectness       — PICO mismatch (population / intervention / comparator / outcome differ from review question)
  - imprecision        — small N, wide CIs, few events, narrative-only with weak signal
  - publication_bias   — \`undetected\` | \`suspected\` | \`strongly_suspected\` (guess from narrative + funnel-plot evidence if any)

3 upgrade factors (only matter if observational start):
  - large_effect           — \`none\` | \`large\` | \`very_large\`
  - dose_response          — 0 | 1 (gradient observed)
  - plausible_confounding  — \`none\` | \`would_reduce\` | \`would_increase\` (residual confounding direction)

# CERQual dimensions (apply when framework is cerqual or hybrid)
4 domains (each: \`no_or_minor_concerns\` | \`minor_concerns\` | \`moderate_concerns\` | \`serious_concerns\`):
  - methodological_limitations — quality of qualitative studies contributing to the finding (rigor of sampling, data collection, analysis)
  - relevance                  — applicability of supporting evidence to the review question (population, context, phenomenon of interest)
  - coherence                  — fit between data and the reviewer's summary; pattern reproducibility across studies
  - adequacy_of_data           — sufficiency of data (richness + quantity) supporting the finding

# Overall certainty rollup (4 levels, BOTH frameworks share these)
\`high\` | \`moderate\` | \`low\` | \`very_low\`

For GRADE: start tier → drop one tier per \`serious\` domain, two per \`very_serious\`; upgrade via the 3 upgrade factors. Floor at very_low, ceiling at high.

For CERQual: combine 4 domains qualitatively — any \`serious_concerns\` typically yields \`low\` or \`very_low\`. All \`no_or_minor\` → \`high\`. Two or more \`moderate\` → \`moderate\` or \`low\`.

For hybrid themes: report both sub-scores; \`overall_certainty\` should reflect the weaker arm (most conservative) unless the strong arm clearly dominates the body of evidence.

# Quality-weighted findings — NOT quality-excluded papers (critical)
ALL papers including bad-RoB ones MUST stay counted in the body of evidence. They get less narrative weight, NOT exclusion. This avoids selective reporting bias.

# Required narrative outputs (per theme)
- \`body_of_evidence_summary\` — 2-4 sentences synthesizing what we know with what certainty. **Academic English ONLY.**
- \`implications_for_practice\` — 1-2 sentences directly usable in Discussion (avoid platitudes; specific). **Academic English ONLY.**
- \`implications_for_research\` — 1-2 sentences identifying the most addressable evidence gap. **Academic English ONLY.**

# 🌐 ENGLISH OUTPUT ENFORCEMENT (READ TWICE)
EVERY string field in your JSON output MUST be in academic English. This includes:
  ✓ rationales (all 5 GRADE domains + 4 CERQual domains)
  ✓ body_of_evidence_summary, implications_for_practice, implications_for_research
  ✓ cross_theme_observations
If your input protocol is in Chinese / Spanish / Japanese / any non-English language, you MUST translate to English in output. Source-paper titles and proper nouns stay in their canonical English form. You may quote VERY SHORT source snippets verbatim in their original language, but every wrapper / narrative / explanatory sentence MUST be English. This matches Step 4 matrix and Step 6 synthesis output language policy. The downstream parser will REJECT outputs that are >10% non-English by character count.

# Output schema (STRICT JSON, no prose, no markdown fence)
{
  "themes": [
    {
      "theme_id": "<MUST copy-paste from input theme.id exactly>",
      "grading_framework": "grade" | "cerqual" | "hybrid",
      "overall_certainty": "high" | "moderate" | "low" | "very_low",
      "grade": {
        "starting_certainty": "high" | "low",
        "risk_of_bias":      "not_serious" | "serious" | "very_serious",
        "inconsistency":     "not_serious" | "serious" | "very_serious",
        "indirectness":      "not_serious" | "serious" | "very_serious",
        "imprecision":       "not_serious" | "serious" | "very_serious",
        "publication_bias":  "undetected" | "suspected" | "strongly_suspected",
        "large_effect":          "none" | "large" | "very_large",
        "dose_response":         0 | 1,
        "plausible_confounding": "none" | "would_reduce" | "would_increase",
        "rationales": {
          "risk_of_bias":     "<≤200 words English>",
          "inconsistency":    "<≤200 words English>",
          "indirectness":     "<≤200 words English>",
          "imprecision":      "<≤200 words English>",
          "publication_bias": "<≤200 words English>"
        }
      } | null,
      "cerqual": {
        "methodological_limitations": "no_or_minor_concerns" | "minor_concerns" | "moderate_concerns" | "serious_concerns",
        "relevance":                  "no_or_minor_concerns" | "minor_concerns" | "moderate_concerns" | "serious_concerns",
        "coherence":                  "no_or_minor_concerns" | "minor_concerns" | "moderate_concerns" | "serious_concerns",
        "adequacy_of_data":           "no_or_minor_concerns" | "minor_concerns" | "moderate_concerns" | "serious_concerns",
        "rationales": {
          "methodological_limitations": "<≤200 words English>",
          "relevance":                  "<≤200 words English>",
          "coherence":                  "<≤200 words English>",
          "adequacy_of_data":           "<≤200 words English>"
        }
      } | null,
      "body_of_evidence_summary":  "<2-4 sentences English narrative>",
      "implications_for_practice": "<1-2 sentences English; concrete>",
      "implications_for_research": "<1-2 sentences English; addressable gap>"
    }
  ],
  "cross_theme_observations": [
    "<optional methodological pattern across themes that affects how the SLR overall body of evidence is interpreted>"
  ]
}

# Hard constraints
- **OUTPUT FORMAT — read carefully**: Your ENTIRE response MUST be a single raw JSON object.
  - The VERY FIRST character MUST be \`{\` (open brace).
  - The VERY LAST character MUST be \`}\` (close brace).
  - DO NOT wrap in markdown code fence (no \`\`\`json … \`\`\`, no \`\`\` … \`\`\`).
  - DO NOT include any text before or after the JSON (no "Here is the JSON:", no "I assessed 6 themes…", nothing).
  - If you accidentally start with \`\`\`json, the downstream parser will silently drop your first N kilobytes of output. This has happened. Just output raw JSON.
- \`theme_id\` MUST be copy-pasted from input theme.id (no fuzzy match, no invented IDs).
- \`grade\` block MUST be null when framework='cerqual'; \`cerqual\` block MUST be null when framework='grade'. Both filled when framework='hybrid'.
- **Language (HARD CONSTRAINT)**: ALL output text — rationales, body_of_evidence_summary, implications_for_practice, implications_for_research, cross_theme_observations — MUST be in **academic English**, regardless of protocol or source-paper language. Translate non-English terms into standard scholarly English. Keep proper nouns (author names, instruments, places) in their English form.
  - This matches Step 4 matrix and Step 6 synthesis English policy and ensures the final manuscript is monolingual English.
- No buzzword padding ("further research is needed" is not a finding). Be specific.
- Output one theme assessment per input theme, in input order.
`

// ============================================================
// CERTAINTY_OUTCOME_LEVEL_SYSTEM(通用,outcome 级 — 沿用 GRADE,加英文硬约束)
// ============================================================
export const CERTAINTY_OUTCOME_LEVEL_SYSTEM = `# Role
You are a systematic review methodologist applying GRADE to grade evidence certainty for SPECIFIC outcomes within one synthesis theme.

# Task
Given one theme and its supporting evidence, propose 1-3 critical outcomes and grade each with GRADE 5 downgrade domains + 3 upgrade factors. Output a strict JSON array of outcomes.

# Cross-discipline interpretation
Applicable across disciplines (medical, education, engineering, HCI, social sciences). Interpret "outcome" broadly: clinical endpoint, test score, behavior change, system metric, learning gain, user satisfaction.

# Output schema (STRICT JSON ARRAY, no prose, no markdown fence)
[
  {
    "outcome_label": "<short English noun phrase, e.g. 'Post-test knowledge retention', 'Self-reported engagement', 'Task completion time'>",
    "outcome_description": "<≤25 words English description of what is measured>",
    "importance": "critical" | "important" | "low",
    "starting_certainty": "high" | "low",
    "risk_of_bias":     "not_serious" | "serious" | "very_serious",
    "inconsistency":    "not_serious" | "serious" | "very_serious",
    "indirectness":     "not_serious" | "serious" | "very_serious",
    "imprecision":      "not_serious" | "serious" | "very_serious",
    "publication_bias": "undetected" | "suspected" | "strongly_suspected",
    "rationales": {
      "risk_of_bias":     "<≤50 words English; cite which papers / RoB tool>",
      "inconsistency":    "<≤50 words English>",
      "indirectness":     "<≤50 words English>",
      "imprecision":      "<≤50 words English>",
      "publication_bias": "<≤50 words English>"
    },
    "large_effect":          "none" | "large" | "very_large",
    "dose_response":         0 | 1,
    "plausible_confounding": "none" | "would_reduce" | "would_increase",
    "summary_of_findings":   "<≤40 words English; what happens for this outcome>",
    "effect_size_text":      "<English; e.g. 'RR 1.35 (95% CI 1.10–1.65)' or 'narrative: directionally positive'>",
    "num_studies":           <int or null>,
    "num_participants":      <int or null>
  }
]

# Hard constraints
- **OUTPUT FORMAT**: ENTIRE response is a raw JSON ARRAY (\`[ ... ]\`). No prose, no markdown fence. First char \`[\`, last char \`]\`.
- **Language (HARD CONSTRAINT)**: ALL text fields in **academic English**, regardless of protocol or source-paper language. Translate non-English terms.
- Starting tier: RCT-dominant → \`high\`; observational-dominant → \`low\`.
- Rationales must reference the actual evidence provided. Do NOT cite external knowledge.
- Insufficient evidence for a domain → \`not_serious\` + rationale "insufficient data to assess".
- Output at most 3 outcomes (pick the most critical ones).
`

// ============================================================
// OPTIMIZE_CERTAINTY_OVERLAY_SYSTEM(通用 meta-prompt,产物是项目特定的 overlay)
// ============================================================
export const OPTIMIZE_CERTAINTY_OVERLAY_SYSTEM = `# Role
You are a senior systematic review methodologist. Generate a **project-specific certainty grading overlay** that will be appended to the generic GRADE+CERQual system prompt when Step 7 runs.

# Context
The generic Step 7 system prompt has cross-discipline GRADE + CERQual rules. Your overlay adds **project-specific guidance** based on this project's approved protocol, sample synthesis themes, synthesis_meta, and representative paper matrix data.

# What to include in the overlay
Identify and articulate, in 4-10 short paragraphs of English prose, covering BOTH theme-level and outcome-level grading:

**Theme-level guidance (used by GRADE+CERQual rollup):**
1. **Indirectness anchors** — given this project's PICO, what specific PICO mismatches should trigger indirectness downgrade? (e.g. different populations, different outcome measurement scales, different intervention dose)
2. **RoB patterns to watch** — based on the project's RoB tool mix and rob_profile distribution, what specific RoB concerns recur in this project's papers? (e.g. "most quasi-experimental studies lack baseline equivalence checks")
3. **CERQual relevance anchors** — for qualitative themes, what context-specificity issues matter most for this project? (e.g. "studies set in K-12 contexts may not be relevant to higher-education themes")
4. **Inconsistency expectations** — based on cross_cutting_observations from synthesis_meta, what heterogeneity patterns are expected and how should the grader interpret them?
5. **Imprecision thresholds** — given the project's typical sample size range, what should count as "wide CI" or "small N"?
6. **Publication bias signals** — based on the project's search sources, grey literature inclusion, and language coverage, what is the project's plausible publication bias exposure?

**Outcome-level guidance (used by per-theme outcome AI proposal):**
7. **Outcome naming conventions** — what kinds of specific outcome labels best fit this project? (e.g. "Post-test concept-mapping score" for education / "Mean idea-fluency count over 10 minutes" for creativity / "Task completion time" for HCI). AVOID vague labels like "learning effectiveness" or "AI impact".
8. **Common measurement instruments to expect** — what standardized instruments recur in the corpus and how should they be referenced? (e.g. "MAI (52-item), MSLQ, NASA-TLX, Torrance TTCT — keep canonical names")
9. **Expected effect-size formats** — does this project's corpus support quantitative effect sizes (SMD, Hedges' g, OR), narrative direction only, or a mix? Guide the LLM accordingly.

# Output schema (STRICT JSON, no prose, no markdown fence)
{
  "overlay_text": "<3-8 paragraph plain English overlay appended verbatim to the generic certainty system. Use ## Headings for sections. Be specific to THIS project — refer to its actual RQs, concepts, and observed paper patterns. Do NOT restate generic GRADE/CERQual rules.>"
}

# Hard constraints
- OUTPUT raw JSON object. First char \`{\`, last char \`}\`. No fence, no prose.
- overlay_text MUST be 500-3000 chars.
- overlay_text MUST be in English.
- Do NOT restate generic GRADE/CERQual mechanics (the base system already has those).
- Be project-specific (cite RQ numbers, concept group names, observed paper patterns) — but produce English that another methodologist reading just this overlay could understand without the project's documents.
`

// ============================================================
// buildThemeRollupUserPrompt — 主题级 rollup 用户 prompt(英文)
// ============================================================
/**
 * @param {object} args
 * @param {object} args.protocol      loadApprovedProtocolFull 返回的对象
 * @param {Array}  args.themes        loadAllThemesWithMeta 返回(含 grading_framework)
 * @param {Map}    args.papersByRid   record_id → { record, matrixData, robData, screeningData }
 * @param {Map}    args.evidenceByTheme  theme_id → [evidence_points...]
 * @param {object} args.synthesisMeta { cross_cutting_observations, protocol_coverage }
 * @param {Array}  [args.finalQueries]  Step 2 locked search queries(for publication bias)
 * @param {function} args.formatPaperProfile  从 synthesis-helpers import 的完整 paper profile 格式化器
 * @param {string} [args.overlay]     项目专用 overlay 文本(可空)
 */
export function buildThemeRollupUserPrompt({ protocol, themes, papersByRid, evidenceByTheme, synthesisMeta, finalQueries = [], formatPaperProfile, overlay = '' }) {
  if (typeof formatPaperProfile !== 'function') {
    throw new Error('buildThemeRollupUserPrompt requires formatPaperProfile callback')
  }
  const lines = []
  lines.push(`# Certainty grading input — ${themes.length} themes`)
  lines.push('')
  lines.push('**OUTPUT LANGUAGE (HARD CONSTRAINT)**: ALL output text in academic English. Translate any non-English terms. This is the Step 7 (certainty) hard policy; matches Step 4 matrix and Step 6 synthesis.')
  lines.push('')

  // 1) Protocol(M30+ 完整字段:RQs + inclusion + exclusion + PICO concepts)
  if (protocol) {
    lines.push('## Approved Protocol')
    lines.push(`- Version: v${protocol.version}`)
    if (protocol.review_type) lines.push(`- Review type: ${protocol.review_type}`)
    if (protocol.research_questions?.length) {
      lines.push('### Research Questions')
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 600)}`)
      })
    }
    if (Array.isArray(protocol.inclusion_criteria) && protocol.inclusion_criteria.length) {
      lines.push('### Inclusion criteria')
      protocol.inclusion_criteria.forEach((c) => lines.push(`- ${String(typeof c === 'string' ? c : c?.text || JSON.stringify(c)).slice(0, 400)}`))
    }
    if (Array.isArray(protocol.exclusion_criteria) && protocol.exclusion_criteria.length) {
      lines.push('### Exclusion criteria (critical for indirectness boundary)')
      protocol.exclusion_criteria.forEach((c) => lines.push(`- ${String(typeof c === 'string' ? c : c?.text || JSON.stringify(c)).slice(0, 400)}`))
    }
    if (Array.isArray(protocol.pico_concepts) && protocol.pico_concepts.length) {
      lines.push('### PICO Concept Groups')
      protocol.pico_concepts.forEach((c) => {
        const name = typeof c === 'string' ? c : (c?.name || c?.label || JSON.stringify(c))
        lines.push(`- ${String(name).slice(0, 300)}`)
      })
    }
    lines.push('')
  }

  // 2) Final search queries(Step 2)— for publication bias judgment
  if (Array.isArray(finalQueries) && finalQueries.length) {
    lines.push('## Step 2 Final search queries (for publication bias judgment — db coverage + grey literature)')
    finalQueries.slice(0, 10).forEach((q) => {
      const db = q?.database || q?.db || '?'
      const text = q?.query_text || q?.query || ''
      lines.push(`- [${db}] ${String(text).slice(0, 300)}`)
    })
    lines.push('')
  }

  // 2) Synthesis meta (cross_cutting + coverage)
  if (synthesisMeta) {
    if (Array.isArray(synthesisMeta.cross_cutting_observations) && synthesisMeta.cross_cutting_observations.length) {
      lines.push('## Step 6 Cross-cutting observations (methodological patterns across themes)')
      synthesisMeta.cross_cutting_observations.forEach((o) => lines.push(`- ${o}`))
      lines.push('')
    }
    if (synthesisMeta.protocol_coverage && typeof synthesisMeta.protocol_coverage === 'object') {
      lines.push('## Protocol coverage (Step 6)')
      const pc = synthesisMeta.protocol_coverage
      if (pc.coveredBy && typeof pc.coveredBy === 'object') {
        for (const [rq, themeIds] of Object.entries(pc.coveredBy)) {
          if (Array.isArray(themeIds)) lines.push(`- ${rq}: covered by ${themeIds.length} theme(s)`)
        }
      }
      if (Array.isArray(pc.uncovered) && pc.uncovered.length) {
        lines.push(`- Uncovered RQs (treat as evidence gaps): ${pc.uncovered.join(', ')}`)
      }
      lines.push('')
    }
  }

  // 3) Themes (the body)
  lines.push(`## Themes to grade (${themes.length})`)
  lines.push('')
  themes.forEach((t, idx) => {
    lines.push(`### Theme ${idx + 1} (theme_id=\`${t.id}\`, framework=\`${t.grading_framework}\`)`)
    lines.push(`- **name**: ${t.name}`)
    if (t.description) lines.push(`- **description**: ${t.description}`)
    if (t.evidence_strength) lines.push(`- Step 6 evidence_strength rating: ${t.evidence_strength}`)
    if (Array.isArray(t.maps_to_research_questions) && t.maps_to_research_questions.length) {
      lines.push(`- maps_to_research_questions: ${t.maps_to_research_questions.join(', ')}`)
    }
    if (Array.isArray(t.maps_to_pico_concepts) && t.maps_to_pico_concepts.length) {
      lines.push(`- maps_to_pico_concepts: ${t.maps_to_pico_concepts.join(', ')}`)
    }
    if (t.study_design_mix && Object.keys(t.study_design_mix).length) {
      lines.push(`- **study_design_mix**: ${JSON.stringify(t.study_design_mix)}`)
    }
    if (t.rob_profile && Object.keys(t.rob_profile).length) {
      lines.push(`- **rob_profile**: ${JSON.stringify(t.rob_profile)}`)
    }
    if (t.methodological_note) lines.push(`- methodological_note (Step 6): ${t.methodological_note}`)

    // Consistent / conflicting findings + gaps
    if (Array.isArray(t.consistent_findings) && t.consistent_findings.length) {
      lines.push(`  - **Consistent findings (${t.consistent_findings.length})**:`)
      t.consistent_findings.slice(0, 20).forEach((f, i) => {
        const txt = typeof f === 'string' ? f : (f?.finding || JSON.stringify(f).slice(0, 300))
        lines.push(`    ${i + 1}. ${String(txt).slice(0, 400)}`)
      })
    }
    if (Array.isArray(t.conflicting_findings) && t.conflicting_findings.length) {
      lines.push(`  - **Conflicting findings (${t.conflicting_findings.length})**:`)
      t.conflicting_findings.slice(0, 10).forEach((f, i) => {
        const txt = typeof f === 'string' ? f : JSON.stringify(f).slice(0, 400)
        lines.push(`    ${i + 1}. ${String(txt).slice(0, 500)}`)
      })
    }
    if (Array.isArray(t.evidence_gaps) && t.evidence_gaps.length) {
      lines.push(`  - **Evidence gaps (${t.evidence_gaps.length})**:`)
      t.evidence_gaps.slice(0, 10).forEach((f, i) => lines.push(`    ${i + 1}. ${String(f).slice(0, 300)}`))
    }

    // Supporting papers — M30+ 完整画像(每篇 ~2-3KB:matrix 完整字段 + RoB rationale + 单域评级 + screening 标签)
    //   不再 abridged。30 篇主题 → ~75KB,跟 Step 6 synthesis 一个数量级,Opus 1M 完全装得下
    const supportIds = t.supporting_record_ids || []
    if (supportIds.length) {
      lines.push(`  - **Supporting papers (${supportIds.length} with FULL matrix + RoB rationale + per-domain ratings)**:`)
      lines.push('')
      supportIds.forEach((rid, idx) => {
        const p = papersByRid?.get(rid)
        if (!p) {
          lines.push(`    [missing data for ${rid}]`)
          return
        }
        // 用通用 formatPaperProfile,跟 Step 6 synthesis 同款完整画像
        //   含 matrix(study_design / recruitment / sample_size / setting / intervention / comparator /
        //              outcomes / measurement_tools / data_source / analysis_method / key_findings /
        //              quantitative_results / limitations / ethics_funding / reproducibility / 自定义字段)
        //   + RoB(tool + overall_rating + overall_rationale 全文 + 单域评级)
        //   + screening(命中 concepts / criteria / ai_confidence)
        const profile = formatPaperProfile({ record: p.record, matrixData: p.matrixData, robData: p.robData, screeningData: p.screeningData, idx })
        // 缩进 4 空格让 markdown 嵌套清晰
        lines.push(profile.split('\n').map((l) => '    ' + l).join('\n'))
        lines.push('')
      })
    }

    // Evidence points (atomic findings)— 移除 50 截断,主题级 rollup 需要完整一致性/冲突信号
    const eps = evidenceByTheme?.get(t.id) || []
    if (eps.length) {
      lines.push(`  - **Evidence points (${eps.length} atomic findings)**:`)
      eps.forEach((ep) => {
        lines.push(`    - [${ep.record_id}] (${ep.evidence_type || '—'}, ${ep.strength || '—'}): ${String(ep.finding || '').slice(0, 600)}`)
      })
    }
    lines.push('')
  })

  // 4) Project overlay (if available)
  if (overlay && String(overlay).trim()) {
    lines.push('---')
    lines.push('')
    lines.push('## Project-specific certainty grading overlay')
    lines.push('(generated by Opus from this project\'s protocol + sample themes; treat as auxiliary indirectness / RoB / CERQual relevance anchors specific to THIS project — do not override the generic methodology in the system prompt)')
    lines.push('')
    lines.push(String(overlay))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('Return the JSON object per system schema. Output ONE theme_certainty per input theme, theme_id verbatim. Remember: ALL English, no markdown fence, no prose.')
  return lines.join('\n')
}

// ============================================================
// buildOptimizeCertaintyOverlayUserPrompt — 给 Opus 看,生成项目专用 overlay
// ============================================================
/**
 * @param {object} args
 * @param {object} args.protocol
 * @param {Array}  args.themes        (含 grading_framework + study_design_mix + rob_profile)
 * @param {object} args.synthesisMeta
 * @param {Array}  args.samplePapers  3-4 篇代表 papers(含 record + matrixData + robData)
 */
export function buildOptimizeCertaintyOverlayUserPrompt({ protocol, themes, synthesisMeta, samplePapers = [] }) {
  const lines = []
  lines.push('# Generate a certainty grading overlay for this systematic review project')
  lines.push('')
  lines.push('Read the project context below and produce a project-specific GRADE+CERQual overlay (English) that will be appended to the generic Step 7 system prompt.')
  lines.push('')

  if (protocol) {
    lines.push('## Approved Protocol')
    lines.push(`- Version v${protocol.version}; type=${protocol.review_type || '?'}`)
    if (protocol.research_questions?.length) {
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 400)}`)
      })
    }
    if (Array.isArray(protocol.pico_concepts) && protocol.pico_concepts.length) {
      lines.push(`- PICO concepts: ${protocol.pico_concepts.map((c) => (typeof c === 'string' ? c : c?.name || c?.label || JSON.stringify(c))).join(' | ')}`)
    }
    lines.push('')
  }

  // 主题摘要(只标 framework 分布 + 简短)
  lines.push(`## Themes summary (${themes.length})`)
  const frameworkCount = { grade: 0, cerqual: 0, hybrid: 0 }
  themes.forEach((t) => { frameworkCount[t.grading_framework] = (frameworkCount[t.grading_framework] || 0) + 1 })
  lines.push(`- framework split: ${JSON.stringify(frameworkCount)}`)
  themes.slice(0, 10).forEach((t, i) => {
    lines.push(`  ${i + 1}. (${t.grading_framework}) ${t.name} — ${(t.supporting_record_ids || []).length} papers · rob_profile=${JSON.stringify(t.rob_profile || {})}`)
  })
  lines.push('')

  // synthesis_meta
  if (synthesisMeta) {
    if (Array.isArray(synthesisMeta.cross_cutting_observations) && synthesisMeta.cross_cutting_observations.length) {
      lines.push('## Cross-cutting methodological observations (from Step 6)')
      synthesisMeta.cross_cutting_observations.slice(0, 8).forEach((o) => lines.push(`- ${o}`))
      lines.push('')
    }
  }

  // 代表性 papers(让 Opus 看到真实 RoB + 真实 design + 真实 outcome 测量)
  if (samplePapers.length) {
    lines.push(`## Sample papers (${samplePapers.length}, with full matrix + RoB)`)
    samplePapers.forEach((p, i) => {
      const r = p.record || {}
      const m = p.matrixData || {}
      const rob = p.robData || {}
      lines.push(`### Sample ${i + 1}: ${(r.title || '').slice(0, 120)} (${r.year || '?'})`)
      if (m.study_design) lines.push(`- design: ${String(m.study_design).slice(0, 200)}`)
      if (m.intervention) lines.push(`- intervention: ${String(m.intervention).slice(0, 300)}`)
      if (m.outcomes) lines.push(`- outcomes: ${String(m.outcomes).slice(0, 300)}`)
      if (m.measurement_tools) lines.push(`- measurement_tools: ${String(m.measurement_tools).slice(0, 200)}`)
      if (m.limitations) lines.push(`- limitations: ${String(m.limitations).slice(0, 200)}`)
      if (rob.tool) lines.push(`- RoB: ${rob.tool} = ${rob.overall_rating} · ${(rob.overall_rationale || '').slice(0, 200)}`)
      lines.push('')
    })
  }

  lines.push('---')
  lines.push('')
  lines.push('Generate the project-specific certainty overlay JSON per system schema. Be specific to THIS project — name actual RQ numbers, concept groups, sample paper patterns. Do NOT restate generic GRADE/CERQual mechanics.')
  return lines.join('\n')
}

// ============================================================
// parseThemeRollupOutput — 校验 + 规范化 LLM 主题级 rollup 输出
// ============================================================
/**
 * @param {any} raw            LLM 返回(已 JSON.parse 过的对象,或 null)
 * @param {object} ctx
 * @param {Set<string>} ctx.themeIds  允许的 theme_id 集合
 */
export function parseThemeRollupOutput(raw, { themeIds = new Set() } = {}) {
  const errors = []
  if (!raw || typeof raw !== 'object') {
    return { ok: false, themes: [], cross_theme_observations: [], errors: ['raw is not an object'] }
  }
  const themesIn = Array.isArray(raw.themes) ? raw.themes : (Array.isArray(raw.assessments) ? raw.assessments : null)
  if (!themesIn) {
    return { ok: false, themes: [], cross_theme_observations: [], errors: ['no themes array in output'] }
  }

  const FRAMEWORK = new Set(['grade', 'cerqual', 'hybrid'])
  const CERTAINTY = new Set(['high', 'moderate', 'low', 'very_low'])
  const DOWNGRADE = new Set(['not_serious', 'serious', 'very_serious'])
  const PUB_BIAS = new Set(['undetected', 'suspected', 'strongly_suspected'])
  const LARGE = new Set(['none', 'large', 'very_large'])
  const PLAUS = new Set(['none', 'would_reduce', 'would_increase'])
  const START = new Set(['high', 'low'])
  const CERQUAL_LEVEL = new Set(['no_or_minor_concerns', 'minor_concerns', 'moderate_concerns', 'serious_concerns'])

  const pick = (allowed, v, fallback) => (allowed.has(v) ? v : fallback)
  const cleanStr = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

  const out = []
  for (const t of themesIn) {
    if (!t || typeof t !== 'object') continue
    const themeId = String(t.theme_id || t.id || '').trim()
    if (!themeId) { errors.push('theme entry missing theme_id'); continue }
    if (themeIds.size && !themeIds.has(themeId)) {
      errors.push(`unknown theme_id ${themeId} (ignored)`)
      continue
    }
    const framework = pick(FRAMEWORK, t.grading_framework, 'hybrid')
    const overall = pick(CERTAINTY, t.overall_certainty, 'low')

    let grade = null
    if (framework === 'grade' || framework === 'hybrid') {
      const g = t.grade || {}
      grade = {
        starting_certainty:     pick(START, g.starting_certainty, 'high'),
        risk_of_bias:           pick(DOWNGRADE, g.risk_of_bias, 'not_serious'),
        inconsistency:          pick(DOWNGRADE, g.inconsistency, 'not_serious'),
        indirectness:           pick(DOWNGRADE, g.indirectness, 'not_serious'),
        imprecision:            pick(DOWNGRADE, g.imprecision, 'not_serious'),
        publication_bias:       pick(PUB_BIAS, g.publication_bias, 'undetected'),
        large_effect:           pick(LARGE, g.large_effect, 'none'),
        dose_response:          g.dose_response ? 1 : 0,
        plausible_confounding:  pick(PLAUS, g.plausible_confounding, 'none'),
        rationales: {
          risk_of_bias:     cleanStr(g.rationales?.risk_of_bias, 1500),
          inconsistency:    cleanStr(g.rationales?.inconsistency, 1500),
          indirectness:     cleanStr(g.rationales?.indirectness, 1500),
          imprecision:      cleanStr(g.rationales?.imprecision, 1500),
          publication_bias: cleanStr(g.rationales?.publication_bias, 1500),
        },
      }
    }

    let cerqual = null
    if (framework === 'cerqual' || framework === 'hybrid') {
      const c = t.cerqual || {}
      cerqual = {
        methodological_limitations: pick(CERQUAL_LEVEL, c.methodological_limitations, 'moderate_concerns'),
        relevance:                  pick(CERQUAL_LEVEL, c.relevance, 'moderate_concerns'),
        coherence:                  pick(CERQUAL_LEVEL, c.coherence, 'moderate_concerns'),
        adequacy_of_data:           pick(CERQUAL_LEVEL, c.adequacy_of_data, 'moderate_concerns'),
        rationales: {
          methodological_limitations: cleanStr(c.rationales?.methodological_limitations, 1500),
          relevance:                  cleanStr(c.rationales?.relevance, 1500),
          coherence:                  cleanStr(c.rationales?.coherence, 1500),
          adequacy_of_data:           cleanStr(c.rationales?.adequacy_of_data, 1500),
        },
      }
    }

    out.push({
      theme_id: themeId,
      grading_framework: framework,
      overall_certainty: overall,
      grade,
      cerqual,
      body_of_evidence_summary:  cleanStr(t.body_of_evidence_summary, 2000),
      implications_for_practice: cleanStr(t.implications_for_practice, 1000),
      implications_for_research: cleanStr(t.implications_for_research, 1000),
    })
  }

  const cross = Array.isArray(raw.cross_theme_observations) ? raw.cross_theme_observations.map(String).filter(Boolean).slice(0, 20) : []

  // 英文输出抽检:统计输出文本里非 ASCII 字符占比
  //   英文文本 ~95%+ ASCII(只有偶尔的引号 / dash 等 unicode)
  //   中文 / 日文 / 阿拉伯文 等会大量非 ASCII
  //   阈值:>10% 非 ASCII → warning(LLM 没遵守英文硬约束)
  let langWarning = null
  try {
    let totalChars = 0, nonAsciiChars = 0
    const collectText = (s) => {
      if (typeof s !== 'string') return
      for (const ch of s) {
        totalChars++
        if (ch.charCodeAt(0) > 127) nonAsciiChars++
      }
    }
    for (const t of out) {
      collectText(t.body_of_evidence_summary)
      collectText(t.implications_for_practice)
      collectText(t.implications_for_research)
      if (t.grade?.rationales) {
        for (const v of Object.values(t.grade.rationales)) collectText(v)
      }
      if (t.cerqual?.rationales) {
        for (const v of Object.values(t.cerqual.rationales)) collectText(v)
      }
    }
    for (const c of cross) collectText(c)
    if (totalChars > 0) {
      const nonAsciiPct = nonAsciiChars / totalChars
      if (nonAsciiPct > 0.10) {
        langWarning = `Non-English output ratio ${(nonAsciiPct * 100).toFixed(1)}% exceeds 10% threshold — LLM did not respect English-only constraint`
        errors.push(langWarning)
      }
    }
  } catch { /* ignore audit failure */ }

  return {
    ok: out.length > 0,
    themes: out,
    cross_theme_observations: cross,
    errors,
    langWarning,
  }
}

// ============================================================
// parseCertaintyOverlayOutput — 校验 overlay JSON
// ============================================================
export function parseCertaintyOverlayOutput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'raw not object' }
  const text = String(raw.overlay_text || raw.overlay || raw.text || '').trim()
  if (text.length < 200) return { ok: false, error: `overlay_text too short (${text.length} chars; expected 500-3000)` }
  if (text.length > 6000) return { ok: false, error: `overlay_text too long (${text.length} chars)` }
  return { ok: true, overlay_text: text }
}
