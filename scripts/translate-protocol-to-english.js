// scripts/translate-protocol-to-english.js
// ──────────────────────────────────────────────────────────────────────────
// 一次性脚本:把已锁定的 SLR 协议(可能是中文)翻译成学术英文,
// **保持 version 号不变**,避免触发下游 5 处 overlay 全部 stale。
//
// 用法:
//   node scripts/translate-protocol-to-english.js <project_id> [protocol_id]
//
// 不指定 protocol_id 时取该项目最高版本的 approved_by_user=1 行。
// 翻译范围:
//   - research_questions[]
//   - inclusion_criteria[]
//   - exclusion_criteria[]
//   - concept_groups[].name(terms 已是英文,不动)
//   - rationale
//   - clarification_questions[](若有)
// 保留不动:version / id / created_at / generated_by / model / approved_by_user
// ──────────────────────────────────────────────────────────────────────────

// 用法:
//   DB_PATH=/var/lib/slr/db/slr.db node scripts/translate-protocol-to-english.js <project_id> [protocol_id]
//   DRY_RUN=1 ... 仅预览不写库
const PROJECT_ID = process.argv[2]
const PROTOCOL_ID = process.argv[3] || null
if (!PROJECT_ID) {
  console.error('Usage: DB_PATH=... node scripts/translate-protocol-to-english.js <project_id> [protocol_id]')
  process.exit(2)
}
// 必须在 import db/index.js 之前设 env(initDb 读 process.env.DB_PATH 时已 lock 值)
if (!process.env.DB_PATH) {
  console.error('Missing DB_PATH env var')
  process.exit(2)
}
const { initDb } = await import('../db/index.js')
const { runLlm } = await import('../services/llm.js')

const TRANSLATE_SYSTEM = `# Role
You are a precise academic translator and SLR methodologist.

# Task
Translate a Chinese / mixed-language systematic-review protocol into clean academic English.

# Constraints
- ABSOLUTE: preserve the exact array lengths and ordering. If input has 5 RQs, output 5 RQs in same order.
- Preserve meaning faithfully; do NOT add new content, do NOT drop content, do NOT merge/split items.
- Translate concepts to academic English (MeSH / Scopus convention). Plain readable academic English.
- For research_questions: keep the "RQ1." "RQ2." prefix. Begin each with an actual interrogative ("How does...", "What characteristics...", "To what extent...").
- For inclusion / exclusion criteria: one criterion per item, ≤25 words, clear and mutually exclusive.
- For concept_groups[].name: short English category label (e.g. "Intervention / Technology", "Population / Domain").
- rationale: 1-3 sentence English justification, keep the original meaning.
- ZERO Chinese / Japanese / non-English characters in output (except proper nouns without English equivalent).
- STRICT JSON output, no Markdown, no code fences, no commentary outside JSON.

# Output schema (strict JSON, key order flexible)
{
  "research_questions":      [ "RQ1. ...", "RQ2. ...", ... ],
  "inclusion_criteria":      [ "...", ... ],
  "exclusion_criteria":      [ "...", ... ],
  "concept_groups_names":    [ "Group 1 name", "Group 2 name", ... ],
  "rationale":               "1-3 sentence English rationale",
  "clarification_questions": [ "...", ... ]
}`

async function main() {
  const db = initDb()

  // 1) 找协议
  const sql = PROTOCOL_ID
    ? `SELECT * FROM protocols WHERE id = ? AND project_id = ?`
    : `SELECT * FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
  const args = PROTOCOL_ID ? [PROTOCOL_ID, PROJECT_ID] : [PROJECT_ID]
  const proto = db.prepare(sql).get(...args)
  if (!proto) {
    console.error('Protocol not found for project', PROJECT_ID)
    process.exit(3)
  }
  console.log('▸ Loaded protocol', proto.id, 'v' + proto.version, 'approved=' + proto.approved_by_user)

  // 2) 找 owner_user_id
  const proj = db.prepare(`SELECT user_id FROM projects WHERE id = ?`).get(PROJECT_ID)
  if (!proj) { console.error('Project not found'); process.exit(3) }
  const userId = proj.user_id

  // 3) 解 JSON 字段
  const rq  = tryParse(proto.research_questions, [])
  const inc = tryParse(proto.inclusion_criteria, [])
  const exc = tryParse(proto.exclusion_criteria, [])
  const cg  = tryParse(proto.concept_groups, [])
  const cqs = tryParse(proto.clarification_questions, [])
  const rationale = proto.rationale || ''

  console.log('  RQ:', rq.length, '· inclusion:', inc.length, '· exclusion:', exc.length, '· concept_groups:', cg.length)

  // 4) 拼 user prompt
  const userPrompt = [
    'Translate the following SLR protocol fields to academic English. Preserve EXACT array lengths and ordering.',
    '',
    '## research_questions (input)',
    ...rq.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## inclusion_criteria (input)',
    ...inc.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## exclusion_criteria (input)',
    ...exc.map((q, i) => `${i + 1}. ${q}`),
    '',
    '## concept_groups (input — translate ONLY the name; terms are already English)',
    ...cg.map((g, i) => `${i + 1}. name=${g.name || g.group || ''} (${(g.terms || []).length} terms)`),
    '',
    '## rationale (input)',
    rationale,
    '',
    cqs.length ? `## clarification_questions (input)\n${cqs.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : '',
    '',
    'Return strict JSON per the system schema. Make sure array lengths match exactly.',
  ].filter(Boolean).join('\n')

  // 5) 调 Opus
  console.log('▸ Calling Opus (heavy) for translation ...')
  const startedAt = Date.now()
  const result = await runLlm(db, {
    userId,
    actionType: 'translate_protocol_oneoff',
    system: TRANSLATE_SYSTEM,
    prompt: userPrompt,
    expectJson: true,
    model: 'heavy',                // 强制 Opus,翻译质量要求高
    maxTokens: 8192,
    projectId: PROJECT_ID,
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('▸ LLM returned in', elapsed + 's · status=' + result.status + ' · model=' + result.model)

  if (result.status !== 'success') {
    console.error('LLM call failed:', result.status, result.error)
    console.error('Raw text:', (result.text || '').slice(0, 500))
    process.exit(4)
  }

  // 6) 解析输出(LLM 有时不听话会加 ```json 代码围栏 — strip 掉)
  let out
  let raw = String(result.text || '').trim()
  raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  try {
    out = JSON.parse(raw)
  } catch (e) {
    console.error('Failed to parse JSON:', e.message)
    console.error('Raw (first 1000):', raw.slice(0, 1000))
    process.exit(5)
  }

  // 7) 验证 array lengths
  function check(label, oldArr, newArr) {
    if (!Array.isArray(newArr)) {
      console.error(`✗ ${label}: expected array, got ${typeof newArr}`)
      process.exit(6)
    }
    if (newArr.length !== oldArr.length) {
      console.error(`✗ ${label}: length mismatch — input ${oldArr.length}, output ${newArr.length}`)
      process.exit(6)
    }
  }
  check('research_questions', rq, out.research_questions)
  check('inclusion_criteria', inc, out.inclusion_criteria)
  check('exclusion_criteria', exc, out.exclusion_criteria)
  check('concept_groups_names', cg, out.concept_groups_names)

  // 8) 重新组装 concept_groups(只换 name,terms 保留原始)
  const newConceptGroups = cg.map((g, i) => ({
    name:  out.concept_groups_names[i],
    terms: g.terms || g.keywords || [],
  }))

  // 9) 简单的中文残留检查
  const hasChinese = (s) => /[一-鿿]/.test(String(s))
  const allText = [
    ...out.research_questions,
    ...out.inclusion_criteria,
    ...out.exclusion_criteria,
    ...out.concept_groups_names,
    out.rationale,
    ...(out.clarification_questions || []),
  ].join(' ')
  if (hasChinese(allText)) {
    console.warn('⚠ Output still contains Chinese characters — review before commit')
    console.warn('  Snippet:', allText.match(/[一-鿿].{0,20}/g)?.slice(0, 3).join(' | '))
  } else {
    console.log('✓ All output fields are English-only')
  }

  // 10) 预览(节选)
  console.log('\n──── PREVIEW ────')
  console.log('research_questions[0]:', out.research_questions[0])
  console.log('research_questions[1]:', out.research_questions[1])
  console.log('inclusion[0]:', out.inclusion_criteria[0])
  console.log('exclusion[0]:', out.exclusion_criteria[0])
  console.log('concept_groups[0].name:', out.concept_groups_names[0])
  console.log('rationale:', String(out.rationale || '').slice(0, 200))
  console.log('────────────────\n')

  // 11) 准备 UPDATE — version 不变
  const updates = {
    research_questions:      JSON.stringify(out.research_questions),
    inclusion_criteria:      JSON.stringify(out.inclusion_criteria),
    exclusion_criteria:      JSON.stringify(out.exclusion_criteria),
    concept_groups:          JSON.stringify(newConceptGroups),
    rationale:               String(out.rationale || ''),
    clarification_questions: JSON.stringify(out.clarification_questions || cqs),
  }

  if (process.env.DRY_RUN === '1') {
    console.log('▸ DRY_RUN=1 — not writing to DB.')
    console.log('  Would UPDATE protocols SET ... WHERE id = ?', proto.id)
    return
  }

  // 12) 写回(保持 version 不变)
  db.prepare(`
    UPDATE protocols SET
      research_questions      = ?,
      inclusion_criteria      = ?,
      exclusion_criteria      = ?,
      concept_groups          = ?,
      rationale               = ?,
      clarification_questions = ?
    WHERE id = ?
  `).run(
    updates.research_questions,
    updates.inclusion_criteria,
    updates.exclusion_criteria,
    updates.concept_groups,
    updates.rationale,
    updates.clarification_questions,
    proto.id
  )
  console.log('✓ UPDATED protocols row', proto.id, '— version UNCHANGED (v' + proto.version + ')')
  console.log('  Downstream overlay stale: NONE triggered (version stayed at ' + proto.version + ')')
}

function tryParse(s, fallback) {
  if (!s) return fallback
  try {
    const x = typeof s === 'string' ? JSON.parse(s) : s
    return x
  } catch { return fallback }
}

main().catch((e) => {
  console.error('FATAL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
