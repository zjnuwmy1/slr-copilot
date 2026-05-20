# SUMMARY-G — Phase 4 Agent G(Zotero RDF 解析 + ingest + 去重)

> 数据 ingest 后端服务,本期不挂路由 — 路由由 Agent H/I 负责,从这里 import。
> 注:Agent G 在执行时 harness 拒绝了 `.md` 文件写入,这份 summary 由汇总层(主 agent)代为落盘。

## 1. 文件清单

```
services/zotero-ingest.js              — 主解析器 + 持久化 + 流水线
services/dedup.js                      — DOI / normalized title 去重
services/__tests__/zotero-ingest.test.js — Node ESM smoke test
```

**没动**:`server.js`、`db/schema.sql`、`db/index.js`、`package.json`、其他 services、任何 routes/views/middleware。

## 2. API 签名(Agent H 用)

### `services/zotero-ingest.js`

```js
parseZoteroRdf({ rdfText, packageRootPath }) → {
  meta: { rdf_about_count, attachment_count, errors: string[] },
  records: [{
    zotero_item_id, zotero_rdf_about, item_type,
    title, authors: [{surname, givenName, full, type}], authors_text,
    year, date_text, journal, publisher, doi, url,
    abstract, keywords: string[], notes,
    attachments: [{ zotero_item_id, kind, filename, storage_path, mime_type }],
    has_pdf: 0|1,
  }]
}

persistParseResult(db, { projectId, userId, packageId, parseResult, packageStoragePath })
  → { package_id, total_records, total_with_pdf, total_with_doi, total_duplicates, manifest }

ingestPackage(db, { projectId, userId, packageId, packageRootPath })
  → Promise<{ package_id, total_records, total_with_pdf, total_with_doi,
              total_duplicates, dedup, manifest, rdf_filename }>
```

`ingestPackage` 自动:找 `*.rdf` → status `parsing → parsed → ingested`(失败 → `failed` + error_message)→ 解析 → 写 records/attachments → 跑 `dedupProject` → 回填 `zotero_packages` 统计列。

### `services/dedup.js`

```js
dedupProject(db, { projectId }) → { groups_found, records_merged }
normalizeTitle(s) → string
normalizeDoi(s)   → string
```

去重规则:**Level 1** `normalizeDoi(doi)` 完全匹配;**Level 2** `normalized_title` 完全 + `year ±1` + 第一作者姓相同。幂等。

## 3. 实测数字(`/Users/mingyu/Downloads/robotic foundation models/`)

| 指标 | 实测 | 期望 |
|---|---:|---:|
| records 总数 | **176** | 176 |
| journalArticle / conferencePaper / bookSection / webpage | **52 / 122 / 1 / 1** | 52/122/1/1 |
| has_pdf | **27** | 27 |
| with_doi | **141** | ~140 |
| with_abstract | **172** | ≥150 |
| with_notes (>50 char) | **165** | ≥1 |
| with_authors / with_year | **175 / 176** | ≥160 |
| attachments(27 pdf + 3 html) | **30** | 30 |
| dedup groups / records_merged | **1 / 1** | — |
| parse 耗时 | 53 ms | — |
| ingest 全程 | ~60 ms | — |
| meta.errors | **0** | 0 |

幂等性:同 `packageId` 二次 `ingestPackage`,records / attachments 保持 176 / 30。

## 4. 关键设计

- **节点识别**:122 条 conferencePaper 都在 `<rdf:Description>` 下而不是专用 tag,需要这个 tag 也算文献条目
- **`dcterms:isPartOf` 双格式兼容**:外部 `rdf:resource` 引用 + 内联 `<bib:Journal>`,内联优先
- **DOI 多源 fallback**:`bib:doi` → `dc:identifier DOI ...` → journal 上的 → URL regex 抠
- **附件验证**:160 个 `<z:Attachment>` 里只入库 30 条(其余是 Zotero URL 引用,文件不在本地)
- **笔记关联**:`dcterms:isReferencedBy` 双向扫,多条 memo 用 `\n\n---\n\n` 拼成单 `notes`
- **fast-xml-parser**:`maxTotalExpansions: 10000000`,`maxExpandedLength: 50000000`(嵌入 HTML 笔记的 RDF 会爆默认 1000)
- **写入策略**:records 用 `INSERT OR REPLACE`;attachments 在事务里先 DELETE WHERE package_id 再全量重插

## 5. Agent H 集成提示

```js
import { ingestPackage } from '../../services/zotero-ingest.js'

const summary = await ingestPackage(db, {
  projectId,
  userId: req.user.id,
  packageId,
  packageRootPath,
})
```

`zotero_packages` 行需在调 `ingestPackage` 之前插入(`ingestPackage` 只 UPDATE 不 INSERT)。

## 6. 已知不足

- 跨包 dedup 未测
- 中文作者姓未测
- 超大 RDF (>50 MB) 同步全量读入,届时需切流式
- 未抽 PDF 全文,只索引路径
- 未关联 attachment-level annotation(Zotero 给 PDF 加的批注)
