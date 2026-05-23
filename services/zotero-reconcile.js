/**
 * Zotero 包二次匹配(reconciliation)
 * ------------------------------------------------------------
 * Step 3 用户上传 Excel/CSV → AI 初筛 → 用户决定 include/exclude/uncertain。
 * Step 4 用户(advanced_extraction_enabled)上传 Zotero zip 包 → 解析。
 *
 * 一个直觉:用户在 Zotero 里整理过的文献,通常已经过他自己的人工筛选 —
 * 这跟系统里已 include 的论文应该高度重合。但二者来源不同(CSV 元数据 vs
 * Zotero RDF),不能简单"再插一份" — 否则会出现两条记录指代同一篇文献。
 *
 * 因此 ingest 之后,我们在系统已 include 的 records 与 Zotero 包里解析出
 * 的论文之间做一次"二次匹配",分三组报告:
 *   - matched          双方都有 → 后续 merge 步骤补字段(abstract、PDF)
 *   - extra_in_zotero  Zotero 有但系统没纳入 → 提示用户人工复核(可能漏)
 *   - extra_in_system  系统纳入但 Zotero 没传 → 提示用户(可能 Zotero 漏)
 *
 * 匹配策略(由强到弱,任一命中即视为一致):
 *   1) DOI 完全相等(normalizeDoi:小写、剥前缀、去尾部空白)
 *   2) normalized_title + 第一作者姓 都相等
 *   3) normalized_title + year 都相等(同年同题不太可能不是同篇)
 */

import { normalizeTitle, normalizeDoi } from './dedup.js'

/** 从 'Wang G, Tang R, Xu M' 取第一作者姓(lowercase) */
function firstAuthorSurname(authorsText) {
  if (!authorsText) return ''
  const first = String(authorsText).split(',')[0].trim()
  const m = first.match(/^(\S+)/)
  return m ? m[1].toLowerCase() : ''
}

/** 把一个 zotero parse 结果项归一化到比对用结构。来自 parseZoteroRdf().records 的元素 */
function normalizeZoteroRecord(z) {
  const title = z.title || ''
  const normTitle = normalizeTitle(title)
  const normDoi = normalizeDoi(z.doi || '')
  // zotero parse 结果里 authors 是结构化的;取第一个 surname,fallback authors_text
  let surname = ''
  if (Array.isArray(z.authors) && z.authors.length > 0) {
    const a0 = z.authors[0]
    if (a0 && a0.surname) surname = String(a0.surname).toLowerCase()
  }
  if (!surname) surname = firstAuthorSurname(z.authors_text || '')
  return {
    raw: z,
    title,
    normalized_title: normTitle,
    normalized_doi: normDoi,
    year: z.year || null,
    first_author_surname: surname,
  }
}

/** 把 DB 里的 system record 行归一化到比对用结构 */
function normalizeSystemRecord(r) {
  return {
    raw: r,
    id: r.id,
    title: r.title || '',
    normalized_title: r.normalized_title || normalizeTitle(r.title || ''),
    normalized_doi: normalizeDoi(r.doi || ''),
    year: r.year || null,
    first_author_surname: firstAuthorSurname(r.authors_text || ''),
  }
}

/**
 * 跑二次匹配。
 *
 * @param {object} db better-sqlite3 实例
 * @param {{ projectId:string, packageId:string, zoteroRecords:Array }} opts
 *   zoteroRecords 是 parseZoteroRdf() 返回的 records[] 中间数据
 *   (不是已经写进 DB 的 records 行 — 我们要的就是这份"原汁原味"信息以便合并)
 *
 * @returns {{
 *   matched: Array<{ system_record_id:string, zotero_record:object, match_type:'doi'|'title_author'|'title_year', score:number }>,
 *   extra_in_zotero: Array<object>,   // zotero parse 原始记录
 *   extra_in_system: Array<object>,   // system records 行(已 include 但 zotero 没覆盖)
 *   stats: { included_count:number, zotero_count:number, matched_count:number, by_match_type:Record<string,number> },
 * }}
 */
export function reconcilePackage(db, { projectId, packageId, zoteroRecords }) {
  if (!projectId) throw new Error('projectId required')
  if (!Array.isArray(zoteroRecords)) {
    throw new Error('zoteroRecords must be an array')
  }
  // packageId 当前仅用于审计 / 未来扩展;主流程不依赖它。
  void packageId

  // ---- 拉系统中所有"已 include"的 records ----
  // 同 services/literature-matrix.js 里 listIncludedRecords 的口径:
  // human_decision='include' + 排除已被去重合并的副本。
  // stage 不限(title_abstract 或 full_text 都算 include)。
  const includedRows = db
    .prepare(
      `SELECT r.id, r.title, r.normalized_title, r.doi, r.authors_text, r.year,
              r.journal, r.abstract, r.keywords_json, r.has_pdf
         FROM records r
        INNER JOIN screening_decisions sd
           ON sd.record_id = r.id
          AND sd.project_id = r.project_id
          AND sd.human_decision = 'include'
        WHERE r.project_id = ?
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
        GROUP BY r.id`
    )
    .all(projectId)

  const systemNorm = includedRows.map(normalizeSystemRecord)
  const zoteroNorm = zoteroRecords.map(normalizeZoteroRecord)

  // ---- 建索引(系统侧) ----
  // 同一个 normalized_title 在系统里可能有 0/1/多条 — 都收下,匹配时再选最优。
  const sysByDoi = new Map()           // normDoi → systemNormItem
  const sysByTitle = new Map()         // normTitle → systemNormItem[]
  for (const s of systemNorm) {
    if (s.normalized_doi) {
      // DOI 冲突的话(理论上去重已经合并),保留先到的 — 后到的也能从 title 走匹配。
      if (!sysByDoi.has(s.normalized_doi)) sysByDoi.set(s.normalized_doi, s)
    }
    if (s.normalized_title) {
      if (!sysByTitle.has(s.normalized_title)) sysByTitle.set(s.normalized_title, [])
      sysByTitle.get(s.normalized_title).push(s)
    }
  }

  const matched = []
  const matchedSystemIds = new Set()
  const matchedZoteroIdx = new Set()
  const byMatchType = { doi: 0, title_author: 0, title_year: 0 }

  // ---- Pass 1:DOI 完全相等(强度最高) ----
  zoteroNorm.forEach((z, idx) => {
    if (!z.normalized_doi) return
    const s = sysByDoi.get(z.normalized_doi)
    if (!s) return
    if (matchedSystemIds.has(s.id)) return // 同一个系统 record 不重复 match
    matched.push({
      system_record_id: s.id,
      zotero_record: z.raw,
      match_type: 'doi',
      score: 1.0,
    })
    matchedSystemIds.add(s.id)
    matchedZoteroIdx.add(idx)
    byMatchType.doi++
  })

  // ---- Pass 2:normalized_title + first author surname ----
  zoteroNorm.forEach((z, idx) => {
    if (matchedZoteroIdx.has(idx)) return
    if (!z.normalized_title || !z.first_author_surname) return
    const candidates = sysByTitle.get(z.normalized_title)
    if (!candidates) return
    for (const s of candidates) {
      if (matchedSystemIds.has(s.id)) continue
      if (!s.first_author_surname) continue
      if (s.first_author_surname !== z.first_author_surname) continue
      matched.push({
        system_record_id: s.id,
        zotero_record: z.raw,
        match_type: 'title_author',
        score: 0.9,
      })
      matchedSystemIds.add(s.id)
      matchedZoteroIdx.add(idx)
      byMatchType.title_author++
      break
    }
  })

  // ---- Pass 3:normalized_title + year(同年同题) ----
  zoteroNorm.forEach((z, idx) => {
    if (matchedZoteroIdx.has(idx)) return
    if (!z.normalized_title || z.year == null) return
    const candidates = sysByTitle.get(z.normalized_title)
    if (!candidates) return
    for (const s of candidates) {
      if (matchedSystemIds.has(s.id)) continue
      if (s.year == null) continue
      if (s.year !== z.year) continue
      matched.push({
        system_record_id: s.id,
        zotero_record: z.raw,
        match_type: 'title_year',
        score: 0.8,
      })
      matchedSystemIds.add(s.id)
      matchedZoteroIdx.add(idx)
      byMatchType.title_year++
      break
    }
  })

  // ---- 剩下未配对的两边各自列出 ----
  const extra_in_zotero = []
  zoteroNorm.forEach((z, idx) => {
    if (matchedZoteroIdx.has(idx)) return
    extra_in_zotero.push(z.raw)
  })

  const extra_in_system = systemNorm
    .filter((s) => !matchedSystemIds.has(s.id))
    .map((s) => s.raw)

  return {
    matched,
    extra_in_zotero,
    extra_in_system,
    stats: {
      included_count: includedRows.length,
      zotero_count: zoteroRecords.length,
      matched_count: matched.length,
      by_match_type: byMatchType,
    },
  }
}
