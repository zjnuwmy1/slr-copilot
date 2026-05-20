# SUMMARY-D — Phase 3 Agent D · PRISMA Stepper / Wizard UI

把扁平的项目详情页改造成 **8 步 PRISMA 2020 向导**:左侧固定 stepper、右侧主区是当前 step 内容、每个 step 一个独立 URL。

## 1. 文件清单

### 新建(9 个)

| 路径 | 作用 |
|---|---|
| `views/projects/partials/stepper.ejs` | 左侧 8 step 卡片 + 顶部 PRISMA 总进度条;接 `progress.stepStatus` 渲染状态徽章 |
| `views/projects/partials/project-header.ejs` | 项目标题 + 状态徽章 + "← 项目列表"返回链接 |
| `views/projects/partials/step-layout.ejs` | **说明文件**(纯注释),EJS 不支持 slot,所以这里描述每个 step 页面应该如何组合 partials |
| `views/projects/screening.ejs` | Step 3 占位页 |
| `views/projects/extraction.ejs` | Step 4 占位页 |
| `views/projects/rob.ejs` | Step 5 占位页 |
| `views/projects/synthesis.ejs` | Step 6 占位页 |
| `views/projects/certainty.ejs` | Step 7 占位页 |
| `views/projects/report.ejs` | Step 8 占位页 |

### 修改(2 个)

| 路径 | 改动 |
|---|---|
| `views/projects/detail.ejs` | 重构为 Step 1 (protocol) 页:顶部面包屑 + 双栏布局(stepper + 协议内容)+ 协议审批后的 "进入检索式 →" CTA |
| `routes/projects/index.js` | (1) 顶部新增 `getChecklistItems` import;(2) `GET /:id` 的 `res.render` 补传 `progress` / `currentStep` / `stepLabel`;(3) 文件末尾 append 一个 `for` 循环注册 6 个 step 占位路由 |

**未触碰**:`server.js`、`db/schema.sql`、所有 `services/*`、所有 `middleware/*`、`routes/auth.js`、`routes/admin/*`、`routes/account/*`、`views/partials/*` 共享头尾、`views/projects/search.ejs`(Agent E)、`views/projects/prisma.ejs`(Agent F)、`routes/projects/search.js`、`routes/projects/prisma.js`、`package.json`、`data/*`、`.env.example`、`README.md`、`DEPLOY.md`。

## 2. Stepper 数据流

```
GET /projects/:id              ┐
GET /projects/:id/<step>       ├─►  ownProjectOr404 → getProjectProgress(db, projectId)
                               ┘                          │
                                                          ▼
                          progress.stepStatus.<step> = { status, summary }
                          progress.prismaProgress     = { donePct, done, total }
                                                          │
                                                          ▼
                                  partials/stepper.ejs 渲染:
                                  - 顶部进度条:donePct %
                                  - 8 个 step 卡:status → badge color (emerald/amber/slate/lock)
                                  - currentStep === step.id → 蓝色左竖条 + 浅蓝背景
                                  - status === 'locked' → 渲染为 <div>(不可点),其余为 <a>
```

**状态规则**(在 `services/prisma.js#getProjectProgress` 里已写好,我们只消费,不改):
- `protocol`:有 approved 行 → `done`;有 row 没 approve → `in_progress`;否则 `not_started`
- `search`:有 result_count → `done`;有 row 无计数 → `in_progress`;无 row → `not_started`
- 其余 6 个 step:协议未审批前 → `locked`;协议审批后 → `not_started`(Phase 4+ 接入后再改)

## 3. 路由追加列表

`routes/projects/index.js` 末尾追加(在 `export default router` 之前):

```
GET /projects/:id/screening    → views/projects/screening.ejs
GET /projects/:id/extraction   → views/projects/extraction.ejs
GET /projects/:id/rob          → views/projects/rob.ejs
GET /projects/:id/synthesis    → views/projects/synthesis.ejs
GET /projects/:id/certainty    → views/projects/certainty.ejs
GET /projects/:id/report       → views/projects/report.ejs
```

每个路由统一传 locals:
```js
{ title, project, progress, currentStep: '<step>', stepLabel: '<n>. ...', stepItems }
```
其中 `stepItems` = `getChecklistItems().filter(it => it.workflow_step === stepId)`,占位页用来渲染 "本步骤覆盖的 PRISMA 清单项" 列表。

**注意没追加** `/:id/search` 和 `/:id/prisma`,它们分别由 Agent E、F 注册;但 stepper 里的 `<a href="/projects/:id/search">` 已经指向那里,等 E 合入即生效。

## 4. server.js 是否需要改?

**不需要**。所有新路由都在 `projects` router 内,server.js 里 `app.use('/projects', requireUser, projectsRouter)` 一行已经把整个子路由挂上,新增 GET 会自动透出。

## 5. 路由顺序提示

Express 按注册顺序匹配,`projects/index.js` 内现有顺序保持不变:
```
GET /              (list)
GET /new           (new form)
POST /             (create)
GET /:id/progress.json   ← 已经在 :id 前面
GET /:id           (protocol = detail)
POST /:id/protocol/...   (生成/审批/编辑)
GET /:id/screening ↓
GET /:id/extraction ↓    ← 新增 6 个,都是具体路径段,不会被 :id 吞掉
GET /:id/rob ↓
GET /:id/synthesis ↓
GET /:id/certainty ↓
GET /:id/report ↓
```
和 Agent E/F 的 `/:id/search` `/:id/prisma` 同样是具体段,互不冲突。

## 6. UI / Tailwind 关键类

- 主容器 `grid gap-6 lg:grid-cols-[260px_1fr]` —— 在 `views/partials/header.ejs` 的 `max-w-5xl` 下:260px stepper + 1fr 主区,刚好放得下;窄屏自动堆叠(`lg:` 断点)
- 状态徽章配色:done `bg-emerald-100/700`、in_progress `bg-amber-100/700`、locked `bg-slate-100/400 + 🔒 emoji`、not_started `bg-slate-100/500`
- 当前 step:`border-l-4 border-blue-500 bg-blue-50/60`
- 圆形序号:done 绿底白字 / current 蓝底白字 / locked 灰底浅字 / 默认浅灰底深字
- 占位页 hero:`rounded-2xl border-dashed border-slate-300` 中央 emoji + "即将开放" 文案 + 返回上一步 / 跳到协议两个按钮

## 7. 测试 Checklist

1. **启动**:`npm start`(端口默认 3001)。如未登录 admin,先 `/login`。
2. **建项目**:`/projects/new` → 任意填一个项目 → 提交。`seedChecklistForProject` 会自动种 42 条 PRISMA items。
3. **打开详情**:跳转到 `/projects/:id`。验证:
   - 左侧出现 8 个 step 卡片,**Step 1 协议**蓝色高亮、状态 `未开始`
   - **Step 2 检索式**显示 `未开始`(search 在 prisma.js 里没受 locked 规则约束)
   - **Step 3-8** 显示 `🔒 锁定`(因为协议未审批)
   - 顶部 PRISMA 总进度条:`0% · 0/42 项已完成`
4. **点 locked step**:不应该是链接(`<div>`),光标 `cursor-not-allowed`
5. **手动访问** `/projects/:id/screening` 验证占位页能渲染 → 显示 "覆盖 PRISMA #8 #16a #16b" + 三条清单详情
6. **生成 + 审批协议**:点 "让 Claude 生成协议" → 等 LLM → 点 "审批"。
   - 回到 `/projects/:id`,Step 1 状态变 ✓ `已完成`
   - 新出现 "协议已审批,进入检索式 →" 绿色 CTA
   - Step 3-8 解锁(`locked` → `not_started`),可点击
   - Step 2 search 仍 not_started(直到 Agent E 真正写 search_strategies 行)
7. **跳 step**:点 Step 5 偏倚风险 → `/projects/:id/rob` → 显示占位页 + #11 #14 #18 #21 四条 PRISMA 项目
8. **轮询接口仍工作**:`curl /projects/:id/progress.json` 返回 JSON 含 `stepStatus` + `prismaProgress`
9. **E/F 合并后**:`/projects/:id/search` 和 `/projects/:id/prisma` 可正常进入(stepper href 已正确指向)

## 8. 已知约束 / 注意

- header.ejs 是 `max-w-5xl`(约 1024px),双栏 260px + 760px 够用,但桌面再窄就会触发 `lg:` 之下的纵向堆叠 — 这是有意的。
- stepper 在每个 step 页面都 include 一遍,**没有 SPA**,每次切 step 走全页 SSR。这与项目其他页面的风格一致(渐进增强 / 无前端框架)。
- `progress.json` 路由没改,前端将来加 `setInterval` 时直接更新 stepper 即可(目前先全页刷新)。
- 占位页用 `stepItems`(路由层 filter 出),没读 `prisma_checklist` 表,因为占位阶段不需要每条 item 状态;Phase 4+ 改成读表即可。
