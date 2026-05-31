/**
 * Phase 9 · Agent U — WoS / Scopus / PubMed CSV ingest 服务
 * ------------------------------------------------------------
 * 把第三方文献库导出的 CSV 解析成统一记录格式,写入 records 表,
 * 复用 services/dedup.js 的 normalize 规则做 project 内去重。
 *
 * 三个公开入口:
 *   detectFormat(csvText) → 'wos' | 'scopus' | 'pubmed' | 'unknown'
 *   parseCsv(csvText, format) → [{ title, authors_text, year, journal, doi, abstract, keywords[] }]
 *   ingestCsv(db, { projectId, userId, csvText, sourceFilename })
 *     → { format, total_parsed, total_inserted, total_duplicates, errors }
 *
 * 不依赖第三方 CSV 包 —— 手写 parser(支持引号 / 转义引号 / CRLF / BOM / 中文)。
 *
 * 三种导出格式差异(我们识别表头并归一化):
 *   WoS:    可能是 tab-separated(默认导出格式)或 comma-separated。
 *           典型字段:AU, TI, SO, PY, AB, DI / DOI, DE / Author Keywords, DT...
 *           也可能是完整字段名:Authors, Article Title, Source Title, Publication Year, ...
 *   Scopus: comma-separated, 表头第一行通常是:
 *           Authors,Title,Year,Source title,Cited by,DOI,Link,Abstract,Author Keywords,...
 *   PubMed: comma-separated, "Send To: → File → CSV" 导出格式:
 *           PMID,Title,Authors,Citation,First Author,Journal/Book,Publication Year,Create Date,PMCID,NIHMS ID,DOI
 */

import { normalizeDoi, normalizeTitle, dedupProject } from './dedup.js'
import { randomId } from './crypto.js'

// ---------- BOM / 编码工具 ----------

/** 剥 UTF-8 BOM(EF BB BF / U+FEFF)。Node 读 utf-8 时会把它解码成 ﻿。 */
function stripBom(s) {
  if (!s) return s
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1)
  return s
}

// ---------- 自写 CSV parser ----------

/**
 * 解析整段 CSV 文本,返回二维数组 rows[][cell]。
 * 支持:
 *   - 自定义分隔符(',' 或 '\t')
 *   - 字段被双引号包裹(内部可包含分隔符 / 换行)
 *   - 字段内转义引号:""  → "
 *   - 行尾 CRLF / LF / CR
 *   - 文件开头 UTF-8 BOM
 *
 * 不处理:转义反斜杠(标准 CSV 不需要)、单引号包裹(非标准)。
 *
 * 复杂度 O(n),~50 行核心循环,适用 ≤50MB 单文件同步处理。
 */
export function parseCsvText(text, delimiter = ',') {
  const src = stripBom(String(text == null ? '' : text))
  const rows = []
  let row = []
  let field = ''
  let i = 0
  let inQuotes = false
  const n = src.length

  while (i < n) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        // 看下一个:连续两个 "" 是转义,否则结束引号
        if (i + 1 < n && src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    // 非引号状态
    if (ch === '"') {
      // 只在字段开头时才进入引号状态;字段中间的裸 " 当成字面量字符
      if (field.length === 0) {
        inQuotes = true
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === delimiter) {
      row.push(field)
      field = ''
      i += 1
      continue
    }

    // 行结束:\r\n / \n / \r
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      // 吃掉 \r\n 的 \n
      if (ch === '\r' && i + 1 < n && src[i + 1] === '\n') i += 2
      else i += 1
      continue
    }

    field += ch
    i += 1
  }

  // flush 最后一个字段 / 行(如果文件不以换行结尾)
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  // 把每个 cell trim 一下空白(常见 Scopus / WoS 在 cell 末尾留空格)
  return rows.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)))
}

/**
 * 自动检测分隔符。统计第一行(去 BOM)里 ',' vs '\t' 出现次数,取多者。
 * 若都没有,默认 ','。
 */
function detectDelimiter(text) {
  const s = stripBom(String(text || ''))
  // 找第一行
  let firstLine = s
  const nl = s.search(/\r?\n/)
  if (nl >= 0) firstLine = s.slice(0, nl)
  // 注意:第一行可能本身就被引号截开 — 我们只数引号外的字符
  let tabs = 0
  let commas = 0
  let inQ = false
  for (let i = 0; i < firstLine.length; i++) {
    const c = firstLine[i]
    if (c === '"') {
      if (i + 1 < firstLine.length && firstLine[i + 1] === '"') {
        i += 1
        continue
      }
      inQ = !inQ
      continue
    }
    if (inQ) continue
    if (c === '\t') tabs += 1
    else if (c === ',') commas += 1
  }
  return tabs > commas ? '\t' : ','
}

// ---------- 格式识别 ----------

/**
 * 三种格式的表头签名(全部小写比较;字段名前后空格被 trim 后比对)。
 * 命中策略:
 *   - PubMed: 第一列是 'pmid' 或 'pubmedid' / pubmed_id;表头里有 'pmcid' 或 'first author'
 *   - WoS:   表头是 2 字母代码集(AU/TI/SO/PY 等)中任意 3 个命中,
 *            或表头里有 'article title' 且 source title / publication year 字段名风格
 *   - Scopus: 表头含 'authors' + 'title' + ('source title' 或 'cited by')
 */
const WOS_2L_SET = new Set([
  'pt', 'au', 'af', 'ti', 'so', 'la', 'dt', 'de', 'id', 'ab',
  'c1', 'rp', 'cr', 'nr', 'tc', 'pu', 'pi', 'pa', 'sn', 'ei',
  'j9', 'ji', 'pd', 'py', 'vl', 'is', 'bp', 'ep', 'di', 'pg',
  'wc', 'sc', 'ga', 'ut', 'da',
])

function lower(s) { return String(s || '').trim().toLowerCase() }

export function detectFormat(csvText) {
  const text = stripBom(String(csvText || ''))
  if (!text.trim()) return 'unknown'
  const delim = detectDelimiter(text)
  const rows = parseCsvText(text, delim)
  if (rows.length === 0) return 'unknown'
  const header = rows[0].map(lower)
  if (header.length === 0) return 'unknown'

  // ---- PubMed ----
  // PubMed CSV 导出第一列固定是 PMID
  const first = header[0]
  if (first === 'pmid' || first === 'pubmedid' || first === 'pubmed_id') return 'pubmed'
  if (header.includes('pmcid') && header.includes('title')) return 'pubmed'
  if (header.includes('first author') && header.includes('publication year')) return 'pubmed'

  // ---- WoS 2-letter codes ----
  // 如果表头里有 >=3 个 2 字母代码命中 WOS_2L_SET,认为是 WoS
  let wos2lHits = 0
  for (const h of header) {
    if (h.length === 2 && WOS_2L_SET.has(h)) wos2lHits += 1
  }
  if (wos2lHits >= 3) return 'wos'

  // WoS 也有"完整字段名"导出格式
  if (
    (header.includes('article title') || header.includes('title')) &&
    header.includes('source title') &&
    (header.includes('publication year') || header.includes('year published'))
  ) {
    return 'wos'
  }

  // ---- Scopus ----
  if (
    header.includes('authors') &&
    header.includes('title') &&
    (header.includes('source title') || header.includes('cited by') || header.includes('author keywords'))
  ) {
    return 'scopus'
  }

  return 'unknown'
}

// ---------- 字段映射 ----------

/**
 * 把一行(数组)+ header(数组)归一化成 record 对象。
 * 不同格式调用不同 mapper。
 */

function rowToMap(header, row) {
  // 用 lowercase header 作 key
  const m = {}
  for (let i = 0; i < header.length; i++) {
    const k = lower(header[i])
    const v = row[i] == null ? '' : String(row[i])
    // 多列同名时不覆盖前者(以前者为准),但通常没有
    if (!(k in m)) m[k] = v
  }
  return m
}

function pick(m, ...keys) {
  for (const k of keys) {
    if (m[k] != null && m[k] !== '') return m[k]
  }
  return ''
}

function parseYearFrom(s) {
  if (!s) return null
  const t = String(s)
  const mm = t.match(/\b(19|20|21)\d{2}\b/)
  if (!mm) return null
  const y = parseInt(mm[0], 10)
  if (y < 1500 || y > 2100) return null
  return y
}

/** 把 'kw1; kw2; kw3' / 'kw1, kw2' / 'kw1|kw2' 分裂成数组 */
function splitKeywords(s) {
  if (!s) return []
  const parts = String(s)
    .split(/[;|]|,\s+(?=[A-Z一-鿿])/) // 分号 / 竖线 优先;逗号 + 大写或中文(避免拆"Wang, G")
    .map((x) => x.trim())
    .filter(Boolean)
  // 去重(保留顺序)
  const seen = new Set()
  const out = []
  for (const p of parts) {
    const k = p.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

// ============================================================
// 2026-05-25 BUG FIX:作者名解析
// ------------------------------------------------------------
// 之前的 bug:
//   - WoS 把 'Wang, Gang' 强行砍成 'Wang G'(丢了完整 given name)
//   - 输出只有 authors_text(没拆 surname / givenName)
//   - 下游 citation-format normalizeRecord 把 "Wang G" 按空格 split 后,
//     最后一个 token "G" 被当成 surname,前面 "Wang" 当 givenName → 完全反了
//   - 最终引文里作者名 garbled(看起来"只有首字母"或姓名颠倒)
//
// 修复后每个 parser 返回 { authors: [{surname, givenName, full, type}], authors_text }
// authors 数组直接落 records.authors_json,引文输出走结构化路径,正确。
// authors_text 保留(用作 display + screening prompt)。
// ============================================================

/** 把单个 author string 拆成 {surname, givenName} */
function splitAuthorName(s, opts = {}) {
  if (!s) return null
  const raw = String(s).trim()
  if (!raw) return null
  // 机构作者(含 "Group" / "Society" / "&" 等)
  if (/\b(Group|Society|Consortium|Collaboration|Association|Committee|Organization)\b/i.test(raw)) {
    return { surname: '', givenName: '', full: raw, type: 'organization' }
  }
  // 形式 A: "Surname, Given" (WoS / Scopus AF / Zotero)
  //   - "Wang, Gang"
  //   - "Wang, G"
  //   - "Wang, G. K."
  let m = raw.match(/^([^,]+),\s*(.+?)\.?$/)
  if (m) {
    const surname = m[1].trim()
    const given = m[2].trim().replace(/\.$/, '')
    if (surname) {
      return {
        surname,
        givenName: given,
        full: given ? `${surname}, ${given}` : surname,
        type: 'person',
      }
    }
  }
  // 形式 B: "Surname Initials"  e.g. "Wang G", "Wang GK", "Wang G K"
  //   姓在前 + 后面跟 1-3 个大写首字母(可能有点/空格)
  m = raw.match(/^([^\s]+(?:\s[^\s]+)*?)\s+([A-Z](?:\.?\s?[A-Z]\.?){0,3})\.?$/)
  if (m) {
    const surname = m[1].trim()
    const initials = m[2].replace(/\./g, '').replace(/\s+/g, '')
    return {
      surname,
      givenName: initials,
      full: `${surname}, ${initials}`,
      type: 'person',
    }
  }
  // 形式 C: 完整名字 "Given Surname" 或单 token — fallback
  const parts = raw.replace(/\.$/, '').split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    return { surname: parts[0], givenName: '', full: parts[0], type: 'person' }
  }
  // 多 token:在 opts.lastIsSurname 时把最后一个当 surname,否则把第一个当 surname
  //   WoS/Scopus 通常 Surname 在前 → 把第一个当 surname(对 "Wang Gang Kun" 也对)
  //   但 PubMed 偶尔 "Gang Wang" → 启发式:如果第一个 token 是 1-3 个大写字母,认为是 initials,
  //   surname 在后
  const isInitial = /^[A-Z]{1,3}\.?$/.test(parts[0])
  if (isInitial) {
    return {
      surname: parts[parts.length - 1],
      givenName: parts.slice(0, -1).join(' ').replace(/\./g, ''),
      full: raw,
      type: 'person',
    }
  }
  return {
    surname: parts[0],
    givenName: parts.slice(1).join(' '),
    full: raw,
    type: 'person',
  }
}

/** WoS:优先用 AF (Author Full Names) = "Wang, Gang; Tang, Rong",fallback AU = "Wang, G; Tang, R" */
function parseWosAuthors(s) {
  if (!s) return []
  return String(s).split(/;/).map(x => x.trim()).filter(Boolean).map(splitAuthorName).filter(Boolean)
}

/** Scopus:'Wang G., Tang R., Xu M.' — 在逗号 + 大写处拆 */
function parseScopusAuthors(s) {
  if (!s) return []
  return String(s).split(/,\s*(?=[A-Z一-鿿])/)
    .map(x => x.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .map(splitAuthorName).filter(Boolean)
}

/** PubMed:'Wang G, Tang R, Xu M' */
function parsePubmedAuthors(s) {
  if (!s) return []
  return String(s).split(/,/).map(x => x.trim()).filter(Boolean).map(splitAuthorName).filter(Boolean)
}

/** authors array → "Surname G, Surname2 G2" 风格的 display string */
function authorsToDisplayText(authors) {
  return authors
    .map(a => {
      if (a.type === 'organization') return a.full
      if (a.surname && a.givenName) {
        const init = a.givenName.replace(/[^A-Za-z一-鿿]/g, '').slice(0, 3).toUpperCase()
        return init ? `${a.surname} ${init}` : a.surname
      }
      return a.surname || a.full || ''
    })
    .filter(Boolean)
    .join(', ')
}

// 老 API 兼容(本文件其他地方还会调)— 仍然返回 display string,但内部走新的 parser
function normalizeWosAuthors(s)    { return authorsToDisplayText(parseWosAuthors(s)) }
function normalizeScopusAuthors(s) { return authorsToDisplayText(parseScopusAuthors(s)) }
function normalizePubmedAuthors(s) { return authorsToDisplayText(parsePubmedAuthors(s)) }

function mapWosRow(m) {
  // 2 字母代码 ↔ 完整字段名 两种来源都接
  const title = pick(m, 'ti', 'article title', 'title')
  // 2026-05-25 BUG FIX:优先用 AF (Author Full Names) = "Wang, Gang; Tang, Rong"
  //   只在没 AF 时才退到 AU (= "Wang, G"),最大程度保住完整 given name。
  const authorsFull   = pick(m, 'af', 'author full names')
  const authorsInit   = pick(m, 'au', 'authors', 'author(s)')
  const authorsRaw    = authorsFull || authorsInit
  const journal = pick(m, 'so', 'source title', 'journal')
  const yearRaw = pick(m, 'py', 'publication year', 'year published', 'year')
  const doi = pick(m, 'di', 'doi')
  const abstract = pick(m, 'ab', 'abstract')
  const keywords = pick(m, 'de', 'author keywords', 'id', 'keywords plus', 'keywords')
  const language = pick(m, 'la', 'language', 'languages')
  // 新加:volume / issue / pages — M35 加列后导出引文需要
  const volume = pick(m, 'vl', 'volume')
  const issue  = pick(m, 'is', 'issue')
  const pages  = pick(m, 'pg', 'page range', 'pages') || (pick(m, 'bp', 'beginning page') && pick(m, 'ep', 'ending page') ? `${pick(m,'bp','beginning page')}-${pick(m,'ep','ending page')}` : '')
  const authors = parseWosAuthors(authorsRaw)
  return {
    title: title || '',
    authors,
    authors_text: authorsToDisplayText(authors),
    year: parseYearFrom(yearRaw),
    journal: journal || '',
    doi: doi || '',
    abstract: abstract || '',
    keywords: splitKeywords(keywords),
    language: language || '',
    volume: volume || '',
    issue: issue || '',
    pages: pages || '',
  }
}

function mapScopusRow(m) {
  const title = pick(m, 'title', 'article title')
  // Scopus "Author full names" 字段比 "Authors" 更全(含中间名)— 优先用
  const authorsFull = pick(m, 'author full names')
  const authorsInit = pick(m, 'authors')
  const authorsRaw  = authorsFull || authorsInit
  const journal = pick(m, 'source title', 'journal')
  const yearRaw = pick(m, 'year', 'publication year')
  const doi = pick(m, 'doi')
  const abstract = pick(m, 'abstract')
  const keywords = pick(m, 'author keywords', 'index keywords', 'keywords')
  // Scopus 字段是 "Language of Original Document"
  const language = pick(m, 'language of original document', 'language', 'languages')
  const volume = pick(m, 'volume')
  const issue  = pick(m, 'issue')
  const pages  = pick(m, 'page range', 'pages') || (pick(m, 'page start') && pick(m, 'page end') ? `${pick(m,'page start')}-${pick(m,'page end')}` : '')
  const authors = parseScopusAuthors(authorsRaw)
  return {
    title: title || '',
    authors,
    authors_text: authorsToDisplayText(authors),
    year: parseYearFrom(yearRaw),
    journal: journal || '',
    doi: doi || '',
    abstract: abstract || '',
    keywords: splitKeywords(keywords),
    language: language || '',
    volume: volume || '',
    issue: issue || '',
    pages: pages || '',
  }
}

function mapPubmedRow(m) {
  const title = pick(m, 'title')
  const authorsRaw = pick(m, 'authors')
  const journal = pick(m, 'journal/book', 'journal', 'journal/book ')
  const yearRaw = pick(m, 'publication year', 'year')
  const doi = pick(m, 'doi')
  // PubMed CSV 一般不带 abstract / keywords / language;language 一般要去 PubMed [Language] 字段
  const language = pick(m, 'language', 'languages')
  // PubMed CSV 的 Citation 字段含 vol/issue/pages 但格式不固定;先不抽,留空
  const authors = parsePubmedAuthors(authorsRaw)
  return {
    title: title || '',
    authors,
    authors_text: authorsToDisplayText(authors),
    year: parseYearFrom(yearRaw),
    journal: journal || '',
    doi: doi || '',
    abstract: '',
    keywords: [],
    language: language || '',
    volume: '',
    issue: '',
    pages: '',
  }
}

const MAPPERS = {
  wos: mapWosRow,
  scopus: mapScopusRow,
  pubmed: mapPubmedRow,
}

// ---------- 主入口:解析 ----------

/**
 * 解析 csvText 为统一记录列表。
 * @param {string} csvText
 * @param {'wos'|'scopus'|'pubmed'} format
 * @returns {Array<{ title, authors_text, year, journal, doi, abstract, keywords:string[] }>}
 */
export function parseCsv(csvText, format) {
  if (!csvText || !format || !MAPPERS[format]) return []
  const text = stripBom(String(csvText))
  const delim = detectDelimiter(text)
  const rows = parseCsvText(text, delim)
  if (rows.length < 2) return []
  const header = rows[0]
  const mapper = MAPPERS[format]
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    // 空行 / 全空 cell 跳过
    if (!r || r.length === 0) continue
    if (r.every((c) => !c || !String(c).trim())) continue
    const m = rowToMap(header, r)
    try {
      const rec = mapper(m)
      // 没标题且没 DOI 就跳过(等同空行)
      if (!rec.title && !rec.doi) continue
      out.push(rec)
    } catch {
      // 单行解析失败就跳过,不阻塞整体
    }
  }
  return out
}

// ---------- 持久化 + 去重 ----------

/**
 * 把 csvText 解析后落入 records 表。
 * 去重策略(同 project 内):
 *   - DOI normalize 后已存在 → 跳过(duplicate++)
 *   - normalized_title 已存在(且 DOI 都为空)→ 跳过(duplicate++)
 *
 * 注:这里只在"入库前"做去重,避免重复行。已经入库的同源 record(Zotero 包 / 上次 CSV)也会被识别。
 * 入库后不再调 dedupProject —— 那个是全量重跑、按组写 duplicate_group_id 的。
 *
 * @returns {{ format, total_parsed, total_inserted, total_duplicates, errors:string[] }}
 */
export function ingestCsv(db, { projectId, userId, csvText, sourceFilename }) {
  const errors = []
  if (!projectId) throw new Error('projectId required')
  if (!csvText || typeof csvText !== 'string') {
    return { format: 'unknown', total_parsed: 0, total_inserted: 0, total_duplicates: 0, errors: ['empty csv'] }
  }

  const format = detectFormat(csvText)
  if (format === 'unknown') {
    return { format: 'unknown', total_parsed: 0, total_inserted: 0, total_duplicates: 0, errors: ['unrecognized CSV format'] }
  }

  const parsed = parseCsv(csvText, format)
  const totalParsed = parsed.length

  if (totalParsed === 0) {
    return { format, total_parsed: 0, total_inserted: 0, total_duplicates: 0, errors: ['no data rows parsed'] }
  }

  // 预取本 project 内已有 DOI / normalized_title → record_id + 已有 source_databases
  // 用于:① 去重(同 DOI 或同 normalized_title 视为重复);② merge source_databases。
  const existingByDoi = new Map()     // doi(lower) → { id, source_databases:Set<string> }
  const existingByTitle = new Map()   // normalized_title → { id, source_databases:Set<string> }
  const existingRows = db
    .prepare(`SELECT id, doi, normalized_title, source_databases FROM records WHERE project_id = ?`)
    .all(projectId)
  for (const r of existingRows) {
    const dbs = parseDbSet(r.source_databases)
    const entry = { id: r.id, source_databases: dbs }
    if (r.doi) existingByDoi.set(String(r.doi).toLowerCase(), entry)
    if (r.normalized_title) existingByTitle.set(r.normalized_title, entry)
  }

  // 2026-05-25 BUG FIX:加 volume / issue / pages — 让 csv 导入的 records 也填上
  //   完整引文字段(M35 加列了但 csv-ingest 之前没用)
  const insertStmt = db.prepare(`
    INSERT INTO records (
      id, project_id, package_id,
      zotero_item_id, zotero_rdf_about, item_type,
      title, normalized_title, authors_json, authors_text,
      year, date_text, journal, publisher,
      doi, url, abstract, keywords_json, notes, has_pdf,
      source_databases, language,
      volume, issue, pages
    ) VALUES (
      ?, ?, NULL,
      NULL, NULL, ?,
      ?, ?, ?, ?,
      ?, NULL, ?, NULL,
      ?, NULL, ?, ?, NULL, 0,
      ?, ?,
      ?, ?, ?
    )
  `)

  const updateSourcesStmt = db.prepare(`
    UPDATE records SET source_databases = ? WHERE id = ?
  `)

  let totalInserted = 0
  let totalMergedSameDb = 0   // 同库重复(被丢弃,不增 source_databases)
  let totalMergedCrossDb = 0  // 跨库重复(被合并到已有记录的 source_databases)

  const tx = db.transaction(() => {
    for (const r of parsed) {
      const title = r.title ? String(r.title).trim() : ''
      const doi = normalizeDoi(r.doi)
      const normTitle = normalizeTitle(title)

      if (!title && !doi) continue

      // 找已有匹配(本批 + 历史)— DOI 优先,标题兜底
      // 旧 bug:旧逻辑只在 `!doi` 时做标题匹配 — 但常见场景"Zotero 已导无 DOI 的记录,
      //         后来 CSV 拉到同一篇带 DOI"会被漏掉,导致两条记录共存。
      //         真实病例:Miura 那篇,Zotero PDF 无 DOI / CSV 有 Scopus DOI,标题完全相同。
      // 现在:DOI 不匹配时,继续 fallback 到 normalized_title 匹配
      let existing = null
      if (doi && existingByDoi.has(doi)) existing = existingByDoi.get(doi)
      else if (normTitle && existingByTitle.has(normTitle)) existing = existingByTitle.get(normTitle)

      if (existing) {
        // 重复:合并 source_databases
        if (existing.source_databases.has(format)) {
          // 已经标过这个库 → 真重复,丢弃
          totalMergedSameDb += 1
        } else {
          // 跨库新来源 → 添加这个库
          existing.source_databases.add(format)
          updateSourcesStmt.run(JSON.stringify([...existing.source_databases]), existing.id)
          totalMergedCrossDb += 1
        }
        continue
      }

      // 新记录
      const id = randomId('rec')
      const dbsArr = [format]
      // 2026-05-25 BUG FIX:authors 已经是 [{surname, givenName, full, type}] 结构(mapWosRow / mapScopusRow / mapPubmedRow 解析时拆好了),
      //   直接 stringify 落 authors_json — citation-format normalizeRecord 接收对象后能正确按 style 渲染。
      //   旧代码用 r.authors_text.split(',') 是错的:每个 "Wang G" 被当成 .full 一字符串,
      //   下游 normalizeRecord 把空格 split 后 surname/given 颠倒(Wang 当 given,G 当 surname)。
      const authorsArr = Array.isArray(r.authors) ? r.authors : (
        r.authors_text
          ? r.authors_text.split(',').map((x) => ({ full: x.trim(), type: 'person' })).filter((a) => a.full)
          : []
      )
      insertStmt.run(
        id,
        projectId,
        // item_type
        'journalArticle',
        title || `(Untitled csv row)`,
        normTitle || null,
        JSON.stringify(authorsArr),
        r.authors_text || null,
        r.year == null ? null : r.year,
        r.journal || null,
        doi || null,
        r.abstract || null,
        JSON.stringify(r.keywords || []),
        JSON.stringify(dbsArr),
        r.language || null,
        r.volume || null,
        r.issue || null,
        r.pages || null,
      )

      // 缓存到 map 里,避免本批后续行重复同 DOI/title 再插入
      const cacheEntry = { id, source_databases: new Set(dbsArr) }
      if (doi) existingByDoi.set(doi, cacheEntry)
      if (normTitle) existingByTitle.set(normTitle, cacheEntry)
      totalInserted += 1
    }
  })

  try {
    tx()
  } catch (e) {
    errors.push(`db transaction failed: ${e.message}`)
  }

  // 兜底:全量重跑 dedupProject。
  //   inline 去重只看一对一(incoming vs existing),无法回头补救"上次入库时还没被识别的对"。
  //   比如 Zotero 先导无 DOI 的记录,CSV 后导有 DOI 的同篇 — 必须靠 Level 2(title+year+surname)
  //   重新归组,并把后到的标 duplicate_of_record_id 让 screening 列表不再重复显示。
  //   dedupProject 是 idempotent 的,先 reset 再分组,跑多遍没副作用。
  let dedupSummary = null
  try {
    dedupSummary = dedupProject(db, { projectId })
  } catch (e) {
    errors.push(`dedup pass failed: ${e.message}`)
  }

  return {
    format,
    total_parsed: totalParsed,
    total_inserted: totalInserted,
    total_duplicates: totalMergedSameDb + totalMergedCrossDb, // 向后兼容
    total_merged_same_db: totalMergedSameDb,
    total_merged_cross_db: totalMergedCrossDb,
    dedup: dedupSummary,
    errors,
    source_filename: sourceFilename || null,
  }
}

// 解析 records.source_databases JSON 文本 → Set<string>(向后兼容 NULL / 旧行)
function parseDbSet(jsonText) {
  if (!jsonText) return new Set()
  try {
    const parsed = JSON.parse(jsonText)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()))
    }
  } catch { /* fall through */ }
  return new Set()
}
