# SUMMARY-U — Phase 9 · Step 3 CSV 导入(WoS / Scopus / PubMed)

> harness 拒 .md 写入,由汇总层代落。

给 Step 3 加了通用 CSV 工作流:用户在 WoS / Scopus / PubMed 跑完检索 → 导出 CSV → 上传到 `/projects/:id/import/csv` → 自动识别格式、字段映射、入库、去重。手写 ~50 行 CSV parser,无新依赖。

## 文件清单
- `services/csv-ingest.js`(新建)— `detectFormat / parseCsv / parseCsvText / ingestCsv`
- `routes/projects/import-csv.js`(新建)— `POST /` 单文件 multipart(.csv/.tsv/.txt ≤50MB)
- `views/projects/zotero.ejs`(扩展)— 在 Zotero 卡上方加 CSV 上传卡 + 3 种库导出说明 details
- `services/__tests__/csv-ingest.test.js`(新建)— **PASS 41 / FAIL 0**

## server.js 接入代码
```js
import projectImportCsvRouter from './routes/projects/import-csv.js'
// 加在 projectZoteroRouter 后面:
app.use('/projects/:id/import/csv', requireUser, projectImportCsvRouter)
```

## 关键设计
- **格式识别**:headers lowercase 后判断
  - 首列 `PMID` / 含 `pmcid` → PubMed
  - 命中 ≥3 个 WoS 2 字母代码(AU/TI/SO/PY/DI/AB/DE)→ WoS
  - `authors` + `title` + (`source title` | `cited by` | `author keywords`) → Scopus
  - 否则 unknown → flash error,不写库
- **分隔符自动**:首行引号外 `\t` vs `,` 多者胜(WoS tab / Scopus comma 都吃)
- **去重**:预取 project 的 DOI(`normalizeDoi`)+ `normalized_title`(`normalizeTitle`)集合,命中即跳;批内 set 同步更新避免同次内重复
- **手写 parser**:支持 `""` 转义、引号内逗号 / 换行、CRLF/LF/CR、UTF-8 BOM、tab/comma
- **审计**:`csv_imported`(format / total_parsed / total_inserted / total_duplicates) 或 `csv_import_failed`
- multer disk storage → `os.tmpdir()/slr-csv-uploads/`,处理完 unlink

## 测试 checklist(全 ✅)
1. WoS tab-separated → 识别 wos,作者 `Wang, G; Tang, R` → `Wang G, Tang R`
2. Scopus comma+quoted → 识别 scopus,标题里逗号保留,abstract `""` 还原 `"`
3. PubMed CSV → 识别 pubmed,中文标题 / DOI / journal / year 正确
4. UTF-8 BOM 兼容
5. 字段内逗号 + 引号包正确解析
6. unknown 格式不写库
7. 去重:同份 CSV 传两次,第二次 inserted=0 duplicates=2
8. 中文标题持久化

## 不变量
- 0 npm install / 0 schema 改动
- 未改 server.js / package.json / 其他 routes
- 未 git commit
