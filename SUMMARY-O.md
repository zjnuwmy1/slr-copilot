# SUMMARY-O — Phase 6 Agent O(主题聚类 + Evidence Matrix + 综述初稿 + PRISMA flow)

> harness 拒 .md 写入,由汇总层代落。

## 文件清单

**新建**:
```
services/prompts/synthesis.js
services/prompts/drafting.js
services/prisma-flow.js
routes/projects/synthesis.js
routes/projects/report.js
```

**替换**(占位 → 完整 UI):
```
views/projects/synthesis.ejs
views/projects/certainty.ejs
views/projects/report.ejs
```

**改动**:
- `routes/projects/index.js`:顶部 import 新两个 router + `router.use('/', synthesisRouter)` + `router.use('/', reportRouter)`(在 step-loop 之前,防 POST 被 GET 占位拦截);从 `STEP_LABELS` 删 `synthesis` / `report`(certainty 仍走 step-loop)

**不动**:server.js / schema / package.json / partials / 其他 services

## 路由(11 个)

### Synthesis(5 个)
- `GET  /:id/synthesis` — Evidence Matrix 页
- `POST /:id/synthesis/run` — 跑主题聚类
- `POST /:id/synthesis/themes/:themeId/edit` — 人工编辑主题
- `POST /:id/synthesis/themes/:themeId/delete` — 删主题
- `GET  /:id/synthesis/matrix.csv` — 导出矩阵

### Report(6 个)
- `GET  /:id/report` — 综述初稿编辑器
- `POST /:id/report/generate-section` — 跑单章 LLM
- `POST /:id/report/generate-all` — 顺序跑全部 8 章节
- `POST /:id/report/section/:sectionId/edit` — 人工编辑
- `GET  /:id/report/progress.json` — 批量进度
- `GET  /:id/report/export.md` — 整文 Markdown

## 关键设计

1. **PRISMA 数字绝对从 DB 算**,LLM 仅消费;Mermaid + 文字表共享同一 counts 对象
2. **citation_map 强校验**:paper_id 必须在 `included records` 集合;反向扫正文 `[xxx]` 补漏报;不合法记 `citation_issues`
3. **References 走 `exportReferencesSection`**(APA),不调 LLM
4. **synthesis 双层前置**:UI disable + POST 校验(< 5 篇 verified 拒跑)
5. **normalize 失败**:audit + 把 raw 8000 字写入 `usage_logs.error_message`(与 protocol 一致)
6. **generate-all** 用 `setImmediate` + 内存 `inFlightJobs` Map,前端 5 秒轮 `progress.json`
7. **draft_sections 版本化**:每次跑 / 编辑都写新 version

## AI 调用配置
- synthesis:`actionType: 'synthesis'`, model `heavy`, maxTokens 12288, timeoutMs 600_000 (10 min)
- 每个 section:`actionType: 'drafting'`, `heavy`, maxTokens 8192, timeoutMs 480_000 (8 min)

## 测试 checklist
1. `GET /projects/:id/synthesis` 在 verifiedCount<5 时按钮 disabled + 提示
2. 塞 5 条 verified extractions → POST `/run` → themes 表写入 + evidence_points 由 consistent_findings × supporting_record_ids 笛卡尔积生成
3. `GET /projects/:id/report` 渲染 9 张卡 + PRISMA 七节点 Mermaid + 数字表
4. POST `/report/generate-section` section=introduction → `draft_sections` 写入,正文含 `[record_id]` 占位
5. PRISMA 数字:Mermaid 节点 n=N 与右侧表格逐行一致(同一 counts 渲染)
6. `GET /report/export.md` 输出顺序:title→abstract→intro→methods→PRISMA(```mermaid```+表)→results→discussion→limitations→conclusion→References(APA)

## 校验
- `node --check` 全过
- EJS `ejs.renderFile` 三模板用空/满 mock 数据均成功
- routes/projects/index.js 注册 23 条路由,Phase 6 路由优先级正确
