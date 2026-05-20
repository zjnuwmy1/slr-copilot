/**
 * Smoke test for services/pdf-parse.js
 * ------------------------------------------------------------
 * 不依赖测试框架,直接 node ESM 跑:
 *   node services/__tests__/pdf-parse.test.js
 *
 * 测试数据来自 /Users/mingyu/Downloads/robotic foundation models/
 * 用 zotero-ingest 先把 RDF + PDF 灌进 in-memory SQLite,
 * 再跑 parsePdfAttachment / parseProjectPdfs / getSectionText 端到端验证。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  parsePdfAttachment,
  parseProjectPdfs,
  getChunksForRecord,
  getSectionText,
  PDF_PARSE_CONSTANTS,
} from '../pdf-parse.js'

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

header('Setup')
if (!fs.existsSync(RDF_FILE)) {
  console.error('Test RDF not found at:', RDF_FILE)
  console.error('This test requires the real Zotero export. Skipping.')
  process.exit(0)
}

const Database = (await import('better-sqlite3')).default
const { ingestPackage } = await import('../zotero-ingest.js')

// 建 in-memory DB,只包含 pdf-parse 需要的表 + zotero-ingest 需要的表
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
  CREATE TABLE paper_chunks (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    attachment_id TEXT,
    section_type TEXT,
    heading TEXT,
    page_start INTEGER,
    page_end INTEGER,
    chunk_index INTEGER,
    text TEXT NOT NULL,
    token_count INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_chunks_record ON paper_chunks(record_id);
  CREATE INDEX idx_chunks_section ON paper_chunks(section_type);
`)

// Ingest 真实 RDF
db.prepare(`
  INSERT INTO zotero_packages (id, project_id, user_id, source_kind, storage_path)
  VALUES (?, ?, ?, 'web_upload', ?)
`).run('pkg_test_pdf', 'proj_test_pdf', 'user_test_pdf', PKG)

console.log('Ingesting Zotero package...')
await ingestPackage(db, {
  projectId: 'proj_test_pdf',
  userId: 'user_test_pdf',
  packageId: 'pkg_test_pdf',
  packageRootPath: PKG,
})

const pdfRows = db
  .prepare(`SELECT id, record_id, filename, storage_path FROM attachments WHERE attachment_kind = 'pdf'`)
  .all()
console.log(`Ingested. Found ${pdfRows.length} pdf attachments.`)

// ---------- Test 1: single PDF ----------

header('Test 1: parsePdfAttachment — single PDF')

// 挑一个文件名靠前的 PDF
const sample = pdfRows[0]
console.log('parsing:', sample.filename)
console.log('storage_path:', sample.storage_path)

const t0 = Date.now()
const res = await parsePdfAttachment(db, {
  attachmentId: sample.id,
  recordId: sample.record_id,
})
const elapsed = Date.now() - t0
console.log(`elapsed: ${elapsed} ms`)
console.log('result:', {
  record_id: res.record_id,
  page_count: res.page_count,
  total_chunks: res.total_chunks,
  text_length: res.text_length,
  sections: res.sections,
  errors_count: res.errors.length,
  requires_ocr: res.requires_ocr || false,
})

check('page_count > 0', res.page_count, (v) => v > 0)
check('total_chunks > 0', res.total_chunks, (v) => v > 0)
check('text_length > 1000', res.text_length, (v) => v > 1000)
check('not requires_ocr', res.requires_ocr || false, (v) => v === false)
check('sections has at least 2 types', Object.keys(res.sections).length, (v) => v >= 2)
// 大多数 robotics 论文都有 references
check(
  'has at least one of {abstract, references}',
  ['abstract', 'references'].some((k) => (res.sections[k] || 0) > 0),
  (v) => v === true,
)

// 验证 DB 写入
const dbChunks = db
  .prepare(`SELECT COUNT(*) AS c FROM paper_chunks WHERE record_id = ?`)
  .get(sample.record_id).c
check('paper_chunks rows in DB match', dbChunks, (v) => v === res.total_chunks)

// ---------- Test 2: idempotency ----------

header('Test 2: re-parse same PDF — idempotent')
const res2 = await parsePdfAttachment(db, {
  attachmentId: sample.id,
  recordId: sample.record_id,
})
check('total_chunks unchanged after re-parse', res2.total_chunks, (v) => v === res.total_chunks)
const dbChunks2 = db
  .prepare(`SELECT COUNT(*) AS c FROM paper_chunks WHERE record_id = ?`)
  .get(sample.record_id).c
check('DB rows unchanged (no duplicates)', dbChunks2, (v) => v === res.total_chunks)

// ---------- Test 3: getChunksForRecord / getSectionText ----------

header('Test 3: query helpers')
const allChunks = getChunksForRecord(db, sample.record_id)
check('getChunksForRecord returns rows', allChunks.length, (v) => v === res.total_chunks)
check('chunk_index strictly ascending', allChunks, (v) => {
  for (let i = 1; i < v.length; i++) {
    if (v[i].chunk_index <= v[i - 1].chunk_index) return false
  }
  return true
})

for (const sec of Object.keys(res.sections)) {
  const txt = getSectionText(db, sample.record_id, sec)
  console.log(`  section ${sec}: ${txt.length} chars (chunks=${res.sections[sec]})`)
  check(`getSectionText(${sec}) returns non-empty`, txt.length, (v) => v > 0)
}

// ---------- Test 4: section header detection across multiple PDFs ----------

header('Test 4: section detection across 5 PDFs')

const samplePdfs = pdfRows.slice(0, 5)
const allSections = {}
for (const r of samplePdfs) {
  const result = await parsePdfAttachment(db, { attachmentId: r.id, recordId: r.record_id })
  console.log(`  ${r.filename.slice(0, 50)}...`)
  console.log(`    pages=${result.page_count} chunks=${result.total_chunks} sections=${JSON.stringify(result.sections)}`)
  for (const k of Object.keys(result.sections)) {
    allSections[k] = (allSections[k] || 0) + 1
  }
}
console.log('\naggregate sections found across 5 PDFs:', allSections)
check('detected references in ≥3 PDFs', allSections.references || 0, (v) => v >= 3)
check('detected at least 4 distinct section types overall', Object.keys(allSections).length, (v) => v >= 4)

// ---------- Test 5: parseProjectPdfs batch ----------

header('Test 5: parseProjectPdfs batch (force=true to reset)')
const progress = []
const batchRes = await parseProjectPdfs(db, {
  projectId: 'proj_test_pdf',
  onProgress: (idx, total, rid) => {
    if (idx === 0 || idx === total || idx % 5 === 0) {
      progress.push({ idx, total, rid })
    }
  },
  force: true,
})
console.log('batch result:', {
  total: batchRes.total,
  parsed: batchRes.parsed,
  skipped: batchRes.skipped,
  ocr_required: batchRes.ocr_required,
  failed: batchRes.failed,
})
console.log('progress callbacks:', progress.length)
check('batch.total = 27', batchRes.total, (v) => v === 27)
check('batch.parsed + ocr_required + failed = total', batchRes.parsed + batchRes.ocr_required + batchRes.failed, (v) => v === batchRes.total)
check('most PDFs parsed successfully (≥80%)', batchRes.parsed, (v) => v >= 22)

// 全项目的 section 分布
const sectionDist = db
  .prepare(`SELECT section_type, COUNT(*) AS c FROM paper_chunks GROUP BY section_type ORDER BY c DESC`)
  .all()
console.log('\nproject-wide section distribution:')
for (const row of sectionDist) console.log(`  ${row.section_type}: ${row.c} chunks`)

// ---------- Test 6: skip already-parsed ----------

header('Test 6: re-run batch with force=false → all skipped')
const batchRes2 = await parseProjectPdfs(db, {
  projectId: 'proj_test_pdf',
  force: false,
})
console.log('batch result 2:', {
  total: batchRes2.total,
  parsed: batchRes2.parsed,
  skipped: batchRes2.skipped,
  ocr_required: batchRes2.ocr_required,
  failed: batchRes2.failed,
})
check('all 27 skipped on second run', batchRes2.skipped, (v) => v === 27)

// ---------- 总结 ----------

header('Constants exposed')
console.log(PDF_PARSE_CONSTANTS)

db.close()
console.log('\n--- All checks done ---')
