# SUMMARY-F — Phase 3 Agent F(PRISMA 27 项清单 + 进度追踪)

> 注:Agent F 在执行时 harness 拒绝了 `.md` 文件写入,这份 summary 由汇总层(主 agent)代为落盘。

## 1. 文件清单
```
routes/projects/prisma.js
views/projects/prisma.ejs
```
未修改任何已有文件。

## 2. 路由表(挂在 `/projects/:id/prisma`)

| Method | Path | 行为 |
|---|---|---|
| GET  | `/`                                 | 渲染 42 条清单页(7 section 折叠 + 完成度卡 + 批量标记) |
| POST | `/item/:itemNumber`                 | 单条更新 status / notes / evidence_url |
| POST | `/bulk-mark-step`                   | 按 workflow_step 批量标 status |
| GET  | `/export.md`                        | 导出 Markdown 附录 |

## 3. server.js 接入(汇总层用)

Router 用 `mergeParams: true`,所以 `:id` 透传。挂载:
```js
import prismaRouter from './routes/projects/prisma.js'
app.use('/projects/:id/prisma', requireUser, prismaRouter)
```

## 4. 关键设计
1. 复用 Agent D 的 `partials/project-header.ejs` + `partials/stepper.ejs`,传 `currentStep: 'prisma'`(不在 8 step 列表里,stepper 不高亮但页面正常)
2. `ownProjectOr404` 校验项目归属;status / workflow_step 双白名单;notes ≤ 5000 / evidence_url ≤ 1000
3. 审计三种事件:`prisma_item_updated`(含 from/to status diff)、`prisma_bulk_marked`(含 from_status_counts)、`prisma_exported`
4. UI:
   - 顶部完成度卡(donePct + 4 个分项小卡 + 导出按钮)
   - 折叠"按 step 批量标记"区
   - 7 个 section 折叠区,done / not_applicable 的 item 编辑表单默认折叠
5. 导出 Markdown 格式:项目元信息 + 完成度 + 7 section,每条 item 含 status icon、recommendation、workflow_step 链接、notes、evidence_url

## 5. 测试 checklist
1. 创建项目 → /projects/:id/prisma 应显示 42 条,全部 not_started
2. 改某条 status = done + 写 notes → 保存 → 刷新后持久化
3. 点"一键标记 protocol step 完成" → 6 条 protocol items 全变 done
4. 顶部完成度更新到 6/42 ≈ 14%
5. 导出 Markdown 看格式
