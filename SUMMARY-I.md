# SUMMARY-I — Records 浏览(Phase 4 Agent I)

让用户浏览 Zotero ingest 后的文献条目:列表 + 详情 + PDF 下载/预览。

## 1. 文件清单(新建)

- `routes/projects/records.js` — Express Router(`mergeParams: true`),3 个路由
- `views/projects/records/list.ejs` — 列表 + 过滤 + 分页
- `views/projects/records/detail.ejs` — 详情 + 附件
- `SUMMARY-I.md` — 本文件

不动:`server.js`、`db/*`、`package.json`、任何 `services/*`、任何已有 routes/views。

## 2. server.js 需要追加的代码

汇总层请按下方两处加入。

```js
// === import 区(与其它 project 子路由一起) ===
import projectRecordsRouter from './routes/projects/records.js'

// === 路由挂载区(放在 projectsRouter 之前!否则通用 /:id 会先吃掉) ===
app.use('/projects/:id/prisma', requireUser, projectPrismaRouter)
app.use('/projects', requireUser, projectRecordsRouter)   // ← 新增
app.use('/projects', requireUser, projectSearchRouter)
app.use('/projects', requireUser, projectsRouter)
```

> records router 的所有路径都是 `/:id/records*` 和 `/:id/attachments/:aid/download`,与 `projectSearchRouter` (`/:id/search/*`) 不冲突,顺序随意;但必须在 `projectsRouter` 之前注册,否则通用 `/:id` 占位会先匹配。

## 3. 路由 + 查询字段

| Method | Path | 说明 |
|---|---|---|
| GET | `/projects/:id/records` | 列表。Query: `q` `has_pdf` `has_doi` `hide_duplicates` `year_from` `year_to` `page`。默认 `hide_duplicates=1`。每页 50 条。 |
| GET | `/projects/:id/records/:recordId` | 详情:metadata / abstract / keywords / Zotero notes / 附件 / 重复组。 |
| GET | `/projects/:id/attachments/:attachmentId/download` | 下载/预览。PDF → `Content-Disposition: inline`,其它 → `attachment`。 |

### 列表 SELECT

```sql
SELECT r.*,
  (SELECT COUNT(*) FROM attachments WHERE record_id = r.id AND attachment_kind = 'pdf') AS pdf_count,
  (SELECT COUNT(*) FROM attachments WHERE record_id = r.id) AS total_attachments
FROM records r
WHERE r.project_id = ?
  [AND r.duplicate_of_record_id IS NULL]   -- hide_duplicates(默认开)
  [AND r.has_pdf = 1]                       -- has_pdf 过滤
  [AND r.doi IS NOT NULL AND r.doi != '']  -- has_doi 过滤
  [AND r.year >= ? AND r.year <= ?]        -- 年份范围
  [AND (r.title LIKE ? OR r.authors_text LIKE ? OR r.journal LIKE ? OR r.doi LIKE ?)]  -- 关键词
ORDER BY (r.year IS NULL), r.year DESC, r.title
LIMIT 50 OFFSET ?
```

### 统计字段(顶部小卡)

`total / with_pdf / with_doi / duplicates / missing_abstract`,**不受过滤影响**(永远是项目全貌)。

### 安全要点

1. 过滤 SQL 全部参数化(`?` placeholder)。
2. 下载校验三重:项目归属 → attachment JOIN records 验项目 → `path.resolve` 后用 `path.relative()` 比对 `$DATA_DIR/uploads/`,出根则 403。
3. `fs.statSync` + `isFile()` 双保险,不存在 → 404。
4. 非 ASCII 文件名走 RFC 5987(`filename*=UTF-8''...`),中文 OK。
5. UPLOADS_ROOT 取 `process.env.DATA_DIR || '/var/lib/slr'` + `/uploads`。

## 4. UI 截图描述(文字版)

### 列表页 `/projects/:id/records`

```
← 项目列表
[项目标题]                                                      [状态徽章]

┌─ Stepper(左) ─┐  Records · 文献条目
│ 1. 协议 ✓     │  文献条目浏览
│ 2. 检索式 ✓   │  从 Zotero RDF 解析得到的全部条目…
│ 3. 筛选 ← 当前 │
│ 4-8 锁定      │  ┌─────┐┌─────┐┌─────┐┌─────┐┌─────┐
└──────────────┘  │总数 ││PDF ││DOI ││重复 ││缺Abs│
                   │ 176 ││ 27 ││140 ││  2  ││ 18 │
                   └─────┘└─────┘└─────┘└─────┘└─────┘

                   ┌─ 过滤工具栏(横排) ──────────────────────────┐
                   │ [关键词____][年起][年止] ☐PDF ☐DOI ☑隐藏重复  │
                   │                                  [筛选][重置] │
                   └────────────────────────────────────────────┘

                   显示第 1-50,共 174 条匹配         第 1/4 页

                   ┌──────────────────────────────────────────┐
                   │ ☐ │ Title / authors      │ 年 │ 期刊 │标记 │
                   ├──────────────────────────────────────────┤
                   │ ☐ │ Foundation Models …  │2024│ AIS  │PDF DOI │
                   │   │ Wang G, Tang R, Xu M et al.        │
                   │   │ [robotics][VLA]+3                  │
                   │ ☐ │ Survey of …          │2023│ TPAMI│PDF DOI Note │
                   │ … (50 行)                              │
                   └──────────────────────────────────────────┘
                              [← 上一页][1] 2 3 4 [下一页 →]
```

badge 配色:`PDF` emerald-100/700 · `DOI` blue-100/700 · `Note` violet-100/700 · `DUP` slate-100/500。

### 详情页 `/projects/:id/records/:recordId`

```
← 返回文献列表                            [已合并副本?][journalArticle]

┌───────────────────────────────────────────────────────────────┐
│ 标题(大字号)                                                 │
│ Wang G, Tang R, Xu M, Liu S, Tang J  (前 5 个,> 5 显示总数)  │
│                                                                │
│ 年份: 2024     期刊: Advanced Intelligent Systems              │
│ DOI: 10.1002/aisy.xxx (蓝链接,点跳 doi.org)                  │
│ URL: https://...      Zotero ID: #item_1364                   │
│                                                                │
│ 关键词: [foundation model] [robotics] [VLA] …                 │
└───────────────────────────────────────────────────────────────┘

┌─ Abstract(主区) ──────────────┐  ┌─ 附件(右栏) ──────┐
│ Recent advances …              │  │ [PDF] 4.2 MB        │
│ (whitespace-pre-line 换行)     │  │ wang_2024.pdf       │
└────────────────────────────────┘  │ [预览 PDF] 按钮     │
┌─ Zotero 笔记(紫色,可选) ───┐  └─────────────────────┘
│ 中文标注 …                     │  ┌─ 下一步 ───────────┐
└────────────────────────────────┘  │ → 前往筛选        │
                                     └────────────────────┘
┌─ 同组重复条目 (若有) ──────────────────────────────────┐
│ [主/副] Title …  · 2024 · 期刊                          │
└────────────────────────────────────────────────────────┘
```

### 空态(records 表空)

居中卡片:📭 + "还没有文献条目" + "前往 Zotero 上传" 按钮(链到 `/projects/:id/zotero`,由 Agent H 实现)。

## 5. 测试 checklist(G+H 未合并也能验证)

**空表也跑得通:**

- [ ] 登录后访问 `/projects/<own_project>/records` → 渲染空态(stepper 显示 currentStep=screening)。
- [ ] Query 拼 `?q=test&has_pdf=1&has_doi=1&year_from=2020&year_to=2024&page=2&hide_duplicates=0` → 正常渲染"无匹配"。
- [ ] 重置链接清空 query → 回到 `/projects/:id/records`。
- [ ] `/projects/:id/records/不存在` → 404 error 页(不是 500)。
- [ ] 跨用户:`/projects/<otherUserProject>/records` → 404(`ownProjectOr404` 拦)。
- [ ] `/projects/<own>/attachments/anything/download` 在表空时 → 404 "附件不存在或无权访问"。

**G+H 合并 + ingest 后:**

- [ ] 176 条 → 4 页分页(50/50/50/26),分页器显示 1 … 4。
- [ ] `has_pdf=1` → 27 条;`hide_duplicates=0` → 显示被合并副本(若有)。
- [ ] 详情页点 PDF → 浏览器内嵌打开。
- [ ] **路径遍历**:手动 UPDATE `attachments SET storage_path='/etc/passwd'` 后访问 download → 403。
- [ ] **越权**:别人项目的 attachmentId 拼自己项目 URL → 404。
- [ ] 中文文件名能正确下载(RFC 5987)。
- [ ] Zotero 中文 `notes` 字段紫色框内换行正常(`whitespace-pre-line`)。

## 6. 实现细节备忘

- **`hide_duplicates` 默认 true**:checkbox 勾选时表单字段为空 → 后端 `query.hide_duplicates !== '0'` 判断为开;取消勾选 → 隐藏字段提交 `hide_duplicates=0`。
- **authors 解析**:列表用 `authors_text` split(`,;`)取前 3 + `et al.`;详情用 `authors_json` 解析,前 5 + "共 N 位作者"。
- **重复组**:同 `duplicate_group_id` 的其他记录(主记录优先,LIMIT 20)+ 若本条是副本,单独高亮主记录卡。
- **stepper currentStep**:`'screening'`(records 是筛选的入口)。
- **页号修正**:用户传 page > totalPages 时自动夹到 totalPages,不会越界查询。
- **只读,不写 usage_logs / audit_events**:浏览页无须审计。
