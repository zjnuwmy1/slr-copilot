/**
 * Zotero RDF ingest 服务
 * ------------------------------------------------------------
 * 输入:用户上传 Zotero 导出的 zip 包(已解压到本地目录)。
 *      目录里有一个 .rdf 文件 + 一个 files/ 子目录(可选)。
 *
 * 输出:解析成 records[] + attachments[],写入 SQLite。
 *
 * 三个公开入口:
 *   parseZoteroRdf({ rdfText, packageRootPath })
 *     纯解析函数,不碰 DB。
 *   persistParseResult(db, { projectId, userId, packageId, parseResult, packageStoragePath })
 *     把解析结果写入 records + attachments(transaction)。
 *   ingestPackage(db, { projectId, userId, packageId, packageRootPath })
 *     完整流水线:找 RDF 文件 → parse → persist → dedup → update zotero_packages。
 *
 * 用法示例(Agent H 路由里):
 *   import { ingestPackage } from '../../services/zotero-ingest.js'
 *   const summary = await ingestPackage(db, { projectId, userId, packageId, packageRootPath })
 */

import fs from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { randomId } from './crypto.js'
import { dedupProject, normalizeTitle, normalizeDoi } from './dedup.js'

// ---------- 常量 ----------

// 我们认为是"文献条目"的 z:itemType 值
const RECORD_ITEM_TYPES = new Set([
  'journalArticle',
  'conferencePaper',
  'bookSection',
  'book',
  'thesis',
  'report',
  'webpage',
  'magazineArticle',
  'newspaperArticle',
  'preprint',
  'manuscript',
  'document',
])

// 我们认为是"附件"的 z:itemType 值
const ATTACHMENT_ITEM_TYPES = new Set(['attachment'])

// ---------- XML 解析器(单例) ----------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false, // 保留 bib: / dc: / z: 等前缀
  // 这些元素永远当成数组(可能出现 1 个也可能多个)
  isArray: (name) =>
    /^(rdf:li|dc:subject|dc:identifier|link:link|dcterms:isReferencedBy|bib:authors|bib:editors|bib:contributors|bib:translators)$/.test(
      name,
    ),
  // 保留实体转义后的文本(rdf:value 里有 &lt; &amp; 等,fast-xml-parser 会自动解码)。
  // Zotero 笔记是嵌入 HTML,176 条记录的 RDF 里轻松上万 entities,
  // 必须把默认 1000 的 maxTotalExpansions 上调,否则解析整个文档失败。
  processEntities: {
    enabled: true,
    maxTotalExpansions: 10_000_000,
    maxExpandedLength: 50_000_000,
  },
  trimValues: true,
})

// ---------- 通用工具 ----------

/** 把"可能是字符串 / 可能是 { '#text': '...' } / 可能是数组"统一变成字符串(取第一个非空)。 */
function asText(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    for (const x of node) {
      const s = asText(x)
      if (s) return s
    }
    return ''
  }
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text']
    if (typeof node['rdf:value'] !== 'undefined') return asText(node['rdf:value'])
    // 一些场景 inner 直接是个 nested URI
    if (node['dcterms:URI']) return asText(node['dcterms:URI'])
  }
  return ''
}

/** 强制变数组(对于 fast-xml-parser 单 / 多元素一致化) */
function asArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/** 获取 rdf:resource 属性。可能在节点本身的 @_rdf:resource,也可能在嵌套子节点。 */
function getRdfResource(node) {
  if (node == null) return ''
  if (typeof node === 'string') return ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = getRdfResource(x)
      if (r) return r
    }
    return ''
  }
  if (typeof node === 'object') {
    if (typeof node['@_rdf:resource'] === 'string') return node['@_rdf:resource']
  }
  return ''
}

/** 从 #item_1366 抽 1366 ;原值不是 #item_ 形式时原样返回。 */
function normalizeItemId(s) {
  return s ? String(s).trim() : ''
}

/** 从 dc:date / dcterms:issued / dcterms:dateSubmitted 提取 year(int 或 null) */
function parseYear(rawDate) {
  if (!rawDate) return null
  const s = String(rawDate)
  const m = s.match(/\b(19|20|21)\d{2}\b/)
  if (!m) return null
  const y = parseInt(m[0], 10)
  if (y < 1500 || y > 2100) return null
  return y
}

/** 从一个 bib:authors 节点取作者数组 */
function extractAuthors(authorsNode) {
  // bib:authors > rdf:Seq > rdf:li > foaf:Person { foaf:surname, foaf:givenName }
  if (!authorsNode) return []
  const seq = authorsNode['rdf:Seq'] || authorsNode
  const lis = asArray(seq?.['rdf:li'])
  const out = []
  for (const li of lis) {
    if (!li) continue
    const person = li['foaf:Person'] || li
    // Organization author(机构作者)
    const org = li['foaf:Organization']
    if (org) {
      const name = asText(org['foaf:name'])
      if (name) out.push({ surname: '', givenName: '', full: name, type: 'organization' })
      continue
    }
    if (!person || typeof person !== 'object') continue
    const surname = asText(person['foaf:surname']).trim()
    const givenName = asText(person['foaf:givenName']).trim()
    const fallbackName = asText(person['foaf:name']).trim()
    if (!surname && !givenName && !fallbackName) continue
    const full = surname && givenName ? `${surname}, ${givenName}` : surname || givenName || fallbackName
    out.push({ surname, givenName, full, type: 'person' })
  }
  return out
}

/** authors → 'Wang G, Tang R, Xu M' 风格(显示 + 第一作者姓比对) */
function authorsToText(authors) {
  if (!authors || authors.length === 0) return ''
  return authors
    .map((a) => {
      if (a.type === 'organization') return a.full
      if (a.surname) {
        const initial = a.givenName ? ` ${a.givenName.charAt(0).toUpperCase()}` : ''
        return a.surname + initial
      }
      return a.full
    })
    .filter(Boolean)
    .join(', ')
}

/**
 * 抽 DOI:多源 fallback
 *   1) bib:doi / prism:doi 子元素
 *   2) dc:identifier 包含 'DOI ' 前缀
 *   3) record 关联的 bib:Journal.dc:identifier 里含 'DOI '
 *   4) rdf:about 或 url 里像 doi.org/10.xxxx 的部分
 */
function extractDoi(node, partOfJournal) {
  // 1) 直接 bib:doi / prism:doi
  const direct = asText(node['bib:doi']) || asText(node['prism:doi'])
  if (direct) return direct.trim()

  // 2) dc:identifier(可能是数组)中找 'DOI '
  const idents = asArray(node['dc:identifier'])
  for (const id of idents) {
    const t = asText(id)
    if (!t) continue
    const m = t.match(/^DOI\s+(.+)$/i)
    if (m) return m[1].trim()
    // dcterms:URI inside dc:identifier? 已被 asText 取到 inner URI 字符串
    if (/^10\.\d{4,}/.test(t.trim())) return t.trim()
  }

  // 3) 关联 Journal 的 dc:identifier
  if (partOfJournal) {
    const jidents = asArray(partOfJournal['dc:identifier'])
    for (const id of jidents) {
      const t = asText(id)
      if (!t) continue
      const m = t.match(/^DOI\s+(.+)$/i)
      if (m) return m[1].trim()
    }
  }

  // 4) 从 rdf:about / URL 里抠 doi.org/10.xxxxx
  const about = node['@_rdf:about'] || ''
  const url = extractUrl(node)
  for (const src of [about, url]) {
    if (!src) continue
    const m = String(src).match(/doi\.org\/(10\.\d{4,}[^\s?#"]+)/i)
    if (m) return m[1]
  }

  return ''
}

/** 抽 URL:dc:identifier > dcterms:URI > rdf:value;或 rdf:about(若是 http/https) */
function extractUrl(node) {
  const idents = asArray(node['dc:identifier'])
  for (const id of idents) {
    if (id && typeof id === 'object') {
      const uri = id['dcterms:URI']
      if (uri) {
        const v = asText(uri['rdf:value'] || uri)
        if (v && /^https?:/i.test(v)) return v
      }
    }
  }
  const about = node['@_rdf:about'] || ''
  if (about && /^https?:/i.test(about)) return about
  return ''
}

/** 抽 abstract:dcterms:abstract / bib:abstract / dc:description (description 太杂,只在前两个都没有时用) */
function extractAbstract(node) {
  const a = asText(node['dcterms:abstract'])
  if (a) return a
  const b = asText(node['bib:abstract'])
  if (b) return b
  // dc:description 有时是 "_eprint: https://..." 这种垃圾,只在看起来像摘要(>=80 字)时用
  const d = asText(node['dc:description'])
  if (d && d.length >= 80 && !d.startsWith('_eprint:')) return d
  return ''
}

/** 抽 keywords (dc:subject 下的 z:AutomaticTag / 自由 tag) */
function extractKeywords(node) {
  const out = []
  const subs = asArray(node['dc:subject'])
  for (const s of subs) {
    if (!s) continue
    if (typeof s === 'string') {
      out.push(s.trim())
      continue
    }
    // z:AutomaticTag > rdf:value
    if (s['z:AutomaticTag']) {
      const v = asText(s['z:AutomaticTag']['rdf:value'] || s['z:AutomaticTag'])
      if (v) out.push(v.trim())
      continue
    }
    // dcterms:LCC 等其他 — 忽略(那些是分类码而非关键词)
    if (s['dcterms:LCC']) continue
    // 直接的 rdf:value
    if (s['rdf:value']) {
      const v = asText(s['rdf:value'])
      if (v) out.push(v.trim())
    }
  }
  // 去重(保留顺序),过滤空 / 以 '/' 开头的内部标签(如 /unread)
  const seen = new Set()
  const result = []
  for (const k of out) {
    if (!k || k.startsWith('/')) continue
    const key = k.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(k)
  }
  return result
}

/** 抽出 record 关联的 attachment item id 列表(从 link:link 节点) */
function extractAttachmentRefs(node) {
  const out = []
  const links = asArray(node['link:link'])
  for (const l of links) {
    const r = getRdfResource(l)
    if (r) out.push(r)
  }
  return out
}

/** 抽出 record 关联的 memo item id 列表(从 dcterms:isReferencedBy 节点) */
function extractMemoRefs(node) {
  const out = []
  const refs = asArray(node['dcterms:isReferencedBy'])
  for (const r of refs) {
    const id = getRdfResource(r)
    if (id) out.push(id)
  }
  return out
}

/** 抽 attachment 的本地相对路径(z:path rdf:resource 或 rdf:resource) */
function extractAttachmentPath(attachNode) {
  // z:path 子元素带 rdf:resource
  if (attachNode['z:path']) {
    const p = getRdfResource(attachNode['z:path'])
    if (p) return p
  }
  // 直接的 rdf:resource(老格式)
  const direct = attachNode['rdf:resource']
  if (direct) {
    if (typeof direct === 'string') return direct
    const p = getRdfResource(direct)
    if (p) return p
    const t = asText(direct)
    if (t) return t
  }
  return ''
}

/** attachment 的 mime → 我们 schema 里的 attachment_kind */
function attachmentKindFromMime(mime, filename) {
  const m = (mime || '').toLowerCase()
  const f = (filename || '').toLowerCase()
  if (m === 'application/pdf' || f.endsWith('.pdf')) return 'pdf'
  if (m.startsWith('text/html') || f.endsWith('.html') || f.endsWith('.htm')) return 'html'
  if (m.startsWith('image/')) return 'snapshot'
  return 'other'
}

/** item_type 归一(超出我们 schema 列出的 5 个,统一成 'other') */
function normalizeItemType(t) {
  const v = (t || '').trim()
  if (v === 'journalArticle' || v === 'conferencePaper' || v === 'bookSection' || v === 'webpage') return v
  if (!v) return 'other'
  return v // 保留原值;schema 里没强约束 enum,我们对应到 records.item_type 字段
}

// ---------- 主解析函数 ----------

/**
 * 同步解析 RDF 文本。
 *
 * @param {{ rdfText: string, packageRootPath: string }} opts
 * @returns {{
 *   meta: { rdf_about_count: number, attachment_count: number, errors: string[] },
 *   records: Array<{
 *     zotero_item_id: string,
 *     zotero_rdf_about: string,
 *     item_type: string,
 *     title: string,
 *     authors: Array<{ surname:string, givenName:string, full:string, type:string }>,
 *     authors_text: string,
 *     year: number|null,
 *     date_text: string,
 *     journal: string,
 *     publisher: string,
 *     doi: string,
 *     url: string,
 *     abstract: string,
 *     keywords: string[],
 *     notes: string,
 *     attachments: Array<{ zotero_item_id:string, kind:string, filename:string, storage_path:string, mime_type:string }>,
 *     has_pdf: number,
 *   }>
 * }}
 */
export function parseZoteroRdf({ rdfText, packageRootPath }) {
  const errors = []
  if (typeof rdfText !== 'string' || !rdfText) {
    return { meta: { rdf_about_count: 0, attachment_count: 0, errors: ['empty RDF'] }, records: [] }
  }

  let doc
  try {
    doc = xmlParser.parse(rdfText)
  } catch (e) {
    return { meta: { rdf_about_count: 0, attachment_count: 0, errors: [`XML parse failed: ${e.message}`] }, records: [] }
  }

  const root = doc['rdf:RDF']
  if (!root) {
    return { meta: { rdf_about_count: 0, attachment_count: 0, errors: ['no <rdf:RDF> root'] }, records: [] }
  }

  // 把根下所有节点拍平到一张 "all_nodes" 列表,带上 tag 名,便于多 pass 处理
  // 同一类 tag 下可能是单对象或数组,统一拍平。
  const allNodes = []
  for (const tag of Object.keys(root)) {
    if (tag.startsWith('@_') || tag === '#text') continue
    const items = asArray(root[tag])
    for (const it of items) {
      if (it && typeof it === 'object') allNodes.push({ tag, node: it })
    }
  }

  // ---- Pass 1: 索引所有 attachment / memo / journal,按 rdf:about 建 map ----
  const attachmentsById = new Map() // '#item_1366' → node
  const memosById = new Map() // '#item_1364' → node
  const journalsById = new Map() // 'urn:issn:...' → node
  let rdfAboutCount = 0

  for (const { tag, node } of allNodes) {
    const about = node['@_rdf:about']
    if (typeof about === 'string') rdfAboutCount++
    const itemType = asText(node['z:itemType'])

    if (tag === 'z:Attachment' || itemType === 'attachment') {
      if (about) attachmentsById.set(about, node)
      continue
    }
    if (tag === 'bib:Memo' || itemType === 'note') {
      if (about) memosById.set(about, node)
      continue
    }
    if (tag === 'bib:Journal') {
      if (about) journalsById.set(about, node)
      continue
    }
  }

  // ---- Pass 2: 找文献条目并组装 ----
  const records = []

  for (const { tag, node } of allNodes) {
    const itemType = asText(node['z:itemType'])
    // 必须是文献:有 z:itemType 且不是 attachment/note/journal
    if (!itemType) continue
    if (ATTACHMENT_ITEM_TYPES.has(itemType)) continue
    if (itemType === 'note') continue
    if (tag === 'bib:Journal') continue
    if (tag === 'z:Collection') continue
    if (tag === 'bib:Memo') continue
    if (tag === 'z:Attachment') continue
    // 通常 RECORD_ITEM_TYPES 命中;如果 itemType 是未列的怪类型,也保留
    if (!RECORD_ITEM_TYPES.has(itemType) && !RECORD_ITEM_TYPES.has((itemType || '').toLowerCase())) {
      // 不丢,塞一个 warn 但继续
      // errors.push(`unknown itemType: ${itemType} (about=${node['@_rdf:about']})`)
    }

    try {
      const about = node['@_rdf:about'] || ''
      const zoteroItemId = normalizeItemId(about)

      // 关联 Journal 有两种格式:
      //   A) <dcterms:isPartOf rdf:resource="urn:issn:..."/>  → 在文档别处的 bib:Journal 节点
      //   B) <dcterms:isPartOf><bib:Journal>...</bib:Journal></dcterms:isPartOf>  → 内联 Journal
      let journalNode = null
      const partOfNode = node['dcterms:isPartOf']
      if (partOfNode) {
        // 先看是否有 rdf:resource(case A)
        const partOfRes = getRdfResource(partOfNode)
        if (partOfRes) {
          journalNode = journalsById.get(partOfRes) || null
        }
        // 再看是否内联(case B)— 也可能 A+B 都有,我们以内联为优先(同节点内信息更准)
        if (partOfNode['bib:Journal']) {
          // 内联 Journal 也是单对象或数组,统一拿第一个
          journalNode = asArray(partOfNode['bib:Journal'])[0] || journalNode
        }
        // conferencePaper 有时是 isPartOf -> bib:Series / bib:Proceedings,兜底
        if (!journalNode && partOfNode['bib:Series']) {
          journalNode = asArray(partOfNode['bib:Series'])[0]
        }
      }
      const journalTitle = journalNode ? asText(journalNode['dc:title']) : ''

      // publisher: 直接 / 或在 Journal 上
      let publisher = ''
      const pubNode = node['dc:publisher']
      if (pubNode) {
        publisher = asText(pubNode['foaf:Organization']?.['foaf:name'] || pubNode)
      }
      if (!publisher && journalNode) {
        const jpub = journalNode['dc:publisher']
        if (jpub) publisher = asText(jpub['foaf:Organization']?.['foaf:name'] || jpub)
      }

      // title — 容错
      let title = asText(node['dc:title']).trim()
      if (!title) {
        title = `(Untitled ${zoteroItemId || 'record'})`
        errors.push(`missing title for ${zoteroItemId || about}`)
      }

      // authors
      const authorsRaw = asArray(node['bib:authors'])[0]
      const authors = extractAuthors(authorsRaw)
      const authorsText = authorsToText(authors)

      // date / year
      const dateText = asText(node['dc:date']) || asText(node['dcterms:issued']) || asText(node['dcterms:dateSubmitted'])
      const year = parseYear(dateText)

      // doi / url / abstract / keywords
      const doi = extractDoi(node, journalNode)
      const url = extractUrl(node)
      const abstract = extractAbstract(node)
      const keywords = extractKeywords(node)

      // 附件
      const attachmentRefs = extractAttachmentRefs(node)
      const attachments = []
      let hasPdf = 0
      for (const ref of attachmentRefs) {
        const an = attachmentsById.get(ref)
        if (!an) continue
        const relPath = extractAttachmentPath(an)
        const mime = asText(an['link:type'])
        const titleAtt = asText(an['dc:title'])
        // 优先用 z:path 的 filename;若无 path 则用 title
        let filename = ''
        let storagePath = ''
        if (relPath) {
          // relPath 可能 URL 编码 / 含中文 — 直接用,不动
          filename = path.basename(relPath)
          storagePath = path.join(packageRootPath, relPath)
          // verify 文件存在
          if (!fs.existsSync(storagePath)) {
            // 文件丢了 — 不挂这条附件
            errors.push(`attachment file missing: ${relPath}`)
            continue
          }
        } else {
          // 网页 snapshot(只有 URL 没有本地文件)— 不算 has_pdf,也不挂为 attachment 行
          continue
        }
        const kind = attachmentKindFromMime(mime, filename)
        attachments.push({
          zotero_item_id: ref,
          kind,
          filename,
          storage_path: storagePath,
          mime_type: mime || '',
        })
        if (kind === 'pdf') hasPdf = 1
      }

      // notes:双向找
      //   A) record 上的 dcterms:isReferencedBy rdf:resource="#item_XXX" 指向 memo
      //   B) memo 节点 dcterms:isPartOf rdf:resource = record id ← 罕见但兜底
      const memoIds = new Set(extractMemoRefs(node))
      // 兜底 B:扫所有 memo,看哪个 isPartOf 指回这个 record
      for (const [mid, mnode] of memosById) {
        const partOf = getRdfResource(mnode['dcterms:isPartOf'])
        if (partOf && partOf === about) memoIds.add(mid)
      }
      const memoTexts = []
      for (const mid of memoIds) {
        const mn = memosById.get(mid)
        if (!mn) continue
        const v = asText(mn['rdf:value'])
        if (v && v.trim()) memoTexts.push(v.trim())
      }
      const notes = memoTexts.join('\n\n---\n\n')

      records.push({
        zotero_item_id: zoteroItemId,
        zotero_rdf_about: about,
        item_type: normalizeItemType(itemType),
        title,
        authors,
        authors_text: authorsText,
        year,
        date_text: dateText || '',
        journal: journalTitle,
        publisher,
        doi,
        url,
        abstract,
        keywords,
        notes,
        attachments,
        has_pdf: hasPdf,
      })
    } catch (e) {
      errors.push(`parse record failed: ${e.message}`)
    }
  }

  return {
    meta: {
      rdf_about_count: rdfAboutCount,
      attachment_count: attachmentsById.size,
      errors,
    },
    records,
  }
}

// ---------- 持久化 ----------

/**
 * 把 parseZoteroRdf 的结果写入数据库。
 * 同 package_id 重新 ingest 时:先删旧 records & attachments(ON DELETE CASCADE 会清 attachments)。
 * 用 transaction 保证原子。
 *
 * @param {object} db better-sqlite3 db handle
 * @param {{ projectId:string, userId:string, packageId:string, parseResult:object, packageStoragePath:string }} opts
 * @returns {{ package_id:string, total_records:number, total_with_pdf:number, total_with_doi:number, total_duplicates:number, manifest:object }}
 */
export function persistParseResult(db, { projectId, userId, packageId, parseResult, packageStoragePath }) {
  if (!projectId || !packageId) throw new Error('projectId and packageId required')
  if (!parseResult || !Array.isArray(parseResult.records)) {
    throw new Error('parseResult.records missing')
  }

  const insertRecord = db.prepare(`
    INSERT OR REPLACE INTO records (
      id, project_id, package_id,
      zotero_item_id, zotero_rdf_about, item_type,
      title, normalized_title, authors_json, authors_text,
      year, date_text, journal, publisher,
      doi, url, abstract, keywords_json, notes, has_pdf
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `)

  const insertAttachment = db.prepare(`
    INSERT INTO attachments (
      id, record_id, package_id,
      attachment_kind, filename, storage_path, size_bytes, mime_type, zotero_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // 删旧 attachments 用于这个 package(records ON DELETE CASCADE 会自动清,但我们用 INSERT OR REPLACE
  // 在 records 上,attachments 不会被自动清,得手动)
  const deleteOldAttachments = db.prepare(`DELETE FROM attachments WHERE package_id = ?`)
  const deleteOldRecords = db.prepare(`DELETE FROM records WHERE package_id = ?`)

  let totalWithPdf = 0
  let totalWithDoi = 0

  const tx = db.transaction(() => {
    deleteOldAttachments.run(packageId)
    deleteOldRecords.run(packageId)

    for (const r of parseResult.records) {
      const recordId = randomId('rec')
      const normTitle = normalizeTitle(r.title)
      const normDoi = normalizeDoi(r.doi)
      if (normDoi) totalWithDoi++
      if (r.has_pdf) totalWithPdf++

      insertRecord.run(
        recordId,
        projectId,
        packageId,
        r.zotero_item_id || null,
        r.zotero_rdf_about || null,
        r.item_type || null,
        r.title,
        normTitle,
        JSON.stringify(r.authors || []),
        r.authors_text || null,
        r.year,
        r.date_text || null,
        r.journal || null,
        r.publisher || null,
        normDoi || null,
        r.url || null,
        r.abstract || null,
        JSON.stringify(r.keywords || []),
        r.notes || null,
        r.has_pdf ? 1 : 0,
      )

      // ingest 插入 attachments 指向 extracted/(每条记录可能有多个附件,如 PDF + snapshot)。
      // 注意:对 matched 记录,后续 mergeZoteroIntoSystem 会另外插一行指向 /pdfs/<sys_record>.pdf,
      // 同一文件可能在 attachments 表里有两行(zotero record + system record)。
      // 占用统计的去重靠 services/storage.js 的 seenInodes(hardlink 同 inode 只算一次);
      // 配额统计的去重要确保 size_bytes 设置正确(我们已 stat 出真实大小)。
      // 这是一个权衡:多一行 DB 行换代码简单 + Zotero 记录自身也能查到 PDF。
      for (const a of r.attachments || []) {
        let sizeBytes = null
        try {
          const st = fs.statSync(a.storage_path)
          if (st && st.isFile()) sizeBytes = st.size
        } catch {
          // ignore
        }
        insertAttachment.run(
          randomId('att'),
          recordId,
          packageId,
          a.kind,
          a.filename || null,
          a.storage_path,
          sizeBytes,
          a.mime_type || null,
          a.zotero_item_id || null,
        )
      }
    }
  })

  tx()

  const manifest = {
    storage_path: packageStoragePath,
    rdf_meta: parseResult.meta,
    counts: {
      records: parseResult.records.length,
      with_pdf: totalWithPdf,
      with_doi: totalWithDoi,
      with_abstract: parseResult.records.filter((r) => r.abstract && r.abstract.length > 0).length,
      with_notes: parseResult.records.filter((r) => r.notes && r.notes.length > 0).length,
    },
  }

  return {
    package_id: packageId,
    total_records: parseResult.records.length,
    total_with_pdf: totalWithPdf,
    total_with_doi: totalWithDoi,
    total_duplicates: 0, // 由 dedup 阶段补
    manifest,
  }
}

// ---------- 完整流水线 ----------

/**
 * 解压目录 → 找 RDF → 解析 → 持久化 → 去重 → 更新 zotero_packages 行。
 * Agent H 的路由直接调它。
 *
 * @param {object} db
 * @param {{ projectId:string, userId:string, packageId:string, packageRootPath:string }} opts
 * @returns {Promise<{
 *   package_id:string,
 *   total_records:number, total_with_pdf:number, total_with_doi:number,
 *   total_duplicates:number,
 *   dedup: { groups_found:number, records_merged:number },
 *   manifest:object,
 *   rdf_filename:string,
 * }>}
 */
/**
 * 终态失败时清理 extractDir。仅允许动 UPLOAD_ROOT 之内的路径,防越权 rm -rf。
 *   失败时如不清理:files 会一直占用用户配额、admin 看到"项目占用 359 MB / 0 attachments"
 *   这种诡异数字,且不会出现在孤儿列表(DB 行还在)。
 *   清完文件后,调用方应同时把 zotero_packages.storage_path 置 NULL。
 */
function cleanupFailedPackageFiles(packageRootPath) {
  if (!packageRootPath) return
  const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
  const resolved = path.resolve(packageRootPath)
  // 必须在 UPLOAD_ROOT 之下,且不能等于 UPLOAD_ROOT(防 rm -rf 整个 uploads/)
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep) || resolved === UPLOAD_ROOT) {
    console.warn('[zotero-ingest] refusing cleanup outside UPLOAD_ROOT:', packageRootPath)
    return
  }
  try {
    // 顺手把上层 pkg_xxx/ 目录也清(extractDir 通常是 pkg_xxx/extracted/)
    const parent = path.dirname(resolved)
    if (parent.startsWith(UPLOAD_ROOT + path.sep) && parent !== UPLOAD_ROOT) {
      fs.rmSync(parent, { recursive: true, force: true })
    } else {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('[zotero-ingest] cleanup failed for', packageRootPath, e.message)
  }
}

export async function ingestPackage(db, { projectId, userId, packageId, packageRootPath }) {
  if (!projectId || !packageId || !packageRootPath) {
    throw new Error('projectId, packageId, packageRootPath required')
  }
  if (!fs.existsSync(packageRootPath) || !fs.statSync(packageRootPath).isDirectory()) {
    throw new Error(`packageRootPath not a directory: ${packageRootPath}`)
  }

  // 找 .rdf 文件。三种情况:
  //   1. 上层路由 findRdfFilename 已经扫到并存进 zotero_packages.rdf_filename(可能含子目录如 "ai下载/ai下载.rdf")
  //      → 优先用,避免重复扫盘 + 兼容深一层结构
  //   2. 老包没存 → 顶层扫一遍
  //   3. 顶层没有 → 扫 1 层子目录(Zotero 导出包常见结构:storage/library.rdf)
  let rdfName = null
  try {
    const row = db.prepare('SELECT rdf_filename FROM zotero_packages WHERE id = ?').get(packageId)
    if (row && row.rdf_filename) {
      // 校验文件实存在,失效就 fallback 到扫盘
      const candidate = path.join(packageRootPath, row.rdf_filename)
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        rdfName = row.rdf_filename
      }
    }
  } catch { /* 没列也走 fallback */ }

  if (!rdfName) {
    const entries = fs.readdirSync(packageRootPath)
    rdfName = entries.find((n) => n.toLowerCase().endsWith('.rdf')) || null
    // 顶层没找到 — 扫 1 层子目录(包内 storage/library.rdf 或 用户标题命名的子目录)
    if (!rdfName) {
      for (const n of entries) {
        const sub = path.join(packageRootPath, n)
        let st; try { st = fs.statSync(sub) } catch { continue }
        if (!st.isDirectory()) continue
        const inner = fs.readdirSync(sub)
        const m = inner.find((x) => x.toLowerCase().endsWith('.rdf'))
        if (m) { rdfName = path.join(n, m); break }
      }
    }
  }

  if (!rdfName) {
    // 终态失败:.rdf 不在包里 → 这个包没法 ingest,清掉 extractDir 立刻释放配额。
    //   storage_path 一并置空(schema NOT NULL,所以用 '' 不是 NULL),
    //   getProjectStorage/diskUsage 都会把它当作"无引用"跳过。
    //   保留 DB 行供 UI 显示"上传失败"原因 + 用户可点删除按钮彻底清掉。
    cleanupFailedPackageFiles(packageRootPath)
    db.prepare(
      `UPDATE zotero_packages
          SET status = 'failed',
              error_message = ?,
              storage_path = ''
        WHERE id = ?`
    ).run('no .rdf file found in package', packageId)
    throw new Error('no .rdf file found in package')
  }

  // 标记 parsing
  db.prepare(`UPDATE zotero_packages SET status = 'parsing', rdf_filename = ? WHERE id = ?`).run(rdfName, packageId)

  let summary
  try {
    const rdfPath = path.join(packageRootPath, rdfName)
    const rdfText = fs.readFileSync(rdfPath, 'utf8')

    // 关键:Zotero RDF 里的 z:path 是相对 RDF 文件所在目录的(不是 packageRootPath)。
    //   当 rdfName 含子目录(如 'ai下载/ai下载.rdf')时,packageRootPath = extractDir = '/.../extracted',
    //   但 z:path 形如 'files/3034/Fares.pdf' 是相对 '/.../extracted/ai下载' 的。
    //   旧代码直接 join(extractDir, relPath) 会找不到附件文件。
    //   现在把 RDF 所在目录作为 parser 的"附件根"传进去。
    const rdfDir = path.dirname(rdfPath)

    const parseResult = parseZoteroRdf({ rdfText, packageRootPath: rdfDir })

    summary = persistParseResult(db, {
      projectId,
      userId,
      packageId,
      parseResult,
      packageStoragePath: packageRootPath,
    })
  } catch (e) {
    // 解析/落库失败也算终态(没有 retry 流程)。清盘 + null storage_path。
    cleanupFailedPackageFiles(packageRootPath)
    db.prepare(
      `UPDATE zotero_packages
          SET status = 'failed',
              error_message = ?,
              storage_path = ''
        WHERE id = ?`
    ).run(String(e.message || e), packageId)
    throw e
  }

  // 标记 parsed(去重前)
  db.prepare(`UPDATE zotero_packages SET status = 'parsed', parsed_at = datetime('now') WHERE id = ?`).run(packageId)

  // 跑去重
  const dedup = dedupProject(db, { projectId })

  // 完整 manifest 落库
  const fullManifest = {
    ...summary.manifest,
    dedup,
    rdf_filename: rdfName,
  }

  db.prepare(`
    UPDATE zotero_packages SET
      status = 'ingested',
      total_records = ?,
      total_with_pdf = ?,
      total_with_doi = ?,
      total_duplicates = ?,
      manifest = ?,
      ingested_at = datetime('now')
    WHERE id = ?
  `).run(
    summary.total_records,
    summary.total_with_pdf,
    summary.total_with_doi,
    dedup.records_merged,
    JSON.stringify(fullManifest),
    packageId,
  )

  return {
    ...summary,
    total_duplicates: dedup.records_merged,
    dedup,
    manifest: fullManifest,
    rdf_filename: rdfName,
  }
}
