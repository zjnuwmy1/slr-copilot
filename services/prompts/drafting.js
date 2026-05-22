/**
 * Drafting — 综述初稿章节写作。
 *
 * 落地自用户设计文档 Prompt 6(章节起草)+ 7(整文组装的引用一致性约束)。
 *
 * 每个章节单独跑一次 LLM,因为:
 *  1) 上下文不同(intro 不需要 evidence matrix,results 需要;methods 需要 PRISMA flow);
 *  2) 单次 8K maxTokens 才够中文 + 引用占位的体量;
 *  3) 失败可单独重试。
 *
 * 写作约束:
 *  - 每个事实性陈述后面带 `[record_id]` 占位符,例:
 *    "端到端学习在内窥镜分割任务上准确率比传统方法高 5-8 个百分点 [rec_abc123]。"
 *  - LLM 同时返回 citation_map,把 placeholder 映射回 record_id。
 *  - References 章节**不走 LLM**,由调用方用 exportReferencesSection 生成。
 */

// ============================================================
// 共用约束:每个 system message 都拼接
// ============================================================

const COMMON_RULES = `
通用约束:
1. **输出严格 JSON**,字段:
   {
     "content_markdown": "用 Markdown 写的章节正文(中文为主,英文术语括号注)",
     "citation_map": [
       { "placeholder": "[rec_abc123]", "paper_id": "rec_abc123" }
     ]
   }

2. **引用规则(最关键,务必遵守)**:
   - 每一个具体的事实性陈述、数字、结论后面必须带 \`[record_id]\` 占位符。
   - record_id 必须来自用户给你的"可引用论文列表",**不要编造**、不要写论文标题。
   - 多篇支持时写成 \`[rec_a, rec_b, rec_c]\`(同一对方括号内,逗号分隔)。
   - citation_map 列出**正文出现过的所有 placeholder**,每条 {placeholder, paper_id}。
     一个 placeholder 可能映射多条 paper_id,这种情况就一条 paper_id 一行,placeholder 字段相同。
   - 不要用 [1] / [2] 这种 IEEE 编号,引用层会在导出时统一转编号。
   - 总览类语句、综述方法本身、过渡句不需要引用。

3. **语言**:中文为主,术语第一次出现时英文括号注一次。
   不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股套话。
   不要"探究 / 探讨 / 旨在 / 拟"这类八股开头。

4. **Markdown 格式**:
   - 用 \`##\` 作为章节大标题,\`###\` 作为小节。
   - 段落之间空一行。
   - 列表用 \`-\`。
   - 表格用 GFM 风格(\`| 列 | 列 |\` + 分隔行)。
   - 不要在 content_markdown 里放 References 章节(那是单独导出的)。

5. **只输出 JSON**,不要前后加解释、不要代码围栏(\`\`\`json ... \`\`\`)。
`

// ============================================================
// 每个章节的特化 system message
// ============================================================

export const SECTION_SYSTEMS = {
  title: `你是系统性文献综述方法学专家。任务:基于研究主题、研究问题、主题聚类,
给本篇综述起一个准确、可检索的中文标题(可选英文副标题)。
${COMMON_RULES}

特别要求(title):
- content_markdown 只放一行 Markdown 一级标题(\`# 标题\`),不要别的内容。
- 中文标题 12-30 字,体现"系统综述"或"综述"二字。
- 可在中文标题下方加一行英文标题(无引用)。
- citation_map 给空数组(标题不带引用)。
- 不要用副标题之外的修辞、不要疑问句。
`,

  abstract: `你是系统性文献综述方法学专家,精通结构化摘要(PRISMA Abstract 2020 项 #2)。
任务:写 250-350 字的结构化中文摘要,涵盖背景、方法、结果、讨论、结论。
${COMMON_RULES}

特别要求(abstract):
- content_markdown 用 \`## Abstract\` 作大标题,下方分段(背景 / 方法 / 结果 / 讨论 / 结论 各 1-2 句)。
- 用 \`**背景**:...\` 这种粗体引导分段,不要用单独的 \`###\` 小标题。
- 摘要里需要引用具体研究的地方加 \`[record_id]\`,但整体偏概括,引用数 ≤ 6 个。
- 给出 3-6 个英文关键词,放在末尾一行:\`**Keywords**: keyword1; keyword2; ...\`(关键词部分无需引用)。
`,

  introduction: `你是系统性文献综述方法学专家。任务:写综述的引言(Introduction)。
${COMMON_RULES}

特别要求(introduction):
- content_markdown 以 \`## Introduction\` 开头。
- 三段结构:
  1) 研究背景(为什么这个主题重要,引用 3-6 篇关键论文)
  2) 现有研究的空白 / 局限(引用 2-5 篇说明已做了什么、还缺什么)
  3) 本综述的研究问题(把 RQ 转成自然语言陈述,1-2 句话总结)
- 总长 400-700 字。
`,

  methods: `你是系统性文献综述方法学专家,精通 PRISMA 2020。任务:写综述的方法学章节。
${COMMON_RULES}

特别要求(methods):
- content_markdown 以 \`## Methods\` 开头,下分:
  - \`### 检索策略\` — 引用项目里实际用到的数据库 + 检索式版本
  - \`### 纳排标准\` — 列出 inclusion / exclusion criteria
  - \`### 筛选与抽取流程\` — 描述 title/abstract 筛 → full-text 评估 → 数据抽取的流程
  - \`### 综合方法\` — 简述本次用了主题聚类(thematic synthesis)而非 Meta 分析
- methods 章节**通常不需要引用**(它描述本综述自己的做法),citation_map 给空数组或极少。
- 总长 300-500 字。
`,

  results: `你是系统性文献综述方法学专家。任务:基于"主题聚类 + Evidence Matrix",写综述的结果章节。
${COMMON_RULES}

特别要求(results):
- content_markdown 以 \`## Results\` 开头。
- 第一段总览:纳入 N 篇研究、覆盖的研究类型 / 年份范围 / 地区(基于用户给的 PRISMA 计数,这部分**不需要引用**)。
- 接下来按主题(themes)分小节,每个主题:
  - \`### 主题名\`
  - 描述这个主题下论文的一致结论(每条带 \`[record_id]\`)
  - 矛盾结论(如果有)用 "然而,X 论文报告..."(带引用)
  - 1-2 句小结
- 总长 800-1500 字。引用密度大(每段 2-6 个引用占位)。
- **所有具体的数字 / 性能比较 / 实验结论必带引用**。
`,

  discussion: `你是系统性文献综述方法学专家。任务:写综述的讨论章节。
${COMMON_RULES}

特别要求(discussion):
- content_markdown 以 \`## Discussion\` 开头。
- 三个子节:
  - \`### 主要发现\` — 把 results 的 themes 抽象成 2-4 条核心结论(引用支持论文)
  - \`### 证据空白\` — 基于 evidence_gaps 谈现有研究的局限(引用 2-4 篇代表性研究)
  - \`### 对实践和未来研究的启示\` — 不需要密集引用,1-2 段话
- 总长 500-900 字。
- 区别于 results:discussion 是"解释为什么",不是"罗列谁说了什么"。
`,

  limitations: `你是系统性文献综述方法学专家。任务:写综述的局限性(Limitations)章节。
${COMMON_RULES}

特别要求(limitations):
- content_markdown 以 \`## Limitations\` 开头。
- 两个角度:
  1) 本综述自身的局限(检索时间窗 / 语言限定 / 灰色文献 / 单审查者偏倚等,**通常不需引用**)
  2) 纳入研究的整体方法学局限(样本量 / 异质性 / 评估指标不统一,可引用 2-3 篇代表)
- 总长 200-400 字。
`,

  conclusion: `你是系统性文献综述方法学专家。任务:写综述的结论(Conclusion)。
${COMMON_RULES}

特别要求(conclusion):
- content_markdown 以 \`## Conclusion\` 开头。
- 单段 100-200 字。
- 不引入新观点,把 discussion 的核心结论凝练成 3-5 句。
- 末尾一句话给"未来研究建议"。
- 引用 0-3 个,只用于支撑最关键的论断。
`,
}

/**
 * 给定章节名,返回对应的 system message;不存在则返回 null。
 */
export function getSectionSystem(section) {
  return SECTION_SYSTEMS[section] || null
}

/**
 * Phase 9 Agent W:把"目标期刊模板"约束拼到 system message 末尾。
 *
 * 调用方:`routes/projects/report.js` 在 runLlm 之前用这个函数包装 system。
 * 若 styleHint 为空字符串/null,直接返回原 system(零回归)。
 *
 * @param {string} system    原 SECTION_SYSTEMS[section] 内容
 * @param {string|null} styleHint  来自 journal-template 的 buildSectionStyleHint() 输出
 * @returns {string} 拼接后的 system
 */
export function augmentSystemWithTemplate(system, styleHint) {
  if (!system) return system
  if (!styleHint || typeof styleHint !== 'string' || !styleHint.trim()) return system
  return system + '\n\n' + styleHint.trim() + '\n'
}

/**
 * 标准 9 章节顺序(References 不在这里,导出时单独拼)。
 */
export const SECTION_ORDER = [
  'title',
  'abstract',
  'introduction',
  'methods',
  'results',
  'discussion',
  'limitations',
  'conclusion',
]

export const SECTION_LABELS = {
  title:        '题目(Title)',
  abstract:     '摘要(Abstract)',
  introduction: '引言(Introduction)',
  methods:      '方法(Methods)',
  results:      '结果(Results)',
  discussion:   '讨论(Discussion)',
  limitations:  '局限(Limitations)',
  conclusion:   '结论(Conclusion)',
  references:   '参考文献(References)',
}

/**
 * 构造每个章节的 user prompt。
 *
 * @param {object} args
 * @param {string} args.section
 * @param {object} args.project        含 title, topic, discipline, year_start, year_end, databases 等
 * @param {object|null} args.protocol  含 research_questions, inclusion_criteria, exclusion_criteria
 * @param {Array}  args.themes         normalize 后的 themes,含 supporting_record_ids
 * @param {Array}  args.evidencePoints 可引用的 finding 列表 [{record_id, finding, section, ...}]
 * @param {object|null} args.prismaCounts PRISMA flow 数字
 * @param {Array}  args.citableRecords 可引用论文列表 [{record_id, short_label}]  ← LLM 用 record_id 引用
 * @param {Array}  args.searchStrategies 已用的检索式(给 methods 用)
 */
export function buildSectionUserPrompt({
  section,
  project = {},
  protocol = null,
  themes = [],
  evidencePoints = [],
  prismaCounts = null,
  citableRecords = [],
  searchStrategies = [],
}) {
  const lines = [`请为系统综述撰写 **${section}** 章节。`, '']

  // 项目基础信息
  lines.push('===== 项目信息 =====')
  if (project.title) lines.push(`项目标题: ${project.title}`)
  if (project.topic) lines.push(`研究主题: ${project.topic}`)
  if (project.discipline) lines.push(`学科: ${project.discipline}`)
  if (project.goal) lines.push(`研究目标: ${project.goal}`)
  if (project.year_start || project.year_end) {
    lines.push(`时间范围: ${project.year_start || '不限'} - ${project.year_end || '不限'}`)
  }
  if (Array.isArray(project.databases) && project.databases.length) {
    lines.push(`检索数据库: ${project.databases.join(', ')}`)
  }

  // 协议
  if (protocol) {
    lines.push('')
    lines.push('===== 已审批协议 =====')
    if (Array.isArray(protocol.research_questions) && protocol.research_questions.length) {
      lines.push('研究问题:')
      protocol.research_questions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
    }
    if (['methods', 'introduction', 'abstract'].includes(section)) {
      if (Array.isArray(protocol.inclusion_criteria) && protocol.inclusion_criteria.length) {
        lines.push('纳入标准:')
        protocol.inclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
      }
      if (Array.isArray(protocol.exclusion_criteria) && protocol.exclusion_criteria.length) {
        lines.push('排除标准:')
        protocol.exclusion_criteria.forEach((c) => lines.push(`  - ${c}`))
      }
    }
  }

  // PRISMA 计数(主要给 methods / results / abstract 用)
  if (prismaCounts && ['methods', 'results', 'abstract'].includes(section)) {
    lines.push('')
    lines.push('===== PRISMA Flow 计数(由系统精确计算,直接引用) =====')
    lines.push(`检索命中(去重前): ${formatRecordsIdentified(prismaCounts.records_identified)}`)
    lines.push(`去重移除: ${prismaCounts.duplicates_removed ?? 0}`)
    lines.push(`待筛选(去重后): ${prismaCounts.records_screened ?? 0}`)
    lines.push(`标题/摘要排除: ${prismaCounts.excluded_title_abstract ?? 0}`)
    lines.push(`全文评估: ${prismaCounts.full_text_assessed ?? 0}`)
    lines.push(`全文排除: ${prismaCounts.full_text_excluded ?? 0}`)
    lines.push(`最终纳入: ${prismaCounts.studies_included ?? 0}`)
  }

  // 检索式(methods 用)
  if (section === 'methods' && searchStrategies.length) {
    lines.push('')
    lines.push('===== 已使用的检索式 =====')
    for (const s of searchStrategies.slice(0, 9)) {
      lines.push(`- [${s.database_name} / ${s.query_type}] 命中 ${s.result_count ?? '未记录'} 条`)
    }
  }

  // Themes + Evidence(results / discussion / limitations / conclusion 用)
  if (['results', 'discussion', 'limitations', 'conclusion', 'abstract', 'introduction'].includes(section)) {
    if (themes.length) {
      lines.push('')
      lines.push('===== 主题聚类(Themes) =====')
      themes.forEach((t, i) => {
        lines.push('')
        lines.push(`主题 ${i + 1}: ${t.name}`)
        if (t.description) lines.push(`描述: ${t.description}`)
        if (t.evidence_strength) lines.push(`证据强度: ${t.evidence_strength}`)
        const ids = Array.isArray(t.supporting_record_ids) ? t.supporting_record_ids : []
        if (ids.length) lines.push(`支持论文 record_id: ${ids.join(', ')}`)
        if (Array.isArray(t.consistent_findings) && t.consistent_findings.length) {
          lines.push('一致结论:')
          t.consistent_findings.forEach((f) => lines.push(`  - ${f}`))
        }
        if (Array.isArray(t.conflicting_findings) && t.conflicting_findings.length) {
          lines.push('矛盾结论:')
          t.conflicting_findings.forEach((f) => lines.push(`  - ${f}`))
        }
        if (Array.isArray(t.evidence_gaps) && t.evidence_gaps.length) {
          lines.push('证据空白:')
          t.evidence_gaps.forEach((f) => lines.push(`  - ${f}`))
        }
      })
    }

    if (evidencePoints.length && ['results', 'discussion'].includes(section)) {
      lines.push('')
      lines.push('===== 重点 finding(可在正文引用) =====')
      // 限制条数:前 60 条
      evidencePoints.slice(0, 60).forEach((ep) => {
        const tag = ep.strength ? `[${ep.strength}]` : ''
        lines.push(`- ${tag} ${ep.finding} (record_id: ${ep.record_id}${ep.section ? ', section=' + ep.section : ''})`)
      })
    }
  }

  // 可引用论文列表 — 这是引用合法性的来源
  if (citableRecords.length) {
    lines.push('')
    lines.push('===== 可引用论文列表(引用时必须用这些 record_id) =====')
    citableRecords.forEach((r) => {
      lines.push(`  ${r.record_id}: ${r.short_label || ''}`)
    })
  }

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出本章节。')
  lines.push('记住:正文里的 [record_id] 必须来自上面的"可引用论文列表",绝对不要编造。')
  return lines.join('\n')
}

/**
 * 格式化 records_identified:可能是数字,也可能是 { wos:N, scopus:N, ...other:N }
 */
function formatRecordsIdentified(v) {
  if (v == null) return '0'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const parts = []
    let total = 0
    for (const [k, n] of Object.entries(v)) {
      if (typeof n !== 'number') continue
      total += n
      parts.push(`${k}=${n}`)
    }
    return parts.length ? `${total}(${parts.join(', ')})` : '0'
  }
  return String(v)
}

// ============================================================
// 输出 normalize
// ============================================================

/**
 * 把 LLM 输出 normalize 成可入库的结构。
 *
 * @param {any} raw   LLM 解析后的 JSON
 * @param {object} ctx
 * @param {Set<string>|string[]|null} ctx.knownRecordIds  citation_map 强校验:placeholder→paper_id 必须在这个集合里
 * @returns {{ content_markdown: string, citation_map: Array<{placeholder, paper_id}>, citation_issues: string[] }}
 */
export function normalizeSectionOutput(raw, { knownRecordIds = null } = {}) {
  const empty = { content_markdown: '', citation_map: [], citation_issues: [] }
  if (!raw || typeof raw !== 'object') return empty

  raw = unwrapOne(raw)
  raw = unwrapOne(raw)

  // content_markdown
  let content =
    typeof raw.content_markdown === 'string'
      ? raw.content_markdown
      : typeof raw.content === 'string'
        ? raw.content
        : typeof raw.markdown === 'string'
          ? raw.markdown
          : typeof raw.text === 'string'
            ? raw.text
            : ''

  content = String(content || '').trim()

  // citation_map
  const known = knownRecordIds
    ? (knownRecordIds instanceof Set ? knownRecordIds : new Set(knownRecordIds))
    : null

  const rawMap = Array.isArray(raw.citation_map) ? raw.citation_map
    : Array.isArray(raw.citations) ? raw.citations
    : Array.isArray(raw.citationMap) ? raw.citationMap
    : []

  const citationMap = []
  const issues = []
  const seenPair = new Set()

  for (const entry of rawMap) {
    if (!entry || typeof entry !== 'object') continue
    const placeholder = typeof entry.placeholder === 'string' ? entry.placeholder.trim() : ''
    let paperIds = []
    if (typeof entry.paper_id === 'string') paperIds = [entry.paper_id.trim()]
    else if (Array.isArray(entry.paper_id)) paperIds = entry.paper_id.filter((x) => typeof x === 'string')
    else if (typeof entry.record_id === 'string') paperIds = [entry.record_id.trim()]
    else if (Array.isArray(entry.record_ids)) paperIds = entry.record_ids.filter((x) => typeof x === 'string')

    if (!placeholder || paperIds.length === 0) continue

    for (const pid of paperIds) {
      const p = (pid || '').trim()
      if (!p) continue
      if (known && !known.has(p)) {
        issues.push(`paper_id 不在已知论文集合: ${p}`)
        continue
      }
      const key = placeholder + '|' + p
      if (seenPair.has(key)) continue
      seenPair.add(key)
      citationMap.push({ placeholder, paper_id: p })
    }
  }

  // 反向校验:正文里所有 [xxx] 占位是否都在 citation_map 里 — 抽取一下,找漏报
  if (content && known) {
    const placeholdersInText = extractPlaceholdersFromMarkdown(content)
    const mappedPlaceholders = new Set(citationMap.map((c) => c.placeholder))
    // 如果 placeholder 在 citation_map 里出现过则 OK;否则补一条(只补合法的 record_id)
    for (const ph of placeholdersInText) {
      if (mappedPlaceholders.has(ph)) continue
      // 尝试从 placeholder 内部把 record_id 提出来,如果 known 包含就补
      const inner = ph.replace(/^\[/, '').replace(/\]$/, '')
      const ids = inner.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
      const legitIds = ids.filter((id) => known.has(id))
      if (legitIds.length) {
        for (const id of legitIds) {
          const key = ph + '|' + id
          if (seenPair.has(key)) continue
          seenPair.add(key)
          citationMap.push({ placeholder: ph, paper_id: id })
        }
      } else {
        issues.push(`正文有占位 ${ph},但 citation_map 未声明且不含已知 record_id`)
      }
    }
  }

  return { content_markdown: content, citation_map: citationMap, citation_issues: issues }
}

/**
 * 从 markdown 文本里提取 [record_id] / [id1, id2] 风格的占位。
 * 简化:匹配 `\[ ... \]`,只取里面看起来像 record_id 的(字母+数字+下划线/连字符)。
 */
export function extractPlaceholdersFromMarkdown(md) {
  if (typeof md !== 'string' || !md) return []
  const out = new Set()
  // 简单贪婪:形如 [xxx] 或 [a, b, c]
  const re = /\[([a-zA-Z][a-zA-Z0-9_\-,\s]+)\]/g
  let m
  while ((m = re.exec(md)) !== null) {
    const inner = m[1]
    // 跳过 markdown 链接的 anchor 文字部分 → 通过紧跟的 ( 检测
    const next = md[m.index + m[0].length]
    if (next === '(') continue
    // 必须看起来像 record_id:含字母 + 数字 / 下划线
    if (!/[a-zA-Z]/.test(inner)) continue
    if (!/\d|_|-/.test(inner)) continue
    out.add('[' + inner + ']')
  }
  return Array.from(out)
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  const hasTop = keys.some((k) => /^(content_markdown|content|markdown|citation_map|citations)$/i.test(k))
  if (hasTop) return raw
  for (const k of keys) {
    if (/^(result|output|data|response|section)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object') return v
    }
  }
  return raw
}
