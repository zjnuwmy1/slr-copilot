# SUMMARY-B — Phase 1 Agent B(用户自助绑定 API key)

> 注:Agent B 在执行时 harness 拒绝了 `.md` 文件写入,所以这份 summary 由汇总层(主 agent)代为落盘,内容来自 Agent B 的完成报告。

## 1. 文件清单(全部新增)
```
services/credentials.js
services/providers/anthropic-api.js
services/providers/openai-api.js
routes/account/credentials.js
views/account/credentials/{list,new,detail}.ejs
```

未修改任何已有文件。

## 2. 路由表
```
GET  /account/credentials                — 列表(空时显示空状态卡片)
GET  /account/credentials/new            — ?type=api_key 渲染表单;?type=oauth 重定向 /account/oauth/start
POST /account/credentials                — 校验→quota→测活→加密落库→审计 credential_bind
GET  /account/credentials/:id            — 详情(时间戳 + 最近错误)
POST /account/credentials/:id/retest     — 重新测活 + 审计 credential_validated
POST /account/credentials/:id/revoke     — status=revoked + 审计 credential_revoke
```
全部走 `requireUser`。

## 3. server.js 接入(粘贴即用)

顶部 import 区追加:
```js
import credentialsRouter from './routes/account/credentials.js'
```

在那行 `app.get(['/login', ...占位])` **之前** 插入(Express 按注册顺序匹配,占位行无需改):
```js
app.use('/account/credentials', requireUser, credentialsRouter)
```

`requireUser` 已经在 server.js 顶部 import 过,无需重复。

## 4. 环境变量
不新增。复用现有 `ENCRYPTION_KEY`(已在 `services/crypto.js` 用)。
provider HTTP 请求带的是用户粘贴的 key,不需要 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。

## 5. 关键决策
1. 测活后才落库;失败不留脏行。
2. Anthropic 用 `POST /v1/messages` + `max_tokens=8` + `claude-haiku-4-5`(便宜);OpenAI 用 `GET /v1/models`(零 token)。
3. 5 秒 AbortController 超时。
4. 错误码归一:`invalid_key` / `timeout` / `http_<status>` / `network:...`,**绝不回显 apiKey**。
5. 所有按 ID 操作的 SQL 都带 `AND user_id = ?`;路由层 retest/revoke 前再 getById 一次防越权。
6. `listForUser` / `getById` 显式列 SAFE_COLUMNS,不查 `credential_blob_enc`。
7. Quota 预留:`checkProviderAllowed` 读 `user_quotas.allowed_providers` / `allowed_auth_types`,没行就全允许。
8. 审计事件:`credential_bind` / `credential_validated` / `credential_revoke`,payload 不含 apiKey。
9. OAuth 流转给 Agent C:`?type=oauth` → 302 `/account/oauth/start?provider=...`
10. `sendMessage` 留接口给 Phase 1.5 LLM router,Phase 1 不调。

## 6. UI / 视觉
- Tailwind via CDN,slate 主色,rounded-2xl 白卡
- Status badge:`active=emerald` / `expired=amber` / `revoked=slate` / `error=red`
- `api_key` 框 `type=password` + `font-mono`,自带"显示/隐藏"小按钮

## 7. 测试 checklist
1. 登录 → /account/credentials,看到空状态卡片
2. 点"+ 添加 API Key 凭证"→ 表单
3. 粘无效 key → 红色错误条 "invalid_key",label 回填、key 不回填
4. 粘真实 Anthropic key → 302 回列表 + 绿色 flash,状态 active
5. 点"重新测活" → flash "测活成功(xxx ms)",status 不变
6. 点"撤销" → confirm 后 status=revoked
7. 访问别人的 cred id → 404 "凭证不存在或不属于当前用户"
8. `sqlite3 .data/slr.db "SELECT event_type, payload FROM audit_events ORDER BY id DESC LIMIT 5;"` → 三条事件,payload 不含 apiKey 明文

## 8. 不变量自检
- 没动 `server.js` / `schema.sql` / `db/index.js` / `middleware/*` / 现有 `services/*` / `partials/*` / `index.ejs` / `error.ejs` / `.env.example` / `package.json` / `package-lock.json`
- 没创建 `routes/account/index.js`、`views/account/index.ejs`(汇总层)
- 没创建 `routes/account/oauth.js`、`views/account/oauth/*`(Agent C 已经自己创建了)
- 没 npm install,只用原生 fetch + AbortController
- 没 git commit

## 9. 小提示(给汇总层)
- `partials/header.ejs` 第 17 行已经预留了"凭证"导航链接指向 `/account/credentials`,所以挂上 router 后顶部导航自动可用
- `claude-haiku-4-5` 是从 `.env.example` 的 `CLAUDE_MODEL_LIGHT` 抄来的,如果它将来不存在,改 `services/providers/anthropic-api.js` 顶部的 `PING_MODEL` 常量即可
