/**
 * services/prompts/latex-overlay.js — Phase 1 of LaTeX rendering
 * ------------------------------------------------------------
 * 给 LaTeX 渲染加一个"模板专用 prompt"前置层(对应 drafting overlay → plan → section
 * 的同款模式):
 *
 *   ① 抽模板规范(Sonnet, 1-3 min) ← 本文件
 *      input:  上传的 main.tex 模板源码 + 通用 LaTeX SLR 规范
 *      output: JSON overlay
 *              {
 *                template_family: 'frontiers' | 'elsevier' | 'ieee' | 'lncs' | 'generic',
 *                section_command_pattern, author_pattern, abstract_placement,
 *                figure_caption_position, table_caption_position, bib_style_hint,
 *                math_mode_convention, list_style, quote_style,
 *                template_quirks: [...], format_fixes_to_apply: [...]
 *              }
 *
 *   ② 用 overlay 填模板(Opus, 5-8 min) ← latex-fill.js v4
 *      input: 模板 + drafts + 上面的 overlay + 通用规则 + 格式修复 mandate
 *      output: filled main.tex
 *
 * 设计要点:
 *   - overlay 跟模板绑定(模板换了 → 重抽);跟 draft 内容无关
 *   - Phase 1 用 Sonnet(structural extraction,不需要 deep reasoning;cost / latency 都低)
 *   - overlay text 直接拼到 Phase 2 的 user prompt
 */

// v1 (2026-05-26 初版)
export const LATEX_OVERLAY_SYSTEM_VERSION = '2026-05-26-v1'

export const LATEX_OVERLAY_SYSTEM = `# Role
You are a LaTeX manuscript-template analyst. Given a journal-supplied LaTeX
template source (.tex), extract a STRICT JSON "template overlay" that
documents the template's structural conventions so that a downstream LaTeX
manuscript assembler can fill the template faithfully and avoid common
formatting pitfalls.

You are NOT producing prose. You produce a SINGLE structured JSON object.

# Output schema (STRICT JSON — no markdown fence, no prose around it)

{
  "template_family": "<one of: frontiers | elsevier | ieee | lncs | acm | springer-nature | apa-style | revtex | generic>",
  "documentclass": "<verbatim documentclass line including options>",
  "key_packages": ["<package1>", "<package2>", "..."],
  "section_command_pattern": {
    "primary": "<one of: \\\\section{...} | \\\\section*{...}>",
    "subsection": "<one of: \\\\subsection{...} | \\\\subsection*{...}>",
    "subsubsection": "<one of: \\\\subsubsection{...} | \\\\subsubsection*{...} | none>",
    "uses_section_labels": <true|false — does template use \\\\label{sec:xxx} after each section?>
  },
  "author_pattern": {
    "macro_style": "<one of: \\\\author{...}\\\\affiliation{...} | IEEEauthorblock | elsevier-frontmatter | acm-author | latex-default>",
    "supports_orcid": <true|false>,
    "supports_corresponding": <true|false>,
    "example_block": "<short snippet showing how ONE author entry should look in this template>"
  },
  "abstract_placement": {
    "environment": "<one of: \\\\begin{abstract}...\\\\end{abstract} | \\\\abstract{...} | abstract-as-section | none-required>",
    "max_words_hint": <integer — template-implied abstract word limit, e.g. 250 for IEEE; 0 if unspecified>,
    "keywords_macro": "<one of: \\\\keywords{...} | \\\\begin{keywords}...\\\\end{keywords} | IEEEkeywords | none>"
  },
  "figure_caption_position": "<below | above | unclear>",
  "table_caption_position": "<above | below | unclear>",
  "figure_environment": "<verbatim short example: e.g. \\\\begin{figure}[!ht]\\\\centering...\\\\end{figure}>",
  "table_environment": "<verbatim short example: e.g. \\\\begin{table}[!ht]\\\\centering\\\\caption{...}...\\\\end{table}>",
  "uses_booktabs": <true|false — does template use \\\\toprule \\\\midrule \\\\bottomrule (booktabs package) for tables?>,
  "bib_style_hint": {
    "command": "<one of: \\\\bibliography{references} | biblatex \\\\printbibliography | \\\\begin{thebibliography}...\\\\end{thebibliography} | none>",
    "style": "<one of: numerical | author-year | alphabetic | inferred-from-package>",
    "style_name": "<verbatim style name if \\\\bibliographystyle{X} present, e.g. plainnat, ieeetr, frontiersinHLTH>"
  },
  "math_mode_convention": "<one of: dollar-inline | paren-inline | bracket-display | dollar-display | mixed>",
  "list_style": "<one of: itemize-enumerate | description | template-custom | unclear>",
  "quote_style": "<one of: latex-quotes(\`\`...''/\`...') | unicode-quotes(“...”) | unclear>",
  "line_numbering": <true|false — does template have lineno / linenumbers package active?>,
  "double_column": <true|false>,
  "page_geometry_hint": "<short description: e.g. 'letterpaper, 1in margins' or 'A4, two-column'>",
  "template_quirks": [
    "<plain-English description of any unusual macro / convention the assembler needs to respect, max 8 items>"
  ],
  "format_fixes_to_apply": [
    "<plain-English rule for the assembler to apply when converting Markdown drafts to this template's LaTeX — e.g. 'Convert MD ** to \\\\textbf and never leave raw asterisks', 'Use booktabs (toprule/midrule/bottomrule), never \\\\hline', 'Escape & inside table cells and URL params', 'Place figure captions BELOW figures, table captions ABOVE tables', 'Use \\\\citep for parenthetical, \\\\citet for narrative citations', 'Convert any inline Chinese to English'. Aim for 6-12 actionable rules tailored to THIS template.>"
  ],
  "estimated_total_words_budget": <integer — estimated body-prose word budget from template comments/instructions; 0 if not specified>,
  "confidence_summary": "<one short sentence on how confident you are in the family identification + reasoning>",
  "detected_main_tex_filename": "<best guess of the main .tex filename you would expect from this template (e.g. 'main.tex', 'frontiers.tex', 'elsarticle-template.tex', 'manuscript.tex', 'IEEE-conference.tex'); when in doubt, return 'main.tex'>",
  "bibliography_handling": {
    "expected_bib_filename": "<usual companion .bib filename (e.g. 'references.bib', 'mybib.bib'); empty if biblatex-inline or thebibliography only>",
    "supports_bibtex": <true|false — does template work with BibTeX/biblatex workflow?>,
    "in_text_citation_command": "<recommended in-text citation macro for this template (e.g. \\\\citep, \\\\cite, \\\\citet, \\\\autocite)>",
    "reference_section_macro": "<one of: \\\\bibliography{references} | \\\\printbibliography | \\\\begin{thebibliography}...\\\\end{thebibliography} | none>",
    "csl_or_natbib_options": "<short description, e.g. 'natbib with [authoryear,round]', 'biblatex backend=biber style=apa', 'none' if unspecified>"
  }
}

# Hard constraints
1. OUTPUT STRICT JSON — first character \`{\`, last \`}\`. No markdown fence, no prose around.
2. **All strings in English.** If template comments contain Chinese / other languages, translate when extracting.
3. **Be conservative**: if a field cannot be confidently determined from the supplied template, use a defensible default ('generic' / 'unclear' / 0 / empty array) — do NOT guess wildly.
4. \`format_fixes_to_apply\` is the most valuable field: list concrete, tailored format-fix rules that the downstream assembler should apply when converting Markdown drafts into this template's LaTeX. Cover at minimum: bold/italic conversion, list conversion, table formatting (booktabs vs hline), caption position, citation command (\\\\citep vs \\\\cite), escaping (&, %, _, $, #, {}), quote characters, equation delimiters. 6-12 rules ideal.
5. \`template_quirks\` documents non-obvious behaviors that could trip up the assembler (e.g. "IEEE template requires \\\\IEEEPARstart for first-paragraph drop cap", "Elsevier needs \\\\address[a]{...} block matching each \\\\author[a]{...}").
6. Never invent macros not present in the template — only document what you observe.
`

/**
 * 把上传的 .tex 模板源 + 项目元数据(题目 / discipline)拼成 user prompt。
 * Sonnet 看完输出 STRICT JSON overlay。
 */
const TEMPLATE_MAX_CHARS = 60_000   // Sonnet 200K input,留够空间给 system + meta

export function buildLatexOverlayUserPrompt({
  templateTex,
  project = {},
  filename = '',
} = {}) {
  const lines = []
  const tpl = String(templateTex || '')

  lines.push('# Analyse this LaTeX template and emit the overlay JSON')
  lines.push('')
  if (project.title) lines.push(`Project title (for context only): ${String(project.title).slice(0, 200)}`)
  if (project.discipline) lines.push(`Discipline: ${String(project.discipline).slice(0, 80)}`)
  if (filename) lines.push(`Template filename: ${String(filename).slice(0, 80)}`)
  lines.push('')

  lines.push('## Template source (.tex)')
  lines.push('')
  if (tpl.length > TEMPLATE_MAX_CHARS) {
    lines.push(`*(template is ${tpl.length} chars; truncated to first ${TEMPLATE_MAX_CHARS} chars — preamble + early sections are sufficient for family identification + convention extraction)*`)
    lines.push('')
    lines.push('```latex')
    lines.push(tpl.slice(0, TEMPLATE_MAX_CHARS))
    lines.push('```')
  } else {
    lines.push('```latex')
    lines.push(tpl)
    lines.push('```')
  }
  lines.push('')

  lines.push('---')
  lines.push('Now produce the JSON overlay per the system schema. STRICT JSON ONLY — first char `{`, last `}`.')
  return lines.join('\n')
}

/**
 * 解析 Sonnet 输出,返回 normalize 后的 overlay 对象(已校验/补齐字段)。
 * 失败 → { ok: false, error }
 */
export function parseLatexOverlayOutput(raw) {
  if (raw == null) return { ok: false, error: 'empty output' }
  let obj = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj.trim()) } catch (e) {
      return { ok: false, error: 'json parse: ' + (e?.message || 'failed') }
    }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' }

  // 解一层 envelope wrapper(老 LLM 偶发会包 { result: {...} })
  if (obj.result && typeof obj.result === 'object' && !obj.template_family) obj = obj.result
  if (obj.output && typeof obj.output === 'object' && !obj.template_family) obj = obj.output

  // 字段 normalize + 截断 + defensive defaults
  const out = {
    template_family: typeof obj.template_family === 'string' ? obj.template_family.trim().slice(0, 40).toLowerCase() : 'generic',
    documentclass:   typeof obj.documentclass === 'string' ? obj.documentclass.trim().slice(0, 200) : '',
    key_packages:    Array.isArray(obj.key_packages) ? obj.key_packages.map(s => String(s).slice(0, 60)).slice(0, 30) : [],
    section_command_pattern: (obj.section_command_pattern && typeof obj.section_command_pattern === 'object') ? {
      primary:                 typeof obj.section_command_pattern.primary === 'string' ? obj.section_command_pattern.primary.slice(0, 50) : '\\section{...}',
      subsection:              typeof obj.section_command_pattern.subsection === 'string' ? obj.section_command_pattern.subsection.slice(0, 50) : '\\subsection{...}',
      subsubsection:           typeof obj.section_command_pattern.subsubsection === 'string' ? obj.section_command_pattern.subsubsection.slice(0, 50) : '\\subsubsection{...}',
      uses_section_labels:     !!obj.section_command_pattern.uses_section_labels,
    } : {
      primary: '\\section{...}', subsection: '\\subsection{...}', subsubsection: '\\subsubsection{...}', uses_section_labels: false,
    },
    author_pattern: (obj.author_pattern && typeof obj.author_pattern === 'object') ? {
      macro_style:           typeof obj.author_pattern.macro_style === 'string' ? obj.author_pattern.macro_style.slice(0, 60) : 'latex-default',
      supports_orcid:        !!obj.author_pattern.supports_orcid,
      supports_corresponding: !!obj.author_pattern.supports_corresponding,
      example_block:         typeof obj.author_pattern.example_block === 'string' ? obj.author_pattern.example_block.slice(0, 800) : '',
    } : { macro_style: 'latex-default', supports_orcid: false, supports_corresponding: false, example_block: '' },
    abstract_placement: (obj.abstract_placement && typeof obj.abstract_placement === 'object') ? {
      environment:    typeof obj.abstract_placement.environment === 'string' ? obj.abstract_placement.environment.slice(0, 80) : '\\begin{abstract}...\\end{abstract}',
      max_words_hint: Number(obj.abstract_placement.max_words_hint) || 0,
      keywords_macro: typeof obj.abstract_placement.keywords_macro === 'string' ? obj.abstract_placement.keywords_macro.slice(0, 80) : 'none',
    } : { environment: '\\begin{abstract}...\\end{abstract}', max_words_hint: 0, keywords_macro: 'none' },
    figure_caption_position: typeof obj.figure_caption_position === 'string' ? obj.figure_caption_position.slice(0, 20) : 'below',
    table_caption_position:  typeof obj.table_caption_position === 'string' ? obj.table_caption_position.slice(0, 20) : 'above',
    figure_environment:      typeof obj.figure_environment === 'string' ? obj.figure_environment.slice(0, 400) : '',
    table_environment:       typeof obj.table_environment === 'string' ? obj.table_environment.slice(0, 400) : '',
    uses_booktabs:           !!obj.uses_booktabs,
    bib_style_hint: (obj.bib_style_hint && typeof obj.bib_style_hint === 'object') ? {
      command:    typeof obj.bib_style_hint.command === 'string' ? obj.bib_style_hint.command.slice(0, 80) : '\\bibliography{references}',
      style:      typeof obj.bib_style_hint.style === 'string' ? obj.bib_style_hint.style.slice(0, 40) : 'inferred-from-package',
      style_name: typeof obj.bib_style_hint.style_name === 'string' ? obj.bib_style_hint.style_name.slice(0, 60) : '',
    } : { command: '\\bibliography{references}', style: 'inferred-from-package', style_name: '' },
    math_mode_convention: typeof obj.math_mode_convention === 'string' ? obj.math_mode_convention.slice(0, 40) : 'dollar-inline',
    list_style:           typeof obj.list_style === 'string' ? obj.list_style.slice(0, 40) : 'itemize-enumerate',
    quote_style:          typeof obj.quote_style === 'string' ? obj.quote_style.slice(0, 40) : 'unclear',
    line_numbering:       !!obj.line_numbering,
    double_column:        !!obj.double_column,
    page_geometry_hint:   typeof obj.page_geometry_hint === 'string' ? obj.page_geometry_hint.slice(0, 200) : '',
    template_quirks:      Array.isArray(obj.template_quirks) ? obj.template_quirks.map(s => String(s).slice(0, 400)).slice(0, 12) : [],
    format_fixes_to_apply: Array.isArray(obj.format_fixes_to_apply) ? obj.format_fixes_to_apply.map(s => String(s).slice(0, 400)).slice(0, 15) : [],
    estimated_total_words_budget: Number(obj.estimated_total_words_budget) || 0,
    confidence_summary:   typeof obj.confidence_summary === 'string' ? obj.confidence_summary.slice(0, 400) : '',
    // 2026-05-26:LLM 自动检测 main.tex 文件名(用户不用手选)+ 参考文献处理细则
    detected_main_tex_filename: typeof obj.detected_main_tex_filename === 'string'
      ? obj.detected_main_tex_filename.trim().slice(0, 80)
      : 'main.tex',
    bibliography_handling: (obj.bibliography_handling && typeof obj.bibliography_handling === 'object') ? {
      expected_bib_filename:   typeof obj.bibliography_handling.expected_bib_filename === 'string'
        ? obj.bibliography_handling.expected_bib_filename.trim().slice(0, 80) : 'references.bib',
      supports_bibtex:         !!obj.bibliography_handling.supports_bibtex,
      in_text_citation_command: typeof obj.bibliography_handling.in_text_citation_command === 'string'
        ? obj.bibliography_handling.in_text_citation_command.trim().slice(0, 40) : '\\citep',
      reference_section_macro: typeof obj.bibliography_handling.reference_section_macro === 'string'
        ? obj.bibliography_handling.reference_section_macro.trim().slice(0, 80) : '\\bibliography{references}',
      csl_or_natbib_options:   typeof obj.bibliography_handling.csl_or_natbib_options === 'string'
        ? obj.bibliography_handling.csl_or_natbib_options.trim().slice(0, 200) : '',
    } : {
      expected_bib_filename: 'references.bib',
      supports_bibtex: true,
      in_text_citation_command: '\\citep',
      reference_section_macro: '\\bibliography{references}',
      csl_or_natbib_options: '',
    },
  }

  // sanity check
  if (!out.format_fixes_to_apply.length) {
    return { ok: false, error: 'format_fixes_to_apply is empty — overlay needs at least 3 fix rules' }
  }
  return { ok: true, overlay: out }
}

/**
 * 把 overlay JSON 渲染成给 LaTeX-fill Phase 2 LLM user prompt 末尾用的 text block。
 * Phase 2 system prompt 通用,这块项目专用 — 同 drafting overlay 模式。
 */
export function renderLatexOverlayBlock(overlay) {
  if (!overlay || typeof overlay !== 'object') return ''
  const o = overlay
  const lines = []
  lines.push('## LaTeX template overlay (project-specific conventions extracted from the template)')
  lines.push('')
  lines.push(`Template family: **${o.template_family || 'generic'}**`)
  if (o.documentclass) lines.push(`Documentclass: \`${o.documentclass}\``)
  if (Array.isArray(o.key_packages) && o.key_packages.length) {
    lines.push(`Key packages: ${o.key_packages.slice(0, 12).join(', ')}`)
  }
  lines.push('')

  lines.push('### Section commands')
  if (o.section_command_pattern) {
    lines.push(`- primary: \`${o.section_command_pattern.primary}\``)
    lines.push(`- subsection: \`${o.section_command_pattern.subsection}\``)
    lines.push(`- subsubsection: \`${o.section_command_pattern.subsubsection}\``)
    lines.push(`- uses \`\\label{sec:...}\` after sections: ${o.section_command_pattern.uses_section_labels ? 'yes' : 'no'}`)
  }
  lines.push('')

  lines.push('### Author / affiliation conventions')
  if (o.author_pattern) {
    lines.push(`- macro style: ${o.author_pattern.macro_style}`)
    lines.push(`- supports ORCID: ${o.author_pattern.supports_orcid ? 'yes' : 'no'}`)
    lines.push(`- supports corresponding flag: ${o.author_pattern.supports_corresponding ? 'yes' : 'no'}`)
    if (o.author_pattern.example_block) {
      lines.push('- example author block:')
      lines.push('  ```latex')
      lines.push(o.author_pattern.example_block.split('\n').map(l => '  ' + l).join('\n'))
      lines.push('  ```')
    }
  }
  lines.push('')

  lines.push('### Abstract / keywords')
  if (o.abstract_placement) {
    lines.push(`- environment: \`${o.abstract_placement.environment}\``)
    if (o.abstract_placement.max_words_hint > 0) lines.push(`- max words hint: ${o.abstract_placement.max_words_hint}`)
    lines.push(`- keywords macro: \`${o.abstract_placement.keywords_macro}\``)
  }
  lines.push('')

  lines.push('### Figure / table conventions')
  lines.push(`- Figure caption position: **${o.figure_caption_position}**`)
  lines.push(`- Table caption position: **${o.table_caption_position}**`)
  lines.push(`- Uses booktabs (toprule/midrule/bottomrule): **${o.uses_booktabs ? 'yes — never use \\hline' : 'no — use \\hline as fallback'}**`)
  if (o.figure_environment) lines.push(`- Figure example: \`${o.figure_environment.slice(0, 200)}\``)
  if (o.table_environment) lines.push(`- Table example: \`${o.table_environment.slice(0, 200)}\``)
  lines.push('')

  lines.push('### Bibliography')
  if (o.bib_style_hint) {
    lines.push(`- bib command: \`${o.bib_style_hint.command}\``)
    lines.push(`- style: ${o.bib_style_hint.style}${o.bib_style_hint.style_name ? ` (\`${o.bib_style_hint.style_name}\`)` : ''}`)
  }
  if (o.bibliography_handling) {
    const bh = o.bibliography_handling
    if (bh.expected_bib_filename) lines.push(`- expected .bib filename: \`${bh.expected_bib_filename}\` (the assembler writes this file next to main.tex)`)
    lines.push(`- supports BibTeX/biblatex workflow: ${bh.supports_bibtex ? 'yes' : 'no — fall back to manual \\begin{thebibliography}'}`)
    if (bh.in_text_citation_command) lines.push(`- in-text citation macro: \`${bh.in_text_citation_command}\` (use this verbatim for ALL [rec_xxx] citations; do NOT mix with \\cite/\\citet unless prose explicitly reads narratively)`)
    if (bh.reference_section_macro) lines.push(`- reference section macro: \`${bh.reference_section_macro}\``)
    if (bh.csl_or_natbib_options) lines.push(`- options: ${bh.csl_or_natbib_options}`)
  }
  lines.push('')

  lines.push('### Math / lists / quotes / layout')
  lines.push(`- math mode: ${o.math_mode_convention}`)
  lines.push(`- list style: ${o.list_style}`)
  lines.push(`- quote style: ${o.quote_style}`)
  lines.push(`- line numbering active: ${o.line_numbering ? 'yes' : 'no'}`)
  lines.push(`- double-column layout: ${o.double_column ? 'yes — careful with wide tables (use table*)' : 'no'}`)
  if (o.page_geometry_hint) lines.push(`- page geometry: ${o.page_geometry_hint}`)
  lines.push('')

  if (Array.isArray(o.template_quirks) && o.template_quirks.length) {
    lines.push('### Template quirks (respect these — they are non-obvious)')
    o.template_quirks.forEach((q) => lines.push(`- ${q}`))
    lines.push('')
  }

  lines.push('### Format-fix rules to APPLY during conversion (mandatory)')
  if (Array.isArray(o.format_fixes_to_apply) && o.format_fixes_to_apply.length) {
    o.format_fixes_to_apply.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
  } else {
    lines.push('(no fixes specified — fall back to system prompt defaults)')
  }
  lines.push('')

  return lines.join('\n')
}
