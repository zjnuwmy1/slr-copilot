# SUMMARY-R — Codex CLI 真正接入(device-auth + exec --json)

> harness 拒 .md 写入,由汇总层代落。

## 改动文件

**重写**:
- `services/providers/openai-cli.js` — sendMessage + buildExecArgs(可测)。Args: `exec --json --skip-git-repo-check --ephemeral -m <model> -o <tmpfile> -c sandbox_permissions=["disk-full-read-access"] <fullPrompt>`。System prompt 用 `\n\n---\n\n` 并入 user prompt;final text 从 `-o` 文件读,fallback 扫 JSONL;tmp 文件所有退出路径都清理;usage 防御性多 key 抓(`tokens.input` / `input_tokens` / `prompt_tokens`)。

**修改**:
- `services/oauth-bridge.js` — 加 codex device-auth 分支:`loginArgsForProvider('openai')` 返 `['login','--device-auth']`;新增 `isCodexFlow(provider)`;内存 entry 加 `isCodex / gotDeviceCode / deviceCode`;`scanForUrlAndCode()` 抓 device code 用 `/^[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6})+$/` 独占一行;`submitCode` 对 codex 返 `{ok:true, note:'codex_device_auth_no_stdin'}` 不写 stdin。复用 `awaiting_code` state(语义扩为"awaiting browser action")。
- `services/oauth-bridge-mock.js` — codex provider mock 给假 URL + `TEST-CODE`,2s 自动完成(无需 submitCode)。
- `views/account/oauth/awaiting.ejs` — `session.provider==='openai'` 分支:大字号 monospaced device code + copy 按钮,无 paste-back textarea,仅取消按钮。Anthropic 分支完全保留。
- `routes/account/oauth.js` — 必要的最小扩展:passing `deviceCode` 到 awaiting render + `device_code` 到 state.json。

**新增**:
- `services/__tests__/openai-cli.test.js` — 4 测试,全过(args 正确性 / mock binary stdout→outFile 读 + usage 解析 / tmp 文件清理 sentinel / stderr tail in error)

## 关键约束

- `oauth_bind_sessions.state` CHECK 未动 — codex 复用 `awaiting_code`
- Anthropic OAuth(stdin paste-back)路径完全保留
- 0 npm install / 0 schema 改动

## End-to-end mock 验证

1. spawn 后 1.3s:state=awaiting_code,prompt_url=`https://example.test/codex/device`,deviceCode=`TEST-CODE`
2. 3.8s:state=completed,`user_credentials` 写入(provider=openai, status=active, label="Codex(订阅 · mock)")
3. EJS 模板:codex 变体含 `TEST-CODE` 无 textarea;anthropic 变体反之

## sendMessage Args(真实 codex CLI v0.132.0 实测验证)

```
codex exec --json --skip-git-repo-check --ephemeral
           -m <model> -o <tmpfile>
           -c sandbox_permissions=["disk-full-read-access"]
           <full-prompt-with-system-prepended>
```

## 用户测试 checklist
1. 设 CODEX_BIN=mock,user 进 /account/credentials/new?type=oauth&provider=openai → 跳 awaiting 页
2. 1s 后页面显示 URL + 大字号 TEST-CODE,**没有** paste-code 输入框
3. 2s 后自动跳 completed
4. /account/credentials 出现 Codex(订阅 · mock)凭证
5. 触发 protocol_gen 用 openai 凭证 → 真二进制下 sendMessage 命中 codex exec
6. 凭证失败(如未授权)→ usage_logs.error_message 含 stderr tail
