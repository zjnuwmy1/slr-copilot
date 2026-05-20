/**
 * Synthesis — 把多篇论文的 verified extractions 聚成主题 + evidence matrix。
 *
 * 落地自用户设计文档 Prompt 5(证据矩阵生成 / 主题聚类)。
 *
 * 输出严格 JSON,字段见 system message。
 */

export const SYNTHESIS_SYSTEM = `你是系统性文献综述(SLR)的证据合成专家。
任务:把多篇已通过抽取并由人工核实的论文(每篇 1 个 extraction JSON),
跨论文聚成 3-7 个主题,识别一致结论 / 矛盾结论 / 证据空白,给每个主题打证据强度。

工作准则:

1. **输出严格 JSON**,字段如下(顺序可变):
   {
     "themes": [
       {
         "name": "主题名(中文,5-15 字)",
         "description": "1-2 句话解释这个主题在覆盖什么、为什么聚到一起",
         "supporting_record_ids": ["record_id1", "record_id2", ...],
         "consistent_findings": ["跨论文一致的结论(中文,每条 ≤ 60 字)"],
         "conflicting_findings": ["不同论文之间打架的结论 / 不一致点(中文)"],
         "evidence_gaps": ["在这个主题下被忽略 / 数据不足 / 未来研究方向(中文)"],
         "evidence_strength": "strong | moderate | weak | unclear"
       }
     ],
     "cross_cutting_observations": [
       "跨主题、整体性的观察(中文,例如:'多数研究集中在 X 数据集,缺乏多中心验证')"
     ],
     "evidence_gaps": [
       "整体证据空白(中文,与 cross_cutting_observations 互补)"
     ]
   }

2. **主题数量 3-7 个**。少于 3 个意味着粒度太粗,多于 7 个意味着碎片化。
   每个主题至少要有 2 篇论文支持(supporting_record_ids 长度 ≥ 2),
   单篇研究自成主题的情况记进 evidence_gaps,不要列成主题。

3. **supporting_record_ids 必须是用户输入里给你的 record_id 字符串**,
   原样回填,不要改写、不要编造、不要 paraphrase 成论文标题。
   如果你不确定某篇是不是属于该主题,就不要纳入。

4. **evidence_strength 判定**:
   - strong: ≥ 4 篇 + 结论高度一致 + 方法可比;
   - moderate: 2-3 篇一致,或 4+ 篇但方法异质;
   - weak: 2-3 篇,结论方向相符但样本 / 设计偏弱;
   - unclear: 论文之间结论分歧明显,或证据太少难以判断。

5. **conflicting_findings**:如果该主题下没有真实矛盾,就给空数组,**不要硬编**。

6. **evidence_gaps**:每个主题 1-3 条,具体(如"缺乏长期随访数据" / "未对儿童群体单独分析"),
   不要写"需要更多研究"这种废话。

7. **只输出 JSON**,不要前后加解释、Markdown、代码围栏。

语言要求(**强制**):
- 所有面向人的字段(name / description / consistent_findings / conflicting_findings /
  evidence_gaps / cross_cutting_observations)用**简体中文**。
- 必要的英文学术术语可以括号注一次,例如:"端到端学习(end-to-end learning)"。

写作风格:
- 大白话,直接陈述,不要"赋能 / 范式 / 解构 / 路径 / 机制 / 驱动 / 颗粒度"这类八股套话。
- 每条 finding ≤ 60 字;每个 description ≤ 80 字。
- 不要"探究 / 探讨 / 旨在"这类八股开头,直接说"在 X 任务上准确率比 Y 高 N 个点"这种具体的话。
`

/**
 * 把 N 条 verified extractions 拼成 LLM 输入。
 *
 * @param {object} args
 * @param {string[]} args.researchQuestions  approved protocol 的 RQ 列表(给 LLM 当聚类锚点)
 * @param {Array<{record_id, title, year, authors_text, extraction}>} args.extractions
 *   extraction 是 parse 过的对象(来自 extractions.extracted_json)
 */
export function buildSynthesisUserPrompt({ researchQuestions = [], extractions = [] }) {
  const lines = [
    '请基于以下已抽取并人工核实的论文做跨研究证据合成:',
    '',
  ]

  if (researchQuestions.length) {
    lines.push('研究问题(聚类时请围绕这些 RQ):')
    researchQuestions.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
    lines.push('')
  }

  lines.push(`论文数: ${extractions.length}`)
  lines.push('')
  lines.push('===== 论文抽取数据 =====')

  extractions.forEach((row, i) => {
    lines.push('')
    lines.push(`--- 论文 ${i + 1} ---`)
    lines.push(`record_id: ${row.record_id}`)
    if (row.title) lines.push(`title: ${row.title}`)
    if (row.year) lines.push(`year: ${row.year}`)
    if (row.authors_text) lines.push(`authors: ${row.authors_text}`)
    if (row.extraction && typeof row.extraction === 'object') {
      // 限制单篇 extraction 体积:>6000 字截断,保留头部
      const blob = JSON.stringify(row.extraction, null, 2)
      const MAX = 6000
      lines.push('extraction:')
      lines.push(blob.length > MAX ? blob.slice(0, MAX) + '\n... (截断)' : blob)
    }
  })

  lines.push('')
  lines.push('请严格按 system message 的 JSON schema 输出。')
  lines.push('记住:supporting_record_ids 必须用上面给出的 record_id 字符串原样回填,不要编造。')
  return lines.join('\n')
}

const VALID_STRENGTH = new Set(['strong', 'moderate', 'weak', 'unclear'])

/**
 * 把 LLM 输出 normalize 成可入库的结构。
 *
 * 返回:
 *   {
 *     themes: [{ name, description, supporting_record_ids,
 *                consistent_findings, conflicting_findings,
 *                evidence_gaps, evidence_strength }],
 *     cross_cutting_observations: [string],
 *     evidence_gaps: [string]
 *   }
 *
 * 容错:
 *   - 顶层有 wrapper({result|output|data: {...}})自动剥
 *   - 字段同义词容忍
 *   - 缺字段用空数组 / null,不抛
 *   - 非法 evidence_strength → 'unclear'
 *   - supporting_record_ids 里非字符串 / 空字符串剔除
 */
export function normalizeSynthesisOutput(raw, { knownRecordIds = null } = {}) {
  const empty = { themes: [], cross_cutting_observations: [], evidence_gaps: [] }
  if (!raw || typeof raw !== 'object') return empty

  raw = unwrapOne(raw)
  raw = unwrapOne(raw)

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : [])
  const strArr = (v) =>
    arr(v).map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean)
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  const themesRaw = arr(raw.themes || raw.clusters || raw.groups)
  const known = knownRecordIds ? new Set(knownRecordIds) : null

  const themes = []
  for (const t of themesRaw) {
    if (!t || typeof t !== 'object') continue
    const name = strOrNull(t.name || t.title || t.theme)
    if (!name) continue

    let ids = strArr(t.supporting_record_ids || t.record_ids || t.records || t.supportingRecords)
    if (known) ids = ids.filter((id) => known.has(id))
    // 去重保序
    ids = Array.from(new Set(ids))

    let strength = strOrNull(t.evidence_strength || t.strength)
    strength = strength && VALID_STRENGTH.has(strength.toLowerCase())
      ? strength.toLowerCase()
      : 'unclear'

    themes.push({
      name,
      description: strOrNull(t.description || t.summary) || '',
      supporting_record_ids: ids,
      consistent_findings: strArr(t.consistent_findings || t.consistentFindings || t.agreements),
      conflicting_findings: strArr(t.conflicting_findings || t.conflictingFindings || t.disagreements),
      evidence_gaps: strArr(t.evidence_gaps || t.evidenceGaps || t.gaps),
      evidence_strength: strength,
    })
  }

  return {
    themes,
    cross_cutting_observations: strArr(raw.cross_cutting_observations || raw.crossCuttingObservations || raw.observations),
    evidence_gaps: strArr(raw.evidence_gaps || raw.evidenceGaps || raw.gaps),
  }
}

function unwrapOne(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const keys = Object.keys(raw)
  // 已经有顶层 themes / evidence_gaps 字段就不剥
  const hasTop = keys.some((k) =>
    /^(themes|clusters|cross_cutting_observations|evidence_gaps)$/i.test(k)
  )
  if (hasTop) return raw
  for (const k of keys) {
    if (/^(result|output|data|response|synthesis)$/i.test(k)) {
      const v = raw[k]
      if (v && typeof v === 'object') return v
    }
  }
  return raw
}
