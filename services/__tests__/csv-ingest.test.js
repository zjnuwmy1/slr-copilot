/**
 * Smoke test for services/csv-ingest.js
 * ------------------------------------------------------------
 * 不依赖测试框架,跑:
 *   node services/__tests__/csv-ingest.test.js
 *
 * Coverage:
 *   1. detectFormat() 对 WoS(tab)/ Scopus(comma)/ PubMed 三种 fixture 正确识别
 *   2. parseCsv() 字段映射(title / authors_text / year / journal / doi / abstract / keywords)
 *   3. ingestCsv() 写入临时 in-memory SQLite,records 行数与去重统计正确
 *   4. UTF-8 BOM + 中文标题 + 字段内逗号(被引号包)
 *   5. unknown 格式不写库
 */

import Database from 'better-sqlite3'
import { detectFormat, parseCsv, parseCsvText, ingestCsv } from '../csv-ingest.js'

let pass = 0
let fail = 0
function check(label, cond) {
  if (cond) { pass += 1; console.log('PASS', label) }
  else { fail += 1; console.log('FAIL', label) }
}
function header(s) {
  console.log('\n' + '='.repeat(60) + '\n' + s + '\n' + '='.repeat(60))
}

// ---------- 1. parseCsvText 基础 ----------
header('parseCsvText basics')

{
  const txt = 'a,b,c\n1,2,3\n"x,1","y""z",w\n'
  const rows = parseCsvText(txt, ',')
  check('rowCount=3', rows.length === 3)
  check('quoted comma in cell', rows[2][0] === 'x,1')
  check('escaped quote in cell', rows[2][1] === 'y"z')
}

{
  // CRLF + BOM
  const txt = '﻿h1,h2\r\nv1,v2\r\n'
  const rows = parseCsvText(txt, ',')
  check('BOM + CRLF parses', rows.length === 2 && rows[0][0] === 'h1' && rows[1][1] === 'v2')
}

// ---------- 2. WoS tab-separated fixture ----------
header('WoS (tab) fixture')

const wosFixture = [
  'AU\tTI\tSO\tPY\tDI\tAB\tDE',
  'Wang, G; Tang, R\tA Robotic Foundation Model Survey\tNature Machine Intelligence\t2024\t10.1038/s42256-024-00001-1\tThis survey covers...\tfoundation models; robotics; LLM',
  'Liu, X\tDeep Learning for Manipulation\tIEEE TRO\t2023\t10.1109/TRO.2023.12345\tWe propose...\tmanipulation; deep learning',
].join('\n')

{
  const fmt = detectFormat(wosFixture)
  check('wos detected', fmt === 'wos')
  const recs = parseCsv(wosFixture, 'wos')
  check('wos parsed 2 rows', recs.length === 2)
  check('wos title', recs[0].title === 'A Robotic Foundation Model Survey')
  check('wos authors normalized', recs[0].authors_text === 'Wang G, Tang R')
  check('wos year=2024', recs[0].year === 2024)
  check('wos doi', recs[0].doi === '10.1038/s42256-024-00001-1')
  check('wos keywords split', Array.isArray(recs[0].keywords) && recs[0].keywords.length === 3)
}

// ---------- 3. Scopus comma fixture(字段里有逗号,被引号包) ----------
header('Scopus (comma + quoted) fixture')

const scopusFixture = [
  '"Authors","Title","Year","Source title","Cited by","DOI","Abstract","Author Keywords"',
  '"Wang G., Tang R., Xu M.","A study, with comma, in title","2024","Advanced Robotics","12","10.1109/AR.2024.000","An abstract with ""quotes"" inside.","robot; learning"',
  '"Chen Y., Li B.","Another paper","2023","J. Robotic Sys.","3","10.1002/jrs.2023.99","Short abstract.","ai; control"',
].join('\n')

{
  const fmt = detectFormat(scopusFixture)
  check('scopus detected', fmt === 'scopus')
  const recs = parseCsv(scopusFixture, 'scopus')
  check('scopus parsed 2 rows', recs.length === 2)
  check('scopus title has comma kept', recs[0].title === 'A study, with comma, in title')
  check('scopus abstract has unescaped quotes', recs[0].abstract.includes('"quotes"'))
  check('scopus year=2024', recs[0].year === 2024)
  check('scopus doi', recs[0].doi === '10.1109/AR.2024.000')
}

// ---------- 4. PubMed CSV fixture ----------
header('PubMed CSV fixture')

const pubmedFixture = [
  'PMID,Title,Authors,Citation,First Author,Journal/Book,Publication Year,Create Date,PMCID,NIHMS ID,DOI',
  '12345678,"PubMed sample title","Wang G, Tang R","Nature. 2024;5(1):1-10",Wang G,Nature,2024,2024-01-15,PMC9999999,,10.1038/nat.2024.1',
  '87654321,"中文标题:基于深度学习的机器人控制","Liu X, Chen Y","机器人. 2023;1(1):1",Liu X,机器人,2023,2023-06-01,,,10.6789/zh.2023.01',
].join('\n')

{
  const fmt = detectFormat(pubmedFixture)
  check('pubmed detected', fmt === 'pubmed')
  const recs = parseCsv(pubmedFixture, 'pubmed')
  check('pubmed parsed 2 rows', recs.length === 2)
  check('pubmed chinese title kept', recs[1].title.includes('中文标题'))
  check('pubmed year=2024', recs[0].year === 2024)
  check('pubmed doi', recs[0].doi === '10.1038/nat.2024.1')
  check('pubmed journal', recs[0].journal === 'Nature')
}

// ---------- 5. UTF-8 BOM + 中文 ----------
header('UTF-8 BOM + Chinese')

{
  const bomCsv = '﻿' + scopusFixture
  const fmt = detectFormat(bomCsv)
  check('BOM does not break detection', fmt === 'scopus')
  const recs = parseCsv(bomCsv, 'scopus')
  check('BOM rows ok', recs.length === 2)
}

// ---------- 6. unknown 格式 ----------
header('Unknown format')

{
  const junk = 'foo,bar,baz\n1,2,3\n4,5,6'
  check('unknown detected', detectFormat(junk) === 'unknown')
}

// ---------- 7. ingestCsv + in-memory DB ----------
header('ingestCsv (in-memory DB)')

{
  const db = new Database(':memory:')
  // 只建必要的 records 表(不带 FK,简化)+ projects 占位
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
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
  `)
  db.prepare(`INSERT INTO projects (id) VALUES (?)`).run('proj1')

  // 第一次:scopus 2 条 → 都新进
  let r = ingestCsv(db, {
    projectId: 'proj1',
    userId: 'u1',
    csvText: scopusFixture,
    sourceFilename: 'scopus-export.csv',
  })
  check('ingest #1 format=scopus', r.format === 'scopus')
  check('ingest #1 parsed=2', r.total_parsed === 2)
  check('ingest #1 inserted=2', r.total_inserted === 2)
  check('ingest #1 duplicates=0', r.total_duplicates === 0)

  // 第二次:同 CSV 再传一次 → 全部 duplicate
  r = ingestCsv(db, {
    projectId: 'proj1',
    userId: 'u1',
    csvText: scopusFixture,
    sourceFilename: 'scopus-export.csv',
  })
  check('ingest #2 inserted=0', r.total_inserted === 0)
  check('ingest #2 duplicates=2', r.total_duplicates === 2)

  // 第三次:WoS 2 条 → 全新(不同 DOI)
  r = ingestCsv(db, {
    projectId: 'proj1',
    userId: 'u1',
    csvText: wosFixture,
    sourceFilename: 'wos.txt',
  })
  check('ingest #3 format=wos', r.format === 'wos')
  check('ingest #3 inserted=2', r.total_inserted === 2)
  check('ingest #3 duplicates=0', r.total_duplicates === 0)

  // 第四次:PubMed 2 条(不同 DOI)
  r = ingestCsv(db, {
    projectId: 'proj1',
    userId: 'u1',
    csvText: pubmedFixture,
    sourceFilename: 'pubmed.csv',
  })
  check('ingest #4 format=pubmed', r.format === 'pubmed')
  check('ingest #4 inserted=2', r.total_inserted === 2)

  // 总计入库 6 条
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE project_id = ?`).get('proj1').n
  check('total rows in db = 6', cnt === 6)

  // 中文标题真的存进去了
  const zh = db.prepare(`SELECT title FROM records WHERE title LIKE ?`).get('%中文标题%')
  check('Chinese title persisted', zh && zh.title.includes('中文标题'))

  // unknown 格式不写库
  r = ingestCsv(db, {
    projectId: 'proj1',
    userId: 'u1',
    csvText: 'foo,bar\n1,2',
    sourceFilename: 'junk.csv',
  })
  check('unknown not inserted', r.format === 'unknown' && r.total_inserted === 0)
  const cnt2 = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE project_id = ?`).get('proj1').n
  check('row count unchanged after unknown', cnt2 === 6)
}

// ---------- 汇总 ----------
header('Summary')
console.log(`PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
