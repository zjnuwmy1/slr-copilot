/**
 * Smoke test for services/zotero-ingest.js + services/dedup.js
 * ------------------------------------------------------------
 * 不依赖测试框架,直接 node ESM 跑:
 *   node services/__tests__/zotero-ingest.test.js
 *
 * 期望真实测试数据在 /Users/mingyu/Downloads/robotic foundation models/
 * (176 条记录,27 PDF,~140 DOI,~170 abstract,≥1 笔记)
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseZoteroRdf } from '../zotero-ingest.js'
import { normalizeTitle, normalizeDoi } from '../dedup.js'

const PKG = '/Users/mingyu/Downloads/robotic foundation models'
const RDF_FILE = path.join(PKG, 'robotic foundation models.rdf')

function header(s) {
  console.log('\n' + '='.repeat(60))
  console.log(s)
  console.log('='.repeat(60))
}

function check(label, actual, expectFn) {
  const ok = expectFn(actual)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}`)
  return ok
}

// ---------- helpers ----------

header('Setup')
if (!fs.existsSync(RDF_FILE)) {
  console.error('Test RDF not found at:', RDF_FILE)
  console.error('This test requires the real Zotero export. Skipping.')
  process.exit(0)
}
const rdfText = fs.readFileSync(RDF_FILE, 'utf8')
console.log('RDF size:', rdfText.length, 'bytes')

// ---------- normalizeDoi / normalizeTitle unit checks ----------

header('Unit: normalizeDoi / normalizeTitle')

const doiCases = [
  ['10.1002/aisy.202500288', '10.1002/aisy.202500288'],
  ['DOI 10.1002/aisy.202500288', '10.1002/aisy.202500288'],
  ['doi:10.1002/aisy.202500288', '10.1002/aisy.202500288'],
  ['https://doi.org/10.1002/aisy.202500288', '10.1002/aisy.202500288'],
  ['  HTTPS://DOI.ORG/10.1002/AISY.202500288  ', '10.1002/aisy.202500288'],
  ['https://dx.doi.org/10.1109/LRA.2025.3592065.', '10.1109/lra.2025.3592065'],
  [null, ''],
  ['', ''],
]
for (const [input, expected] of doiCases) {
  const got = normalizeDoi(input)
  // 'DOI 10.x...' 这种,我的实现会剥掉 'doi ' 前缀(我加了 'doi ' 分支),应该 OK
  check(`normalizeDoi(${JSON.stringify(input)})`, got, (v) => v === expected)
}

const titleCases = [
  ['EndoARSS: Adapting Spatially Aware Foundation Model', 'endoarss adapting spatially aware foundation model'],
  ['The   Future   of  AI ', 'future ai'],
  // 'with' 是 stopword,会被去掉;'!' 被替换成空格;输出空格分词。
  ['多模态机器人 with foundation models!', '多模态机器人 foundation models'],
  [null, ''],
]
for (const [input, expected] of titleCases) {
  const got = normalizeTitle(input)
  check(`normalizeTitle(${JSON.stringify(input)})`, got, (v) => v === expected)
}

// ---------- Parse the real RDF ----------

header('Parse: robotic foundation models.rdf')
const t0 = Date.now()
const r = parseZoteroRdf({ rdfText, packageRootPath: PKG })
const elapsed = Date.now() - t0
console.log(`parse done in ${elapsed} ms`)
console.log('meta:', { rdf_about_count: r.meta.rdf_about_count, attachment_count: r.meta.attachment_count, errors: r.meta.errors.length })

const withPdf = r.records.filter((x) => x.has_pdf)
const withDoi = r.records.filter((x) => x.doi)
const withAbstract = r.records.filter((x) => x.abstract)
const withNotes = r.records.filter((x) => x.notes && x.notes.length > 50)
const withAuthors = r.records.filter((x) => x.authors && x.authors.length > 0)
const withKeywords = r.records.filter((x) => x.keywords && x.keywords.length > 0)
const withYear = r.records.filter((x) => x.year != null)
const withJournal = r.records.filter((x) => x.journal)

header('Counts')
check('records count ≈ 176', r.records.length, (v) => Math.abs(v - 176) <= 2)
check('with_pdf = 27', withPdf.length, (v) => v === 27)
check('with_doi ≈ 140', withDoi.length, (v) => Math.abs(v - 140) <= 14) // ±10%
check('with_abstract ≥ 150', withAbstract.length, (v) => v >= 150)
check('with_notes ≥ 1', withNotes.length, (v) => v >= 1)
check('with_authors ≥ 160', withAuthors.length, (v) => v >= 160)
check('with_year ≥ 160', withYear.length, (v) => v >= 160)

// 项目类型分布
const byType = {}
for (const x of r.records) byType[x.item_type] = (byType[x.item_type] || 0) + 1
console.log('item_type distribution:', byType)
check('journalArticle = 52', byType.journalArticle || 0, (v) => v === 52)
check('conferencePaper = 122', byType.conferencePaper || 0, (v) => v === 122)
check('bookSection = 1', byType.bookSection || 0, (v) => v === 1)
check('webpage = 1', byType.webpage || 0, (v) => v === 1)

// ---------- 示例记录 ----------

header('Sample: first record with PDF')
const ex = r.records.find((x) => x.has_pdf)
if (ex) {
  console.log({
    title: ex.title.slice(0, 80),
    item_type: ex.item_type,
    year: ex.year,
    doi: ex.doi,
    authors_text: ex.authors_text,
    journal: ex.journal,
    has_pdf: ex.has_pdf,
    keywords: ex.keywords.slice(0, 3),
    attachments: ex.attachments.map((a) => ({ kind: a.kind, filename: a.filename })),
    abstract_len: ex.abstract.length,
    notes_len: ex.notes.length,
  })
}

header('Sample: first record with notes')
const exNote = r.records.find((x) => x.notes && x.notes.length > 50)
if (exNote) {
  console.log({
    title: exNote.title.slice(0, 80),
    notes_preview: exNote.notes.slice(0, 200) + '...',
    notes_len: exNote.notes.length,
  })
}

header('Sample: record with conferencePaper type')
const exConf = r.records.find((x) => x.item_type === 'conferencePaper')
if (exConf) {
  console.log({
    title: exConf.title.slice(0, 80),
    year: exConf.year,
    doi: exConf.doi,
    journal: exConf.journal,
    publisher: exConf.publisher,
    authors_text: exConf.authors_text,
  })
}

// ---------- Errors ----------

if (r.meta.errors.length > 0) {
  header(`Parse warnings (${r.meta.errors.length})`)
  for (const e of r.meta.errors.slice(0, 10)) console.log(' -', e)
  if (r.meta.errors.length > 10) console.log(`  ... and ${r.meta.errors.length - 10} more`)
}

// ---------- Persistence + dedup against in-memory SQLite ----------

header('Persist + dedup against in-memory SQLite')

try {
  const Database = (await import('better-sqlite3')).default
  const { persistParseResult, ingestPackage } = await import('../zotero-ingest.js')
  const { dedupProject } = await import('../dedup.js')

  // Stand up a minimal in-memory schema (just the tables we touch)
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE zotero_packages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'web_upload',
      source_filename TEXT,
      storage_path TEXT NOT NULL,
      size_bytes INTEGER,
      rdf_filename TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      total_records INTEGER,
      total_with_pdf INTEGER,
      total_with_doi INTEGER,
      total_duplicates INTEGER,
      manifest TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      parsed_at TEXT,
      ingested_at TEXT
    );
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      package_id TEXT,
      zotero_item_id TEXT,
      zotero_rdf_about TEXT,
      item_type TEXT,
      title TEXT NOT NULL,
      normalized_title TEXT,
      authors_json TEXT,
      authors_text TEXT,
      year INTEGER,
      date_text TEXT,
      journal TEXT,
      publisher TEXT,
      doi TEXT,
      url TEXT,
      abstract TEXT,
      keywords_json TEXT,
      notes TEXT,
      has_pdf INTEGER NOT NULL DEFAULT 0,
      duplicate_group_id TEXT,
      duplicate_of_record_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      package_id TEXT,
      attachment_kind TEXT NOT NULL,
      filename TEXT,
      storage_path TEXT NOT NULL,
      size_bytes INTEGER,
      mime_type TEXT,
      zotero_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // ENCRYPTION_KEY isn't needed for ingest path, but randomId doesn't use it.
  // Seed a package row(ingestPackage 期望它存在)
  db.prepare(`
    INSERT INTO zotero_packages (id, project_id, user_id, source_kind, storage_path)
    VALUES (?, ?, ?, 'web_upload', ?)
  `).run('pkg_test1', 'proj_test1', 'user_test1', PKG)

  const t0p = Date.now()
  const result = await ingestPackage(db, {
    projectId: 'proj_test1',
    userId: 'user_test1',
    packageId: 'pkg_test1',
    packageRootPath: PKG,
  })
  const elapsedP = Date.now() - t0p

  console.log('ingest elapsed (ms):', elapsedP)
  console.log('result:', {
    total_records: result.total_records,
    total_with_pdf: result.total_with_pdf,
    total_with_doi: result.total_with_doi,
    total_duplicates: result.total_duplicates,
    dedup: result.dedup,
    rdf_filename: result.rdf_filename,
  })

  // Verify counts in DB
  const dbRecords = db.prepare('SELECT COUNT(*) as c FROM records').get().c
  const dbAtts = db.prepare('SELECT COUNT(*) as c FROM attachments').get().c
  const dbWithPdf = db.prepare('SELECT COUNT(*) as c FROM records WHERE has_pdf = 1').get().c
  const dbWithDoi = db.prepare('SELECT COUNT(*) as c FROM records WHERE doi IS NOT NULL').get().c
  const dbAttsPdf = db.prepare(`SELECT COUNT(*) as c FROM attachments WHERE attachment_kind = 'pdf'`).get().c
  const dbAttsHtml = db.prepare(`SELECT COUNT(*) as c FROM attachments WHERE attachment_kind = 'html'`).get().c

  check('DB records = 176', dbRecords, (v) => v === 176)
  check('DB has_pdf = 27', dbWithPdf, (v) => v === 27)
  check('DB doi ≈ 140', dbWithDoi, (v) => Math.abs(v - 140) <= 14)
  check('DB attachments = 30 (27 pdf + 3 html)', dbAtts, (v) => v === 30)
  check('DB attachments pdf = 27', dbAttsPdf, (v) => v === 27)
  check('DB attachments html = 3', dbAttsHtml, (v) => v === 3)

  // Sample one row
  const sample = db.prepare(`
    SELECT id, title, doi, year, has_pdf, json_extract(keywords_json, '$[0]') as kw0
    FROM records WHERE has_pdf = 1 LIMIT 1
  `).get()
  console.log('sample db row:', sample)

  // Re-run ingestPackage — should be idempotent (same counts)
  header('Re-ingest idempotency')
  const second = await ingestPackage(db, {
    projectId: 'proj_test1',
    userId: 'user_test1',
    packageId: 'pkg_test1',
    packageRootPath: PKG,
  })
  const dbRecords2 = db.prepare('SELECT COUNT(*) as c FROM records').get().c
  const dbAtts2 = db.prepare('SELECT COUNT(*) as c FROM attachments').get().c
  check('records still 176 after re-ingest', dbRecords2, (v) => v === 176)
  check('attachments still 30 after re-ingest', dbAtts2, (v) => v === 30)
  console.log('second.total_duplicates:', second.total_duplicates)

  // Sanity: dedupProject is idempotent
  const dedup2 = dedupProject(db, { projectId: 'proj_test1' })
  console.log('dedup re-run:', dedup2)

  db.close()
} catch (e) {
  console.error('Persist test failed:', e)
  console.error(e.stack)
}

console.log('\n--- All checks done ---')
