# Agent E — WoS / Scopus / PubMed 检索式 AI 生成

Phase 3 Agent E 范围:学员完成研究协议审批后,在 `/projects/:id/search` 调 Claude 生成 3 库 × 3 版本(高召回 / 平衡 / 高精确)= 9 条检索式;支持复制、回填命中数、备注、导出 Markdown 附录。覆盖 PRISMA 2020 #6(信息来源)+ #7(检索策略)。

## 文件清单(全部新增)

| 文件 | 作用 |
|---|---|
| `services/prompts/search.js` | `SEARCH_SYSTEM` / `buildSearchUserPrompt` / `normalizeSearchOutput` — Prompt 2 LLM 接口 |
| `routes/projects/search.js`  | 5 个 Express 路由 + 内部 helpers |
| `views/projects/search.ejs`  | 检索式页面(stepper 布局 + 3 个 tab + 9 个卡片) |
| `SUMMARY-E.md`               | 本文件 |

**没改动**:`server.js`、`db/schema.sql`、`routes/projects/index.js`、任何 `services/llm.js` / `services/prisma.js` / partials 等已锁定的文件。

## server.js 该 append 的 mount 代码

`routes/projects/search.js` 用了 `express.Router({ mergeParams: true })` + 路由路径 `/:id/search...`,所以挂载到 `/projects` 即可。建议放在 `projectsRouter` 之后(任意顺序都行,Express 会按声明顺序匹配,两个 router 不冲突,因为路径不同)。

```js
// server.js — 在已有 projectsRouter 行之后追加
import searchRouter from './routes/projects/search.js'
// ... existing imports ...

app.use('/projects', requireUser, projectsRouter)
app.use('/projects', requireUser, searchRouter)     // ← Agent E
```

> 注:也可以并入 `projectsRouter`(在 `routes/projects/index.js` 里 `router.use('/:id/search', searchRouter)`),但没动 `routes/projects/index.js`,所以走顶层挂载更干净。

## 路由表

| Method | Path                                              | 作用 |
|--------|---------------------------------------------------|------|
| GET    | `/projects/:id/search`                            | 渲染检索式页(协议未审批 → 提示;已生成 → 9 卡片 + 3 tab) |
| POST   | `/projects/:id/search/generate`                   | 调 runLlm(actionType='search_strategy', model='heavy') → 解析 JSON → 同一 version 批量写入 search_strategies |
| POST   | `/projects/:id/search/:strategyId/log`            | 表单字段 `result_count`(int≥0)、`search_date`(YYYY-MM-DD) → UPDATE |
| POST   | `/projects/:id/search/:strategyId/notes`          | 表单字段 `notes` → UPDATE(限 4000 字) |
| GET    | `/projects/:id/search/export.md`                  | 生成 Markdown 附录(协议要点 + 9 检索式 + 命中汇总表),`Content-Type: text/markdown; charset=utf-8`,`Content-Disposition: attachment` |

所有路由都用本地 `ownProjectOr404(db, projectId, userId)` 直接 SELECT 校验项目归属,**不依赖 routes/projects/index.js 内部函数**。

## Search prompt 设计要点

`services/prompts/search.js` 的 `SEARCH_SYSTEM` 强调三件事:

1. **严格 JSON schema**:`expanded_terms` + `strategies[9]` + `warnings`。strategies 顺序固定:wos×3 → scopus×3 → pubmed×3,版本顺序 high_recall → balanced → high_precision。
2. **9 条不能少**:LLM 跳过任何组合都属于失败。
3. **三库语法手册**:
   - **WoS** `TS=()` / `PY=()` / `DT=()`,`"短语"` / `*` 截词 / `NEAR/5`
   - **Scopus** `TITLE-ABS-KEY()` / `PUBYEAR > x AND PUBYEAR < y` / `DOCTYPE("ar")` / `W/5` / `PRE/5`
   - **PubMed** `[MeSH Terms]` + `[Title/Abstract]` 组合 / `"YYYY/MM/DD"[Date - Publication] : "3000"[Date - Publication]` / `[Publication Type]`,截词仅末尾且 ≥4 字符
4. 每个版本的预期密度:high_recall ≈ balanced × 3-10;high_precision ≈ balanced × 1/3-1/2。
5. `buildSearchUserPrompt` 把已审批 protocol 的 concept_groups / RQ / 纳排标准 / 项目年份 / 文献类型 / 语言全部塞进 user message,LLM 会把年份/类型直接写进 `query_text`。

## normalizeSearchOutput 容错

- 大小写不敏感地匹配 database / query_type
- 同 (database, query_type) 重复 → 仅保留首条
- 非白名单 database / query_type 或空 query_text → 剔除
- filters 任何 schema 错误 → 该 filters 字段设 null,不影响整条
- 任意字段缺失 → 兜底为空

## 路由层关键校验

- 进 `/generate` 前先 `getApprovedProtocol`,无审批 → flash 错误 + redirect,不调 LLM
- runLlm 返回 `ok:false` → flash + audit `search_generate_failed`,不 500
- normalized.strategies < 6 条 → 拒绝写库,audit + flash
- 写库用 transaction,同时把项目 `status` 从 `protocol_approved` 升到 `searching`(已是 searching/之后状态则不动)
- log 路由对 result_count 做 `Number.parseInt + ≥0` 校验;search_date 强制 YYYY-MM-DD 否则当 null

## 审计事件

| event_type | 触发 | payload |
|---|---|---|
| `search_generated`           | 成功批量写入 | `{ version, model, provider, duration_ms, count_total, count_per_db, warnings_count, had_expanded_terms }` |
| `search_generate_failed`     | runLlm 失败 / 解析<6条 | `{ status, error?, count?, model? }` |
| `search_logged`              | log 路由 | `{ strategy_id, result_count, search_date }` |
| `search_note_updated`        | notes 路由 | `{ strategy_id, has_notes }` |
| `search_exported_md`         | export.md | `{ version, strategy_count, bytes }` |

## UI 要点(views/projects/search.ejs)

- 沿用 Agent D 的 stepper 布局:`<%- include('partials/project-header') %>` + `<%- include('partials/stepper', { ..., currentStep: 'search' }) %>`
- 协议未审批 → 黄色提示卡 + "前往协议步骤"按钮(链接到 `/projects/:id`)
- 协议已审批 → 绿色卡 + "让 Claude 生成检索式"按钮(POST `/generate`)
- 生成后:3 个数据库 tab(WoS / Scopus / PubMed),每 tab 内按 high_recall → balanced → high_precision 排序展示卡片
- 每张卡片:版本徽章 + 复制按钮(navigator.clipboard,带 fallback)+ 设计理由 + readonly textarea(font-mono,query_text)+ 过滤器 chips + 命中数表单 + 检索日期表单 + 备注 details
- 顶部有"导出 Markdown 附录"链接(只在已生成时显示)
- 历史版本号在底部列出(导出只含最新)
- Tab 切换是纯 inline JS,无外部依赖

## Markdown 附录格式

```
# 检索策略附录 — <项目名>
- 项目主题 / 学科 / 年份 / 协议 vN / 检索式 vM / 导出时间

## 协议要点
研究问题 / 概念组

## 检索式(PRISMA 2020 #6 + #7)
### Web of Science
#### 高召回
- 设计理由 / 过滤 / 检索日期 / 命中数 / 备注
` ` `
<query_text>
` ` `
...(Scopus / PubMed 同结构)

## 命中数汇总
| 数据库 | 版本 | 命中数 | 检索日期 |
```

`query_text` 包在三反引号代码块,防 markdown 干扰。

## PRISMA 集成

- `services/prisma.js` 的 `getProjectProgress` 已经知道 search step:有 search_strategies → in_progress;有 result_count 不为 null 的 → done。本 router 写入即触发该路径。
- PRISMA item 6 / 7 的 status 由 Agent F 那边管,本 Agent 不动 `prisma_checklist` 表。

## 测试 checklist(本地)

1. `npm run dev`,登录 → 新建项目 → 让 Claude 生成协议 → 审批 v1
2. URL `/projects/<id>/search`
3. 协议已审批的提示卡可见 → 点"让 Claude 生成检索式"
4. 等 30-180 秒,flash 显示"已生成检索式 v1: 9 条 / NNNms"
5. 页面渲染 3 个 tab,每 tab 三张卡片;切换 tab 工作正常
6. 点任意"复制"按钮 → 按钮变"已复制 ✓",粘贴到外部应用(剪贴板有效)
7. 填命中数(整数)+ 检索日期 → 保存记录,刷新仍在
8. 备注 details 展开,填一段,保存
9. 顶部"导出 Markdown 附录" → 下载 `search-strategy-<title>-v1.md`
10. 再次点"重新生成检索式" → version 升到 v2,UI 默认显示 v2
11. 在 admin 面板看 `audit_events`:应能看到 `search_generated` / `search_logged` / `search_exported_md`
12. **负面用例**:协议未审批时点"生成" → flash 错误(不调 LLM、不 500)

## 不变量

- 未 `npm install`
- 未 `git commit`
- 未动 `db/schema.sql`、`server.js`、`routes/projects/index.js`、`services/llm.js` 等锁定文件
- LLM 全部走 `runLlm`
- 不与 Agent D 的 partials 冲突(只 include 不修改)
- 不与 Agent F 的 prisma 范围冲突(不写 prisma_checklist 表)
