/**
 * Step 8 drafting helpers (M32-a) — Phase 8.A Agent A
 * ------------------------------------------------------------
 * 纯函数 + 心跳/进度小工具,for per-section 异步 LLM call + 动态章节列表 + abstract 最后写。
 *
 * 设计原则:
 *   - 纯函数,不调 LLM,不动 LLM 路由器
 *   - 不动 routes/* / views/* / db/index.js(schema 已上)
 *   - 跨学科 + 英文输出策略(prompt 在 services/prompts/drafting.js)
 *
 * Exports:
 *   - FALLBACK_SECTIONS              默认 9 章节(若无 custom_sections_json 也无 journal template)
 *   - loadSectionsForProject(db, pid)    优先级 custom > journal template > FALLBACK
 *   - topoSortSections(sections)         依赖排序,返回可并行批次的 list of lists
 *   - createHeartbeatHandle(opts)        per-row 心跳 closure(running 状态 + meta.last_heartbeat_at)
 *   - summarizeDraftSections(db, pid, sections)  给 view 卡片用的完成度汇总
 */

// ============================================================
// FALLBACK_SECTIONS — 9 章节(若无 custom_sections_json 且无 journal template,用这个)
// ============================================================
//
// 顺序约束:abstract 必须在所有正文(intro/methods/results/discussion/limitations/conclusion)之后,
//          因为 generate-all 阶段 2 反推 abstract 需要先看到全文。
// references 由 export 层从 citation_map 推,不走 LLM(generated='auto')。
// 2026-05-26 加 declarations 段(PRISMA 24-27),order 8 — abstract 之后、references 之前。
//   依赖 methods + conclusion(前者给 protocol/registration context,后者拼装顺序需在最后)
export const FALLBACK_SECTIONS = [
  { name: 'title',        order: 1, target_words: 25,   depends_on: [],                                                                  required: true },
  { name: 'introduction', order: 2, target_words: 550,  depends_on: [],                                                                  required: true },
  { name: 'methods',      order: 3, target_words: 400,  depends_on: [],                                                                  required: true },
  { name: 'results',      order: 4, target_words: 1200, depends_on: ['methods'],                                                          required: true },
  { name: 'discussion',   order: 5, target_words: 700,  depends_on: ['results'],                                                          required: true },
  { name: 'limitations',  order: 6, target_words: 300,  depends_on: ['discussion'],                                                       required: false },
  { name: 'conclusion',   order: 7, target_words: 150,  depends_on: ['discussion'],                                                       required: true },
  { name: 'abstract',     order: 8, target_words: 275,  depends_on: ['introduction', 'methods', 'results', 'discussion', 'conclusion'],  required: true },
  { name: 'declarations', order: 9, target_words: 140,  depends_on: ['methods', 'conclusion'],                                            required: false },
  { name: 'references',   order: 10, target_words: 0,   depends_on: ['*'],                                                                required: true, generated: 'auto' },
]

// 用来识别"正文章节"(abstract 要排在这些之后),与 references 是否要排到末尾
const BODY_BEFORE_ABSTRACT_DEFAULTS = ['introduction', 'methods', 'results', 'discussion', 'conclusion', 'limitations', 'background']

// 把 LLM / 用户输入的 raw section name 归一化成小写 identifier(去多余空格 / 全转小写 / 把空格折成下划线)
function normalizeSectionName(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')   // 去标点(保留下划线 / 连字符 / 字母数字)
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

// 给一个 journal template section,提取 target_words 估计;若 0 / 缺失则用 fallback
function pickTargetWords(rawWordEstimate, fallbackName) {
  const n = typeof rawWordEstimate === 'number'
    ? rawWordEstimate
    : (rawWordEstimate ? parseInt(String(rawWordEstimate).replace(/[^\d]/g, ''), 10) : 0)
  if (Number.isFinite(n) && n > 0) return n
  const fb = FALLBACK_SECTIONS.find((s) => s.name === fallbackName)
  return fb ? fb.target_words : 400
}

// ============================================================
// loadSectionsForProject — 加载本项目章节(动态)
// ============================================================
//
// 优先级:
//   1) projects.custom_sections_json(用户手动定的 — JSON 字符串,数组)
//   2) target_journal_templates.extracted_structure.sections(journal template 抽取的)
//   3) FALLBACK_SECTIONS(9 章节)
//
// 始终保证:
//   - abstract 排在所有正文之后(若已有则重排,若无则补一条 fallback abstract)
//   - 字段:{ name, order, target_words, depends_on, required, generated? }
//   - name 是小写 identifier(用于 db.draft_sections.section_name)
export function loadSectionsForProject(db, projectId) {
  if (!db || !projectId) return FALLBACK_SECTIONS.slice()

  // 1) custom_sections_json
  let custom = null
  try {
    const row = db.prepare('SELECT custom_sections_json FROM projects WHERE id = ?').get(projectId)
    if (row && row.custom_sections_json) {
      const parsed = JSON.parse(row.custom_sections_json)
      if (Array.isArray(parsed) && parsed.length) custom = parsed
    }
  } catch { /* ignore — invalid JSON falls through to template / fallback */ }

  if (custom) {
    return normalizeAndOrderSections(custom.map((s, i) => {
      const name = normalizeSectionName(s?.name) || `section_${i + 1}`
      return {
        name,
        order: typeof s?.order === 'number' ? s.order : (i + 1),
        target_words: pickTargetWords(s?.target_words ?? s?.word_count_estimate, name),
        depends_on: Array.isArray(s?.depends_on) ? s.depends_on.map(normalizeSectionName).filter(Boolean) : [],
        required: s?.required !== false,
        generated: s?.generated || undefined,
      }
    }))
  }

  // 2) journal template
  let templateSections = null
  try {
    const row = db.prepare(
      'SELECT extracted_structure FROM target_journal_templates WHERE project_id = ?'
    ).get(projectId)
    if (row && row.extracted_structure) {
      const parsed = typeof row.extracted_structure === 'string'
        ? JSON.parse(row.extracted_structure)
        : row.extracted_structure
      if (parsed && Array.isArray(parsed.sections) && parsed.sections.length) {
        templateSections = parsed.sections
      }
    }
  } catch { /* ignore — fall through to fallback */ }

  if (templateSections) {
    // template sections 通常只有 { name, word_count_estimate, ... },没有 depends_on
    // → 按出现顺序赋 order;依赖关系用默认推断(results 依赖 methods,discussion 依赖 results,...)
    const mapped = templateSections.map((s, i) => {
      const rawName = typeof s?.name === 'string' ? s.name : ''
      const name = normalizeSectionName(rawName) || `section_${i + 1}`
      return {
        name,
        order: i + 1,
        target_words: pickTargetWords(s?.word_count_estimate, name),
        depends_on: inferDepsForKnownName(name, templateSections.map((x) => normalizeSectionName(x?.name)).filter(Boolean)),
        required: true,
      }
    })
    return normalizeAndOrderSections(mapped)
  }

  // 3) fallback
  return FALLBACK_SECTIONS.slice()
}

// 给已知名字推断默认 depends_on(只用于 journal template 走不带 depends_on 的场景)
function inferDepsForKnownName(name, allKnownNames) {
  const has = (n) => allKnownNames.includes(n)
  switch (name) {
    case 'results':     return has('methods') ? ['methods'] : []
    case 'discussion':  return has('results') ? ['results'] : []
    case 'limitations': return has('discussion') ? ['discussion'] : (has('results') ? ['results'] : [])
    case 'conclusion':  return has('discussion') ? ['discussion'] : (has('results') ? ['results'] : [])
    case 'abstract': {
      // abstract 依赖所有正文(若存在);若 template 没列正文(罕见)则空
      const deps = BODY_BEFORE_ABSTRACT_DEFAULTS.filter((n) => n !== 'abstract' && has(n))
      return deps
    }
    case 'references':  return ['*']
    default:            return []
  }
}

// 规范化最终 section 列表:
//   - 去重(同 name 后者覆盖前者)
//   - 保证有 abstract(若缺则补;不论 user/template,abstract 总是必要的)
//   - 把 abstract 排到所有正文之后(order 重赋)
//   - references(如果存在)排到 abstract 之后(最末)
//   - 每个返回项 name 是小写 identifier
function normalizeAndOrderSections(input) {
  const dedup = new Map()  // name → section
  for (const s of input) {
    if (!s || !s.name) continue
    dedup.set(s.name, {
      name: s.name,
      order: typeof s.order === 'number' ? s.order : 999,
      target_words: Number.isFinite(s.target_words) ? Math.max(0, s.target_words) : 400,
      depends_on: Array.isArray(s.depends_on) ? s.depends_on.slice() : [],
      required: s.required !== false,
      ...(s.generated ? { generated: s.generated } : {}),
    })
  }

  // 优化打磨包(2026-05-24):若缺 title,补一条 fallback title(强约束 — title 是 PRISMA 2020 Item #1 必须)
  //   journal template 抽出来的 sections 通常没 title(发表论文里 title 是 metadata 不是 section)
  //   但写综述必须有 title — 它是 LLM 基于全文论点 + 期刊 voice 单独生成的 short heading
  if (!dedup.has('title')) {
    const fbTitle = FALLBACK_SECTIONS.find((s) => s.name === 'title')
    if (fbTitle) {
      dedup.set('title', { ...fbTitle })
    }
  }

  // 若缺 abstract,补一条 fallback abstract(强约束 — abstract 是 SLR 必须的)
  if (!dedup.has('abstract')) {
    const fbAbs = FALLBACK_SECTIONS.find((s) => s.name === 'abstract')
    if (fbAbs) {
      const knownBody = BODY_BEFORE_ABSTRACT_DEFAULTS.filter((n) => dedup.has(n))
      dedup.set('abstract', { ...fbAbs, depends_on: knownBody.length ? knownBody : fbAbs.depends_on })
    }
  } else {
    // 已有 abstract:补全 depends_on,确保它依赖现有所有正文章节
    const abs = dedup.get('abstract')
    const knownBody = BODY_BEFORE_ABSTRACT_DEFAULTS.filter((n) => dedup.has(n))
    const merged = new Set([...(abs.depends_on || []), ...knownBody])
    abs.depends_on = Array.from(merged)
  }

  // 2026-05-26:若缺 declarations,补一条 fallback(optional — PRISMA 2020 items 24-27)
  //   即使老项目用 custom_sections 或 journal template,也始终把 declarations 自动加进去,
  //   让用户能一键生成 funding / competing interests / data availability 段。
  //   required: false → 用户可以不生成它,不阻塞 generate-all。
  if (!dedup.has('declarations')) {
    const fbDecl = FALLBACK_SECTIONS.find((s) => s.name === 'declarations')
    if (fbDecl) {
      const knownDeps = (fbDecl.depends_on || []).filter((n) => dedup.has(n))
      dedup.set('declarations', { ...fbDecl, depends_on: knownDeps.length ? knownDeps : [] })
    }
  }

  // 优化打磨包:title 永远排第 1(不依赖任何 section,可与 introduction/methods 同批跑);
  //          abstract 在所有正文之后;declarations 在 abstract 之后;references 永远最末。
  // 重赋 order
  const all = Array.from(dedup.values())
  const titleSec = dedup.get('title') || null
  const bodies = all.filter((s) => s.name !== 'title' && s.name !== 'abstract'
                                && s.name !== 'declarations' && s.name !== 'references')
    .sort((a, b) => a.order - b.order)
  const absSec = dedup.get('abstract') || null
  const declSec = dedup.get('declarations') || null
  const refSec = dedup.get('references') || null

  let order = 1
  const out = []
  if (titleSec) out.push({ ...titleSec, order: order++ })
  for (const s of bodies) out.push({ ...s, order: order++ })
  if (absSec) out.push({ ...absSec, order: order++ })
  if (declSec) out.push({ ...declSec, order: order++ })
  if (refSec) out.push({ ...refSec, order: order++ })
  return out
}

// ============================================================
// topoSortSections — 依赖排序,返回执行批次 [[batch1...], [batch2...], ...]
// ============================================================
//
// 输入:loadSectionsForProject 的返回(每项含 name + depends_on)
// 输出:list of lists,每个 sublist 是可并行执行的 section name
//
// 例:
//   [
//     ['title', 'introduction', 'methods'],   // 无依赖
//     ['results'],                             // 依赖 methods
//     ['discussion'],                          // 依赖 results
//     ['limitations', 'conclusion'],           // 依赖 discussion
//     ['abstract'],                            // 依赖 intro+methods+results+discussion+conclusion
//     ['references'],                          // depends_on '*' → 最末
//   ]
//
// 特殊处理:
//   - depends_on 含 '*' → 总是放到最后一批(用于 references)
//   - 环:破环 — 把"目前所有未排的 section 视为同一批,作为下一批立即出列",并 console.warn 一次。
//     这是 graceful degradation;不抛错,因为 generate-all 不能因为依赖配错就崩。
export function topoSortSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return []

  const known = new Set(sections.map((s) => s.name))
  const starSections = sections.filter((s) =>
    Array.isArray(s.depends_on) && s.depends_on.includes('*')
  )
  const normal = sections.filter((s) => !starSections.includes(s))

  // 准备 depends 表(只保留 known + 非 '*' 的依赖)
  const deps = new Map()
  for (const s of normal) {
    const list = Array.isArray(s.depends_on) ? s.depends_on : []
    deps.set(s.name, list.filter((d) => d !== '*' && known.has(d)))
  }

  const batches = []
  const done = new Set()
  const remaining = new Set(normal.map((s) => s.name))

  while (remaining.size > 0) {
    const batch = []
    for (const name of remaining) {
      const ds = deps.get(name) || []
      if (ds.every((d) => done.has(d))) batch.push(name)
    }
    if (batch.length === 0) {
      // 环或缺依赖 — 把剩下的当一批吐出来,warn 但不抛
      console.warn('[topoSortSections] dependency cycle or missing dep; flushing remaining as one batch:', Array.from(remaining))
      const rest = Array.from(remaining)
      batches.push(rest)
      for (const n of rest) { done.add(n); remaining.delete(n) }
      break
    }
    // 按 order 升序排同一批,便于 UI 阅读
    batch.sort((a, b) => {
      const oa = normal.find((s) => s.name === a)?.order ?? 999
      const ob = normal.find((s) => s.name === b)?.order ?? 999
      return oa - ob
    })
    batches.push(batch)
    for (const n of batch) { done.add(n); remaining.delete(n) }
  }

  // '*' 依赖的(references)总是排到最后一批
  if (starSections.length > 0) {
    batches.push(starSections.map((s) => s.name).sort())
  }

  return batches
}

// ============================================================
// createHeartbeatHandle — per-row 心跳 closure factory
// ============================================================
//
// 用法(在 setImmediate 闭包里):
//   const hb = createHeartbeatHandle({
//     db,
//     table: 'draft_sections',
//     idColumn: 'id',
//     id: rowId,
//     statusColumn: 'section_run_status',
//     metaColumn: 'section_run_meta',
//     finishedAtColumn: 'section_run_finished_at',
//     errorColumn: 'section_run_error',
//     intervalMs: 30_000,
//     statsExtras: { section_name },
//   })
//   hb.writeHeartbeat()             // 立即写一次
//   const intervalId = hb.startInterval()
//   ... await runLlm ...
//   hb.finishWithHb('success', null, meta)
//
// 行为:
//   - writeHeartbeat:UPDATE table SET <metaColumn> = ? WHERE <idColumn> = ? AND <statusColumn> = 'running'
//     → 只有 row 还在 running 时才写,避免覆盖已完成 row 的 meta
//   - startInterval:setInterval(writeHeartbeat, intervalMs) → 返回 intervalId(也存内部用于 finishWithHb)
//   - finishWithHb:clearInterval(intervalId) + UPDATE table 最终态(status + finished_at + error + meta)
//   - clearAll:仅清理 interval(用于异常路径)
//
// 不抛错:db 操作失败只 silent swallow(对照 certainty/ai-suggest pattern)。
export function createHeartbeatHandle({
  db,
  table,
  idColumn = 'id',
  id,
  statusColumn,
  metaColumn,
  finishedAtColumn,
  errorColumn,
  intervalMs = 30_000,
  statsExtras = {},
}) {
  if (!db || !table || !id || !statusColumn || !metaColumn || !finishedAtColumn || !errorColumn) {
    throw new Error('createHeartbeatHandle: missing required option')
  }

  const heartbeatStart = Date.now()
  let intervalId = null

  const writeHeartbeat = () => {
    try {
      const sql =
        `UPDATE ${table}
            SET ${metaColumn} = ?
          WHERE ${idColumn} = ? AND ${statusColumn} = 'running'`
      const meta = {
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - heartbeatStart) / 1000),
        ...statsExtras,
      }
      db.prepare(sql).run(JSON.stringify(meta), id)
    } catch { /* ignore — heartbeat best-effort */ }
  }

  const startInterval = () => {
    if (intervalId) return intervalId
    intervalId = setInterval(writeHeartbeat, intervalMs)
    // unref 让 interval 不阻塞 Node 退出
    if (intervalId && typeof intervalId.unref === 'function') intervalId.unref()
    return intervalId
  }

  const clearAll = () => {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  const finishWithHb = (status, errorMessage, meta) => {
    clearAll()
    try {
      const sql =
        `UPDATE ${table}
            SET ${statusColumn} = ?,
                ${finishedAtColumn} = datetime('now', '+8 hours'),
                ${errorColumn} = ?,
                ${metaColumn} = ?
          WHERE ${idColumn} = ?`
      db.prepare(sql).run(
        status,
        errorMessage ? String(errorMessage).slice(0, 500) : null,
        meta ? JSON.stringify(meta) : null,
        id,
      )
    } catch (e) {
      console.error(`[createHeartbeatHandle] finishWithHb failed for ${table}#${id}:`, e?.message)
    }
  }

  return { writeHeartbeat, startInterval, finishWithHb, clearAll }
}

// ============================================================
// summarizeDraftSections — 给 view 卡片用的完成度汇总
// ============================================================
//
// 输入:
//   db, projectId, sections(loadSectionsForProject 的返回)
// 输出:
//   {
//     total: <int — sections 总数>,
//     generated: <int — 有 content_markdown 的 section 数>,
//     in_progress: <int — section_run_status='running' 的>,
//     failed: <int — section_run_status='failed'|'aborted_by_restart' 的>,
//     pending: <int — 未生成 + 未在跑 + 未失败 的>,
//     by_name: {
//       <section_name>: { status, version, model, words, updated_at }
//     }
//   }
//
// 注意:
//   - draft_sections 表 UNIQUE(project_id, section_name, version) → 同 section 可能有多个版本
//     这里只取每个 section 最新版本(MAX(version))
//   - 同一 section 跨版本:status 取最新版本的 section_run_status;若 NULL 但有 content 则视为 'generated'
//   - section 不在 draft_sections 表里 → status='pending'
//   - 失败包括 section_run_status='failed' 和 'aborted_by_restart'(boot cleanup 留下的)
//   - generated='auto'(references)永远视为 pending 之外的 'auto'(不进 progress 比例)
export function summarizeDraftSections(db, projectId, sections) {
  const out = {
    total: 0,
    generated: 0,
    in_progress: 0,
    failed: 0,
    pending: 0,
    by_name: {},
  }
  if (!Array.isArray(sections) || sections.length === 0) return out
  out.total = sections.length

  // 一次性拉所有 row,by section_name 取最新 version
  //   注意:必须取 id 和 citation_map,view 卡片的 ✎ 编辑 / 引用数徽章依赖
  let rows = []
  try {
    rows = db.prepare(
      `SELECT id, section_name, content_markdown, citation_map, model, version, updated_at,
              section_run_status, section_run_error,
              hallucinated_recs_json, lint_warnings_json
         FROM draft_sections
        WHERE project_id = ?`
    ).all(projectId) || []
  } catch { rows = [] }

  // section_name → 最新 version row
  const latestByName = new Map()
  for (const r of rows) {
    const prev = latestByName.get(r.section_name)
    if (!prev || (r.version || 0) > (prev.version || 0)) latestByName.set(r.section_name, r)
  }

  for (const s of sections) {
    const name = s.name
    const row = latestByName.get(name)
    let status, words = 0, model = null, version = 0, updatedAt = null

    if (s.generated === 'auto') {
      // references / 其它 auto-generated:不进 generated/in_progress/failed/pending,单标 'auto'
      status = 'auto'
    } else if (!row) {
      status = 'pending'
      out.pending++
    } else {
      version = row.version || 0
      model = row.model || null
      updatedAt = row.updated_at || null
      const hasContent = typeof row.content_markdown === 'string' && row.content_markdown.trim().length > 0
      words = hasContent ? countWords(row.content_markdown) : 0
      const runStatus = row.section_run_status

      if (runStatus === 'running') {
        status = 'in_progress'
        out.in_progress++
      } else if (runStatus === 'failed' || runStatus === 'aborted_by_restart') {
        status = 'failed'
        out.failed++
      } else if (hasContent) {
        status = 'generated'
        out.generated++
      } else {
        // row 存在但无 content + 不在 running + 不在 failed → pending(可能 schema 边界态)
        status = 'pending'
        out.pending++
      }
    }

    // 解析 citation_map(JSON 列)— view 卡片显示"引用数"徽章用
    let citationCount = 0
    if (row && row.citation_map) {
      try {
        const cm = typeof row.citation_map === 'string' ? JSON.parse(row.citation_map) : row.citation_map
        if (Array.isArray(cm)) citationCount = cm.length
      } catch {}
    }

    // 2026-05-25 P0-6:解析 hallucinated_recs_json + lint_warnings_json
    //   让 view banner / preview chip / job summary 都能 surface 幻觉计数
    let hallucinatedRecs = []
    if (row && row.hallucinated_recs_json) {
      try {
        const j = JSON.parse(row.hallucinated_recs_json)
        if (Array.isArray(j)) hallucinatedRecs = j
      } catch {}
    }
    let lintWarnings = null
    if (row && row.lint_warnings_json) {
      try {
        const j = JSON.parse(row.lint_warnings_json)
        if (j && typeof j === 'object') lintWarnings = j
      } catch {}
    }

    out.by_name[name] = {
      status,
      version,
      model,
      words,
      updated_at: updatedAt,
      // ─── view 卡片渲染必需字段(之前漏了 → 写完正文用户看不到)─────────
      section_id:    row ? row.id : null,
      content_markdown: row && typeof row.content_markdown === 'string' ? row.content_markdown : '',
      content_markdown_preview: row && row.content_markdown
        ? row.content_markdown.slice(0, 400)
        : '',
      citation_count: citationCount,
      // ─── 编排器 run 状态(view 用此区分 ✓ 已生成 / ⚠ 失败 / ⏳ 生成中)──
      //   2026-05-25 修:之前没透出,view 误把 version>0 的失败行渲成 ✓ 已生成,
      //   导致上面 job summary 说"method 失败"、下面卡片说"method 已生成"自相矛盾
      section_run_status: row ? (row.section_run_status || null) : null,
      section_run_error:  row ? (row.section_run_error || null) : null,
      // ─── P0-6/P2-13:质量 lint(per-section)──────────────────────────
      hallucinated_recs: hallucinatedRecs,
      hallucinated_count: hallucinatedRecs.length,
      lint_warnings: lintWarnings,
    }
  }
  // P0-8 / P2-13:顶级汇总加幻觉 + lint 总数,view job summary banner 用
  let totalHallucinated = 0
  let totalLintTables = 0
  let totalLintFigures = 0
  for (const v of Object.values(out.by_name)) {
    totalHallucinated += v.hallucinated_count || 0
    if (v.lint_warnings && typeof v.lint_warnings === 'object') {
      totalLintTables  += (v.lint_warnings.unknown_tables || []).length
      totalLintFigures += (v.lint_warnings.unknown_figures || []).length
    }
  }
  out.total_hallucinated = totalHallucinated
  out.total_lint_unknown_tables = totalLintTables
  out.total_lint_unknown_figures = totalLintFigures
  return out
}

// 简单英文 / 中文混合计字数:英文按空格切,中文按 1 字符 1 字。
// 用于卡片"~ N 词"提示,不需要严格学术算法。
//
// 优化打磨包:**只算正文,跳过非正文内容**。否则带参考文献/代码块/引文占位的章节
// 会显示"~ 20000 词"虚高,或写完 1500 词的 results 因为 60 个 [rec_xxx] 占位而看着像 1600。
// 不算的:
//   - References / Bibliography 段(找到 ## references 后整段砍掉)
//   - 围栏代码块 ``` ... ```
//   - 行内代码 `…`
//   - markdown image / link 的 url 部分(只算 alt/text)
//   - 引文占位符 [rec_xxx](是数据占位,不是正文用词)
//   - 表格 markdown 控制符 | --- |
//   - mermaid / latex / html 块(包在 ``` 里已经被剥)
export function countWords(text) {
  if (typeof text !== 'string' || !text) return 0
  let t = text

  // ────────────────────────────────────────────────────────────────────────
  // 用户硬性要求:每一个模块的表、图、参考文献等都不应该占词数
  //   排除范围(对照 ICMJE / Cochrane 学术综述 word count 惯例 + Frontiers /
  //   Springer / Elsevier 投稿模板 word_count 算法):
  //   - References / Bibliography
  //   - Appendix / Supplementary materials
  //   - Acknowledgements / Funding / Conflict of interest / Author contributions
  //   - Abbreviations / Data availability / Ethics statement
  //   - 表(GFM markdown 整块 + Table N. caption 行)
  //   - 图(![alt](url) + Figure N. caption 行 + Mermaid 围栏)
  //   - 引文 / 占位 / 代码 / HTML
  //   - 脚注引用 + 定义
  // ────────────────────────────────────────────────────────────────────────

  // 1) 砍 References / Bibliography 段 + 论文末尾常见的"非正文"区段(从该段起到文末)
  //    顺序:任何这些 heading 出现一次,该 heading 起到文末都丢掉(论文末尾约定俗成)
  const TAIL_HEADINGS = [
    'references', 'bibliography', '参考文献', '文献列表', '引用文献',
    'appendix', 'appendices', '附录',
    'supplementary materials?', 'supplementary information', 'supporting information', '补充材料', '附加材料',
    'acknowledgements?', 'acknowledgments?', '致谢',
    'funding', 'financial support', '资金', '资助',
    'conflicts? of interests?', 'declaration of interests?', 'competing interests?', '利益冲突',
    'author contributions?', '作者贡献', '作者声明',
    'abbreviations?', '缩写',
    'data availability', '数据可用性',
    'ethics statement', 'ethical approval', '伦理声明',
    'disclosures?', '声明',
    'notes?', 'endnotes?', 'footnotes?', '注释', '脚注',
    'glossary', '术语表',
    'orcid',
  ].join('|')
  // 注意:\b 不对 CJK 生效(中文字符不是 \w),所以用 (?=\s|$|[^\w一-鿿]) 做尾界
  const TAIL_RE = new RegExp(`(^|\\n)#{1,6}\\s*(?:${TAIL_HEADINGS})(?=\\s|$|[^\\w\\u4e00-\\u9fff])[^\\n]*\\n[\\s\\S]*$`, 'i')
  t = t.replace(TAIL_RE, '')

  // 2) 围栏代码块 ``` ... ```(含 mermaid / latex / json)— 同时吞 Mermaid 图源码
  t = t.replace(/```[\s\S]*?```/g, ' ')

  // 3) 行内代码 `code`
  t = t.replace(/`[^`\n]*`/g, ' ')

  // 4) markdown image ![alt](url) → 整体丢(用户要求图不算字,连 alt 也不算)
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')

  // 5) markdown link [text](url) → 保留 text(但若 text 是引文占位 rec_xxx 则置空)
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, txt) => {
    return /^\s*rec_[A-Za-z0-9_-]+\s*$/.test(txt) ? ' ' : txt
  })

  // 6) 裸占位:引文 / 图 / 表 / 脚注引用 / 脚注定义
  //    注意顺序:先杀整行的脚注定义(行首 [^x]: ...),再杀任意位置的脚注引用 [^x]
  //    否则 ref regex 会把 [^x]: 拆掉,行就保留下文文本被当词数
  t = t.replace(/^\s*\[\^[A-Za-z0-9_-]+\]:[^\n]*(?:\n|$)/gm, ' ')       // 脚注定义 [^1]: text\n(整行)
  t = t.replace(/\[\^[A-Za-z0-9_-]+\]/g, ' ')                           // 脚注引用 [^1]
  t = t.replace(/\[rec_[A-Za-z0-9_-]+(?:\s*[,;]\s*rec_[A-Za-z0-9_-]+)*\]/g, ' ')
  t = t.replace(/\[fig:[A-Za-z0-9_-]+\]/g, ' ')
  t = t.replace(/\[tbl:[A-Za-z0-9_-]+\]/g, ' ')

  // 7) HTML 标签
  t = t.replace(/<[^>]+>/g, ' ')

  // 8) markdown 表格整块排除(header row + 分隔行 + data rows 全删)
  //    匹配规则:连续 ≥2 行以 `|` 开头/结尾,中间夹一行 `|---|`(GFM 表格定义)
  t = t.replace(/(^|\n)(\s*\|[^\n]*\|\s*\n)(\s*\|[\s:|-]+\|\s*\n)((?:\s*\|[^\n]*\|\s*\n?)+)/g, '$1')

  // 8b) 兜底:孤立的表格分隔线 | --- |
  t = t.replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/gm, ' ')

  // 8c) Figure / Table caption 行(LLM 常写在表/图前后):
  //     **Figure 1.** ... · Figure 1: ... · Table 2. ... · Fig. 3 ... · 图 1.  ... · 表 2:...
  //     整行 strip(下一个换行符为止)
  t = t.replace(/^\s*(?:\*\*)?\s*(?:Figure|Fig\.?|Table|Tab\.?|图|表)\s*\d+\s*(?:\*\*)?\s*[.:、:]\s*[^\n]*\n?/gmi, ' ')

  // 8d) 表脚注 / 图注的常见前缀行:Note:/Source:/Notes:/Source./说明:
  t = t.replace(/^\s*(?:Notes?|Source|说明|注)\s*[.::]\s*[^\n]*\n?/gm, ' ')

  // 9) markdown 控制符 + 多余空白
  const cjk = (t.match(/[一-鿿]/g) || []).length
  const cleaned = t
    .replace(/[一-鿿]/g, ' ')
    .replace(/[#*_>~\-\[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 必须含至少 1 个字母 / 数字 才算词(剔除纯标点 token,如 "." "," ":"
  // — 这些通常是清理 [^1] / [rec_xxx] / [fig:xxx] 后残留的孤立标点)
  const enWords = cleaned
    ? cleaned.split(' ').filter((w) => w && /[A-Za-z0-9]/.test(w)).length
    : 0
  return cjk + enWords
}

// ============================================================
// Phase 8.B — drafting 数据聚合 + overlay 加载
// ============================================================
//
// 跟 certainty 同款 pattern,但聚合维度更广:
//   - 协议 + themes + theme_certainty + synthesis_meta + papersByRid
//   - evidenceByTheme + finalQueries
//   - prismaCounts(PRISMA 2020 flow)
//   - journalTemplate(extracted_structure for section style hints)
//
// 给 Step 8 per-section LLM call + generate-all + overlay generation 用。

import {
  buildSynthesisInputs as _buildSynthesisInputs,
  loadApprovedProtocolFull as _loadApprovedProtocolFull,
  listFinalSearchQueries as _listFinalSearchQueries,
} from './synthesis-helpers.js'
import {
  loadAllThemesWithMeta as _loadAllThemesWithMeta,
  loadSynthesisMetaForCertainty as _loadSynthesisMetaForCertainty,
  loadEvidencePointsByTheme as _loadEvidencePointsByTheme,
  loadAllThemeCertainty as _loadAllThemeCertainty,
  indexLatestCertaintyByTheme as _indexLatestCertaintyByTheme,
} from './certainty-helpers.js'
import { computePrismaFlow as _computePrismaFlow } from './prisma-flow.js'
import { getJournalTemplate as _getJournalTemplate } from './journal-template.js'

// 引文 cheat-sheet / citable records 上限(防 LLM ctx 爆掉)
//   200 篇 × ~150 char/篇(title + authors + year + journal + doi) ≈ 30K char ≈ 7.5K tokens
//   够 99% SLR 项目(典型 include 数 20-100,极少数 200+)
//   超出时:按 year DESC + created_at ASC 排序,优先保留新论文
const MAX_CITABLE_RECORDS = 200

// ------------------------------------------------------------
// computeDateRangeAlignment — 协议窗 vs 实际入选论文年跨度
// ------------------------------------------------------------
// 场景:协议写 "2016-2026" 但实际入选论文最早是 2022(领域 2022 才出现)。
// 默认行为下 LLM 在 Methods 段会复述"我们检索了 2016-2026 的论文",reviewer 会
// 怀疑"是不是搜漏了 2016-2021 这 6 年"。本 helper 算出 gap,让上游把"协议窗"
// 和"实际跨度"双标注入 prompt,LLM 就会诚实写"searches covered 2016 onward;
// all eligible studies were published in 2022-2026, reflecting the recent
// emergence of this research area"。
//
// 输入:
//   protocol         loadApprovedProtocolFull() 输出 — 用 inclusion_criteria
//                    数组里的年份字面量(正则抽 4 位年份对)。若拿不到,protocol_start/end 为 null。
//   includedRecords  listIncludedRecords() 输出 — 每条有 .year 字段。
//
// 输出:
//   {
//     protocol_start, protocol_end,   // 协议宣称的窗(2016 / 2026),null 表无法识别
//     actual_earliest, actual_latest, // 实际入选论文最早/最晚年(必有)
//     gap_years_at_start,             // protocol_start 比 actual_earliest 早多少年(无数据则 0)
//     gap_years_at_end,               // protocol_end 比 actual_latest 晚多少年
//     has_gap,                        // 任一端 >= 2 年时为 true(<2 不值得提)
//   } 或 null(无入选论文 / 没年份)
//
// 说明:阈值 2 是为了避免"协议 2024-2026,实际 2024-2026"这种无意义微差;
// 想调阈值,改下方 GAP_MIN 常量即可。
export function computeDateRangeAlignment(protocol, includedRecords) {
  const GAP_MIN = 2
  const records = Array.isArray(includedRecords) ? includedRecords : []
  const years = records
    .map((r) => Number(r?.year))
    .filter((y) => Number.isFinite(y) && y >= 1900 && y <= 2200)
  if (years.length === 0) return null

  const actual_earliest = Math.min(...years)
  const actual_latest = Math.max(...years)

  // 从 protocol.inclusion_criteria(string[])里抽 "YYYY ... YYYY" 这种连续年份对
  // 容忍 "between 2016 and May 2026" / "from 2016 to 2026" / "2016-2026" / "2016–2026"
  let protocol_start = null
  let protocol_end = null
  try {
    const crits = Array.isArray(protocol?.inclusion_criteria)
      ? protocol.inclusion_criteria
      : (Array.isArray(protocol?.inclusion) ? protocol.inclusion : [])
    for (const raw of crits) {
      if (typeof raw !== 'string') continue
      // 跑两种 pattern:
      //  ① "YYYY ... YYYY" — 最近的两个 4 位年份
      //  ② "since YYYY" / "after YYYY" / "from YYYY"(只有起始,end 留 null)
      const yrs = raw.match(/\b(19|20|21)\d{2}\b/g) || []
      if (yrs.length >= 2) {
        const a = Number(yrs[0]); const b = Number(yrs[yrs.length - 1])
        protocol_start = Math.min(a, b)
        protocol_end = Math.max(a, b)
        break
      }
      if (yrs.length === 1 && /\b(since|after|from|>=|≥)\b/i.test(raw)) {
        protocol_start = Number(yrs[0])
        protocol_end = null
        break
      }
    }
  } catch {}

  const gap_years_at_start = (protocol_start != null && actual_earliest > protocol_start)
    ? (actual_earliest - protocol_start) : 0
  const gap_years_at_end = (protocol_end != null && actual_latest < protocol_end)
    ? (protocol_end - actual_latest) : 0

  return {
    protocol_start,
    protocol_end,
    actual_earliest,
    actual_latest,
    gap_years_at_start,
    gap_years_at_end,
    has_gap: gap_years_at_start >= GAP_MIN || gap_years_at_end >= GAP_MIN,
  }
}

// ------------------------------------------------------------
// computeCitationCoverage — 引用覆盖率分析(用户提问"哪些被引/哪些没被引")
// ------------------------------------------------------------
// 扫所有 draft_sections 的 content_markdown + citation_map,
// 抽出所有 [rec_xxx] placeholder + citation_map.paper_id 的 union → cited set
// listIncludedRecords - cited set = uncited
//
// 输出:
//   {
//     cited:    Array<{id, title, year, authors_text, journal, in_sections:[...] }>,
//     uncited:  Array<{id, title, year, authors_text, journal}>,
//     cited_n, uncited_n, total_n,
//     coverage_pct,   // cited_n / total_n
//   }
//
// 用途:report.ejs 一张折叠卡 + 导出前的"References 含有未在正文出现的论文,
// 建议从 References 移除 N 条"提醒。
export function computeCitationCoverage(db, projectId, includedRecords) {
  const records = Array.isArray(includedRecords) ? includedRecords : []
  if (!db || !projectId) return null
  const recordById = new Map()
  for (const r of records) {
    if (r?.id) recordById.set(r.id, r)
  }
  const cited = new Map() // rec_id → Set of section names

  let rows = []
  try {
    rows = db.prepare(
      `SELECT section_name, content_markdown, citation_map
         FROM draft_sections
        WHERE project_id = ?`
    ).all(projectId) || []
  } catch { rows = [] }

  // section_name → 最新 version content(简化:直接取该 section_name 的所有行 union;
  // 多 version 引文集合应该是单调增,union 即可)
  for (const r of rows) {
    const section = r.section_name || ''
    // 1) 从 content_markdown 抽 [rec_xxx] / [rec_xxx, rec_yyy] / [rec_xxx; rec_yyy]
    const md = String(r.content_markdown || '')
    const matches = md.match(/\[rec_[A-Za-z0-9_,;\s-]+\]/g) || []
    for (const m of matches) {
      const inner = m.slice(1, -1)
      for (const tok of inner.split(/[,;]\s*/)) {
        const t = tok.trim()
        if (/^rec_[A-Za-z0-9_-]+$/.test(t)) {
          if (!cited.has(t)) cited.set(t, new Set())
          cited.get(t).add(section)
        }
      }
    }
    // 2) 从 citation_map(JSON 数组) 抽 paper_id 兜底(LLM 应该自己填,但有时漏)
    if (r.citation_map) {
      try {
        const cm = typeof r.citation_map === 'string' ? JSON.parse(r.citation_map) : r.citation_map
        if (Array.isArray(cm)) {
          for (const x of cm) {
            const pid = x?.paper_id
            if (typeof pid === 'string' && /^rec_[A-Za-z0-9_-]+$/.test(pid)) {
              if (!cited.has(pid)) cited.set(pid, new Set())
              cited.get(pid).add(section)
            }
          }
        }
      } catch {}
    }
  }

  // 拼输出 — 只对 included 集合分类(被引但不在 include 的视为"幻觉引文",
  // 单列出来给用户审查)
  const citedRows = []
  const uncitedRows = []
  const hallucinated = [] // cited 但不在 include set
  for (const r of records) {
    const inSections = cited.get(r.id)
    if (inSections && inSections.size > 0) {
      citedRows.push({
        id: r.id, title: r.title || '', year: r.year || null,
        authors_text: r.authors_text || '', journal: r.journal || '',
        in_sections: Array.from(inSections),
      })
    } else {
      uncitedRows.push({
        id: r.id, title: r.title || '', year: r.year || null,
        authors_text: r.authors_text || '', journal: r.journal || '',
      })
    }
  }
  for (const [rid, secs] of cited.entries()) {
    if (!recordById.has(rid)) {
      hallucinated.push({ id: rid, in_sections: Array.from(secs) })
    }
  }

  // 按年份倒序排
  citedRows.sort((a, b) => (b.year || 0) - (a.year || 0))
  uncitedRows.sort((a, b) => (b.year || 0) - (a.year || 0))

  const total_n = records.length
  const cited_n = citedRows.length
  const uncited_n = uncitedRows.length
  return {
    cited:        citedRows,
    uncited:      uncitedRows,
    hallucinated, // [rec_xxx] 出现在正文但不在 include 集合(LLM 编 ID 或 include 后改了)
    cited_n,
    uncited_n,
    hallucinated_n: hallucinated.length,
    total_n,
    coverage_pct: total_n > 0 ? Math.round(cited_n / total_n * 100) : 0,
  }
}

// ------------------------------------------------------------
// 1) loadDraftingOverlay — 跟 loadCertaintyOverlay 同款
// ------------------------------------------------------------
export function loadDraftingOverlay(project) {
  if (!project?.drafting_master_prompt_overlay) return null
  try {
    return JSON.parse(project.drafting_master_prompt_overlay)
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// 2) computeDraftingOverlayStale — 对照 certainty 路由的 stale 检测逻辑
// ------------------------------------------------------------
//
// 输入:
//   overlay                  loadDraftingOverlay 返回(含 system_version + 业务字段)
//   currentSystemVersion     prompts/drafting.js 的 DRAFTING_SYSTEM_VERSION
//   protocolVersion          { protocol_version_at_overlay, current_protocol_version } 双形态:
//                            - 传 number(常见):当作 currentProtocolVersion;at_version 走 overlay.at_version
//                            - 传 { at: number, current: number }:显式指定两端
//
// 返回:{ stale, reason, at_protocol_version, at_system_version }
//   reason ∈ 'protocol_upgraded' | 'system_prompt_upgraded' | 'old_overlay_no_version' | null
export function computeDraftingOverlayStale(overlay, currentSystemVersion, protocolVersion) {
  const out = {
    stale: false,
    reason: null,
    at_protocol_version: null,
    at_system_version: null,
  }
  if (!overlay) return out

  const atSystemVersion = overlay.system_version || null
  out.at_system_version = atSystemVersion

  // protocolVersion 双形态归一化
  let atProtocol = null
  let currentProtocol = null
  if (protocolVersion && typeof protocolVersion === 'object') {
    atProtocol = (protocolVersion.at != null) ? Number(protocolVersion.at) : null
    currentProtocol = (protocolVersion.current != null) ? Number(protocolVersion.current) : null
  } else if (typeof protocolVersion === 'number') {
    currentProtocol = protocolVersion
    atProtocol = (overlay.at_version != null) ? Number(overlay.at_version) : null
  }
  out.at_protocol_version = atProtocol

  const staleByProtocol = !!(
    atProtocol != null && currentProtocol != null && currentProtocol > atProtocol
  )
  const staleByPrompt = !!(
    atSystemVersion && currentSystemVersion && atSystemVersion !== currentSystemVersion
  )
  const staleNoVersion = !atSystemVersion  // 老 overlay 无 system_version 字段 → 视为 stale

  if (staleByProtocol) {
    out.stale = true
    out.reason = 'protocol_upgraded'
  } else if (staleByPrompt) {
    out.stale = true
    out.reason = 'system_prompt_upgraded'
  } else if (staleNoVersion) {
    out.stale = true
    out.reason = 'old_overlay_no_version'
  }
  return out
}

// ------------------------------------------------------------
// 3) buildDraftingInputs — 一次性聚合 Step 8 所有写作需要的数据
// ------------------------------------------------------------
//
// opts:
//   includePdfChunks: bool       透传给 buildSynthesisInputs(高级用户用)
//   includedRecords: Array       可选;不传则自己 query(同 certainty run-themes 路由 SQL)
//
// 返回:
//   {
//     protocol,                  loadApprovedProtocolFull
//     themes,                    loadAllThemesWithMeta(含 grading_framework + Step 6 v2 字段)
//     themeCertainty,            Map<theme_id, latest theme_certainty row>(已 parse rationales JSON)
//     synthesisMeta,             { cross_cutting_observations, protocol_coverage, ... } | null
//     papersByRid,               Map<record_id, { record, matrixData, robData, screeningData }>
//     evidenceByTheme,           Map<theme_id, evidence_points[]>
//     finalQueries,              Array(每库一行 final_search_records)
//     prismaCounts,              computePrismaFlow 返回(PRISMA 2020 flow)
//     journalTemplate,           getJournalTemplate(含 extracted_structure) | null
//     stats: {
//       themes_n, papers_n, evidence_n, with_matrix, with_rob, with_pdf_chunks,
//       framework_split: { grade, cerqual, hybrid }
//     }
//   }
//
// 空项目兜底:所有字段返合理 null / 空 Map / 空 array / 0 stats(不抛错)。
export function buildDraftingInputs(db, projectId, opts = {}) {
  const emptyOut = {
    protocol: null,
    themes: [],
    themeCertainty: new Map(),
    synthesisMeta: null,
    papersByRid: new Map(),
    evidenceByTheme: new Map(),
    finalQueries: [],
    prismaCounts: null,
    journalTemplate: null,
    stats: {
      themes_n: 0, papers_n: 0, evidence_n: 0,
      with_matrix: 0, with_rob: 0, with_pdf_chunks: 0,
      framework_split: { grade: 0, cerqual: 0, hybrid: 0 },
    },
  }
  if (!db || !projectId) return emptyOut

  // includedRecords:不传则自己 query(同 routes/projects/certainty.js run-themes 的 SQL)
  let includedRecords = Array.isArray(opts.includedRecords) ? opts.includedRecords : null
  if (!includedRecords) {
    try {
      includedRecords = db.prepare(
        `SELECT r.id, r.title, r.year, r.journal, r.authors_text, r.authors_json, r.doi, r.abstract
           FROM records r
           JOIN screening_decisions sd ON sd.record_id = r.id
          WHERE r.project_id = ?
            AND sd.stage = 'title_abstract'
            AND sd.human_decision = 'include'
            AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
            AND r.rob_excluded_at IS NULL
          ORDER BY r.year DESC, r.created_at ASC`
      ).all(projectId)
    } catch {
      includedRecords = []
    }
  }

  // 复用 synthesis-helpers 的 papers/matrix/RoB/screening 聚合
  let synth
  try {
    synth = _buildSynthesisInputs(db, projectId, includedRecords, {
      includePdfChunks: !!opts.includePdfChunks,
    })
  } catch {
    synth = { protocol: null, finalQueries: [], papers: [], stats: {} }
  }

  const protocol = synth.protocol || _loadApprovedProtocolFull(db, projectId)

  // themes(含 Step 6 v2 + grading_framework)
  let themes = []
  try { themes = _loadAllThemesWithMeta(db, projectId) || [] } catch { themes = [] }

  // theme_certainty:最新 iteration row,by theme_id
  let themeCertainty = new Map()
  try {
    const certRows = _loadAllThemeCertainty(db, projectId) || []
    themeCertainty = _indexLatestCertaintyByTheme(certRows)
  } catch {
    themeCertainty = new Map()
  }

  // synthesisMeta + evidenceByTheme
  let synthesisMeta = null
  try { synthesisMeta = _loadSynthesisMetaForCertainty(db, projectId) } catch {}
  let evidenceByTheme = new Map()
  try { evidenceByTheme = _loadEvidencePointsByTheme(db, projectId) || new Map() } catch {}

  // papersByRid(从 synth.papers 重新索引)
  const papersByRid = new Map()
  for (const p of synth.papers || []) {
    if (p?.record?.id) papersByRid.set(p.record.id, p)
  }

  // finalQueries(synth 已经拉过,优先复用;若空 fallback 直接查)
  let finalQueries = Array.isArray(synth.finalQueries) ? synth.finalQueries : []
  if (!finalQueries.length) {
    try { finalQueries = _listFinalSearchQueries(db, projectId) || [] } catch { finalQueries = [] }
  }

  // prismaCounts
  let prismaCounts = null
  try { prismaCounts = _computePrismaFlow(db, projectId) } catch { prismaCounts = null }

  // journalTemplate:可能 null(用户没传期刊模板)— 上游 prompt 在 null 时走通用结构
  let journalTemplate = null
  try { journalTemplate = _getJournalTemplate(db, projectId) } catch { journalTemplate = null }

  // framework split + evidence total
  const frameworkSplit = { grade: 0, cerqual: 0, hybrid: 0 }
  for (const t of themes) {
    const f = t.grading_framework || 'hybrid'
    frameworkSplit[f] = (frameworkSplit[f] || 0) + 1
  }
  let evidenceTotal = 0
  for (const arr of evidenceByTheme.values()) evidenceTotal += arr.length

  return {
    protocol,
    themes,
    themeCertainty,
    synthesisMeta,
    papersByRid,
    evidenceByTheme,
    finalQueries,
    prismaCounts,
    journalTemplate,
    stats: {
      themes_n: themes.length,
      papers_n: synth.stats?.total || 0,
      evidence_n: evidenceTotal,
      with_matrix: synth.stats?.withMatrix || 0,
      with_rob: synth.stats?.withRob || 0,
      with_pdf_chunks: synth.stats?.withPdfChunks || 0,
      framework_split: frameworkSplit,
    },
  }
}

// ------------------------------------------------------------
// 4) pickRepresentativeSamplePapers — 给 overlay generation 喂 sample
// ------------------------------------------------------------
//
// 优先(combined score):
//   1. 跨主题分布 — 每个主题至少 1 篇(从该主题 supporting_record_ids 里挑分最高的)
//   2. matrix 完整(fields 数 ≥ 8)— +大量加分
//   3. 年份较新(2023+) — +少量加分
//
// 算法:
//   a) 给所有 paper 算 score:matrixFieldsCount * 10 + (year >= 2023 ? 5 : 0) + (hasRob ? 2 : 0)
//   b) themes 按 supporting_record_ids 长度排序;每个主题挑 score 最高的 1 篇(去重已挑过的)
//   c) 还差就从全局 score top 里补,直到凑齐 n
//
// 返回:array of paper objects(同 papersByRid 的 value shape:{record, matrixData, robData, screeningData})
export function pickRepresentativeSamplePapers(papersByRid, themes, n = 4) {
  if (!papersByRid || papersByRid.size === 0) return []
  const N = Math.max(1, n | 0)

  const scoreOf = (p) => {
    if (!p) return 0
    let s = 0
    const fieldsCount = (p.matrixData?.fields && typeof p.matrixData.fields === 'object')
      ? Object.keys(p.matrixData.fields).length : 0
    s += fieldsCount * 10
    if (fieldsCount >= 8) s += 20  // 完整 matrix 大幅加分
    const y = Number(p.record?.year)
    if (Number.isFinite(y) && y >= 2023) s += 5
    if (p.robData) s += 2
    return s
  }

  const picked = new Map()  // rid → paper

  // 阶段 1:跨主题分布 — 主题按支持论文数排序(覆盖大主题优先),每主题挑 1 篇
  if (Array.isArray(themes) && themes.length) {
    const themesSorted = [...themes].sort((a, b) =>
      (b.supporting_record_ids?.length || 0) - (a.supporting_record_ids?.length || 0)
    )
    for (const t of themesSorted) {
      if (picked.size >= N) break
      const candidates = []
      for (const rid of (t.supporting_record_ids || [])) {
        if (picked.has(rid)) continue
        const p = papersByRid.get(rid)
        if (p) candidates.push({ rid, p, s: scoreOf(p) })
      }
      candidates.sort((a, b) => b.s - a.s)
      if (candidates.length) picked.set(candidates[0].rid, candidates[0].p)
    }
  }

  // 阶段 2:还差就从全局 score top 里补
  if (picked.size < N) {
    const all = []
    for (const [rid, p] of papersByRid.entries()) {
      if (picked.has(rid)) continue
      all.push({ rid, p, s: scoreOf(p) })
    }
    all.sort((a, b) => b.s - a.s)
    for (const c of all) {
      if (picked.size >= N) break
      picked.set(c.rid, c.p)
    }
  }

  return Array.from(picked.values())
}

// ------------------------------------------------------------
// 5) buildCitableRecords — LLM 引文 cheat-sheet 用
// ------------------------------------------------------------
//
// 返回:array of records(取所有 include + 非 post-RoB-excluded + 非 dup 的 records)
//   字段:{ id, title, year, authors_text, authors_json, doi, journal }
//   排序:year DESC, created_at ASC(新论文优先)
//   上限:MAX_CITABLE_RECORDS(200)
//
// 用于 buildCitationCheatSheet / 给 LLM 写作时挑可引文献(防 LLM 编造引文)。
export function buildCitableRecords(db, projectId) {
  if (!db || !projectId) return []
  try {
    return db.prepare(
      `SELECT r.id, r.title, r.year, r.authors_text, r.authors_json, r.doi, r.journal
         FROM records r
         JOIN screening_decisions sd ON sd.record_id = r.id
        WHERE r.project_id = ?
          AND sd.stage = 'title_abstract'
          AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
          AND r.rob_excluded_at IS NULL
        ORDER BY r.year DESC, r.created_at ASC
        LIMIT ?`
    ).all(projectId, MAX_CITABLE_RECORDS) || []
  } catch {
    return []
  }
}

// ============================================================
// Phase C — figure / table manifest 构造器
// ============================================================
//
// 把 table-registry 派生的 15 张表 + figure_assets 已上传图(+ 系统 PRISMA 图)
// 折成 buildSectionUserPrompt 用的 manifest 形态:
//   availableTables = [{ key, label, description, intended_section,
//                        row_count, subtable_count }, ...]
//   availableFigures = [{ id, title, intended_section, source }, ...]
//
// 排除规则:
//   - row_count === 0 / subtable 全空的表(避免 LLM 引空表)
//   - 没 derive 出 columns/rows 也没 subtables 的表
//
// figure id 约定:
//   - 'prisma'                                — 系统 Mermaid PRISMA flow
//   - figure_assets.id(figasset_xxxxxxxx)    — 用户上传图
//   (AI-recommended 但未上传的不进 manifest;让 LLM 不引"空槽位")
//
// 不抛错;任何子失败静默吞掉,返回该维度的空数组。
//
// @param {object|null} tableDefs              getAllTableDefs() 返回(数组)
// @param {object|null} tablesData             buildAllRegisteredTables() 返回({key: data})
// @param {Array}       figureAssets           listFigureAssets() 返回
// @param {object}      [opts]
// @param {boolean}     [opts.includePrismaFigure=false]  把 [fig:prisma] 视为可引图(默认 false)
//   2026-05-26:默认 false — PRISMA flow 已由 export 路由自动渲染在 Methods/Results 之间,
//   不应让 LLM 在正文里 `[fig:prisma]` 引用(否则 3 处重复)。
// @returns {{ availableTables: Array, availableFigures: Array }}
export function buildFigTblManifest(tableDefs, tablesData, figureAssets, opts = {}) {
  const includePrisma = opts.includePrismaFigure === true
  // N5 — 可选:T3 LLM polish 后的 cache(polished caption + paragraph_lead 注入到 manifest 让
  //   buildSectionUserPrompt 能让 section LLM 引用 polish 后的出版级文字)
  // 形态:{ [tableKey]: { polished_caption, polished_paragraph_lead, ... } | null }
  const polishedByKey = opts.polishedByKey && typeof opts.polishedByKey === 'object' ? opts.polishedByKey : null

  const availableTables = []
  if (Array.isArray(tableDefs) && tablesData && typeof tablesData === 'object') {
    for (const def of tableDefs) {
      if (!def || !def.key) continue
      const data = tablesData[def.key]
      if (!data) continue

      // 三种数据形态:
      //   1) multi_subtable=true → { subtables: [{rows, ...}, ...] }
      //   2) {columns, rows}    → 单表
      //   3) 其它/空            → 跳过
      let rowCount = 0
      let subtableCount = 0
      if (Array.isArray(data.subtables)) {
        subtableCount = data.subtables.length
        for (const sub of data.subtables) {
          if (Array.isArray(sub?.rows)) rowCount += sub.rows.length
        }
      } else if (Array.isArray(data.rows)) {
        rowCount = data.rows.length
      } else {
        continue
      }
      if (rowCount === 0) continue   // 空表不进 manifest

      // N5:若该表有 LLM polish 结果,把 polished_caption / paragraph_lead 注入 manifest
      //   section LLM 写作时可直接引用(更出版级,比 def.label 强)
      const polished = polishedByKey ? polishedByKey[def.key] : null
      const polishedCaption = (polished && typeof polished.polished_caption === 'string' && polished.polished_caption.trim())
        ? polished.polished_caption.trim() : null
      const polishedParaLead = (polished && typeof polished.polished_paragraph_lead === 'string' && polished.polished_paragraph_lead.trim())
        ? polished.polished_paragraph_lead.trim() : null

      availableTables.push({
        key: def.key,
        label: polishedCaption || def.label || def.key,  // polished 覆盖 label
        description: def.description || '',
        intended_section: def.intended_section || '',
        row_count: rowCount,
        subtable_count: subtableCount,
        // N5 新加字段(对老 caller 无影响)
        polished_caption: polishedCaption,         // 若 null 表示未精修;manifest 渲染时按需引用
        polished_paragraph_lead: polishedParaLead, // 段落 lead;section LLM 可直接拼到引用上下文
      })
    }
  }

  const availableFigures = []
  // 2026-05-26:**默认不把 PRISMA flow 放进 manifest** — 因为它由 export 路由
  //   自动在 Methods 和 Results 之间渲染为 `### PRISMA Flow Diagram` + mermaid 块,
  //   不需要 LLM 在正文里 `[fig:prisma]` 引用(否则会重复 3 处:auto-render + 正文
  //   "Figure 1" 替换 + Figures appendix)。
  //   保留参数(默认 false)以备特殊场景需要时强制开启。
  if (includePrisma === true) {
    availableFigures.push({
      id: 'prisma',
      title: 'PRISMA Flow Diagram',
      intended_section: 'methods',
      source: 'prisma',
    })
  }
  if (Array.isArray(figureAssets)) {
    for (const a of figureAssets) {
      if (!a || !a.id) continue
      availableFigures.push({
        id: a.id,                                // figasset_xxxxxxxxxx
        title: a.caption || a.alt_text || a.original_filename || '(uploaded figure)',
        intended_section: a.intended_section || '',
        source: 'uploaded',
      })
    }
  }

  return { availableTables, availableFigures }
}
