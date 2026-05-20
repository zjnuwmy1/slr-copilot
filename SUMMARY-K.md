# SUMMARY-K — Phase 4.5 Agent K(手动新增/编辑文献 + 引文复制 + 批量导出)

> harness 不允许子 agent 写 .md,本份由汇总层代落。

## 文件清单(仅分配范围)
```
routes/projects/records.js              (扩展,原 3 路由保留)
views/projects/records/list.ejs         (扩展)
views/projects/records/detail.ejs       (扩展)
views/projects/records/new.ejs          (新建)
views/projects/records/edit.ejs         (新建)
services/crossref.js                    (新建)
```

## 新增路由

| Method | Path | 说明 |
|---|---|---|
| GET  | `/:id/records/new` | 手动新增表单(含 DOI 自动填) |
| POST | `/:id/records/new/lookup-doi` | AJAX,Crossref API 5s 超时,回填表单 |
| POST | `/:id/records` | 创建 record(手动,无 zotero_package_id) |
| GET  | `/:id/records/:recordId/edit` | 编辑表单 |
| POST | `/:id/records/:recordId/update` | 更新 record |
| POST | `/:id/records/:recordId/delete` | 删除 + 级联附件 + duplicate_of 置 NULL |
| GET  | `/:id/records.bib` | 批量 BibTeX,`?ids=` 子集 |
| GET  | `/:id/records.ris` | 批量 RIS |
| GET  | `/:id/records.csl.json` | 批量 CSL JSON |
| GET  | `/:id/records.refs.md` | References 章节 Markdown,`?style=apa\|ieee\|gb_t_7714` |

路由顺序保证 `/records/new` 在 `/records/:recordId` 之前(实测 Express 4.21 无冲突)。

## UI 重点
- **list.ejs**:顶部"+ 手动新增"按钮 + "批量导出 ▾"下拉,每行加 checkbox 列(为后续 bulk)
- **detail.ejs**:标题旁"✏️ 编辑"+ "📋 复制为 ▾"(5 style clipboard JS,内嵌前 `JSON.stringify` + `< > &` 转义防 XSS)+ 底部红色危险区"删除"
- **new.ejs / edit.ejs**:顶部 DOI 自动填输入框 + 按钮,POST `/records/new/lookup-doi` 拿元数据回填

## services/crossref.js
- `fetchByDoi(doi, { timeoutMs: 5000 })` → null | normalized object
- User-Agent 标识,JATS abstract 清理,type 映射(journal-article → journalArticle 等)

## 安全
- 全部路由过 `ownProjectOr404`
- update/delete 二次校验 `project_id`
- 删除附件:`path.relative(UPLOADS_ROOT, abs)` 防遍历 + `unlinkSync` try/catch
- 事务把指向被删 record 的 `duplicate_of_record_id` 置 NULL
- 5 style 字符串内嵌前 `JSON.stringify` + 转义 `< > &`

## 审计
- `record_created` / `record_updated` / `record_deleted` / `record_exported`(format / style 在 payload)

## 集成自测(内存 DB)
- 创建 / 更新 / 删除流通
- 4 种导出端点返回正确 Content-Type + 合法内容(`@article` / `TY  - ` / valid JSON / `[1]`)
- 空 title → 400
- 空 DOI → 400 `invalid_doi`
- XSS 转义生效

## 不变量
- 0 新依赖,0 schema 改动
- 未改 server.js / 其他 routes / Agent J 的 services
- 未 npm install,未 git commit

## 已知取舍
- 无 CSRF(沿用项目现状)
- 无批量删除/编辑(checkbox UI 已就位)
- "Li Wei" 按英文 "Given Surname" 习惯解析为 surname=Wei,提示已写在 UI
- new/edit 模板字段重复未抽 partial(短期可接受)
