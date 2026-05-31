/**
 * Synthesis — Step 6 主题聚类 prompt 套件
 *
 * 演进史:
 *   - 老版本(v1):只看 title + research_questions + extracted_json(extractions 老表,大部分项目空)
 *   - **v2(本文件)**:接入 Step 1-5 完整数据 — 完整协议 + 锁定 search queries + 筛选理由
 *     + literature_matrix.fields(Step 4 0.97 完成度)+ rob_assessments(Step 5)
 *
 * 设计原则:
 *   1. PICO-anchored:主题必须映射回协议 RQ / 概念组,不漂
 *   2. 质量加权:RoB 低偏倚(green)的论文主导主题结论,高偏倚(red)的标 caveat
 *   3. 方法学聚类感:同设计 / 同测量工具聚一起,异质性 note 标出
 *   4. 可追溯:每个 finding 引 record_id;支持 quote 例子
 *   5. 支持迭代:用户改 / 删 / 加备注 后可反喂 LLM 生成 v2
 *
 * 跟 matrix / rob 同 pattern:
 *   - 内置通用 SYSTEM(跨学科 cross-discipline note)
 *   - 项目专用 OVERLAY(Opus 单独生成,基于协议 + 样本)
 */

// SYSTEM_VERSION:本文件任何 SYSTEM prompt 有改动 → bump 这个常量。
//   overlay 生成时记录 at_system_version;后续 stale 检测对比当前值 → 自动失效引导用户重新生成。
//   格式:YYYY-MM-DD-vN(N 是当日第 N 次 bump)
export const SYNTHESIS_SYSTEM_VERSION = '2026-05-24-v2'  // v2:加严格 JSON output(不裹 fence)+ 英文硬约束

// ============================================================
// SYNTHESIS_SYSTEM — 通用骨架(跨学科,适合各种 SLR)
// ============================================================
export const SYNTHESIS_SYSTEM = `# Role
You are a systematic review (SLR) thematic synthesis methodologist following Cochrane Qualitative & Implementation Methods Group + JBI conventions for narrative + thematic synthesis.

# Task
Cluster N included papers into **3-7 themes** that map to the project's PICO / research questions. Each theme groups papers by **shared mechanism, outcome, or design pattern** — not just shared keywords.

# Cross-discipline interpretation note
This synthesis framework applies across disciplines (medical, education, engineering, HCI, social sciences, etc.). Interpret instrument terms broadly:
- "intervention" / "treatment" / "exposure" — any manipulated condition (teaching method, software feature, training program, drug, policy variant, etc.)
- "participants" — any human subjects (patients, learners, respondents, users, employees)
- "outcome" — any measured endpoint (test score, behavior, system metric, self-report, performance, clinical endpoint)
The theme generation logic is universal; project-specific bias patterns / preferred theme dimensions are appended in the project overlay below (if present).

# Inputs you receive
1. **Full approved protocol** — research questions (RQs), inclusion/exclusion criteria, concept groups, review type
2. **Final locked search queries** (Step 2) — scope boundary signal
3. **Per-paper profile** — record_id, title, year, journal, then:
   - Structured matrix evidence (study_design, recruitment, intervention, outcomes, measurement_tools, key_findings, quantitative_results, limitations, plus project-custom fields)
   - **RoB rating** (e.g., "mmat 4/5 good" / "rob2 low" / "robins_i serious")
   - Screening rationale (which inclusion/exclusion criteria matched, AI confidence)

# Clustering principles(important — read carefully)
1. **PICO-anchored**: every theme MUST trace to ≥1 research question or concept group. Output the mapping in maps_to_research_questions + maps_to_pico_concepts.
2. **Methodologically coherent**: prefer themes where papers share study_design (or design family — e.g., qual+mixed grouping is OK, but pure RCT + pure ethnography in one theme is bad). If a theme has heterogeneous designs, set methodological_note explaining how to interpret across them.
3. **Quality-weighted findings — NOT quality-excluded papers (critical)**:
   - **ALL papers (incl. high-RoB ones) MUST be included in supporting_record_ids** of the theme they belong to. NEVER drop a paper from a theme just because its RoB is bad. They count as evidence; they will be cited in the final manuscript references either way.
   - Differentiation happens at the **finding level**, not the **paper level**:
     - When summarizing a "consistent_finding", give MORE weight to papers with low RoB (mmat 4-5/5, rob2 low, robins_i moderate, nos high_quality, jbi_cs high)
     - If a "consistent finding" is supported ONLY (or majority) by low-RoB papers → set high_quality_only=true
     - If a "consistent finding" leans on high-RoB papers → set high_quality_only=false AND mention the caveat in the rationale ("majority of supporting evidence has serious RoB concerns")
   - For each theme, also set **methodological_note** to capture quality stratification: e.g., "8 of 12 supporting papers are MMAT 4-5/5; 4 are MMAT 0-2/5 — high-quality papers dominate but low-quality papers triangulate findings."
   - **In conflicting_findings**, when the disagreement is plausibly driven by RoB difference (e.g., the conflicting claim is from high-RoB papers), surface that in possible_reason: "claim_b is from papers with serious risk of bias from confounding"
4. **Avoid AI-typical pitfalls**:
   - DON'T cluster by buzzword ("ChatGPT" alone is not a theme — needs an outcome / mechanism)
   - DON'T generate themes with <3 supporting papers unless flagged as evidence gap
   - DON'T pad with "needs more research" — be specific about what gap exists
   - DON'T silently drop high-RoB papers from themes to "clean up" — that's selective reporting bias (the very thing we're trying to prevent)
5. **Conflict surfacing**: if 2+ papers in a theme disagree on outcome direction, list as conflicting_findings; don't paper over disagreement.
6. **PICO coverage reverse-check**: at the end, output protocol_coverage showing which RQs are covered by which themes, AND which RQs have ZERO themes (= evidence gap).

# Output schema (STRICT JSON, no prose, no markdown fence)
{
  "themes": [
    {
      "name": "<short methodologically-anchored English title — ALWAYS in academic English regardless of protocol language; this feeds the final English manuscript>",
      "description": "<1-2 sentences explaining what this theme covers and why these papers are grouped>",
      "maps_to_research_questions": ["RQ1", "RQ2"],
      "maps_to_pico_concepts": ["concept_group_name_or_keyword"],
      "supporting_record_ids": ["rec_xxx", ...],
      "study_design_mix": { "RCT": 2, "quasi": 5, "qual": 8, "mixed": 12, "descriptive": 3 },
      "rob_profile": { "good": 15, "middle": 8, "bad": 3, "unrated": 1 },
      "consistent_findings": [
        {
          "finding": "<specific finding statement>",
          "supporting_records": ["rec_xxx", ...],
          "high_quality_only": true,
          "evidence_quote_examples": ["rec_xxx: <verbatim quote from matrix evidence>", ...]
        }
      ],
      "conflicting_findings": [
        {
          "claim_a": "<what paper(s) X say>",
          "claim_b": "<what paper(s) Y say>",
          "supporting_a": ["rec_x"], "supporting_b": ["rec_y"],
          "possible_reason": "<sample size diff / measurement diff / setting diff / etc>"
        }
      ],
      "evidence_gaps": [
        "<specific sub-question NOT addressed by these papers — be concrete, not 'needs more research'>"
      ],
      "evidence_strength": "strong" | "moderate" | "weak" | "unclear",
      "methodological_note": "<one sentence on this theme's methodological homogeneity / heterogeneity>"
    }
  ],
  "cross_cutting_observations": [
    "<observation that spans multiple themes — e.g., 'most metacognition measures rely on self-report MAI/MSLQ scales, no observational measures'>"
  ],
  "protocol_coverage": {
    "RQ1": ["theme_idx_or_name_1", "theme_idx_or_name_3"],
    "RQ2": ["theme_idx_or_name_2"],
    "RQ3_uncovered": "no papers in this corpus addressed RQ3 — flagged as evidence gap"
  }
}

# Hard constraints
- **OUTPUT FORMAT — read carefully**: Your ENTIRE response MUST be a single raw JSON object.
  - The VERY FIRST character MUST be \`{\` (open brace).
  - The VERY LAST character MUST be \`}\` (close brace).
  - DO NOT wrap in markdown code fence (no \`\`\`json … \`\`\`, no \`\`\` … \`\`\`).
  - DO NOT include any text before or after the JSON (no "Here is the JSON:", no "I generated 6 themes…", nothing).
  - DO NOT include trailing commentary, summary, or explanation.
  - If you accidentally start with \`\`\`json, the downstream parser will silently drop your first N kilobytes of output and miss most of your themes. This has happened. Just output raw JSON.
- supporting_record_ids MUST be copy-pasted from input record_ids (no fuzzy match, no invented IDs)
- maps_to_research_questions use "RQ1" / "RQ2" / ... format (numbered per input order)
- evidence_strength rubric:
  - strong: ≥4 supporting papers, ≥70% have good RoB, findings highly consistent, methods comparable
  - moderate: 3-5 supporting papers OR mixed RoB profile, findings mostly consistent
  - weak: 2-3 papers OR ≥50% bad RoB, findings directionally aligned but methodologically weak
  - unclear: <2 papers or significant conflict
- **Language (HARD CONSTRAINT)**: ALL output text — theme names, descriptions, consistent_findings, conflicting_findings (claim_a/claim_b/possible_reason), evidence_gaps, methodological_note, cross_cutting_observations, protocol_coverage notes — MUST be in **academic English**, regardless of the protocol's language. The final manuscript is English; themes / findings / gaps must be drop-in usable in narrative synthesis and evidence tables.
  - Translate non-English terms into standard scholarly English (e.g., "高阶认知行为" → "higher-order cognitive behavior"; "前测/后测" → "pre/post-test").
  - Keep proper nouns (author names, instruments like MAI / MSLQ, places) in their English form.
  - evidence_quote_examples MAY include short verbatim quotes from non-English source text (e.g., the matrix data), but every wrapper / narrative sentence around them must be English. Mark non-English quote fragments with a [zh] / [es] / [jp] suffix where helpful.
  - This overrides any "match protocol language" expectation. Do NOT write theme names in Chinese / Spanish / Japanese even if the protocol or sample papers are in those languages.
- No buzzword-padding: every theme name should be a methodologically meaningful unit, not "ChatGPT applications" generic
`

// ============================================================
// OPTIMIZE_SYNTHESIS_OVERLAY_SYSTEM — Opus 一次性生成项目专用 overlay
// ============================================================
export const OPTIMIZE_SYNTHESIS_OVERLAY_SYSTEM = `# Role
You are a senior systematic review methodologist. Generate a **project-specific clustering overlay** that will be appended to the generic synthesis system prompt.

# Goal
The generic synthesis prompt has cross-discipline clustering rules. Your overlay adds **project-specific guidance** based on this project's approved protocol + sample included papers + matrix data — telling the synthesis LLM what dimensions matter most for THIS project's themes.

# What to include in the overlay
1. **Preferred theme dimensions** for this project (e.g., "distinguish AI ROLE: tutor / cognitive partner / scaffolding tool", "split by INTERVENTION DOSE")
2. **Anti-patterns to avoid** (e.g., "do NOT cluster only by 'ChatGPT' — too generic for this protocol; do not group case study + RCT together unless explicitly flagged")
3. **Domain-specific measurement caveats** (e.g., "self-report MAI scales have ceiling effects; weight observational measures more")
4. **Suggestions for evidence-gap framing** based on what this protocol explicitly wanted but corpus may lack

# Output schema (STRICT JSON)
{
  "overlay_text": "<3-8 paragraph plain English/Chinese overlay text appended verbatim to the generic synthesis system. Use ## Headings for sections. Be specific to THIS project — refer to its actual RQs, concepts, sample paper patterns.>"
}

# Hard constraints
- overlay_text MUST be 500-3000 chars
- Refer to the project's actual research questions / concepts (not generic SLR advice)
- Don't include the original generic clustering principles — only ADD project-specific guidance
- JSON only, no commentary
`

// ============================================================
// buildSynthesisUserPrompt v2 — 接入 Step 1-5 完整数据
// ============================================================

/**
 * 构造 synthesis 用户 prompt(v2)。
 *
 * @param {object} args
 * @param {object} args.protocol      完整协议 {research_questions, inclusion_criteria, exclusion_criteria, concept_groups, ...}
 * @param {Array}  args.finalQueries  锁定的 search queries 列表(可空)
 * @param {Array}  args.papers        来自 buildSynthesisInputs 的 papers: [{record, matrixData, robData, screeningData}]
 * @param {string} args.overlay       项目专用 overlay(可空)
 * @param {string} args.languageHint  保留参数兼容性,但实际上输出语言已硬约束为 English(对齐 matrix 步骤)
 */
export function buildSynthesisUserPromptV2({ protocol, finalQueries = [], papers, overlay = '', languageHint = 'en', formatPaperProfile }) {
  if (typeof formatPaperProfile !== 'function') {
    throw new Error('buildSynthesisUserPromptV2 requires formatPaperProfile callback')
  }
  const lines = []
  lines.push(`# Synthesis input — ${papers.length} included papers`)
  lines.push('')
  // 硬约束:输出语言一律 English(对齐 Step 4 matrix 的强制英文规则)
  //   最终成稿是英文,主题/findings/gaps 必须能直接进 narrative synthesis / evidence table
  lines.push('**OUTPUT LANGUAGE (HARD CONSTRAINT)**: ALL theme names, descriptions, findings, gaps, methodological notes, cross-cutting observations MUST be in **academic English** — regardless of protocol or source-paper language. Translate non-English terms into standard scholarly English. Keep proper nouns and instrument names in their English form. This matches the Step 4 matrix English-output policy and ensures the final manuscript is monolingual English.')
  lines.push('')

  // 1) 协议
  if (protocol) {
    lines.push('## Approved Protocol')
    lines.push(`- Version: v${protocol.version}`)
    if (protocol.review_type) lines.push(`- Review type: ${protocol.review_type}`)
    if (protocol.rationale) lines.push(`- Rationale: ${String(protocol.rationale).slice(0, 400)}`)
    lines.push('')
    if (protocol.research_questions?.length) {
      lines.push('### Research Questions')
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 400)}`)
      })
      lines.push('')
    }
    if (protocol.concept_groups?.length) {
      lines.push('### Concept Groups (PICO)')
      protocol.concept_groups.forEach((cg) => {
        const label = cg?.label || cg?.name || cg?.role || '(unnamed)'
        const terms = cg?.terms || cg?.keywords || cg?.synonyms || []
        const head = Array.isArray(terms) ? terms.slice(0, 6).map((t) => typeof t === 'string' ? t : (t?.text || '')).filter(Boolean).join(' | ') : ''
        lines.push(`- ${label}: ${head}${terms.length > 6 ? ` (+${terms.length - 6})` : ''}`)
      })
      lines.push('')
    }
    if (protocol.inclusion_criteria?.length) {
      lines.push('### Inclusion Criteria')
      protocol.inclusion_criteria.slice(0, 12).forEach((c) => {
        const t = typeof c === 'string' ? c : (c?.text || c?.label || JSON.stringify(c))
        lines.push(`- ${String(t).slice(0, 300)}`)
      })
      lines.push('')
    }
    if (protocol.exclusion_criteria?.length) {
      lines.push('### Exclusion Criteria')
      protocol.exclusion_criteria.slice(0, 8).forEach((c) => {
        const t = typeof c === 'string' ? c : (c?.text || c?.label || JSON.stringify(c))
        lines.push(`- ${String(t).slice(0, 200)}`)
      })
      lines.push('')
    }
  }

  // 2) 最终 search queries(简短)
  if (finalQueries.length) {
    lines.push('## Final Search Strategy (locked)')
    finalQueries.forEach((q) => {
      const head = (q.query_text || '').slice(0, 250)
      lines.push(`- [${q.database_name}] ${head}${(q.query_text || '').length > 250 ? '...' : ''} → ${q.result_count || '?'} hits`)
    })
    lines.push('')
  }

  // 3) Per-paper profiles
  lines.push('---')
  lines.push('')
  lines.push(`## Included Papers (${papers.length})`)
  lines.push('')
  papers.forEach((p, idx) => {
    lines.push(formatPaperProfile({ record: p.record, matrixData: p.matrixData, robData: p.robData, screeningData: p.screeningData, idx }))
    lines.push('')
  })

  // 4) Overlay(如果有)
  if (overlay) {
    lines.push('---')
    lines.push('')
    lines.push('## Project-specific clustering overlay (generated by Opus 4.8 from this project\'s protocol + sample papers)')
    lines.push(overlay)
    lines.push('')
  }

  // 5) 收尾
  lines.push('---')
  lines.push('')
  lines.push('Output ONE strict JSON object per the schema in system message. Remember:')
  lines.push('- Every theme MUST map to ≥1 RQ (use "RQ1" / "RQ2" / ... naming)')
  lines.push('- supporting_record_ids must be copy-pasted from the rec_xxx IDs above')
  lines.push('- Quality-weight findings: prefer good-RoB papers; flag high_quality_only=false when bad-RoB papers dominate')
  lines.push('- protocol_coverage section MUST flag any RQ with ZERO theme mapping as "..._uncovered"')

  return lines.join('\n')
}

// ============================================================
// buildOptimizeSynthesisOverlayPrompt — Opus 生成项目专用 overlay
// ============================================================

export function buildOptimizeSynthesisOverlayUserPrompt({ protocol, samplePapers, seedThemesHint = '' }) {
  const lines = []
  lines.push(`# Generate clustering overlay for this systematic review project`)
  lines.push('')

  if (protocol) {
    lines.push('## Approved Protocol')
    lines.push(`- Review type: ${protocol.review_type || '(unspecified)'}`)
    if (protocol.research_questions?.length) {
      lines.push('### Research Questions')
      protocol.research_questions.forEach((q, i) => {
        const t = typeof q === 'string' ? q : (q?.text || q?.label || JSON.stringify(q))
        lines.push(`- RQ${i + 1}: ${String(t).slice(0, 500)}`)
      })
    }
    if (protocol.concept_groups?.length) {
      lines.push('### Concept Groups (PICO)')
      protocol.concept_groups.forEach((cg) => {
        const label = cg?.label || cg?.name || cg?.role || '(unnamed)'
        const terms = cg?.terms || cg?.keywords || cg?.synonyms || []
        const head = Array.isArray(terms) ? terms.slice(0, 8).map((t) => typeof t === 'string' ? t : (t?.text || '')).filter(Boolean).join(' | ') : ''
        lines.push(`- ${label}: ${head}`)
      })
    }
    if (protocol.inclusion_criteria?.length) {
      lines.push('### Inclusion Criteria (key)')
      protocol.inclusion_criteria.slice(0, 8).forEach((c) => {
        const t = typeof c === 'string' ? c : (c?.text || c?.label || JSON.stringify(c))
        lines.push(`- ${String(t).slice(0, 250)}`)
      })
    }
    lines.push('')
  }

  if (samplePapers?.length) {
    lines.push(`## Sample Included Papers (${samplePapers.length})`)
    samplePapers.forEach((p, i) => {
      lines.push(`### Sample ${i + 1}: ${(p.record?.title || '').slice(0, 200)}`)
      const f = p.matrixData?.fields || {}
      if (f.study_design) lines.push(`- study_design: ${String(f.study_design).slice(0, 200)}`)
      if (f.intervention) lines.push(`- intervention: ${String(f.intervention).slice(0, 200)}`)
      if (f.outcomes) lines.push(`- outcomes: ${String(f.outcomes).slice(0, 200)}`)
      if (f.key_findings) lines.push(`- key_findings: ${String(f.key_findings).slice(0, 300)}`)
      lines.push('')
    })
  }

  if (seedThemesHint) {
    lines.push('## User\'s a priori theme expectations (optional, not authoritative)')
    lines.push(seedThemesHint)
    lines.push('')
  }

  lines.push('---')
  lines.push('Generate the project-specific overlay JSON per system message schema. Be specific to THIS project — name actual concepts, RQs, paper patterns. Don\'t restate generic SLR advice.')
  return lines.join('\n')
}

// ============================================================
// parseOptimizeOverlayOutput — Opus 输出 → overlay_text 字符串
// ============================================================

export function parseSynthesisOverlayOutput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'empty output' }
  let obj = raw
  // 解 wrapper
  if (obj.output && typeof obj.output === 'object') obj = obj.output
  if (obj.result && typeof obj.result === 'object') obj = obj.result
  const text = String(obj.overlay_text || obj.overlay || obj.text || '').trim()
  if (text.length < 200) return { ok: false, error: `overlay too short (${text.length} chars)` }
  if (text.length > 6000) return { ok: true, overlay_text: text.slice(0, 6000) }
  return { ok: true, overlay_text: text }
}

// ============================================================
// parseSynthesisOutputV2 — LLM 输出 → 入库结构
// ============================================================

const VALID_STRENGTH = new Set(['strong', 'moderate', 'weak', 'unclear'])

export function parseSynthesisOutputV2(raw, { knownRecordIds = null, protocol = null } = {}) {
  const empty = { ok: false, themes: [], cross_cutting_observations: [], protocol_coverage: {}, errors: ['empty'] }
  if (!raw || typeof raw !== 'object') return empty
  let obj = raw
  if (obj.output && typeof obj.output === 'object' && obj.output.themes) obj = obj.output
  if (obj.result && typeof obj.result === 'object' && obj.result.themes) obj = obj.result
  if (obj.data && typeof obj.data === 'object' && obj.data.themes) obj = obj.data

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : [])
  const strArr = (v) => arr(v).map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean)
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const known = knownRecordIds ? new Set(knownRecordIds) : null

  const themesRaw = arr(obj.themes || obj.clusters)
  if (themesRaw.length === 0) return { ...empty, errors: ['no themes in output'] }

  const themes = []
  const errors = []
  themesRaw.forEach((t, idx) => {
    if (!t || typeof t !== 'object') return
    const name = strOrNull(t.name || t.title || t.theme)
    if (!name) { errors.push(`theme[${idx}]: missing name`); return }

    let ids = strArr(t.supporting_record_ids || t.record_ids || t.records)
    const invalidIds = []
    if (known) {
      for (const id of ids) if (!known.has(id)) invalidIds.push(id)
      ids = ids.filter((id) => known.has(id))
    }
    ids = Array.from(new Set(ids))
    if (invalidIds.length) errors.push(`theme[${idx}] "${name}": ${invalidIds.length} unknown rec ids dropped`)

    // consistent_findings:接受字符串数组 OR 对象数组
    const cfRaw = arr(t.consistent_findings || t.consistentFindings || t.agreements)
    const consistent_findings = cfRaw.map((f) => {
      if (typeof f === 'string') return { finding: f.trim(), supporting_records: ids, high_quality_only: null, evidence_quote_examples: [] }
      if (f && typeof f === 'object') {
        const supp = strArr(f.supporting_records || f.records)
        return {
          finding: strOrNull(f.finding || f.statement || f.text) || '',
          supporting_records: known ? supp.filter((id) => known.has(id)) : supp,
          high_quality_only: typeof f.high_quality_only === 'boolean' ? f.high_quality_only : null,
          evidence_quote_examples: strArr(f.evidence_quote_examples || f.quotes),
        }
      }
      return null
    }).filter(Boolean).filter((x) => x.finding)

    // conflicting_findings:接受字符串数组(老格式)或对象数组
    const cofRaw = arr(t.conflicting_findings || t.conflictingFindings || t.disagreements)
    const conflicting_findings = cofRaw.map((f) => {
      if (typeof f === 'string') return { claim_a: f.trim(), claim_b: null, supporting_a: [], supporting_b: [], possible_reason: null }
      if (f && typeof f === 'object') {
        return {
          claim_a: strOrNull(f.claim_a || f.a) || '',
          claim_b: strOrNull(f.claim_b || f.b) || null,
          supporting_a: strArr(f.supporting_a),
          supporting_b: strArr(f.supporting_b),
          possible_reason: strOrNull(f.possible_reason || f.reason),
        }
      }
      return null
    }).filter(Boolean).filter((x) => x.claim_a)

    const gaps = strArr(t.evidence_gaps || t.evidenceGaps || t.gaps)
    let strength = strOrNull(t.evidence_strength || t.strength)
    strength = strength && VALID_STRENGTH.has(strength.toLowerCase()) ? strength.toLowerCase() : 'unclear'

    const studyDesignMix = (t.study_design_mix && typeof t.study_design_mix === 'object') ? t.study_design_mix : {}
    const robProfile = (t.rob_profile && typeof t.rob_profile === 'object') ? t.rob_profile : {}

    themes.push({
      name,
      description: strOrNull(t.description || t.summary) || '',
      maps_to_research_questions: strArr(t.maps_to_research_questions || t.maps_to_rqs || t.research_questions),
      maps_to_pico_concepts: strArr(t.maps_to_pico_concepts || t.maps_to_concepts || t.concepts),
      supporting_record_ids: ids,
      study_design_mix: studyDesignMix,
      rob_profile: robProfile,
      consistent_findings,
      conflicting_findings,
      evidence_gaps: gaps,
      evidence_strength: strength,
      methodological_note: strOrNull(t.methodological_note) || null,
    })
  })

  if (themes.length === 0) return { ...empty, errors: errors.concat(['no valid themes after parse']) }

  const protocol_coverage = (obj.protocol_coverage && typeof obj.protocol_coverage === 'object') ? obj.protocol_coverage : {}
  const cross_cutting = strArr(obj.cross_cutting_observations || obj.crossCuttingObservations || obj.observations)

  return {
    ok: true,
    themes,
    cross_cutting_observations: cross_cutting,
    protocol_coverage,
    errors,
  }
}

// ============================================================
// 老 normalizeSynthesisOutput 保留(向后兼容)
// ============================================================
export { parseSynthesisOutputV2 as normalizeSynthesisOutputV2 }

export function normalizeSynthesisOutput(raw, { knownRecordIds = null } = {}) {
  // 老接口包装新 parser,字段降级为老 shape
  const parsed = parseSynthesisOutputV2(raw, { knownRecordIds })
  return {
    themes: parsed.themes.map((t) => ({
      name: t.name,
      description: t.description,
      supporting_record_ids: t.supporting_record_ids,
      consistent_findings: t.consistent_findings.map((f) => typeof f === 'string' ? f : f.finding).filter(Boolean),
      conflicting_findings: t.conflicting_findings.map((f) => typeof f === 'string' ? f : f.claim_a).filter(Boolean),
      evidence_gaps: t.evidence_gaps,
      evidence_strength: t.evidence_strength,
    })),
    cross_cutting_observations: parsed.cross_cutting_observations,
    evidence_gaps: [],   // 老接口期望顶层 evidence_gaps;新 schema 没了,留空
  }
}

// Re-export for users that import old name
export { buildSynthesisUserPromptV2 as buildSynthesisUserPrompt }
