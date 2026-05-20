# SUMMARY-A · Agent A:认证 + Admin 用户管理

Phase 1 / Agent A 的产出。所有改动都在我的范围内,**没有动 server.js / schema.sql / 任何 partial / package.json**。

---

## 1. 新增文件清单

### Routes
- `routes/auth.js` — `/login` `/logout` `/register`
- `routes/admin/users.js` — `/admin` 后台所有路由(被 `requireAdmin` 包住)

### Views
- `views/auth/login.ejs`
- `views/auth/register.ejs`
- `views/admin/dashboard.ejs`
- `views/admin/users-list.ejs`
- `views/admin/user-new.ejs`
- `views/admin/user-detail.ejs`

### 文档
- `SUMMARY-A.md`(本文件)

不需要新依赖,**不要 npm install**。

---

## 2. 路由表

### routes/auth.js (挂在 `/`)

| Method | Path | 行为 |
|---|---|---|
| GET | `/login` | 渲染登录页;支持 `?next=`;已登录会直接跳走 |
| POST | `/login` | bcrypt 校验密码;成功写 session + 更新 `last_login_at` + 审计 `login_success`;失败写审计 `login_fail`(payload 只放 email + reason,不放 password) |
| POST | `/logout` | 清 session,审计 `logout`,redirect `/` |
| GET | `/register` | 渲染注册页;`?code=` 会预填邀请码 |
| POST | `/register` | 校验邀请码可用 + 邮箱唯一 + 密码 ≥10 + 两次匹配 → bcrypt(12) → 事务插 user / 标记邀请码 → 审计 `signup`(payload: invite_code, role, email) → 自动登录 → redirect `/account` |

### routes/admin/users.js (挂在 `/admin`,**整段加 `requireAdmin`**)

| Method | Path | 行为 |
|---|---|---|
| GET | `/admin` | 渲染 dashboard,显示用户数/活跃数/未用邀请码数 + 卡片链接(用户管理可点;使用记录/审计日志是 disabled 占位) |
| GET | `/admin/users` | 列表所有用户 + 未用邀请码(最多 20 条) |
| GET | `/admin/users/new` | 生成邀请码表单(角色 / 备注 / 有效期天数,默认 7,留空 = 永不过期) |
| POST | `/admin/users/invites` | `generateInviteCode()` 生成 8 位,写入 invite_codes;审计 `invite_created`;flash 显示码 + 注册链接;redirect `/admin/users` |
| GET | `/admin/users/:id` | 用户详情:基本信息 + 状态/角色控件 + 配额表单 |
| POST | `/admin/users/:id/activate` | `is_active=1`,审计 `user_activated` |
| POST | `/admin/users/:id/deactivate` | `is_active=0`,**禁止 self**,审计 `user_deactivated` |
| POST | `/admin/users/:id/role` | `role=admin|user`,**禁止自降级**,审计 `role_changed`(payload: from/to) |
| POST | `/admin/users/:id/quota` | UPSERT `user_quotas`(`INSERT ... ON CONFLICT(user_id) DO UPDATE`),审计 `quota_updated`(payload: 新值) |

---

## 3. server.js 需要追加的代码(粘贴即用)

在 `server.js` 顶部 imports 区域加:

```js
import authRouter from './routes/auth.js'
import adminUsersRouter from './routes/admin/users.js'
```

把现有的占位行(下面这段)**删除**:

```js
app.get(['/login', '/logout', '/register', '/account', '/account/*', '/admin', '/admin/*'], (req, res) => {
  res.status(501).render('error', {
    title: 'Not Yet Implemented',
    message: `${req.path} 还没接入(等 Agent A/B/C 完成后会激活)`,
  })
})
```

替换成(注意保留 Agent B/C 的占位,只把 /login /logout /register /admin* 摘出来):

```js
// Agent A:认证 + Admin
app.use('/', authRouter)
app.use('/admin', requireAdmin, adminUsersRouter)

// Agent B/C 的占位(他们接入后删掉)
app.get(['/account', '/account/*'], (req, res) => {
  res.status(501).render('error', {
    title: 'Not Yet Implemented',
    message: `${req.path} 还没接入(等 Agent B/C 完成后会激活)`,
  })
})
```

注意:
- `app.use('/', authRouter)` 内部用 `req.app.locals.db`,所以必须在 `app.locals.db = db` 之后挂载。最稳妥的位置:紧贴在 `app.locals.db = db` 这一行之后,在 404 handler 之前。
- `requireAdmin` 已经从 `./middleware/auth.js` import 进 server.js 了,直接用即可。

完整推荐插入顺序:

```js
app.locals.db = db

app.use('/', authRouter)
app.use('/admin', requireAdmin, adminUsersRouter)

// Agent B/C 占位
app.get(['/account', '/account/*'], (req, res) => {
  res.status(501).render('error', {
    title: 'Not Yet Implemented',
    message: `${req.path} 还没接入(等 Agent B/C 完成后会激活)`,
  })
})

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: '页面不存在' })
})
```

---

## 4. 非显然决策 / 设计说明

1. **`req.app.locals.db` 而不是 import db**:让 router 不依赖 server.js 的具体模块布局,也方便测试时注入。
2. **邀请码生成防撞**:`invite_codes.code` 是 PK,在 INSERT 失败时(`SQLITE_CONSTRAINT_PRIMARYKEY`)重试最多 5 次。理论上 32^8 ≈ 10^12 几乎不会撞,但便宜的保险。
3. **注册的原子性**:用 `db.transaction()` 包 insert user + update invite_code;`UPDATE ... WHERE code=? AND used_by_user_id IS NULL` 的 `changes` 必须 == 1,否则抛 `invite_code_race` 回滚。正好满足"行数 == 1"的要求。
4. **角色规范化**:任何接收 `role` / `preset_role` 的地方都做 `=== 'admin' ? 'admin' : 'user'` 兜底,避免 schema CHECK 反弹。
5. **配额 UPSERT**:用 `INSERT ... ON CONFLICT(user_id) DO UPDATE` 而不是 `INSERT OR REPLACE`。后者会触发 DELETE,如果以后有外键引用 user_quotas 会出问题。语义等同但更安全。
6. **`allowed_providers` / `allowed_auth_types` 空数组 = NULL = 全允许**:跟 schema 注释一致。
7. **`?next=` 防开放重定向**:`safeNext()` 只接受以 `/` 开头且不是 `//` 开头的相对路径。
8. **过期时间解析容错**:邀请码 `expires_at` 是 SQLite `datetime(...)` 输出(无 Z 后缀,实际是 UTC)。JS 的 `new Date()` 默认按本地时区解析,我做了两种解释都比较的容错处理 — 实际服务器在 UTC 时区跑无问题,本地开发偶尔会有 8 小时差异,对邀请码这种粗粒度有效期不会有体感影响。
9. **flash 通过 `req.session.flash`**:server.js 里那个中间件已经把 flash 挪到 `res.locals` 并清掉,我直接用。
10. **Dashboard 极简**:按要求只放欢迎卡片 + 三个统计 + 三个入口卡片(后两个 disabled)。

---

## 5. 安全 & 不变量

- 所有 admin POST 路由都经过 `requireAdmin`;auth router 的 `/logout` 自己检查 `req.session?.user_id`。
- **不能停用自己 / 降级自己**:`/admin/users/:id/deactivate` 和 `/admin/users/:id/role` 中显式比对 `req.user.id === id` 拒绝;detail view 上也对应隐藏按钮。
- 密码字段不会进任何 log / audit payload(`login_fail` payload 只有 email + reason)。
- 模板都用 `<%= %>` 转义输出(EJS 默认转义)。
- 邀请码 race:UPDATE 加 `AND used_by_user_id IS NULL`,`changes !== 1` 即抛错回滚事务。

---

## 6. 手动测试 checklist

### 准备
1. `.env` 里设:
   ```
   BOOTSTRAP_ADMIN_EMAIL=admin@example.com
   BOOTSTRAP_ADMIN_PASSWORD=changeme-strong-pw
   ENCRYPTION_KEY=<64 hex chars>
   SESSION_SECRET=<任意长字符串>
   ```
2. 删 `.data/slr.db` 或换 `DB_PATH` 保证从空库 bootstrap。
3. `npm start` → 控制台应看到 `[bootstrap] admin created: admin@example.com (id=user_...)`。

### 用例
1. 开 `http://127.0.0.1:3001/` → 首页右上角看到"登录"。
2. 点登录 → `/login` → 用 admin 邮箱密码登录 → 跳回 `/`,右上角显示名 + `ADMIN` 徽章。
3. 点"管理后台" → `/admin` → dashboard,总用户=1 / 活跃=1 / 未用邀请码=0。
4. 点"用户管理" → `/admin/users` → 看到 admin 自己,role=ADMIN,status=active。
5. 点 "+ 生成邀请码" → `/admin/users/new` → 选 role=user / 备注随便 / 有效期 7 天 → 提交 → 回列表,顶部绿色 flash:"邀请码 XXXXXXXX 已生成,分享给用户(注册链接:/register?code=XXXXXXXX)"。
6. POST `/logout`(顶栏的"登出") → 打开 `/register?code=XXXXXXXX` → 邀请码已预填 → 填邮箱 `alice@example.com`、显示名、密码 ≥10 → 提交 → 自动登录,跳 `/account`(目前 501,Agent B 接后正常)。
7. **错误路径**:登出 → `/register?code=BADCODE` → 提交 → 红条"邀请码无效"。再试已用的 `/register?code=XXXXXXXX` → "邀请码已被使用"。
8. **alice 越权**:用 alice 登录 → 顶栏无"管理后台"链接 → 直接访问 `/admin` → 403。
9. **admin 操作 alice**:登出 alice → admin 登回 → `/admin/users` → 点 alice 的"详情" → `/admin/users/<alice_id>`。
10. 改配额:每日 100 / 每月 50000 / 勾 anthropic / 勾 api_key / 备注 "test" → 保存 → 绿条"配额已更新"。
11. 刷新页面 → 配额字段还在(持久化验证)。
12. 把 alice 角色从 user 改成 admin → 列表里 alice 显示 ADMIN 徽章。改回 user。
13. 停用 alice → 列表显示 inactive → 登出 → 用 alice 登录应报"账户已被停用"。再 admin 启用回来。
14. **admin 不能停自己**:admin 详情页 → 状态卡片只有提示文字,没有按钮。手动 POST `/admin/users/<admin_id>/deactivate` → flash error "不能停用自己,请让另一个 admin 操作"。
15. **登录失败审计**:`/login` 用错密码 → 红条 → `sqlite3 .data/slr.db "SELECT event_type, payload FROM audit_events ORDER BY id DESC LIMIT 5;"` → `login_fail` 一行,payload 只有 email + reason,**没有 password**。

---

## 7. 建议改动(给汇总层参考,我没改)

无强制项。建议:

1. `views/partials/header.ejs` 里的"登录"按钮 `href="/login"` 可以改成 `href="/login?next=<%= encodeURIComponent(req.originalUrl) %>"`,登录后跳回当前页。**未改,partial 不让动。**
2. 注册流程会重定向到 `/account`。Agent B 没接前用户注册后会看到 501,合并 Agent B 后自动好。
3. 审计事件类型用了:`login_success` `login_fail` `logout` `signup` `invite_created` `user_activated` `user_deactivated` `role_changed` `quota_updated`。汇总层的"审计日志"页按 event_type 过滤可参考。

---

## 8. Caveats

- 因 server.js 还没挂载我的 router,我没法本地真跑。做了:
  - `node --check` 验证两个 JS 文件语法 ✓
  - 用 EJS 单独 render 6 个 view 各跑一遍(stub data)✓
- 合并后第一次启动如果某个 view 报错,大概率是 stub 数据形状没 cover — 麻烦贴 stack trace,我能 1-2 行修。
