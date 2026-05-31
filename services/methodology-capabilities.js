/**
 * services/methodology-capabilities.js — 2026-05-25
 * ------------------------------------------------------------
 * 项目级"方法学诚信声明" — 用户勾的 capability flag 注入到 drafting prompt,
 * 让 LLM 在 methods/abstract/limitations 段能 VERBATIM 报告真实做了的工作
 * (双人筛 / 三人裁决 / Cohen's kappa / PROSPERO 注册 / publication bias 等),
 * 同时配合 system prompt 的 P0-5 学术诚信门 防止编造。
 *
 * 数据流:
 *   UI checkbox/input  →  POST /:id/report/methodology-capabilities
 *                      →  saveCapabilities() 写 projects.methodology_capabilities_json
 *                      →  loadCapabilities() 在 GET /report 加载
 *                      →  buildSectionUserPrompt 注入 buildCapabilitiesPromptBlock() 输出
 *                      →  LLM 在 methods/abstract 段输出包含这些 capability(且仅这些)
 */

const SCHEMA_DEFAULTS = {
  dual_reviewer_screening: false,
  dual_reviewer_extraction: false,
  third_adjudicator: false,
  cohens_kappa_value: null,        // 数字 (0..1) 或 null
  kappa_outcome_label: '',          // 如 "title/abstract screening"
  prospero_id: '',                  // 如 "CRD42025123456"
  registered_protocol_url: '',      // OSF / PROSPERO 公开 URL
  publication_bias_assessed: false,
  publication_bias_method: '',      // 如 "funnel plot + Egger's test for outcome X"
  follows_prisma_p: false,
  notes: '',                        // 自由文本(最多 800 字符,LLM verbatim 引用)
}

export function defaultCapabilities() {
  return { ...SCHEMA_DEFAULTS }
}

/**
 * 从 DB 读出 capabilities,空/解析失败 → 默认全 false
 * @returns {object} merged with defaults(保证字段齐全)
 */
export function loadCapabilities(db, projectId) {
  if (!db || !projectId) return defaultCapabilities()
  try {
    const row = db.prepare(
      `SELECT methodology_capabilities_json FROM projects WHERE id = ?`
    ).get(projectId)
    if (!row || !row.methodology_capabilities_json) return defaultCapabilities()
    const parsed = JSON.parse(row.methodology_capabilities_json)
    if (!parsed || typeof parsed !== 'object') return defaultCapabilities()
    return { ...SCHEMA_DEFAULTS, ...parsed }
  } catch {
    return defaultCapabilities()
  }
}

/**
 * 从表单 body 规范化并写库。同步抛 → 路由层捕获。
 * @returns {object} 入库后的 capabilities(含默认值合并)
 */
export function saveCapabilities(db, projectId, formInput) {
  if (!db || !projectId) throw new Error('saveCapabilities: db + projectId required')
  if (!formInput || typeof formInput !== 'object') formInput = {}

  // 规范化 — boolean 字段接受 truthy / 'on' / '1' / 'true'
  function asBool(v) {
    if (v === undefined || v === null) return false
    if (typeof v === 'boolean') return v
    const s = String(v).toLowerCase().trim()
    return s === 'true' || s === '1' || s === 'on' || s === 'yes'
  }
  function asTrimmedStr(v, max) {
    return v ? String(v).trim().slice(0, max) : ''
  }
  function asKappa(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    if (n < 0 || n > 1) return null  // 不合法范围 → null(避免 LLM 用上 100% 等假数据)
    return Math.round(n * 1000) / 1000  // 3 位小数
  }

  const caps = {
    dual_reviewer_screening:    asBool(formInput.dual_reviewer_screening),
    dual_reviewer_extraction:   asBool(formInput.dual_reviewer_extraction),
    third_adjudicator:          asBool(formInput.third_adjudicator),
    cohens_kappa_value:         asKappa(formInput.cohens_kappa_value),
    kappa_outcome_label:        asTrimmedStr(formInput.kappa_outcome_label, 200),
    prospero_id:                asTrimmedStr(formInput.prospero_id, 80),
    registered_protocol_url:    asTrimmedStr(formInput.registered_protocol_url, 500),
    publication_bias_assessed:  asBool(formInput.publication_bias_assessed),
    publication_bias_method:    asTrimmedStr(formInput.publication_bias_method, 300),
    follows_prisma_p:           asBool(formInput.follows_prisma_p),
    notes:                      asTrimmedStr(formInput.notes, 800),
  }

  // 一致性自动修复:如果未勾 third_adjudicator 但 kappa 给了值,kappa 仍然保留
  //   (kappa 可以在没有第三裁决的情况下算两位 rater 间一致性,是合理的)
  // 反过来:勾了 third_adjudicator 但没勾 dual_reviewer_screening — 警告但仍保留
  //   (UI 层可以加 hint,DB 不阻塞)

  db.prepare(
    `UPDATE projects SET methodology_capabilities_json = ? WHERE id = ?`
  ).run(JSON.stringify(caps), projectId)

  return caps
}

/**
 * 把 caps 渲染成给 LLM 看的 prompt block(英文,因为 LLM 输出是英文)。
 * 在 buildSectionUserPrompt 给 methods / abstract / introduction / limitations
 * 段调用。空对象(全 false)时返回空字符串 — section system prompt 的"诚信门"
 * 自然 fallback 到 default honest phrasing。
 *
 * @returns {string} markdown-formatted block 或 ''
 */
export function buildCapabilitiesPromptBlock(caps) {
  if (!caps) return ''
  const lines = []
  const anyClaimedTrue =
       caps.dual_reviewer_screening
    || caps.dual_reviewer_extraction
    || caps.third_adjudicator
    || (caps.cohens_kappa_value !== null && caps.cohens_kappa_value !== undefined)
    || caps.prospero_id
    || caps.registered_protocol_url
    || caps.publication_bias_assessed
    || caps.follows_prisma_p
    || caps.notes
  if (!anyClaimedTrue) return ''

  lines.push('===== Methodology capabilities (USER-DECLARED — must report VERBATIM, no extrapolation) =====')
  lines.push('')
  lines.push('The user has explicitly declared these methodological procedures were performed. You MAY (and SHOULD)')
  lines.push('report them in Methods / Abstract — but you MUST NOT extend beyond what is listed (e.g. if')
  lines.push('"third adjudicator" is FALSE here, do NOT write "discrepancies resolved by a third reviewer").')
  lines.push('')

  if (caps.dual_reviewer_screening) {
    lines.push('- ✓ **Dual-reviewer title/abstract screening**: two reviewers independently screened titles & abstracts.')
  } else {
    lines.push('- ✗ Dual-reviewer screening NOT performed (single lead reviewer + AI-assisted triage was used). Describe accordingly.')
  }

  if (caps.dual_reviewer_extraction) {
    lines.push('- ✓ **Dual-reviewer data extraction**: two reviewers independently extracted data items, with discrepancies reconciled.')
  } else {
    lines.push('- ✗ Dual-reviewer extraction NOT performed. State that the lead reviewer extracted data with AI assistance.')
  }

  if (caps.third_adjudicator) {
    lines.push('- ✓ **Third-reviewer adjudication**: a third reviewer adjudicated unresolved disagreements.')
  } else {
    lines.push('- ✗ No third-reviewer adjudication. If dual review was used, describe how disagreements were resolved (e.g. discussion to consensus).')
  }

  if (caps.cohens_kappa_value !== null && caps.cohens_kappa_value !== undefined) {
    const lbl = caps.kappa_outcome_label || 'inter-rater agreement'
    lines.push(`- ✓ **Cohen's kappa = ${caps.cohens_kappa_value}** (computed for ${lbl}). Use this VERBATIM — do NOT invent additional kappa values for other outcomes.`)
  } else {
    lines.push('- ✗ Cohen\'s kappa NOT computed. Do NOT invent kappa values.')
  }

  if (caps.prospero_id || caps.registered_protocol_url) {
    let line = '- ✓ **Protocol registered**'
    if (caps.prospero_id) line += `: PROSPERO ${caps.prospero_id}`
    if (caps.registered_protocol_url) line += ` (${caps.registered_protocol_url})`
    lines.push(line + '.')
  } else {
    lines.push('- ✗ Protocol NOT formally registered (no PROSPERO / OSF entry supplied). Do NOT claim registration.')
  }

  if (caps.follows_prisma_p) {
    lines.push('- ✓ Protocol developed following **PRISMA-P 2015** reporting guideline.')
  }

  if (caps.publication_bias_assessed) {
    const method = caps.publication_bias_method ? `: ${caps.publication_bias_method}` : ''
    lines.push(`- ✓ **Publication bias assessed**${method}.`)
  } else {
    lines.push('- ✗ Publication bias NOT formally assessed (no funnel plot / Egger test data supplied). Do NOT claim assessment was performed.')
  }

  if (caps.notes) {
    lines.push('')
    lines.push('Additional methodology notes (verbatim, quote in Methods if relevant):')
    lines.push(`> ${caps.notes.replace(/\r?\n/g, '\n> ')}`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Compact summary for UI chip / status display.
 * @returns {string} 如 "✓ 双筛 / kappa 0.82 / PROSPERO" or "default (single rater)"
 */
export function summarizeCapabilities(caps) {
  if (!caps) return 'default (single rater)'
  const parts = []
  if (caps.dual_reviewer_screening) parts.push('dual screen')
  if (caps.dual_reviewer_extraction) parts.push('dual extract')
  if (caps.third_adjudicator) parts.push('3rd adj.')
  if (caps.cohens_kappa_value !== null && caps.cohens_kappa_value !== undefined) {
    parts.push(`κ=${caps.cohens_kappa_value}`)
  }
  if (caps.prospero_id) parts.push(`PROSPERO ${caps.prospero_id}`)
  if (caps.publication_bias_assessed) parts.push('pub-bias')
  if (caps.follows_prisma_p) parts.push('PRISMA-P')
  if (parts.length === 0) return 'default (single rater + AI triage)'
  return parts.join(' · ')
}
