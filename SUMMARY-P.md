# SUMMARY-P — Admin 只读查看任意用户项目

> harness 拒 .md 写入,由汇总层代落。

## 文件清单

**新建**:
- `routes/admin/projects.js` — 顶部 `router.use` 拒非 GET(405);导出 `default` router + `listProjectsForUser` helper 供 users.js 复用
- `views/admin/projects/list.ejs` — 表格 + 过滤(user/status/q),复用同 view 渲染全平台与单用户视图(`scopeUser` 区分)
- `views/admin/projects/detail.ejs` — 只读详情:橙色 admin 警示框 + 完整 metadata + stepper + 协议版本 + 检索式 + records/screening/extraction 统计 + 草稿 + Zotero 包 + 所有"操作"按钮 disabled

**扩展**(追加,未重写):
- `routes/admin/users.js` — 顶部多 import,末尾加 `GET /users/:id/projects`
- `views/admin/dashboard.ejs` — 4 卡片网格 + "全部项目"入口
- `views/admin/user-detail.ejs` — 底部"该用户的项目"section
- `views/admin/users-list.ejs` — 每行加"项目"列

## server.js 接入
```js
import adminProjectsRouter from './routes/admin/projects.js'
app.use('/admin/projects', requireAdmin, adminProjectsRouter)
// 必须在 app.use('/admin', requireAdmin, adminUsersRouter) 之前(与 /admin/usage、/admin/audit 同模式)
```

## 审计事件
- `admin_listed_projects` — 进 /admin/projects
- `admin_listed_user_projects` — 进 /admin/users/:id/projects(target_user_id)
- `admin_viewed_project` — 进项目详情(target_user_id + project_id)
- `admin_viewed_project_records` — 看 records.json

## 安全
- read-only middleware 拒非 GET(405)
- 所有操作按钮 disabled + title 提示
- 输入走白名单(status Set)+ 参数化 SQL
- limit clamp

## 测试 checklist
1. admin 进 `/admin` → 4 卡片含"项目总数"+ "全部项目"入口
2. `/admin/projects` 列全部项目,`?user=` `?status=` `?q=` 过滤;非白名单 status 被丢弃
3. `/admin/users/:id/projects` 只列该用户的
4. `/admin/projects/:id` 详情完整 + 顶部橙色 admin 警示
5. 详情页"操作"按钮全 disabled
6. POST/DELETE/PATCH 到 `/admin/projects/*` 返回 405
7. `audit_events` 出现 `admin_viewed_project`(含 target_user_id + project_id)
8. `/admin/users` 行多"项目"列
9. `/admin/users/:id` 底部"该用户的项目"卡片可点入只读详情

## 不变量
- 0 npm install / 0 schema 改动
- 未改 server.js / package.json / partials / Agent Q 范围
- 0 git commit
- node --check + import 解析 + EJS 编译全过
