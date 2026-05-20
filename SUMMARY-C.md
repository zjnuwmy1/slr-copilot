# Agent C — Web-driven OAuth bind for Claude / Codex subscriptions

Phase 1 Agent C 范围:让用户在 Web 上完成 `claude login` / `codex login`,生成的订阅凭证落到该用户的私有 HOME,后续平台调用 LLM 直接复用,无需 API key。

## State machine

```
        POST /account/oauth/start
                |
                v
        [INSERT oauth_bind_sessions]
        state='awaiting_url'
                |
                | services/oauth-bridge.startLogin
                |   - mkdir stage HOME (mode 700)
                |   - spawn `claude login` / `codex login`
                |     env: HOME=stage, **不**继承外层 HOME
                |   - listen stdout/stderr
                v
   ┌───────────────────────────────┐
   │  awaiting_url                  │   stdout 匹配 /https?:\/\/[^\s'"<>`]+/i
   │                                │ ─────────────────────────────────────┐
   │                                │                                       │
   └───────────────────────────────┘                                       │
                                                                            v
                                                              ┌───────────────────────────┐
                                                              │  awaiting_code            │
                                                              │  prompt_url 已填          │
                                                              │  前端轮询 state.json 2 s  │
                                                              └───────────────────────────┘
                                                                            │
                                                                            │ POST /:id/code
                                                                            │   bridge.submitCode → proc.stdin.write
                                                                            v
                                                              ┌───────────────────────────┐
                                                              │  (子进程仍在跑,等 close) │
                                                              └───────────────────────────┘
                                                                            │
                                                            ┌───────────────┴────────────────┐
                                                            │                                 │
                                                exit 0 + .claude/ 存在          exit ≠ 0 / 没 .claude
                                                            │                                 │
                                          rename stage→perm,                       清 stage,
                                          INSERT user_credentials                  UPDATE state='failed'
                                          (auth_type='oauth')                       error_message=stderr tail
                                          UPDATE state='completed'                  audit oauth_bind_failed
                                          audit oauth_bind_completed
```

横切两条边:

- 5 min timer 任何时刻触发 → SIGTERM 子进程,state='timeout',清 stage,审计失败
- POST /:id/cancel 任何时刻 → SIGTERM,state='failed'(error_message='user_cancelled')

进程重启 → 内存 Map 丢。route 层 `reconcileSession()` 在访问 awaiting_* 状态的 session 时发现内存里没有对应 entry,直接把行标 `failed`(`error_message='orphaned_after_restart'`),用户看到 failed 页可以重试。

## 文件清单

新增:

| 文件 | 作用 |
| --- | --- |
| `services/oauth-bridge.js` | 真的 spawn + state machine + 内存 Map + 超时 + 落地 |
| `services/oauth-bridge-mock.js` | `CLAUDE_BIN=mock`/`CODEX_BIN=mock` 时走 setTimeout 假流程 |
| `services/providers/anthropic-cli.js` | `sendMessage({ homePath, model, system, prompt })` — Phase 1 不调,框架就位 |
| `services/providers/openai-cli.js` | 同上,binary 是 `codex exec`,顶部 TODO 注明未确认 |
| `routes/account/oauth.js` | Express Router,全 `requireUser` |
| `views/account/oauth/start.ejs` | 选 Claude/Codex |
| `views/account/oauth/awaiting.ejs` | 展示 URL + paste code + 2 s 轮询 JS |
| `views/account/oauth/completed.ejs` | 成功页 |
| `views/account/oauth/failed.ejs` | 失败/超时页 |

未修改(按规则):`server.js`、`db/schema.sql`、`db/index.js`、`middleware/auth.js`、`services/{crypto,audit,bootstrap}.js`、所有 partial / index / error 视图、`.env.example`、`package.json`、Agent B 范围、汇总层范围。

## 路由表

挂载 `/account/oauth`,全部 `requireUser`:

| Method | Path | 作用 |
| --- | --- | --- |
| GET | `/start` | 渲染开始页,`?provider=anthropic\|openai` 可预选 |
| POST | `/start` | 杀旧 awaiting 会话 → INSERT 行 → `startLogin` 异步 → 重定向 `/:id` |
| GET | `/:id` | 按当前 state 渲染 awaiting / completed / failed 之一 |
| GET | `/:id/state.json` | `{ id, state, prompt_url, error_message, finished }` 给前端轮询 |
| POST | `/:id/code` | 把 form 里的 `code` 写到 spawned 进程 stdin |
| POST | `/:id/cancel` | SIGTERM → state='failed' (user_cancelled) → redirect /account/credentials |

## server.js 该追加的代码

(我没改 `server.js` — 由汇总层接入。需要追加:)

```js
// 顶部 import 区
import oauthRouter from './routes/account/oauth.js'

// 在「占位路由」之前注册:
app.use('/account/oauth', oauthRouter)
```

注意:现有的 `/account/*` 占位 501 通配 `app.get(['/login', '/logout', '/register', '/account', '/account/*', ...])` 会拦截 `/account/oauth/*` 的 GET。汇总层接入时**先注册 router 再注册占位通配**,Express 路由顺序决定 router 会优先匹配。POST 不受占位影响(占位是 `app.get(...)`)。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DATA_DIR` | `./.data` | stage / 永久 HOME 根目录(`<DATA_DIR>/user-homes/<user_id>/...`) |
| `CLAUDE_BIN` | `claude` | Anthropic CLI 可执行文件路径;设 `mock` → 走 oauth-bridge-mock |
| `CODEX_BIN` | `codex` | OpenAI Codex CLI 可执行文件路径;设 `mock` → 走 oauth-bridge-mock |
| `ENCRYPTION_KEY` | (已有) | 加密 credential_blob,services/crypto.js |

## 本地测试 checklist(mock 模式)

```bash
# 必备:启动用 mock,免装真二进制
export CLAUDE_BIN=mock
export CODEX_BIN=mock
export ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
export BOOTSTRAP_ADMIN_EMAIL=admin@local.test
export BOOTSTRAP_ADMIN_PASSWORD=changeme1234
```

⚠️ 当前 `server.js` 还在用 `app.get([... /account/* ...])` 占位回 501。要测我这条路径,需要先在 server.js 临时挂上 `app.use('/account/oauth', oauthRouter)`(汇总层会做)。

1. `npm start` → 浏览器 `http://127.0.0.1:3001/login` 登录
2. 手动访问 `/account/oauth/start`(因为 Agent B 的 `/account/credentials` 还没接,通过 URL 直达)
3. 选 Anthropic → 提交 → 自动跳到 `/account/oauth/<id>`
4. 等 ~1 秒,页面应自动出现假 URL `https://example.test/auth?...`,state 变为 `awaiting_code`
5. 在 code 框粘任意字符串(mock 不校验),点提交
6. ~1 秒后页面自动 reload,看到 completed 页
7. SQLite `user_credentials` 表里出现一行:`auth_type='oauth'`, `provider='anthropic'`, `status='active'`,`label='Claude(订阅 · mock)'`
8. `.data/user-homes/<user_id>/cred_<hex>/.claude/fake-credential.json` 存在,权限 700
9. `oauth_bind_sessions` 行:`state='completed'`,`finished_at` 非空
10. `audit_events` 表:`oauth_bind_start` + `oauth_bind_completed` 各一条

附加测:

- POST `/account/oauth/<id>/cancel` 在 awaiting 状态 → state 变 `failed`,error_message='user_cancelled'
- 开新会话:连续 POST `/start` 两次 → 第一次的 session 应被 supersede,state 变 `failed`,error_message='superseded_by_new_session'
- 进程重启:在 awaiting 状态时 Ctrl+C 服务,重启,访问该 session → 自动变 `failed`,error_message='orphaned_after_restart'

## 真实 CLI 模式

```bash
export CLAUDE_BIN=/usr/local/bin/claude
# 或 unset CLAUDE_BIN,fallback 到 PATH 里的 `claude`
```

走完 5 步流程,行为应该一致。关键差异:URL 来自真的 stdout,code 真的喂给子进程 stdin,完成后 `.claude/` 目录里是真的 Anthropic 凭证文件。

## 安全 / 边界

- `user_id` 永远从 `req.user.id` 取,**不**从 form 接受
- session 路径里的 id 用 randomId,用户控制不了 stage 路径
- credential_blob_enc 只存 `{ home_path }`,token 留在文件系统(目录 700,凭证文件应继承 600)
- `/account/oauth/:id/*` 的所有路由都强制校验 `row.user_id === req.user.id`,跨用户访问回 403
- 子进程 env 显式覆写 HOME 和 XDG_*,避免读到 server 进程自己的凭证
- stdout/stderr 缓冲 cap 在 64 KiB,防 CLI 无限输出爆内存
- 审计三种事件:`oauth_bind_start` / `oauth_bind_completed` / `oauth_bind_failed`,payload 含 sessionId、provider、stdout/stderr tail(失败时,512 字节)

## 已知风险 / 假设

1. **`claude login` / `codex login` 的 stdout 格式未真实验证。** 我假设它在某处打印一个 `https://...` 链接,正则 `/https?:\/\/[^\s'"<>`]+/i` 抓第一个匹配。Anthropic 也可能输出多个 URL(隐私政策、文档链接)在授权 URL 之前 — 那会抓错。看到失败先去 `audit_events.payload.stdout_tail` 验证。如果格式确实不稳,后续可以换成「优先匹配 anthropic.com / claude.ai 域名」的更窄正则。
2. **`claude login` 是否真的从 stdin 读取 code,而不是再开浏览器 callback,未验证。** 如果它走的是 PKCE + 本地 listener,这套方案得改:平台需要反代 `http://localhost:<port>/callback` 给用户。从 Agent CLI 在 headless 环境的常见做法看,paste-code 流程是主流,先按这个走。
3. **codex CLI 的 subcommand 是 `codex login` 还是 `codex auth login`,以及 `codex exec` 的参数,我没查到稳定文档。** `services/providers/openai-cli.js` 顶部有 TODO,等接入真二进制时复核。
4. **Node 进程重启会丢内存 Map。** 已经处理:`reconcileSession` 在访问 awaiting_* 但内存里没的会话时标 failed。代价是用户必须重新点一次,可接受。
5. **不支持「平台先关掉服务再重连子进程」**。子进程是父进程的孩子,父进程退出子进程也会被信号清掉(除非 detach)。当前实现不 detach,因为登录流程很短(< 5 min),不值得引入 PID 持久化的复杂度。
6. **stdin 写不一定立刻让 CLI 退出。** 有些 CLI 期望 `code\n` 后再读一行确认。`submitCode` 写的是 `code + '\n'`。如果观察到 CLI 阻塞,需要在这里再 `proc.stdin.end()` 或追加一行。等真二进制测时调。
7. **stage HOME 落在 `DATA_DIR` 下而不是规范里写的 `/var/lib/slr`**。这是为了本地能开发跑通(`/var/lib` 不可写)。生产时通过 `DATA_DIR=/var/lib/slr` 覆盖即可,路径结构完全一致。

## 不变量(给汇总层)

- 我不动 `server.js`、`db/schema.sql`、`package.json`、`middleware/auth.js`、`services/{crypto,audit,bootstrap}.js`、所有 partial 与 index/error 视图
- 没引入新 npm 依赖
- credential_blob_enc 的 schema:`{ "home_path": "<absolute path>" }` —— 这是给 LLM router 后续读凭证的契约
- `user_credentials.auth_type='oauth'` 行的 `last_validated_at` 在创建时填 `datetime('now')`(因为 CLI exit 0 本身就是验证通过)
