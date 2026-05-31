/**
 * services/prompts/latex-fill.js — Phase 8.E LaTeX manuscript assembler.
 *
 * Goal: feed Opus a user-uploaded LaTeX template (.tex) + the already-drafted
 *  manuscript sections (markdown) + author/affiliation metadata + a list of
 *  figures and a citation cheat sheet, and get back a SINGLE filled .tex
 *  document ready to render with pdflatex.
 *
 * Output is STRICT JSON (no markdown fence):
 *   {
 *     "filled_tex": "<entire filled .tex>",
 *     "conversion_notes": ["..."],
 *     "warnings": ["..."]
 *   }
 *
 * Anti-goals:
 *   - Do NOT rewrite the template's preamble (documentclass, packages, custom
 *     macros, geometry, bibliographystyle, hyperref setup) — preserve verbatim.
 *   - Do NOT translate placeholder section content into Chinese.
 *   - Do NOT invent new \cite keys — every \citep{rec_xxx} must map to a record
 *     ID that appears in the citation cheat sheet.
 */

// SYSTEM_VERSION:本文件 SYSTEM prompt 有任何改动 → bump 这个常量。
// 格式:YYYY-MM-DD-vN
// v2 (2026-05-24):Phase D — 教 LLM 把 drafting 阶段产生的 [tbl:<key>] / [fig:<id>]
//                  占位转成 \ref{tab:<key>} / \ref{fig:<id>} + 在文末嵌入完整 table /
//                  figure 环境(figures/ 子目录前缀沿用)。
// v3 (2026-05-25):N4 回归 — 强化 [tbl:]/[fig:] 占位处理的硬约束:
//                  (a) 明确禁止把裸 [tbl:xxx] / [fig:xxx] 留在 filled_tex 里
//                      (LaTeX 会把 [..] 当 optional-arg,导致 pdflatex 报错或乱排);
//                  (b) [fig:prisma] 即便 "Available figures" 没列(caller 漏注入),
//                      也要降级为 \textit{[unresolved figure: prisma]} + LaTeX 注释,
//                      而不是裸 [fig:prisma] 透传;
//                  (c) 未知 [tbl:xxx] 同样输出 \textit{[unresolved table: xxx]}
//                      + % TODO 注释,严禁原样保留方括号。
//                  ── 测试用例(2026-05-25,N4 回归)──
//                  1) 草稿包含 "see [tbl:table1] for ..." + tables=[{key:"table1",...}]
//                     → 期望 filled_tex 含 "see \ref{tab:table1} for ..."
//                       + 文末 \begin{table}\label{tab:table1}...\caption{...}\end{table}
//                  2) 草稿包含 "Fig 1 [fig:prisma] shows..." + figures 含 prisma 条目
//                     → 期望 \ref{fig:prisma} + tikzpicture 或 \includegraphics{figures/prisma.pdf}
//                       + (若用 includegraphics)% TODO: convert PRISMA Mermaid 注释
//                  3) 草稿包含 "[fig:prisma]" 但 figures 列表里没有 prisma 条目
//                     → 期望正文里 \textit{[unresolved figure: prisma]} +
//                       conversion_notes / warnings 标注,严禁裸 [fig:prisma]
//                  4) 草稿包含 [tbl:invalid_key]                → 期望 \textit{[unresolved table: invalid_key]}
//                     + % TODO: unknown table key 注释,严禁裸 [tbl:invalid_key]
//                  5) 空草稿 / 无占位                           → 期望 LLM 不加多余 table/figure 环境
// v4 (2026-05-26):接入 LaTeX overlay(模板专用 prompt,Phase 1 Sonnet 产出) +
//                  加 format-fix mandate(MD bold/italic 转 LaTeX 强制 / 表格 booktabs /
//                  caption 位置 / 引号风格 / hyperref 转义 / equation 模式 / Chinese 残留
//                  扫描);user prompt 末尾若有 latex overlay block,LLM 应严格按 overlay
//                  指定的 template_family + format_fixes_to_apply 执行(对应 drafting
//                  overlay 模式)。
// v5 (2026-05-26):新增 per-section 分段填充 pipeline(LATEX_FILL_SECTION_SYSTEM /
//                  buildLatexFillSectionUserPrompt / parseLatexFillSectionOutput /
//                  assembleSectionsIntoTemplate)。原 v4 one-shot 留作向后兼容,
//                  但 /latex/render 走分段路径 — 8 段每段 5 min/3-5K output,
//                  避开 Opus 一次性出整本稿 + reasoning 烧 budget + Anthropic Overloaded
//                  的三重风险。每段 retry 30s 后再试一次(Overloaded 通常瞬时)。
// v6 (2026-05-26):新增 FILE-OPS 模式(buildLatexFillopsInstructions)。Claude CLI
//                  在 sandbox workdir 里用 Read/Write/Edit 工具直接操作文件,
//                  不再走 JSON envelope 输出 — 解决 results 段 30-50K char
//                  一次性 stream 撞 timeout / Overloaded 的根因。INSTRUCTIONS.md
//                  作为文件喂给 Claude,它一段一段读 sections/*.md 写 out/main.tex。
export const LATEX_FILL_SYSTEM_VERSION = '2026-05-26-v5'
export const LATEX_FILL_SECTION_SYSTEM_VERSION = '2026-05-26-v1'
export const LATEX_FILL_FILEOPS_INSTRUCTIONS_VERSION = '2026-05-26-v1'

// ============================================================
// LATEX_FILL_SYSTEM
// ============================================================
export const LATEX_FILL_SYSTEM = `# Role
You are a LaTeX manuscript assembler. Given a journal-supplied LaTeX template (the user-uploaded \`.tex\` source), the draft manuscript sections written in Markdown (English), authors metadata, available figures, and a citation cheat sheet, your job is to produce ONE complete filled \`.tex\` file that:

  1. **Preserves the template's preamble verbatim** — \`\\documentclass{...}\`, every \`\\usepackage{...}\`, every \`\\newcommand{...}\` / \`\\renewcommand{...}\`, page geometry settings, hyperref configuration, \`\\bibliographystyle{...}\`, line-numbering switches — keep them all unchanged. Do NOT add new package imports unless they are strictly required for content you are inserting (and if you must add one, add it inside a comment block flagging the addition).
  2. **Replaces placeholder body content** — lipsum, "Insert your introduction here", repeated boilerplate, generic abstract — with the appropriate drafted section (Markdown → LaTeX). Identify the corresponding section by the template's section command (\`\\section{Methods}\`, \`\\section*{Abstract}\`, \`\\subsection{...}\`, IEEE-style \`\\section{Introduction}\\label{sec:intro}\`, etc.).
  3. **Converts Markdown to LaTeX faithfully**, following these rules:
       - Markdown headings:
           - \`#\` inside body content → already mapped by the template's \`\\section{...}\` (do not duplicate)
           - \`##\` → \`\\subsection*{...}\` (unnumbered) if the template uses unnumbered sections, else \`\\subsection{...}\`
           - \`###\` → \`\\subsubsection*{...}\` / \`\\subsubsection{...}\` similarly
       - **bold**: \`**x**\` → \`\\textbf{x}\`
       - *italic*: \`*x*\` or \`_x_\` → \`\\emph{x}\`
       - inline code \`\`x\`\` → \`\\texttt{x}\`
       - code block (fenced \`\`\`...\`\`\`) → \`\\begin{verbatim} ... \\end{verbatim}\`
       - bulleted lists (\`- item\`) → \`\\begin{itemize} \\item ... \\end{itemize}\`
       - numbered lists (\`1. item\`) → \`\\begin{enumerate} \\item ... \\end{enumerate}\`
       - GFM tables → \`\\begin{table}[h]\\centering\\begin{tabular}{...}...\\end{tabular}\\caption{...}\\label{...}\\end{table}\` (use the table's first row as header, infer alignment from cell content)
       - inline citations \`[rec_xxx]\` → \`\\citep{rec_xxx}\` (use \`\\citet{}\` only when the surrounding prose reads as "X et al. (year) showed ..."; otherwise prefer \`\\citep\`)
       - paragraph breaks: blank line in Markdown → blank line in LaTeX (which LaTeX renders as a new paragraph)
       - escape LaTeX-special characters inside body text: \`&\` → \`\\&\`, \`%\` → \`\\%\`, \`#\` → \`\\#\`, \`_\` → \`\\_\`, \`$\` → \`\\$\`, \`{\` → \`\\{\`, \`}\` → \`\\}\`, \`<\` → \`\\textless{}\`, \`>\` → \`\\textgreater{}\`. Do NOT escape characters that are already inside \`\\verb\`, verbatim, or your converted commands.
  4. **Inserts authors and affiliations** matching the template's convention:
       - If the template uses \`\\author{First Last}\\affiliation{...}\\email{...}\` (modern style), emit one block per author in that order.
       - If the template uses IEEEtran-style \`\\author{\\IEEEauthorblockN{...}\\IEEEauthorblockA{...}}\`, conform to it.
       - If the template uses Elsevier-style \`\\author[a]{First Last\\corref{cor1}}\\address[a]{...}\`, conform.
       - If the template's author macro is unfamiliar OR you are unsure, place authors as best you can and leave a LaTeX comment line \`% TODO: map to template-specific author macro\` immediately above. Do not crash the document — every \`\\author\` arg must close cleanly.
       - Put \`\\thanks{Corresponding author: <correspondence_email>}\` (or template-equivalent) on the first author if a correspondence email is provided.
  5. **Inserts figures + tables** for any \`[fig:<id>]\` / \`[tbl:<key>]\` placeholder that appears in the draft sections (these are Phase C/D drafting placeholders — the post-processor numbers them, but in LaTeX you use \\ref{} instead):
       - In the running text, **replace** \`[fig:<id>]\` with \`\\ref{fig:<id>}\` and \`[tbl:<key>]\` with \`\\ref{tab:<key>}\`. Do NOT keep the raw \`[fig:...]\` / \`[tbl:...]\` brackets — LaTeX cannot render them.
       - For each unique figure id referenced, emit ONE floating figure environment near the first paragraph that references it:
         \`\\begin{figure}[h]\\centering\\includegraphics[width=\\linewidth]{figures/<filename>}\\caption{<caption>}\\label{fig:<id>}\\end{figure}\`
         The \`figures/\` prefix is mandatory — the render runner copies asset files into a \`figures/\` subdirectory next to \`main.tex\`.
       - For each unique table key referenced, emit ONE table environment near the first paragraph that references it:
         \`\\begin{table}[h]\\centering\\caption{<table label>}\\label{tab:<key>}\\begin{tabular}{...}...\\end{tabular}\\end{table}\`
         The actual tabular body is provided in the "Available tables" section of the user prompt (already converted to GFM Markdown rows — re-format the rows into \`\\begin{tabular}\` form).
       - If a figure id or table key is referenced in the draft but not in the corresponding "Available figures" / "Available tables" list, leave a \`% TODO: figure <id> not provided — placeholder\` or \`% TODO: table <key> not provided — placeholder\` comment in place of the environment, and use \`\\textit{[unresolved figure: <id>]}\` or \`\\textit{[unresolved table: <key>]}\` in the running text instead of \`\\ref\`. **Under no circumstances** leave the raw bracketed form \`[fig:<id>]\` or \`[tbl:<key>]\` in the output — LaTeX parses \`[...]\` as an optional argument and the resulting \`.tex\` will either break compilation or typeset garbage.
       - The special id \`[fig:prisma]\` should be treated as the project's PRISMA flow diagram. If the user prompt's "Available figures" list includes a \`prisma\` entry (typically with a Mermaid source in its \`caption\` / metadata), render the PRISMA flow either as an embedded \`tikzpicture\` / \`forest\` block (if you can faithfully transcribe the Mermaid) or as an \`\\includegraphics{figures/prisma.pdf}\` placeholder with a \`% TODO: convert PRISMA Mermaid to TikZ or upload as figures/prisma.pdf\` comment. If the \`prisma\` entry is missing from the figures list, fall back to the unresolved-figure rule above (\`\\textit{[unresolved figure: prisma]}\` + \`% TODO: PRISMA flow not provided\`) and flag it in \`warnings\`.
  6. **Bibliography**:
       - If the template already has \`\\bibliography{references}\` and \`\\bibliographystyle{...}\` — keep them, do not duplicate. The runner writes \`references.bib\` next to \`main.tex\`.
       - If the template uses \`biblatex\`/\`\\printbibliography\` — keep that command unchanged.
       - If the template has no bibliography command, append a \`\\bibliography{references}\` near the end (right before \`\\end{document}\`). If no \`\\bibliographystyle\` is set, add \`\\bibliographystyle{plainnat}\` next to it.
       - As an absolute last resort (template forbids BibTeX), generate a manual \`References\` section with \`\\begin{thebibliography}{99} \\bibitem{rec_xxx} ... \\end{thebibliography}\` using the citation cheat sheet entries. Note this in \`conversion_notes\`.
  7. **Output discipline**:
       - English only. Every word inserted into the LaTeX source must be academic English.
       - Output JSON ONLY — no \`\`\`json fence, no prose before or after, no markdown.
       - \`filled_tex\` is the COMPLETE \`.tex\` file as a single string (escape newlines per JSON rules — i.e. literal \`\\n\`, not real line breaks).
       - \`conversion_notes\` lists non-fatal decisions (e.g. "Mapped MD subsection 'Population' to LaTeX \\subsubsection{Population}"). Keep each entry under 200 chars.
       - \`warnings\` lists issues the user must review (e.g. "Template uses an unknown author macro — verify author order", "Figure fig_theme_net referenced but not provided"). Keep each entry under 200 chars.

# Constraints (hard)
- DO NOT wrap the JSON output in a markdown code fence.
- DO NOT emit \`\\input{}\` referencing files that are not in the template archive.
- DO NOT change the documentclass.
- The returned \`filled_tex\` MUST start with the same first line as the user-provided template (typically \`\\documentclass{...}\`), preserving comment lines before it.
- Every \`\\begin{}\` must have a matching \`\\end{}\`. Run a mental balance check before finalizing.
- The substrings \`[tbl:\` and \`[fig:\` MUST NOT appear anywhere in \`filled_tex\`. Every occurrence in the input draft must be transformed into either \`\\ref{tab:<key>}\` / \`\\ref{fig:<id>}\` (when the key is available) or \`\\textit{[unresolved table: <key>]}\` / \`\\textit{[unresolved figure: <id>]}\` (with a \`% TODO\` comment) when it is not. Run a final search for the strings \`[tbl:\` and \`[fig:\` before returning JSON; if any remain, fix them.

★ **TEMPLATE OVERLAY (2026-05-26 v4 — critical when present)**:
  If the user prompt contains a section titled \`## LaTeX template overlay\`,
  treat it as the PROJECT-SPECIFIC FILLING GUIDE that takes precedence over
  generic rules above. The overlay was extracted from the template by a
  dedicated analyser (Sonnet) and lists:
    - the template family (frontiers / elsevier / ieee / lncs / acm / generic)
    - the exact section / author / abstract / figure / table macros to use
    - bibliography convention
    - **format_fixes_to_apply** — concrete rules tailored to this template
  When the overlay is supplied:
    1. ALWAYS use the overlay's \`section_command_pattern\`, \`author_pattern.example_block\`,
       \`abstract_placement.environment\`, \`figure_environment\`, \`table_environment\`,
       and \`bib_style_hint.command\` verbatim — they encode the template's true conventions.
    2. APPLY every rule listed under \`format_fixes_to_apply\` while converting
       Markdown drafts to LaTeX. The overlay author has already audited the
       template for known pitfalls; obey their fix list.
    3. RESPECT \`template_quirks\` — these are non-obvious behaviors (e.g.
       "IEEE \\\\IEEEPARstart for drop cap", "Elsevier \\\\address[a] paired
       with \\\\author[a]"). Failing to respect a quirk typically breaks
       pdflatex compilation.

★ **FORMAT FIXES (universal — apply even if overlay absent)**:
  In addition to the basic Markdown→LaTeX rules above, scrub the output for
  these common issues that LLMs commonly leave behind when converting drafts:

  1. **No raw Markdown markers**: search \`filled_tex\` for leftover \`**bold**\`,
     \`*italic*\` / \`_italic_\`, \`\`\`inline-code\`\`\` markers — convert ALL to
     \`\\textbf{...}\`, \`\\emph{...}\`, \`\\texttt{...}\` respectively. Never leave
     bare asterisks or backticks in the LaTeX output.

  2. **Tables use booktabs** when the template uses \`\\usepackage{booktabs}\` (or
     when the overlay's \`uses_booktabs\` = true): replace any \`\\hline\` with
     \`\\toprule\` (top), \`\\midrule\` (between header + body), \`\\bottomrule\` (bottom).
     If booktabs is NOT loaded by the template, keep \`\\hline\` as fallback.

  3. **Caption placement**: figure captions BELOW \`\\includegraphics\` (default),
     table captions ABOVE \`\\begin{tabular}\` — UNLESS overlay says otherwise.

  4. **Hyperref/URL escaping**: in \`\\href{...}{...}\` URL slot, never put bare
     \`#\`, \`%\`, \`&\` — escape as \`\\#\`, \`\\%\`, \`\\&\`. DOIs go through \`\\doi{...}\`
     macro if defined; else \`\\url{https://doi.org/...}\`.

  5. **Citation command consistency**: use \`\\citep{rec_xxx}\` for parenthetical
     citations (default — most common); use \`\\citet{rec_xxx}\` ONLY when the prose
     reads narratively like "Smith et al. (2024) reported...". Do NOT mix
     \`\\cite{}\` with \`\\citep{}\` — pick one family per document.

  6. **Equation delimiters**: inline math = \`$...$\` (most templates) or \`\\(...\\)\`
     (some math-heavy templates) — match the overlay's \`math_mode_convention\`. Display
     math = \`\\[ ... \\]\` or \`\\begin{equation}...\\end{equation}\` (when you need
     a number). NEVER mix \`$\` and \`\\(\` in the same document.

  7. **Quote characters**: convert plain ASCII \`"..."\` to LaTeX \` \`\`...'' \` form
     (or unicode \`"..."\` if template uses unicode quotes — match overlay). Apostrophes:
     ASCII \`'\` → \` ' \`. Never leave a leading \`"\` open in mid-sentence.

  8. **No Chinese / non-Latin residue**: scan body text for any CJK or other
     non-Latin characters that should have been translated. If found, translate
     to standard scholarly English in place. Proper nouns with no English
     equivalent may be transliterated (e.g. pinyin for Chinese names).

  9. **Dash discipline**: en-dash \`--\` for ranges (e.g. \`2022--2026\`, \`pp. 12--34\`),
     em-dash \`---\` for parenthetical breaks. Never use a single hyphen \`-\` for
     either purpose.

  10. **Trailing whitespace + double blank lines**: do NOT introduce excess blank
      lines (LaTeX treats double blank line as new paragraph — multiple blanks
      typeset the same as one, but make the source ugly). Single blank line
      between paragraphs is the convention.

  Apply these fixes silently — list each non-trivial fix in \`conversion_notes\`
  (one entry per kind of fix, not per occurrence).
`

// ============================================================
// buildLatexFillUserPrompt
// ============================================================

/**
 * Build the user prompt for LATEX_FILL_SYSTEM.
 *
 * @param {Object} args
 * @param {string} args.templateTex            Full .tex source of the user-uploaded template. Truncated to TEMPLATE_MAX_CHARS if larger.
 * @param {Array<{section_name:string, content_markdown:string}>} args.draftSections   Latest non-empty sections.
 * @param {Array<Object>} args.authors         e.g. [{ first, last, email, orcid, affiliation_id }]
 * @param {Array<Object>} args.affiliations    e.g. [{ id, name, department, address }]
 * @param {string} [args.correspondenceEmail]
 * @param {string} [args.fundingText]
 * @param {string} [args.acknowledgementsText]
 * @param {Array<Object>} [args.figures]       [{ fig_key, filename, caption, intended_section }]
 * @param {Array<Object>} [args.citableRecords]  [{ id, title, authors_text, year, journal, doi }]
 * @param {Object} [args.project]              project row (title, topic, discipline)
 * @param {Object} [args.protocol]             approved protocol row (optional)
 * @returns {string}
 */
const TEMPLATE_MAX_CHARS = 50000

export function buildLatexFillUserPrompt({
  templateTex,
  draftSections,
  authors,
  affiliations,
  correspondenceEmail,
  fundingText,
  acknowledgementsText,
  figures,
  citableRecords,
  project,
  protocol,
  // 优化打磨包 — Prompt audit fix:复用 drafting overlay 作为本项目的 stylistic overlay
  //   journal voice / banned terms / citation density 等已经在 overlay 里,
  //   LaTeX 填充时拼到 user prompt 末尾,让填充器贴近 drafting 风格,不另起 meta-prompt。
  overlay = '',
  // Phase D 新增:registry 派生表 — 让 LaTeX LLM 把 [tbl:<key>] 转为 \ref{tab:<key>}
  // + 在文末嵌入 table 环境时拿到真实表头 / 行数据(已预渲染为 Markdown 给 LLM 读)。
  // tables 形态:Array<{ key, label, description, intended_section, markdown }>;
  //   markdown 由调用方用 renderTableExport(allTables, key, 'md') 预生成,
  //   LLM 把它转成 \begin{tabular} 形式。
  tables = null,
  // 2026-05-26:LaTeX overlay(Phase 1 Sonnet 抽出的项目专用 LaTeX 填充指引)+ block 渲染函数
  //   有 overlay 时,system prompt 已经被指令"严格按 overlay 执行";builder 把渲染好的
  //   markdown block 拼到 user prompt 末尾。无 overlay 时此段省略,系统走 default 行为。
  latexOverlay = null,
  renderLatexOverlayBlockFn = null,
} = {}) {
  const lines = []

  // ── 1. Template .tex source ─────────────────────────────────
  lines.push('## Template .tex source')
  lines.push('')
  const tpl = String(templateTex || '')
  if (tpl.length > TEMPLATE_MAX_CHARS) {
    lines.push(`*(template is ${tpl.length} chars; truncated to first ${TEMPLATE_MAX_CHARS} chars. The rest is presumed boilerplate / appendix content — preserve it implicitly when reconstructing)*`)
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

  // ── 2. Project metadata ─────────────────────────────────────
  lines.push('## Project metadata')
  lines.push('')
  if (project) {
    if (project.title) lines.push(`- Title: ${String(project.title).slice(0, 300)}`)
    if (project.topic) lines.push(`- Research topic: ${String(project.topic).slice(0, 500)}`)
    if (project.discipline) lines.push(`- Discipline: ${String(project.discipline).slice(0, 100)}`)
  }
  if (protocol && Array.isArray(protocol.research_questions) && protocol.research_questions.length) {
    lines.push(`- Research questions (${protocol.research_questions.length}):`)
    for (const q of protocol.research_questions.slice(0, 10)) {
      lines.push(`    - ${String(q).slice(0, 300)}`)
    }
  }
  lines.push('')

  // ── 3. Authors + affiliations ───────────────────────────────
  lines.push('## Authors + affiliations')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({
    authors: Array.isArray(authors) ? authors : [],
    affiliations: Array.isArray(affiliations) ? affiliations : [],
    correspondence_email: correspondenceEmail || '',
    funding: fundingText || '',
    acknowledgements: acknowledgementsText || '',
  }, null, 2))
  lines.push('```')
  lines.push('')

  // ── 4. Draft sections ───────────────────────────────────────
  lines.push('## Draft sections')
  lines.push('')
  const sections = Array.isArray(draftSections) ? draftSections : []
  if (sections.length === 0) {
    lines.push('*(no draft sections — fill body with template placeholders only)*')
  } else {
    for (const s of sections) {
      if (!s || !s.section_name) continue
      const body = String(s.content_markdown || '').trim()
      lines.push(`### Section: ${s.section_name}`)
      lines.push('')
      if (body) {
        lines.push(body)
      } else {
        lines.push('*(section is empty — leave placeholder text or skip)*')
      }
      lines.push('')
    }
  }

  // ── 5. Available figures ────────────────────────────────────
  lines.push('## Available figures')
  lines.push('')
  const figs = Array.isArray(figures) ? figures : []
  if (figs.length === 0) {
    lines.push('*(none — only insert figure environments for keys explicitly referenced in the draft text)*')
  } else {
    lines.push('Use these for any `[fig:<id>]` placeholder in the draft. Replace the placeholder in body text with `\\ref{fig:<id>}` and emit ONE figure environment near the first paragraph that references it.')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(figs.map(f => ({
      fig_key: f.fig_key || f.id || '',
      filename: f.filename || '',
      caption: f.caption || '',
      intended_section: f.intended_section || '',
    })), null, 2))
    lines.push('```')
  }
  lines.push('')

  // ── 5b. Available tables (Phase D — drafting placeholders [tbl:<key>]) ──
  lines.push('## Available tables')
  lines.push('')
  const tbls = Array.isArray(tables) ? tables : []
  if (tbls.length === 0) {
    lines.push('*(none — any `[tbl:...]` reference in the draft is therefore an error; flag in `warnings`)*')
  } else {
    lines.push('Use these for any `[tbl:<key>]` placeholder in the draft. Replace the placeholder in body text with `\\ref{tab:<key>}` and emit ONE `\\begin{table}...\\label{tab:<key>}...\\end{table}` environment near the first paragraph that references it. The markdown rendition below shows the tabular content — convert it to `\\begin{tabular}{...}` form for LaTeX.')
    for (const t of tbls) {
      if (!t || !t.key) continue
      lines.push('')
      lines.push(`### [tbl:${t.key}] — ${t.label || t.key}`)
      if (t.description) lines.push(`*${t.description}*`)
      if (t.intended_section) lines.push(`*intended section: ${t.intended_section}*`)
      lines.push('')
      const md = String(t.markdown || '').trim()
      if (md) {
        // 嵌进 fenced block 让 LLM 一目了然这是输入数据
        lines.push('```markdown')
        lines.push(md)
        lines.push('```')
      } else {
        lines.push('*(table has no rendered rows — emit `\\textit{[unresolved table]}` if `[tbl:' + t.key + ']` is referenced)*')
      }
    }
  }
  lines.push('')

  // ── 6. Citation cheat sheet ─────────────────────────────────
  lines.push('## Citation cheat sheet')
  lines.push('')
  const recs = Array.isArray(citableRecords) ? citableRecords : []
  if (recs.length === 0) {
    lines.push('*(no citable records — any `[rec_xxx]` reference in the draft is therefore an error; flag it in `warnings`)*')
  } else {
    lines.push('Each row corresponds to ONE BibTeX entry the runner will write to references.bib. Use these exact citation keys (the `id` field) in `\\citep{}` / `\\citet{}` commands.')
    lines.push('')
    lines.push('| key | author (first) | year | title (truncated) | journal | doi |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of recs.slice(0, 250)) {
      const key = r.id || ''
      const author = (r.authors_text || '').split(/[,;]/)[0].trim().slice(0, 30)
      const year = r.year || ''
      const title = (r.title || '').replace(/\|/g, '\\|').slice(0, 80)
      const journal = (r.journal || '').replace(/\|/g, '\\|').slice(0, 40)
      const doi = (r.doi || '').slice(0, 40)
      lines.push(`| ${key} | ${author} | ${year} | ${title} | ${journal} | ${doi} |`)
    }
    if (recs.length > 250) {
      lines.push('')
      lines.push(`*(${recs.length - 250} more records omitted — these are less likely to be cited in the body; if needed they exist in references.bib)*`)
    }
  }
  lines.push('')

  // ── 6b. Project-specific stylistic overlay (reuse drafting overlay) ──
  //   Adds journal voice, banned terms, canonical naming, citation density
  //   without spinning up a separate latex-overlay meta-prompt.
  const ovText = typeof overlay === 'object' && overlay
    ? (overlay.overlay_text || overlay.text || '')
    : String(overlay || '')
  if (ovText && ovText.trim()) {
    lines.push('## Project-specific stylistic overlay (reused from Step 8 drafting overlay)')
    lines.push('')
    lines.push('Apply this overlay\'s voice / banned terms / canonical naming when adapting body text to LaTeX. ' +
               'Do NOT inject new content from the overlay — only use it as stylistic guidance.')
    lines.push('')
    lines.push(ovText.trim())
    lines.push('')
  }

  // ── 6.5. LaTeX overlay(项目专用 LaTeX 填充指引)──
  //   2026-05-26:对应 drafting overlay 模式;Phase 1 Sonnet 已抽出针对本模板的
  //   填充规则 + 格式修复清单。LATEX_FILL_SYSTEM v4 已被指令"优先按 overlay 执行"。
  if (latexOverlay && typeof renderLatexOverlayBlockFn === 'function') {
    try {
      const ovBlock = renderLatexOverlayBlockFn(latexOverlay)
      if (ovBlock && ovBlock.trim()) {
        lines.push('---')
        lines.push('')
        lines.push(ovBlock.trim())
        lines.push('')
      }
    } catch (e) {
      // overlay 渲染失败不阻塞 — system prompt 走通用 fallback
    }
  }

  // ── 7. Final instruction ────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push('Return the JSON object with `filled_tex`, `conversion_notes`, `warnings`. No markdown fence, no prose before or after.')

  return lines.join('\n')
}

// ============================================================
// parseLatexFillOutput
// ============================================================

/**
 * Validate + normalise the LLM output.
 *
 * Tolerates wrappers `{ result: {...} }`, `{ data: {...} }`, `{ output: {...} }`.
 *
 * @param {any} raw   Already JSON.parse-d object (or anything; we defend).
 * @returns {{
 *   ok: boolean,
 *   filled_tex: string,
 *   conversion_notes: string[],
 *   warnings: string[],
 *   error?: string
 * }}
 */
export function parseLatexFillOutput(raw) {
  const fail = (error) => ({
    ok: false,
    filled_tex: '',
    conversion_notes: [],
    warnings: [],
    error,
  })

  if (raw == null) return fail('raw is null')
  // Sometimes LLM returns a string (didn't parse) — try once more.
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return fail('raw is a string and not JSON') }
  }
  if (typeof raw !== 'object') return fail('raw is not an object')

  let r = raw
  if (typeof r.filled_tex !== 'string') {
    if (r.result && typeof r.result === 'object') r = r.result
  }
  if (typeof r.filled_tex !== 'string') {
    if (r.data && typeof r.data === 'object') r = r.data
  }
  if (typeof r.filled_tex !== 'string') {
    if (r.output && typeof r.output === 'object') r = r.output
  }

  const filled = typeof r.filled_tex === 'string' ? r.filled_tex
    : (typeof r.tex === 'string' ? r.tex
       : (typeof r.content === 'string' ? r.content : ''))
  if (!filled || filled.length < 20) {
    return fail('filled_tex missing or too short')
  }

  // Quick sanity: must contain \documentclass somewhere in the first 1000 chars,
  //   otherwise it's almost certainly not a valid .tex file (defensive — don't
  //   reject hard, but record a warning).
  const head = filled.slice(0, 2000)
  const hasDocClass = /\\documentclass\b/.test(head)
  const hasBegin = /\\begin\s*\{\s*document\s*\}/.test(filled)
  const hasEnd = /\\end\s*\{\s*document\s*\}/.test(filled)

  const notes = Array.isArray(r.conversion_notes) ? r.conversion_notes.filter((x) => typeof x === 'string').map((x) => x.slice(0, 300)) : []
  const warns = Array.isArray(r.warnings) ? r.warnings.filter((x) => typeof x === 'string').map((x) => x.slice(0, 300)) : []
  if (!hasDocClass) warns.push('output does not start with \\documentclass — verify template preservation')
  if (!hasBegin || !hasEnd) warns.push('output missing \\begin{document} or \\end{document} — pdflatex will fail')

  return {
    ok: true,
    filled_tex: filled,
    conversion_notes: notes,
    warnings: warns,
  }
}

// ============================================================
// generateBibtex
// ============================================================

/**
 * Build a BibTeX string from citable records. Used to write `references.bib`
 * next to `main.tex` so that `\bibliography{references}` resolves.
 *
 * Strategy:
 *   - One @article per record, keyed by the record id (matches `\citep{<id>}`).
 *   - Sanitise field values: strip braces, replace stray `&` with `\&`, escape
 *     `%` and `#`, drop ASCII control chars.
 *   - Authors: if `authors_json` parses to an array of {full|family|given}
 *     objects, format as "Last, First and Last, First …". Else fall back to
 *     `authors_text` (already in "A; B; C" or "A, B, C" form) — split on `;`
 *     or `,` and re-join with ` and `.
 *
 * @param {Array<{id, title, authors_text, authors_json, year, journal, doi}>} records
 * @returns {string}
 */
export function generateBibtex(records) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const lines = []
  lines.push('% Auto-generated by SLR Copilot — Phase 8.E LaTeX render pipeline')
  lines.push('% Do not edit by hand; regenerated on every render.')
  lines.push('')

  for (const r of records) {
    if (!r || !r.id) continue
    const key = sanitizeKey(r.id)
    const title = bibSanitize(r.title || '')
    const year = parseInt(r.year, 10)
    const yearStr = Number.isFinite(year) ? String(year) : ''
    const journal = bibSanitize(r.journal || '')
    const doi = bibSanitize(r.doi || '')
    const authorBib = formatAuthorsForBib(r.authors_json, r.authors_text)

    lines.push(`@article{${key},`)
    if (authorBib) lines.push(`  author  = {${authorBib}},`)
    if (title)     lines.push(`  title   = {${title}},`)
    if (journal)   lines.push(`  journal = {${journal}},`)
    if (yearStr)   lines.push(`  year    = {${yearStr}},`)
    if (doi)       lines.push(`  doi     = {${doi}},`)
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
}

function sanitizeKey(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_')
}

// 2026-05-26 — CJK Unicode 范围(检测 + 剥离用)
//   CJK Symbols (U+3000-303F) / 平假名 (U+3040-309F) / 片假名 (U+30A0-30FF) /
//   CJK Ideographs Ext A (U+3400-4DBF) / CJK Unified (U+4E00-9FFF) /
//   谚文音节 (U+AC00-D7AF) / 全角符号 (U+FF00-FFEF)
const BIB_CJK_RE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/

function bibSanitize(s) {
  if (!s) return ''
  let txt = String(s)

  // 2026-05-26 — pdflatex(Frontiers / 大多数 article class 默认引擎)没有 CJK 字体,
  //   bbl 里出现 "辅 / 临床 / 思维" 等字符会触发 fatal Unicode error。
  //   用户原则(2026-05-26):"参考文献只要英文标题 双语言的只留英文"。
  //
  //   WoS / Scopus 中文论文 title 见到的形态:
  //     A. "English title; [中文标题]"     — 英文在前,分号分隔
  //     B. "English title (中文标题)"      — 英文在前,括号包中文
  //     C. "中文标题; [English title]"     — 中文在前(少见)
  //     D. "中文标题 (English title)"      — 中文在前(少见)
  //     E. "中文标题"                       — 纯中文论文(无英文)
  //
  //   策略:把 title 按常见双语分隔符切片,挑第一个 **纯英文非空** 片段。
  //   都找不到 → 剥 CJK 后看是否剩英文残片 → 否则用占位字符串(rec_id 保留)。
  if (BIB_CJK_RE.test(txt)) {
    const segments = txt.split(/[;；\[\]\(\)【】《》（）—]|--/)
      .map((t) => t.trim())
      .filter(Boolean)
    const englishOnly = segments.find((seg) => !BIB_CJK_RE.test(seg) && /[A-Za-z]/.test(seg))
    if (englishOnly) {
      txt = englishOnly
    } else {
      const stripped = txt
        .replace(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]+/g, ' ')
        .replace(/[\[\]\(\)【】《》（）]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      txt = (stripped && /[A-Za-z]/.test(stripped)) ? stripped : '[Non-Latin title]'
    }
  }

  return txt
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%#$_])/g, '\\$1')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .trim()
}

function formatAuthorsForBib(authorsJson, authorsText) {
  // Try JSON first
  if (authorsJson) {
    try {
      const arr = typeof authorsJson === 'string' ? JSON.parse(authorsJson) : authorsJson
      if (Array.isArray(arr) && arr.length) {
        const parts = []
        for (const a of arr) {
          if (!a || typeof a !== 'object') continue
          const family = a.family || a.surname || a.last || ''
          const given = a.given || a.first || ''
          const full = a.full || a.name || ''
          if (family && given) parts.push(`${family}, ${given}`)
          else if (full) parts.push(full)
          else if (family) parts.push(family)
        }
        if (parts.length) return parts.map(bibSanitize).join(' and ')
      }
    } catch {}
  }
  // Fallback: split text
  if (authorsText) {
    const parts = String(authorsText).split(/\s*[;]\s*/).map((s) => s.trim()).filter(Boolean)
    if (parts.length <= 1) {
      // try comma split
      const csv = String(authorsText).split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean)
      if (csv.length > 1) return csv.map(bibSanitize).join(' and ')
    }
    if (parts.length) return parts.map(bibSanitize).join(' and ')
  }
  return ''
}

// ============================================================
// 2026-05-26 — PER-SECTION FILL PIPELINE(v5 新增,分段填 LaTeX)
//
// 设计:把"整本稿一次性填"拆成"每段一次 LLM"。每段输出该 section 的
//   tex block(不含 preamble、不含 begin/end document、不含 bibliography)。
//   小请求 + 小输出 → 避开 Anthropic Overloaded / Opus 满负载 timeout。
//   ① /latex/render 循环 SECTION_ORDER 调 LLM
//   ② 每段失败自动 retry(30s 后再试 1 次)— Overloaded 通常瞬时
//   ③ 全部段拿到后,assembleSectionsIntoTemplate 确定性拼:
//        <preamble verbatim> + \begin{document} + <each section> +
//        <bibliography commands> + \end{document}
// ============================================================

export const LATEX_FILL_SECTION_SYSTEM = `# Role
You are a LaTeX editor converting ONE markdown manuscript section into the matching LaTeX block. Your output will be programmatically stitched between the user's template preamble and \\end{document}; you do NOT emit preamble / \\begin{document} / \\end{document} / bibliography commands.

# Output (STRICT JSON — no markdown fence, no prose before/after)

{
  "section_tex": "<the LaTeX block(s) for this single section, ready to drop in>",
  "conversion_notes": ["..."],
  "warnings": ["..."]
}

# Section-specific output discipline
- **title section** → emit \`\\title{...}\\author{...}\\affiliation{...}\\date{...}\\maketitle\` per the template's author macro convention (Frontiers / Elsevier / IEEE / LNCS — defer to template overlay).
- **abstract section** → emit \`\\begin{abstract} ... \\end{abstract}\` (no \\section command; abstract has its own environment).
- **introduction / methods / results / discussion / limitations / conclusion** → emit \`\\section{<Title>} ... body ...\` (use template's section_command_pattern from overlay if supplied; default \`\\section{}\`).
- **declarations** → emit one \`\\section{Declarations}\` with sub-sections \`\\subsection*{Funding}\`, \`\\subsection*{Competing interests}\`, etc.
- **references** → DO NOT emit anything; the assembler appends \`\\bibliography{references}\` + \`\\bibliographystyle{...}\` after all sections.

# Hard constraints
1. **JSON ONLY** — no \`\`\`json fence, no markdown wrapping, no prose around.
2. **section_tex contains ONLY this section's content** — no preamble, no \\begin{document}, no \\end{document}, no other section's content.
3. **Markdown → LaTeX conversion rules** (same as v4 monolithic system):
   - \`##\` → \`\\subsection{...}\` (or \`\\subsection*{}\` if template uses unnumbered)
   - \`###\` → \`\\subsubsection{...}\`
   - \`**x**\` → \`\\textbf{x}\`
   - \`*x*\` / \`_x_\` → \`\\emph{x}\`
   - inline code \`x\` → \`\\texttt{x}\`
   - GFM tables → \`\\begin{table}[h]\\centering\\begin{tabular}{...}...\\end{tabular}\\caption{...}\\label{...}\\end{table}\`
   - bullet list (\`- item\`) → \`\\begin{itemize}\\item ...\\end{itemize}\`
   - numbered list (\`1. item\`) → \`\\begin{enumerate}\\item ...\\end{enumerate}\`
   - \`[rec_xxx]\` → \`\\citep{rec_xxx}\` (prefer \\citep; \\citet only when prose reads "Smith et al. (2024) showed...")
   - escape LaTeX-specials in prose: \`&\` → \`\\&\`, \`%\` → \`\\%\`, \`#\` → \`\\#\`, \`_\` → \`\\_\`, \`$\` → \`\\$\`, \`{\`/\`}\` → \`\\{\`/\`\\}\`
4. **\`[tbl:<key>]\` / \`[fig:<id>]\` placeholders** in the source markdown:
   - In-text: replace with \`\\ref{tab:<key>}\` / \`\\ref{fig:<id>}\` (NEVER leave raw brackets — LaTeX parses \`[...]\` as optional arg, breaks compilation)
   - Emit the matching \`\\begin{table}\` / \`\\begin{figure}\` environment INLINE near the first reference (do not defer to an appendix — that's the assembler's job for things explicitly marked appendix-only)
   - For \`[fig:prisma]\`: special — the assembler injects the PRISMA flow image separately. In your section_tex, only emit \`\\ref{fig:prisma}\` in-text, do NOT emit the figure env.
   - Unknown id/key (not in Available tables / Available figures): emit \`\\textit{[unresolved table: <key>]}\` or \`\\textit{[unresolved figure: <id>]}\` + a \`% TODO\` comment. DO NOT leave bare \`[tbl:xxx]\` / \`[fig:xxx]\`.
5. **English only** in all output.
6. **Length safety**: section_tex should be 500-20,000 chars. Empty section (markdown empty/missing) → emit minimal \`% Section <name> intentionally left empty by author\` comment.

★ **TEMPLATE OVERLAY (if user prompt has "## LaTeX template overlay" block)**: use the overlay's section_command_pattern, author_pattern.example_block, abstract_placement.environment verbatim. Apply every \`format_fixes_to_apply\` rule and respect \`template_quirks\`.

★ **Self-check before returning**:
  - Scan section_tex for \`[tbl:\` / \`[fig:\` — none should remain
  - Every \`\\begin{X}\` has matching \`\\end{X}\` (mental balance check)
  - No \`\\begin{document}\` / \`\\end{document}\` (assembler handles those)
  - No \`\\documentclass\` (assembler preserves template preamble)
`

/**
 * 给单段(title / abstract / introduction / ...)构造 user prompt。
 *
 * @param {object} args
 * @param {string} args.sectionName       e.g. 'methods'
 * @param {string} args.sectionMarkdown   该段的 content_markdown(可能含 [rec_xxx]/[tbl:xxx]/[fig:xxx])
 * @param {Array}  [args.authors]         给 title section 用(non-title 段忽略)
 * @param {Array}  [args.affiliations]    同上
 * @param {string} [args.correspondenceEmail]
 * @param {string} [args.fundingText]
 * @param {Array}  [args.figures]         [{ fig_key, filename, caption, intended_section }]
 * @param {Array}  [args.tables]          registry 派生表 markdown 形态
 * @param {Array}  [args.citableRecords]
 * @param {Object} [args.project]
 * @param {Object} [args.protocol]
 * @param {string} [args.overlay]         drafting overlay(voice / banned terms)
 * @param {Object} [args.latexOverlay]    Sonnet 抽出来的 LaTeX template overlay JSON
 * @param {Function} [args.renderLatexOverlayBlockFn]
 * @returns {string}
 */
export function buildLatexFillSectionUserPrompt({
  sectionName,
  sectionMarkdown,
  authors,
  affiliations,
  correspondenceEmail,
  fundingText,
  figures,
  tables,
  citableRecords,
  project,
  protocol,
  overlay = '',
  latexOverlay = null,
  renderLatexOverlayBlockFn = null,
} = {}) {
  const lines = []

  // ── 1. Section identity + content ─────────────────────────
  lines.push(`## Section to convert: ${sectionName}`)
  lines.push('')
  lines.push('Convert ONLY this single section. Emit no preamble, no \\begin{document}, no other section content.')
  lines.push('')

  // Title section needs special metadata
  if (sectionName === 'title') {
    lines.push('### Authors + affiliations (for \\author/\\affiliation block)')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify({
      authors: Array.isArray(authors) ? authors : [],
      affiliations: Array.isArray(affiliations) ? affiliations : [],
      correspondence_email: correspondenceEmail || '',
    }, null, 2))
    lines.push('```')
    lines.push('')
    if (project?.title) {
      lines.push(`### Manuscript title (from project metadata, in case markdown is missing)`)
      lines.push(String(project.title).slice(0, 300))
      lines.push('')
    }
  }

  // Declarations needs funding etc
  if (sectionName === 'declarations') {
    lines.push('### Funding statement (verbatim from project)')
    lines.push(fundingText || '*(none supplied — emit `[ TBD by author: funding ]` placeholder)*')
    lines.push('')
  }

  // ── 2. Section markdown ─────────────────────────────────
  lines.push('### Markdown content for this section')
  lines.push('')
  lines.push('```markdown')
  lines.push(String(sectionMarkdown || '').trim() || '*(empty — emit minimal LaTeX comment, do not fabricate)*')
  lines.push('```')
  lines.push('')

  // ── 3. Figures referenced ───────────────────────────────
  if (Array.isArray(figures) && figures.length) {
    lines.push('### Available figures (only emit \\begin{figure} for ids referenced in the section markdown above)')
    lines.push('')
    for (const f of figures.slice(0, 20)) {
      const cap = (f.caption || '').slice(0, 200)
      lines.push(`- \`[fig:${f.fig_key}]\` — filename: \`figures/${f.filename}\` — caption: ${cap}`)
    }
    lines.push('')
  }

  // ── 4. Tables referenced (registry-derived) ─────────────
  if (Array.isArray(tables) && tables.length) {
    lines.push('### Available tables (only emit \\begin{table} for keys referenced in the section markdown above)')
    lines.push('')
    for (const t of tables.slice(0, 20)) {
      lines.push(`#### \`[tbl:${t.key}]\` — ${t.label || t.key}`)
      if (t.description) lines.push(`*${t.description}*`)
      lines.push('')
      lines.push('```markdown')
      lines.push(String(t.markdown || '').slice(0, 4000))
      lines.push('```')
      lines.push('')
    }
  }

  // ── 5. Citation cheat sheet (paper ids that can be cited) ──
  if (Array.isArray(citableRecords) && citableRecords.length) {
    lines.push('### Citable papers (every `\\citep{rec_xxx}` MUST use an id from this list)')
    lines.push('')
    const sample = citableRecords.slice(0, 200)
    for (const r of sample) {
      const authorsShort = (r.authors_text || '').split(/[,;]/)[0]?.trim() || 'Anon'
      lines.push(`- \`${r.id}\` — ${authorsShort} et al., ${r.year || 'n.d.'}: ${(r.title || '').slice(0, 100)}`)
    }
    if (citableRecords.length > sample.length) {
      lines.push(`*(... and ${citableRecords.length - sample.length} more — full list available in references.bib)*`)
    }
    lines.push('')
  }

  // ── 6. LaTeX template overlay (per-project filling guide) ──
  if (latexOverlay && typeof renderLatexOverlayBlockFn === 'function') {
    try {
      const overlayBlock = renderLatexOverlayBlockFn(latexOverlay)
      if (overlayBlock && overlayBlock.trim()) {
        lines.push(overlayBlock)
        lines.push('')
      }
    } catch (e) {
      // silent — overlay rendering failure shouldn't break section fill
    }
  }

  // ── 7. drafting overlay (voice / banned terms) ──
  if (overlay && String(overlay).trim()) {
    lines.push('## Drafting overlay (project voice / banned terms — apply within prose)')
    lines.push('')
    lines.push(String(overlay))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`Return JSON per system schema. \`section_tex\` is the LaTeX for the **${sectionName}** section only. No preamble. No other sections.`)
  return lines.join('\n')
}

/**
 * Parse per-section LLM output JSON.
 * @returns {{ ok: boolean, section_tex?: string, conversion_notes?: string[], warnings?: string[], error?: string }}
 */
export function parseLatexFillSectionOutput(raw) {
  if (!raw) return { ok: false, error: 'empty result' }
  let r = raw
  if (typeof r === 'string') {
    try { r = JSON.parse(r) } catch { return { ok: false, error: 'not JSON' } }
  }
  if (!r || typeof r !== 'object') return { ok: false, error: 'not object' }
  // Unwrap common envelopes
  if (r.result && typeof r.result === 'object' && !r.section_tex) r = r.result
  if (r.data && typeof r.data === 'object' && !r.section_tex) r = r.data
  if (r.output && typeof r.output === 'object' && !r.section_tex) r = r.output

  const tex = String(r.section_tex || r.tex || r.latex || '').trim()
  if (!tex) return { ok: false, error: 'section_tex missing or empty' }
  if (tex.length < 5) return { ok: false, error: `section_tex too short (${tex.length} chars)` }
  if (tex.length > 60000) return { ok: false, error: `section_tex too long (${tex.length} chars)` }

  return {
    ok: true,
    section_tex: tex,
    conversion_notes: Array.isArray(r.conversion_notes) ? r.conversion_notes.slice(0, 50) : [],
    warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 50) : [],
  }
}

/**
 * 确定性拼装 — 把 per-section tex blocks 嵌进模板的 preamble 框架。
 *
 * 1. 从 templateTex 切出 preamble(\\begin{document} 之前的全部 — verbatim)
 *    如果模板无 \\begin{document}(罕见,纯 fragment),整段当 preamble。
 * 2. 在 \\begin{document} 后按 SECTION_ORDER 顺序插每段的 section_tex
 * 3. 在 \\end{document} 前插 bibliography 命令(若模板 preamble 没设过)
 *
 * @param {object} args
 * @param {string} args.templateTex          原 .tex 全文(verbatim preamble 用)
 * @param {Object<string,string>} args.sectionTexMap  { title, abstract, introduction, ... }
 * @param {Array<string>} [args.sectionOrder]  默认 ['title','abstract','introduction','methods','results','discussion','limitations','conclusion','declarations']
 * @param {string} [args.bibStyle]           e.g. 'plainnat' / 'unsrtnat' — overlay 里抽出来时传入,否则 fallback 'plainnat'
 * @returns {{ filled_tex: string, warnings: string[] }}
 */
export function assembleSectionsIntoTemplate({
  templateTex,
  sectionTexMap = {},
  sectionOrder = ['title', 'abstract', 'introduction', 'methods', 'results', 'discussion', 'limitations', 'conclusion', 'declarations'],
  bibStyle = 'plainnat',
} = {}) {
  const warnings = []
  const tpl = String(templateTex || '')

  // 1) Split at \begin{document}
  const beginDocRe = /\\begin\s*\{\s*document\s*\}/
  const beginDocMatch = tpl.match(beginDocRe)
  let preamble = ''
  if (beginDocMatch) {
    preamble = tpl.slice(0, beginDocMatch.index).trimEnd()
  } else {
    // No \begin{document} — assume the whole template is preamble (unusual but possible)
    preamble = tpl.trim()
    warnings.push('Template has no \\begin{document} — using whole template as preamble')
  }

  // 2) Check if preamble has \bibliographystyle / \bibliography — if not, we'll add at end
  const hasBibStyle = /\\bibliographystyle\s*\{/.test(preamble)
  const hasBibliography = /\\bibliography\s*\{/.test(tpl) || /\\printbibliography/.test(tpl)

  // 3) Compose body
  const bodyLines = []
  bodyLines.push('')
  for (const secName of sectionOrder) {
    const tex = sectionTexMap[secName]
    if (!tex || !String(tex).trim()) {
      // skip silently — empty section just means user didn't generate it
      continue
    }
    bodyLines.push('% ============================================================')
    bodyLines.push(`% Section: ${secName}`)
    bodyLines.push('% ============================================================')
    bodyLines.push(String(tex).trim())
    bodyLines.push('')
  }

  // 4) Bibliography section
  if (!hasBibliography) {
    bodyLines.push('% ============================================================')
    bodyLines.push('% References (auto-appended; runner writes references.bib)')
    bodyLines.push('% ============================================================')
    if (!hasBibStyle) {
      bodyLines.push(`\\bibliographystyle{${bibStyle}}`)
    }
    bodyLines.push('\\bibliography{references}')
    bodyLines.push('')
  } else {
    // Template already has bibliography commands somewhere — we trust it
    // But the per-section emit won't have included them, so we still need to.
    // Search preamble for inline bib; if found there, skip.
    if (!hasBibliography) {
      warnings.push('Template references bibliography but neither \\bibliography{} nor \\printbibliography found — adding fallback')
      bodyLines.push(`\\bibliographystyle{${bibStyle}}`)
      bodyLines.push('\\bibliography{references}')
    }
    // Otherwise: assume template has it — but template's bib reference was BEFORE \end{document},
    //   which we're now generating fresh. So always re-add to be safe.
    bodyLines.push(`\\bibliographystyle{${bibStyle}}`)
    bodyLines.push('\\bibliography{references}')
    bodyLines.push('')
  }

  // 5) Final assembly
  const out = []
  out.push(preamble)
  out.push('')
  out.push('\\begin{document}')
  out.push(bodyLines.join('\n'))
  out.push('\\end{document}')

  return {
    filled_tex: out.join('\n'),
    warnings,
  }
}

// ============================================================
// 2026-05-26 v6 — FILE-OPS pipeline
//   Claude CLI 在 sandbox workdir 里用 Read/Write/Edit 工具完成任务。
//   不再走 JSON envelope 输出,根本解决 results 段一次性 stream timeout。
// ============================================================

/**
 * 2026-05-26 v6.1 — 升级:加 tables/ 子目录数据透传 + 显式 section bucket 列表 + 防 hallucination 硬约束。
 *
 * 生成 INSTRUCTIONS.md 内容,写到 workdir 顶层,Claude Read 后执行。
 *
 * @param {object} args
 * @param {string}   args.templateMainTexFilename  e.g. 'frontiers.tex' / 'main.tex'
 * @param {string[]} args.sectionFilenames         e.g. ['title.md','abstract.md',...,'declarations.md']
 * @param {string[]} [args.sectionBuckets]          实际有内容的标准桶,按 SECTION_FILL_ORDER 顺序(给 Step 3 列处理顺序)
 * @param {Array}    [args.tableManifest]          [{key,label,description,intended_section}] — Claude 看到 [tbl:key] 时 Read tables/<key>.md
 * @param {Array}    [args.figureManifest]         [{fig_key,filename,caption,intended_section}]
 * @param {string}   [args.citationStyle]          'apa' / 'ieee' / etc. default 'apa'
 * @param {string}   [args.bibStyle]               LaTeX bibliographystyle, e.g. 'plainnat' / 'unsrtnat'
 * @param {boolean}  [args.hasOverlay]
 * @param {boolean}  [args.hasCitationMap]
 * @param {number}   [args.figuresCount]
 * @param {number}   [args.citablePapersCount]
 * @returns {string}  markdown 文件内容
 */
export function buildLatexFillopsInstructions({
  templateMainTexFilename = 'main.tex',
  sectionFilenames = [],
  sectionBuckets = null,
  tableManifest = [],
  figureManifest = [],
  citationStyle = 'apa',
  bibStyle = 'plainnat',
  hasOverlay = false,
  hasCitationMap = false,
  figuresCount = 0,
  citablePapersCount = 0,
} = {}) {
  const sectionList = sectionFilenames.map(f => `   - sections/${f}`).join('\n')
  // 处理顺序:优先用 caller 传入的 sectionBuckets(只列实际有内容的);
  // 否则从 sectionFilenames 推断
  const processOrder = (Array.isArray(sectionBuckets) && sectionBuckets.length > 0)
    ? sectionBuckets
    : sectionFilenames.map(f => f.replace(/\.md$/, ''))
  const processOrderInline = processOrder.join(', ')

  const tablesAvail = Array.isArray(tableManifest) && tableManifest.length > 0
  const tableListMd = tablesAvail
    ? tableManifest.map(t =>
        `  - **\`tables/${t.key}.md\`** — placeholder \`[tbl:${t.key}]\` → label \`tab:${t.key}\` (intended: ${t.intended_section || 'any'}) — ${t.label || ''}`
      ).join('\n')
    : '  (no registered tables — section markdown should not reference [tbl:*])'

  const figuresAvail = Array.isArray(figureManifest) && figureManifest.length > 0
  const figListMd = figuresAvail
    ? figureManifest.map(f =>
        `  - **\`figures/${f.filename || f.fig_key}\`** — placeholder \`[fig:${f.fig_key}]\` → label \`fig:${f.fig_key}\` (intended: ${f.intended_section || 'any'})${f.caption ? ' — ' + f.caption.slice(0, 80) : ''}`
      ).join('\n')
    : '  (no figure assets)'

  return `# TASK: Fill the LaTeX template with the drafted manuscript

You are operating in this working directory as a code-editor agent. Use Read,
Write, Edit, and Glob tools. **The deliverable is \`out/main.tex\` (you must Write it).**

The manuscript content is already finalized in \`sections/*.md\` — do NOT rewrite
the prose, only convert Markdown → LaTeX and slot each section into the right
place in the template. Tables and figures are STAGED with real data — do NOT
fabricate table rows or figure captions.

---

## Working directory layout

\`\`\`
./
├── INSTRUCTIONS.md             ← this file (you are reading it)
├── template/                   ← user's uploaded LaTeX template (DO NOT modify)
│   ├── ${templateMainTexFilename}    ← the template's main .tex (preamble + section anchors)
│   ├── *.cls / *.sty / *.bst  ← template's class / style / bib-style files
│   └── ... (logos, etc.)
├── sections/                   ← drafted manuscript content (Markdown, finalized; one file per standard section bucket)
${sectionList}
${tablesAvail ? '├── tables/                     ← REAL data tables (Markdown) — READ THESE, do NOT fabricate!' : ''}
${tablesAvail ? tableManifest.map(t => `│   ├── ${t.key}.md`).join('\n') : ''}
├── references.bib              ← BibTeX (auto-generated, do NOT modify)
${hasCitationMap ? '├── citation-map.json           ← rec_id → "Author, Year" mapping (for in-text)' : ''}
${hasOverlay ? '├── overlay.json                ← project-specific LaTeX-fill guidance (READ THIS FIRST!)' : ''}
├── figures/                    ← image assets (${figuresCount} files, already in place)
└── out/                        ← YOUR OUTPUT DIRECTORY (currently empty)
    └── main.tex                ← Write your final filled LaTeX here
\`\`\`

---

## Step-by-step workflow

### Step 1 — Read the template and understand its anatomy
\`\`\`
Glob "template/*.tex"          # see what .tex files exist
Read template/${templateMainTexFilename}  # the main one — read it in full
${hasOverlay ? 'Read overlay.json              # template-specific fill rules (priority over generic rules)' : ''}
\`\`\`

Identify:
- The preamble (everything BEFORE \`\\begin{document}\`) — verbatim copy to your output, do NOT change packages, geometry, custom macros, hyperref setup
- The author / title block convention (e.g. \`\\author{...}\` Frontiers vs IEEE \`\\IEEEauthorblockN{}\` vs Elsevier \`\\author[a]{...}\\address[a]{...}\`)
- The section command pattern (\`\\section{}\` vs \`\\section*{}\`)
- The abstract environment (\`\\begin{abstract}...\\end{abstract}\` vs \`\\title*{Abstract}\` etc.)
- The bibliography command (\`\\bibliography{}\` + \`\\bibliographystyle{}\` vs \`biblatex\` \`\\printbibliography\`)

### Step 2 — Create out/main.tex with preamble
\`\`\`
Write out/main.tex   ← copy template's preamble verbatim, then add \\begin{document}
\`\`\`
At this point \`out/main.tex\` has preamble + \`\\begin{document}\` + (empty body).

### Step 3 — Iteratively append each section

**Process every section file in \`sections/\`** — do not skip any. Process in this order:

\`\`\`
${processOrderInline}
\`\`\`

For EACH section file in that order:
\`\`\`
Read sections/<name>.md       # read the entire file
# Convert markdown → LaTeX following the conversion table below
Edit out/main.tex              # append converted LaTeX before \\end{document}
\`\`\`

★ **Each section file may contain "## <Subsection Name>" headings** when multiple
   logical sub-sections were merged into one bucket (e.g. declarations.md may contain
   Funding + Author contributions + Competing interests + Data availability). Convert
   each \`##\` to \`\\subsection*{...}\` (or \`\\subsection{...}\` depending on template).
   Do **NOT** collapse sub-sections — keep them all.

★ **The \`results\` section is the longest (~30,000–50,000 chars of LaTeX).**
   You may split it into multiple Edit/Write operations (3–8 chunks of 5–10K chars each).
   Read sections/results.md in full first, plan the chunking, then Edit incrementally.

★ **Title section special**: emit author/title/affiliation block per template convention,
   then \`\\maketitle\` (or template equivalent). Do NOT emit \`\\section{Title}\`.

★ **Abstract section special**: emit \`\\begin{abstract}...\\end{abstract}\` (no \\section).

★ **Declarations section** (PRISMA 24-27): emit \`\\section*{Declarations}\` (unnumbered),
   then \`\\subsection*{Funding}\` / \`\\subsection*{Competing interests}\` / etc. for each \`##\` sub-block.

### Step 4 — Handle table placeholders ([tbl:*])

When you see \`[tbl:<key>]\` in a section's markdown:

1. \`Read tables/<key>.md\` — this contains the **real table data** (rows, columns)
2. Convert the table's GFM markdown into a LaTeX \`tabular\` environment, preserving:
   - All rows (do NOT truncate to 2-row "summary" stubs — copy every data row faithfully)
   - Column alignment (\`l\` / \`c\` / \`r\` — use \`l\` for prose-heavy columns, \`r\` for numeric, \`c\` for short codes)
   - Header row separator with \`\\hline\` or booktabs \`\\toprule\` / \`\\midrule\` / \`\\bottomrule\` if \`booktabs\` is in preamble

3. **★ MANDATORY ANTI-OVERFLOW WRAPPING — apply ONE of these patterns based on column count:**

   **(A) Tables with ≤ 4 narrow columns** (key-value pairs, short codes, etc.) — emit as-is:
   \`\`\`latex
   \\begin{table}[!htbp]\\centering
     \\caption{...}\\label{tab:<key>}
     \\begin{tabular}{ll}
       \\hline ... \\hline
     \\end{tabular}
   \\end{table}
   \`\`\`

   **(B) Tables with 5+ columns OR any prose-heavy cell (>30 chars typical):**
   wrap the \`tabular\` in \`\\resizebox\` AND use \`\\small\` font, AND prefer \`p{...}\` columns
   for prose to allow word-wrap:
   \`\`\`latex
   \\begin{table}[!htbp]\\centering\\small
     \\caption{...}\\label{tab:<key>}
     \\resizebox{\\textwidth}{!}{%
       \\begin{tabular}{lp{3cm}p{4cm}rr}
         \\hline ... \\hline
       \\end{tabular}%
     }
   \\end{table}
   \`\`\`
   - \`\\resizebox{\\textwidth}{!}{...}\` scales the WHOLE tabular to exactly textwidth (height auto-scales)
   - The \`%\` after \`{\` and before \`}\` suppresses spurious spaces — keep them
   - \`p{3cm}\` (paragraph column with fixed width) lets long prose cells wrap onto multiple lines instead of overflowing right
   - Use \`p{Xcm}\` widths that sum roughly to \`\\textwidth - (number-of-l/r-cols * 1cm)\` — typical: 4-5 prose cols × 2.5–3.5cm

   **(C) Very tall tables (40+ rows)** — use \`longtable\` IF the template's preamble has \`\\usepackage{longtable}\`:
   \`\`\`latex
   \\begin{longtable}{lp{3cm}p{4cm}rr}
     \\caption{...}\\label{tab:<key>}\\\\
     \\hline Header row \\hline\\endfirsthead
     \\hline Header row (cont.) \\hline\\endhead
     ... data rows ...
     \\hline
   \\end{longtable}
   \`\`\`
   (NOT inside \`\\begin{table}\` — longtable IS a float-equivalent that spans pages.)

   **(D) Two-column journal layout + table needs to span both columns:**
   \`\`\`latex
   \\begin{table*}[!htbp]\\centering ... \\end{table*}
   \`\`\`
   (Use \`table*\` instead of \`table\`. Common for results / characteristics tables.)

4. Replace \`[tbl:<key>]\` in the section text with \`\\ref{tab:<key>}\` (or \`Table~\\ref{tab:<key>}\` for prose flow)
5. **★ PLACEMENT — IN-LINE, NOT END-OF-PAPER:** emit the \`\\begin{table}\` environment **right where the FIRST \`[tbl:<key>]\` reference appears in the section prose**. LaTeX will float it to the nearest convenient position (typically the top/bottom of the same or next page). DO NOT batch tables at the end of the document.
6. **Each table env is emitted EXACTLY ONCE** — at the first reference. Subsequent references in the same or other sections just use \`\\ref{tab:<key>}\` (no duplicate env).
7. **Default to pattern (B) when in doubt** — \`\\resizebox{\\textwidth}{!}\` + \`\\small\` will rescue almost any wide / dense table from overflowing the page margin.

8. **★ Multi-part tables with sub-section headers (CRITICAL — avoid double-numbering):**

   When \`tables/<key>.md\` contains multiple \`### Table Xa. ...\` / \`### Table Xb. ...\` / \`#### <sub-title>\` sub-headings (e.g. one logical table broken into per-theme sub-tables), do **NOT** emit one \`\\begin{table}\` per sub-heading. Instead:

   - Emit ONE \`\\begin{longtable}\` (or \`\\begin{table}\` with one inner \`tabular\`) for the WHOLE logical table — there is ONE \`\\label{tab:<key>}\` and LaTeX assigns ONE auto-number.
   - Convert each sub-heading to an in-table divider row: \`\\multicolumn{<N>}{l}{\\textbf{<description>}}\\\\\` placed between the data rows.
   - **★ STRIP the "Table Xa." / "Table Xb." prefix from the divider text** — keep only the description after the period. The whole multi-part table has ONE LaTeX number (e.g. Table 4); the divider must NOT say "Table 1e" or the user sees TWO conflicting numbers ("Table 4 continued" header + "Table 1e" divider) in the rendered PDF.

   Source markdown (in \`tables/table1.md\`):
   \`\`\`
   ### Table 1a. Characteristics of studies in theme: GenAI as Metacognitive Scaffold (N=14)
   | Study | ... |
   | ... | ... |

   ### Table 1b. Characteristics of studies in theme: GenAI as Co-Designer (N=22)
   | Study | ... |
   \`\`\`

   ✅ Correct LaTeX (single longtable, divider rows STRIPPED of "Table 1X." prefix):
   \`\`\`latex
   \\begin{longtable}{p{3cm}p{2cm}...}
     \\caption{Characteristics of included studies organised by theme.}\\label{tab:table1}\\\\
     \\hline Study & ... \\\\\\hline\\endfirsthead
     \\multicolumn{6}{l}{\\emph{Table~\\ref{tab:table1} (continued)}}\\\\
     \\hline Study & ... \\\\\\hline\\endhead
     \\hline\\endfoot

     \\multicolumn{6}{l}{\\textbf{Theme T1: GenAI as Metacognitive Scaffold ($N=14$)}}\\\\
     ... data rows for theme T1 ...

     \\multicolumn{6}{l}{\\textbf{Theme T2: GenAI as Co-Designer ($N=22$)}}\\\\
     ... data rows for theme T2 ...
   \\end{longtable}
   \`\`\`

   ❌ WRONG (don't do this — divider keeps "Table 1a/1b" prefix, clashes with LaTeX numbering):
   \`\`\`latex
     \\multicolumn{6}{l}{\\textbf{Table 1a. GenAI as Metacognitive Scaffold ($N=14$)}}\\\\
     \\multicolumn{6}{l}{\\textbf{Table 1b. GenAI as Co-Designer ($N=22$)}}\\\\
   \`\`\`

   ❌ ALSO WRONG (don't emit one \`\\begin{table}\` per sub-heading — that gives each its own LaTeX number, breaking [tbl:table1] reference):
   \`\`\`latex
   \\begin{table}\\caption{...Table 1a...}\\label{tab:table1a}...\\end{table}
   \\begin{table}\\caption{...Table 1b...}\\label{tab:table1b}...\\end{table}
   \`\`\`

9. **If \`tables/foo.md\` does NOT exist** for a \`[tbl:foo]\` reference, emit \`\\textit{[unresolved table: foo]}\` + \`% TODO: missing table data\` comment — DO NOT fabricate.

Available tables (read these — they have real rows):
${tableListMd}

### Step 5 — Handle figure placeholders ([fig:*])

When you see \`[fig:<id>]\` in a section's markdown:

1. The image is in \`figures/\` — check the manifest below for filename
2. **★ MANDATORY \\includegraphics OPTIONS — always include all three:**
   \`\`\`latex
   \\includegraphics[width=\\linewidth,height=0.85\\textheight,keepaspectratio]{figures/<filename>}
   \`\`\`
   - \`width=\\linewidth\` caps the horizontal size at the column / text width (no left-right overflow)
   - \`height=0.85\\textheight\` caps the vertical size at 85% of the page height (no overflow past the bottom margin — leaves room for caption)
   - \`keepaspectratio\` preserves the image's native aspect ratio when both width and height are constrained — pdflatex picks whichever bound binds first and scales the other proportionally
   - **NEVER** emit \`\\includegraphics{figures/foo.png}\` with no options — a tall image will overflow the page
3. Full figure environment template:
   \`\`\`latex
   \\begin{figure}[!htbp]\\centering
     \\includegraphics[width=\\linewidth,height=0.85\\textheight,keepaspectratio]{figures/<filename>}
     \\caption{...}\\label{fig:<id>}
   \\end{figure}
   \`\`\`
4. **★ FIGURE PATH — ALWAYS \`figures/<filename>\` (NO \`../\` PREFIX).**
   You are writing \`out/main.tex\` here, but at LaTeX compile time \`main.tex\` is
   RELOCATED to a flat directory where \`figures/\` is a direct sibling. Use the
   path \`figures/foo.png\` — **never** \`../figures/foo.png\` or any other
   relative-to-here path. The runner depends on this exact relative form.
5. **★ PLACEMENT — IN-LINE, NOT END-OF-PAPER:** emit the \`\\begin{figure}\` environment **right where the FIRST \`[fig:<id>]\` reference appears in the section prose**. LaTeX will float it near that position. DO NOT batch figures into a \`\\section*{Figure captions}\` at the end of the document.
6. **Each figure env is emitted EXACTLY ONCE** — at the first reference. Subsequent references just use \`\\ref{fig:<id>}\`.
7. **Two-column journal layout + wide figure:** use \`\\begin{figure*}\` (full-page-width float) instead of \`\\begin{figure}\`. The mandatory options stay the same.
8. Replace \`[fig:<id>]\` in section text with \`\\ref{fig:<id>}\` (or \`Figure~\\ref{fig:<id>}\` for prose flow).
9. \`[fig:prisma]\` is a special placeholder for the PRISMA flow diagram — try \`figures/prisma.pdf\`. If missing, emit \`\\textit{[unresolved figure: prisma]}\` + \`% TODO\` comment.

Available figures:
${figListMd}

### Step 5.5 — Frontiers-style "Figure captions" / "Tables" placeholder sections

Some templates (e.g. Frontiers) put empty \`\\section*{Figure captions}\` and
\`\\section*{Tables}\` placeholder sections after the bibliography. These are a
**submission-system artefact** for the publisher's typesetters — they instruct
the AUTHOR where to put separated figure/table material for the journal's
production workflow.

**For a render-to-PDF preview, IGNORE these placeholder sections** — you have
already inlined the figures and tables in Steps 4-5. **Do NOT** re-emit a
\`\\section*{Figure captions}\` or \`\\section*{Tables}\` block at the end of
\`out/main.tex\`. The PDF should read with figures/tables appearing near their
first reference, not as a back-matter dump.

### Step 6 — Close the document
After all sections appended, write the bibliography commands and \`\\end{document}\`:
\`\`\`latex
\\bibliographystyle{${bibStyle}}
\\bibliography{references}
\\end{document}
\`\`\`

(Skip \\bibliographystyle if the template's preamble already sets it, or if template uses biblatex/\\printbibliography — check Step 1.)

### Step 7 — Self-check
\`\`\`
Read out/main.tex                                       # re-read final output
Grep -n "\\[tbl:" out/main.tex                          # MUST return 0 matches (all converted to \\ref)
Grep -n "\\[fig:" out/main.tex                          # MUST return 0 matches
Grep -n "\\[rec_" out/main.tex                          # MUST return 0 matches (all converted to \\citep{})
Grep -n "section\\*{Figure captions}" out/main.tex      # MUST return 0 (no back-matter figure dump)
Grep -n "section\\*{Tables}" out/main.tex               # MUST return 0 (no back-matter table dump)
Grep -n "\\.\\./figures" out/main.tex                   # MUST return 0 (use figures/foo.png, NOT ../figures/foo.png)
\`\`\`

Additionally verify EVERY figure and table is in a proper float environment:
- Every \`\\includegraphics\` line must be inside a \`\\begin{figure}...\\end{figure}\`
  (or \`\\begin{figure*}\`) block — never naked in prose.
- Every \`\\begin{tabular}\` must be inside a \`\\begin{table}...\\end{table}\`
  (or \`\\begin{table*}\` / \`\\begin{longtable}\`) block — never naked in prose.
- Every emitted float MUST have a \`\\caption{...}\` and a \`\\label{tab:...}\` or \`\\label{fig:...}\`.
- Every in-text reference uses \`\\ref{tab:...}\` / \`\\ref{fig:...}\` — never literal "Table 3" or "Fig. 1" strings.

Also verify: each \`\\label{tab:...}\` / \`\\label{fig:...}\` appears exactly once
in the document (one env per table/figure; in-text mentions use \`\\ref\`).

If anything is wrong, **Edit** to fix it. The whole point of this approach is that you can iterate.

---

## Markdown → LaTeX conversion rules

| Markdown | LaTeX |
|---|---|
| \`#\` heading (rare in section files) | \`\\section{...}\` |
| \`##\` heading | \`\\subsection{...}\` (or \`\\subsection*{}\` if template uses unnumbered) |
| \`###\` heading | \`\\subsubsection{...}\` |
| \`**bold**\` | \`\\textbf{bold}\` |
| \`*italic*\` or \`_italic_\` | \`\\emph{italic}\` |
| inline \`code\` | \`\\texttt{code}\` |
| GFM table (in section .md, rare) | \`\\begin{table}\\begin{tabular}{...}...\\end{tabular}\\end{table}\` |
| bulleted list (\`- item\`) | \`\\begin{itemize}\\item ...\\end{itemize}\` |
| numbered list (\`1. item\`) | \`\\begin{enumerate}\\item ...\\end{enumerate}\` |
| \`[rec_xxx]\` placeholder | \`\\citep{rec_xxx}\` (use \\citet{} only when prose reads "Smith et al. (2024) showed...") |
| \`[tbl:key]\` placeholder | \`\\ref{tab:key}\` in-text + emit matching table env (see Step 4) |
| \`[fig:id]\` placeholder | \`\\ref{fig:id}\` in-text + emit matching figure env (see Step 5) |

### LaTeX escaping in prose

\`&\` → \`\\&\` / \`%\` → \`\\%\` / \`#\` → \`\\#\` / \`_\` → \`\\_\` / \`$\` → \`\\$\` / \`{\` → \`\\{\` / \`}\` → \`\\}\`

(Do NOT escape characters that are already inside \\verb / verbatim / your converted commands.)

---

## Available data summary

- **Section files**: ${sectionFilenames.length} markdown files in \`sections/\`
- **Data tables**: ${tableManifest.length} markdown tables in \`tables/\` (READ EACH ONE that's referenced via [tbl:*])
- **Figures**: ${figuresCount} assets in \`figures/\`
- **Citable papers**: ${citablePapersCount} (every \\citep{rec_xxx} must use an id from references.bib)
${hasCitationMap ? '- **citation-map.json**: rec_id → "Author, Year" mapping' : ''}
${hasOverlay ? '- **overlay.json**: Project-specific LaTeX-fill guidance — READ THIS FIRST. Takes precedence over generic rules above.' : ''}
- **Citation style**: ${citationStyle}
- **LaTeX bibliography style**: ${bibStyle}

---

## Hard constraints (do not violate)

1. **\`out/main.tex\` MUST exist** after you finish — that's how the runner detects success.
2. **Process EVERY section file in \`sections/\`** — do NOT skip any. If a file exists, you must include its content.
3. **Preserve template preamble verbatim** — do not delete \`\\usepackage{}\`, do not change \`\\documentclass{}\`, do not modify hyperref.
4. **Do NOT leave bare \`[tbl:xxx]\` / \`[fig:xxx]\` / \`[rec_xxx]\`** in out/main.tex — LaTeX parses \`[..]\` as optional arg, compilation breaks.
5. **Do NOT fabricate table data** — if \`[tbl:key]\` is referenced, Read the actual \`tables/key.md\` and copy ALL its rows. Never emit a 2-row stub with "Field | Value | ... 117 | ..." style — that destroys the manuscript's evidence value.
6. **English only** in the LaTeX output (skip / placeholder any non-Latin fragments).
7. **Do not invent \\cite keys** — every \`\\citep{rec_xxx}\` must use an id present in \`references.bib\`.
8. **Figures and tables INLINE, not end-of-paper.** Each \`\\begin{figure}\` / \`\\begin{table}\` env must appear at the FIRST reference point in the section prose. DO NOT emit \`\\section*{Figure captions}\` or \`\\section*{Tables}\` back-matter dump sections — that destroys reading flow. (Frontiers-style templates ship those as submission-only placeholders; ignore them for the rendered PDF.)
9. **No duplicate table/figure environments.** Each \`tab:<key>\` / \`fig:<id>\` label may appear in ONE \`\\begin{table}\` / \`\\begin{figure}\` env only. All other in-text mentions use \`\\ref{}\` to point at that single emitted env.
10. **Figure paths MUST be \`figures/<filename>\`** — no \`../\`, no absolute paths. Same for any other asset references (\`template/...\` files are read-only inputs, never referenced from main.tex). The compiled main.tex runs in a flat directory where \`figures/\` is a sibling.
11. **★ NO BARE \`\\includegraphics\` OR \`\\begin{tabular}\` IN BODY TEXT.** Every figure asset MUST be wrapped in a \`\\begin{figure}...\\end{figure}\` (or \`\\begin{figure*}\`) float with \`\\caption\` + \`\\label\`. Every data table MUST be wrapped in \`\\begin{table}...\\end{table}\` (or \`\\begin{table*}\` / \`\\begin{longtable}\`) with \`\\caption\` + \`\\label\`. **Never** drop a raw \`\\includegraphics\` directly inside a paragraph — that produces an un-numbered, un-captioned, un-referenceable image. Same for raw \`\\begin{tabular}\`.
12. **Every in-text reference to a figure / table uses \`\\ref{}\`** — never write literal "Figure 1", "Table 3", "Fig 5", etc. Always \`Figure~\\ref{fig:<id>}\` / \`Table~\\ref{tab:<key>}\` so LaTeX renumbers automatically and the cross-references survive section reordering.

---

## When done

Reply with one line:
\`\`\`
DONE — wrote out/main.tex (<N> chars)
\`\`\`

If you encounter an unrecoverable problem, write the partial output anyway and reply:
\`\`\`
PARTIAL — wrote out/main.tex (<N> chars) — issue: <one-sentence explanation>
\`\`\`
`
}

