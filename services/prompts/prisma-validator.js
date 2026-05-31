/**
 * services/prompts/prisma-validator.js — Phase 8.D / PRISMA 2020 27-item auto-validation
 *
 * One Opus 4.8 call reads the entire assembled manuscript (all draft_sections)
 * and rates how well each PRISMA 2020 checklist item is addressed.
 *
 * Three-state rubric per item:
 *   - covered  — section addresses this item fully
 *   - partial  — section partially addresses, but key info is missing
 *   - missing  — no evidence in the manuscript
 *
 * Strictly cross-discipline: we DO NOT inject medical / education / engineering
 * assumptions. The user prompt only contains the 27 generic PRISMA item
 * recommendations + the draft sections as-is + a few context counts.
 *
 * Output is STRICT JSON (no markdown fence). Each item appears exactly once,
 * in the same order as the input list. The parser tolerates {result|data|output}
 * wrappers and defaults missing fields gracefully.
 */

// SYSTEM_VERSION:本文件 SYSTEM prompt 有改动 → bump 这个常量。
//   Validation 结果不写 system_version 列(per-item validated_at 已经够追溯),
//   但 audit payload 会带这个常量,方便日后排查。
//   格式:YYYY-MM-DD-vN
// v2 (2026-05-25 Phase B):加 methodology-capabilities honesty gate(item 11/12/14/24)
//   防 LLM 给假声明的 manuscript 打 "covered" 标签
export const PRISMA_VALIDATOR_SYSTEM_VERSION = '2026-05-25-v2'

// ============================================================
// PRISMA_VALIDATOR_SYSTEM(通用,27-item 全量验证)
// ============================================================
export const PRISMA_VALIDATOR_SYSTEM = `# Role
You are a senior systematic literature review (SLR) methodologist auditing a draft manuscript for PRISMA 2020 compliance. You evaluate WHETHER and HOW WELL each of the 27 reporting items is addressed in the manuscript text.

# Cross-discipline neutrality (read twice)
This audit applies UNIVERSALLY across disciplines (medical, education, engineering, social sciences, computer science, environmental sciences, etc.). The PRISMA 2020 statement is discipline-neutral. You MUST NOT inject discipline-specific expectations:
  - Do NOT assume the review is medical / clinical unless the manuscript says so.
  - Do NOT require RCT-specific language (e.g., randomisation, blinding) if the included studies are observational, qualitative, or computational.
  - Do NOT require meta-analysis language (forest plots, I², heterogeneity) if the synthesis is narrative / thematic.
  - Reason ONLY from the PRISMA 2020 recommendation text and what the manuscript actually says.

# Inputs you receive
1. The PRISMA 2020 27-item checklist (each entry: item_number, item, description / recommendation).
2. The full draft manuscript: every section the project has produced so far, concatenated with \`## Section: <section_name>\` headings. Sections that are still empty or not yet written WILL be missing — treat that as "no evidence".
3. PRISMA flow counts (records_identified, duplicates_removed, records_screened, full_text_assessed, studies_included) — context only; not a substitute for the manuscript prose.
4. Themes count — context only.

# Rating rubric (apply per item)
For each PRISMA item, find any evidence in the manuscript and assign EXACTLY ONE status:

  - \`covered\`  — The manuscript clearly addresses this item with the substance the recommendation asks for. Brief but complete counts; longer when the item is structurally demanding.
  - \`partial\`  — The manuscript addresses some aspect of the item but key information is missing, vague, or scattered. Examples: the search strategy is described but the date searched is not stated; eligibility criteria are listed but the rationale is absent; risk of bias is mentioned but per-study judgements are not presented.
  - \`missing\`  — No evidence in the manuscript. (If the section that would normally cover this item is absent or empty, default to \`missing\` unless the same content is clearly addressed elsewhere.)

When in doubt between covered and partial, prefer \`partial\` and explain what is missing.

# Evidence and recommendation discipline
- \`evidence_quote\` must be a SHORT verbatim quote from the manuscript (≤ 200 characters). Use \`""\` for \`missing\`. Do NOT paraphrase; do NOT translate. Quote the sentence (or fragment) that most clearly supports your rating. If the quote contains double quotes, escape them per JSON rules.
- \`section_found\` is the section heading where you located the evidence (e.g., "methods", "results", "abstract", "discussion"). Use \`""\` when status is \`missing\`.
- \`recommendation\` is concrete, actionable advice on how to add or improve the reporting for this item. ≤ 300 characters. Academic English. Reference the PRISMA item's expected content (e.g., "Add the date each database was last searched"), not the methodology of the review itself.

# Score arithmetic (strict)
After rating all 27 items, compute:
  - covered_count   = number of items with status = covered
  - partial_count   = number of items with status = partial
  - missing_count   = number of items with status = missing
  - overall_score   = round( 100 * (covered_count + 0.5 * partial_count) / 27 )   (integer 0–100)
Sanity: covered_count + partial_count + missing_count MUST equal the number of items you received (27 if the full checklist was sent; otherwise the count provided).

# Output schema (STRICT JSON — no prose, no markdown fence)
{
  "items": [
    {
      "item_number":    "1a",
      "status":         "covered" | "partial" | "missing",
      "evidence_quote": "<short verbatim quote from manuscript if status != missing; ≤ 200 chars>",
      "section_found":  "<section name where evidence is, or \"\" if missing>",
      "recommendation": "<concrete advice on how to add/improve; English; ≤ 300 chars>"
    }
    // ... repeat for every item, in the SAME ORDER as the input list, exactly once each
  ],
  "overall_score":  0,
  "covered_count":  0,
  "partial_count":  0,
  "missing_count":  0
}

# 🌐 ENGLISH OUTPUT ENFORCEMENT (READ TWICE)
EVERY string field in your JSON output MUST be in academic English. This includes \`recommendation\`. The only place where non-English text is allowed is inside \`evidence_quote\` when the manuscript itself contains a foreign-language quote (very unusual — the manuscript is normally English). Wrapper / explanatory fields are always English. The downstream parser will reject outputs that are >10% non-English by character count for non-quote fields.

# Hard constraints
- Output JSON ONLY. No \`\`\`json fence, no prose before or after.
- Each item from the input checklist appears EXACTLY ONCE in \`items\`, in the SAME ORDER, with the same \`item_number\` string verbatim.
- Do NOT invent items not in the input. Do NOT skip items.
- Do NOT downgrade an item to \`missing\` just because the section name does not match the PRISMA Methods/Results/Discussion partition; cross-check the actual prose.

# Ground-truth cross-check (additive rule — use whenever the inputs include them)
When the user prompt contains an "Approved Protocol" block and/or a "Locked Search Strategies" block, treat them as ground truth when rating items 5 (Eligibility criteria), 6 (Information sources), 7 (Search strategy), and 8 (Selection process). If the draft prose contradicts the approved protocol (e.g., the manuscript lists a database not in the locked strategies, or an inclusion criterion that the protocol does not have), flag the item as \`partial\` and quote the contradicting fragment in \`evidence_quote\` so the discrepancy is visible. If the draft prose is silent on something the protocol clearly fixes, still rate based on the manuscript text — the protocol is for cross-check, not for substituting the prose.

# Methodology-capabilities honesty gates (2026-05-25 Phase B)
When the user prompt contains a "Methodology capabilities (USER-DECLARED ...)" block, use it as ground truth for items that depend on whether procedures were actually performed:

- **Item 11 (Data items / extraction) + Item 12 (Risk of bias / certainty assessment)**: If \`dual_reviewer_extraction\` = false in capabilities, the manuscript must NOT claim dual independent extraction. If the prose says "two reviewers independently extracted data" but capabilities show single-rater → mark as \`partial\` and quote the contradicting prose. Same for RoB assessment.

- **Item 14 (Reporting bias / publication bias assessment) — explicit gate**:
  - If \`publication_bias_assessed\` = false in capabilities → cap rating at **partial**, never \`covered\`. Reason: the manuscript can at best acknowledge "publication bias not formally assessed (funnel plot / Egger's test not performed)" as a limitation; it cannot claim assessment was done.
  - If \`publication_bias_assessed\` = true in capabilities AND \`publication_bias_method\` is non-empty → rate \`covered\` IF the prose explicitly describes the method and findings; otherwise \`partial\`.

- **Item 24 (Registration and protocol)**: If \`prospero_id\` is empty AND \`registered_protocol_url\` is empty → cap rating at \`partial\` UNLESS the prose explicitly states "no public protocol registration was performed" (which would be honest enough for partial). If the prose claims PROSPERO / OSF registration but capabilities show empty IDs → mark \`missing\` and quote the false claim.

These gates protect against the LLM rating items as "covered" because the manuscript made a claim — even when the claim itself is fabricated relative to what was actually done.
`

// ============================================================
// buildPrismaValidatorUserPrompt
// ============================================================

/**
 * Build the user prompt that lists the 27 PRISMA items + every draft section's
 * full text + light context counts. Returns a string ready to pass to runLlm.
 *
 * @param {Object} args
 * @param {Array<{item_number:string, item?:string, topic?:string, section?:string, recommendation?:string, description?:string}>} args.checklistItems
 *        The 27 PRISMA 2020 items (from services/prisma.js getChecklistItems()).
 * @param {Array<{section_name:string, content_markdown?:string}>} args.draftSections
 *        The latest non-empty draft sections (from listLatestSections).
 * @param {Object|null} [args.prismaCounts]
 *        PRISMA flow counts (records_identified_total, duplicates_removed, …).
 * @param {number} [args.themes]
 *        Themes count for context.
 * @param {Object|null} [args.protocol]
 *        Approved protocol (ground truth for items 5–7). Shape:
 *          { version:number, research_questions:string[],
 *            inclusion_criteria:string[], exclusion_criteria:string[],
 *            concept_groups:Array<{name:string, terms:string[]}> }
 * @param {Array<{database:string, query_text:string, is_locked:number|boolean, result_count:number|null}>|null} [args.searchStrategies]
 *        Step 2 locked search strategies (ground truth for items 7–8).
 * @returns {string}
 */
export function buildPrismaValidatorUserPrompt({
  checklistItems,
  draftSections,
  prismaCounts = null,
  themes = 0,
  protocol = null,
  searchStrategies = null,
} = {}) {
  const lines = []

  // ── 1. The 27-item checklist ────────────────────────────────────────
  lines.push('# PRISMA 2020 — 27-item checklist to validate')
  lines.push('')
  lines.push('Each item below MUST be rated exactly once, in this order, using the same `item_number` verbatim.')
  lines.push('')
  const items = Array.isArray(checklistItems) ? checklistItems : []
  for (const it of items) {
    if (!it || !it.item_number) continue
    const num = String(it.item_number)
    const title = String(it.item || it.topic || '').trim()
    const section = String(it.section || '').trim()
    const desc = String(it.recommendation || it.description || '').trim()
    lines.push(`## Item ${num}${title ? ' — ' + title : ''}${section ? ' (PRISMA section: ' + section + ')' : ''}`)
    if (desc) lines.push(desc)
    lines.push('')
  }

  // ── 1b. Approved protocol + locked search strategies (ground truth) ─
  const hasProtocol = protocol && typeof protocol === 'object'
  const lockedSearches = Array.isArray(searchStrategies)
    ? searchStrategies.filter((s) => s && (s.is_locked === 1 || s.is_locked === true) && s.query_text)
    : []
  if (hasProtocol || lockedSearches.length > 0) {
    lines.push('---')
    lines.push('')
  }
  if (hasProtocol) {
    lines.push('# Approved Protocol (ground truth for items 5–7)')
    lines.push('')
    if (protocol.version != null) lines.push(`- Version: v${protocol.version}`)
    const rqs = Array.isArray(protocol.research_questions) ? protocol.research_questions : []
    if (rqs.length) {
      lines.push('- Research questions:')
      rqs.forEach((q, i) => {
        const txt = String(q || '').trim()
        if (txt) lines.push(`  - RQ${i + 1}: ${txt}`)
      })
    }
    const inc = Array.isArray(protocol.inclusion_criteria) ? protocol.inclusion_criteria : []
    if (inc.length) {
      lines.push('- Inclusion criteria:')
      for (const c of inc) {
        const txt = String(c || '').trim()
        if (txt) lines.push(`  - ${txt}`)
      }
    }
    const exc = Array.isArray(protocol.exclusion_criteria) ? protocol.exclusion_criteria : []
    if (exc.length) {
      lines.push('- Exclusion criteria:')
      for (const c of exc) {
        const txt = String(c || '').trim()
        if (txt) lines.push(`  - ${txt}`)
      }
    }
    const cgs = Array.isArray(protocol.concept_groups) ? protocol.concept_groups : []
    if (cgs.length) {
      lines.push('- Concept groups (used to build search):')
      for (const g of cgs) {
        if (!g || typeof g !== 'object') continue
        const name = String(g.name || '').trim() || '(unnamed)'
        const terms = Array.isArray(g.terms) ? g.terms : []
        const head = terms.slice(0, 5).map((t) => String(t || '').trim()).filter(Boolean)
        const more = terms.length > head.length ? ` (+${terms.length - head.length} more)` : ''
        lines.push(`  - ${name}: ${head.join(', ')}${more}`)
      }
    }
    lines.push('')
  }
  if (lockedSearches.length > 0) {
    lines.push('# Locked Search Strategies (ground truth for items 7–8)')
    lines.push('')
    for (const s of lockedSearches) {
      const db = String(s.database || '').trim() || '(unknown)'
      const q = String(s.query_text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const rc = (s.result_count != null && Number.isFinite(Number(s.result_count)))
        ? `, ${Number(s.result_count)} results`
        : ''
      lines.push(`- ${db} (locked${rc}): ${q}`)
    }
    lines.push('')
  }

  // ── 2. The draft manuscript ─────────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push('# Draft manuscript (concatenated sections)')
  lines.push('')
  const sections = Array.isArray(draftSections) ? draftSections : []
  if (sections.length === 0) {
    lines.push('_(No draft sections have been written yet. Every item should be rated `missing`.)_')
    lines.push('')
  } else {
    for (const s of sections) {
      if (!s || !s.section_name) continue
      const body = String(s.content_markdown || '').trim()
      lines.push(`## Section: ${s.section_name}`)
      if (body) {
        lines.push(body)
      } else {
        lines.push('_(section is empty)_')
      }
      lines.push('')
    }
  }

  // ── 3. PRISMA flow counts as context ────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push('# Context (do not substitute for manuscript prose)')
  lines.push('')
  if (prismaCounts && typeof prismaCounts === 'object') {
    const ctx = {
      records_identified_total: prismaCounts.records_identified_total ?? null,
      duplicates_removed: prismaCounts.duplicates_removed ?? null,
      records_screened: prismaCounts.records_screened ?? null,
      excluded_title_abstract: prismaCounts.excluded_title_abstract ?? null,
      full_text_assessed: prismaCounts.full_text_assessed ?? null,
      full_text_excluded: prismaCounts.full_text_excluded ?? null,
      studies_included: prismaCounts.studies_included ?? null,
    }
    lines.push('PRISMA flow counts (from internal logs):')
    for (const [k, v] of Object.entries(ctx)) {
      if (v != null) lines.push(`  - ${k}: ${v}`)
    }
    if (prismaCounts.records_identified && typeof prismaCounts.records_identified === 'object') {
      const perDb = Object.entries(prismaCounts.records_identified)
      if (perDb.length) {
        lines.push('  - per database:')
        for (const [db, n] of perDb) lines.push(`    · ${db}: ${n}`)
      }
    }
  } else {
    lines.push('PRISMA flow counts: (not provided)')
  }
  lines.push('')
  lines.push(`Themes (Step 6 synthesis): ${Number(themes) || 0}`)
  lines.push('')

  // ── 4. Final instruction ────────────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push('Validate each of the 27 items above against the manuscript. JSON only, no prose, no markdown fence.')

  return lines.join('\n')
}

// ============================================================
// parsePrismaValidatorOutput
// ============================================================

const VALID_STATUS = new Set(['covered', 'partial', 'missing'])

function truncateString(s, max) {
  if (typeof s !== 'string') return ''
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max).trim() + '…'
}

/**
 * Validate + normalize the LLM JSON output.
 *
 * Tolerates wrappers `{ result: {...} }`, `{ data: {...} }`, `{ output: {...} }`.
 * Each item must have item_number + status; missing fields are defaulted gracefully.
 *
 * @param {any} raw  Already JSON.parse-d object (or anything; we defend).
 * @returns {{
 *   ok: boolean,
 *   items: Array<{item_number:string, status:string, evidence_quote:string, section_found:string, recommendation:string}>,
 *   overall_score: number,
 *   covered_count: number,
 *   partial_count: number,
 *   missing_count: number,
 *   error?: string
 * }}
 */
export function parsePrismaValidatorOutput(raw) {
  const fail = (error) => ({
    ok: false,
    items: [],
    overall_score: 0,
    covered_count: 0,
    partial_count: 0,
    missing_count: 0,
    error,
  })

  if (!raw || typeof raw !== 'object') {
    return fail('raw is not an object')
  }

  // Unwrap common wrappers
  let r = raw
  if (!Array.isArray(r.items)) {
    if (r.result && typeof r.result === 'object') r = r.result
  }
  if (!Array.isArray(r.items)) {
    if (r.data && typeof r.data === 'object') r = r.data
  }
  if (!Array.isArray(r.items)) {
    if (r.output && typeof r.output === 'object') r = r.output
  }

  if (!Array.isArray(r.items)) {
    return fail('items missing or not an array')
  }

  const items = []
  let coveredCount = 0
  let partialCount = 0
  let missingCount = 0

  for (const raw_it of r.items) {
    if (!raw_it || typeof raw_it !== 'object') continue
    const num = String(raw_it.item_number ?? raw_it.number ?? raw_it.id ?? '').trim()
    if (!num) continue
    let status = String(raw_it.status ?? '').trim().toLowerCase()
    if (!VALID_STATUS.has(status)) {
      // Tolerate aliases
      if (status === 'complete' || status === 'fully_covered' || status === 'yes') status = 'covered'
      else if (status === 'partially_covered' || status === 'partial_coverage' || status === 'incomplete') status = 'partial'
      else if (status === 'absent' || status === 'not_covered' || status === 'no') status = 'missing'
      else status = 'missing'  // Default — be conservative
    }
    const evidenceQuote = truncateString(
      raw_it.evidence_quote ?? raw_it.quote ?? raw_it.evidence ?? '',
      200
    )
    const sectionFound = truncateString(
      raw_it.section_found ?? raw_it.section ?? raw_it.where ?? '',
      120
    )
    const recommendation = truncateString(
      raw_it.recommendation ?? raw_it.advice ?? raw_it.suggestion ?? '',
      300
    )

    items.push({
      item_number: num,
      status,
      evidence_quote: status === 'missing' ? '' : evidenceQuote,
      section_found: status === 'missing' ? '' : sectionFound,
      recommendation,
    })

    if (status === 'covered') coveredCount++
    else if (status === 'partial') partialCount++
    else missingCount++
  }

  if (items.length === 0) {
    return fail('no valid items parsed')
  }

  // Trust the LLM's counts if they match; otherwise re-derive from items
  const llmCovered = Number.isFinite(Number(r.covered_count)) ? Number(r.covered_count) : null
  const llmPartial = Number.isFinite(Number(r.partial_count)) ? Number(r.partial_count) : null
  const llmMissing = Number.isFinite(Number(r.missing_count)) ? Number(r.missing_count) : null
  if (llmCovered !== coveredCount || llmPartial !== partialCount || llmMissing !== missingCount) {
    // Re-derive — items[] is the source of truth
  }

  // overall_score: prefer LLM value if it's a sane integer 0-100, else recompute
  let overallScore = Number(r.overall_score)
  const computedScore = items.length
    ? Math.round((100 * (coveredCount + 0.5 * partialCount)) / items.length)
    : 0
  if (!Number.isFinite(overallScore) || overallScore < 0 || overallScore > 100) {
    overallScore = computedScore
  }

  return {
    ok: true,
    items,
    overall_score: overallScore,
    covered_count: coveredCount,
    partial_count: partialCount,
    missing_count: missingCount,
  }
}
