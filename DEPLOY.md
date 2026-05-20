# 部署到 slr.yourai.asia — 操作 checklist

> 本地代码在 `/Users/mingyu/Desktop/workspace/slr-copilot`。完整功能(Phase 0-7)已落地,详见 [README.md](./README.md)。下面是把它推到 `47.236.207.143` 的步骤,**按顺序执行**,每步都有验证命令。

---

## 0. 准备

- SSH 私钥(本项目用 `~/Desktop/workspace/知识分享/test.pem`)
- 域名 DNS 控制台权限
- 一个邮箱(Certbot 续期通知用)
- **可选**:自己的 Anthropic / OpenAI 订阅(给绑定 OAuth 用),或者两家任一的 API key

---

## 1. DNS

```
slr.yourai.asia    A    47.236.207.143    TTL 300
```

验证:
```bash
dig +short slr.yourai.asia      # 应返回 47.236.207.143
```

---

## 2. 推代码

在 `/Users/mingyu/Desktop/workspace/slr-copilot` 下:

```bash
PEM=~/Desktop/workspace/知识分享/test.pem
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .data \
  -e "ssh -i $PEM" \
  ./ root@47.236.207.143:/opt/slr/
```

---

## 3. 服务器一次性安装

```bash
ssh -i $PEM root@47.236.207.143 'bash /opt/slr/deploy/install-server.sh'
```

幂等脚本,做:
- 建 `slr` 系统用户
- 建 `/opt/slr` 和 `/var/lib/slr/{uploads,pdfs,db,claude-home}`
- 装 **Claude Code CLI**(`@anthropic-ai/claude-code`)
- 装 **OpenAI Codex CLI**(`@openai/codex` v0.132.0+)
- 生成 `/etc/slr.env`(含随机 SESSION_SECRET)
- 装 systemd unit + Nginx 站点
- `npm install --omit=dev`
- 启动 `slr.service`(MemoryMax=600M)

验证:
```bash
ssh -i $PEM root@47.236.207.143 'systemctl is-active slr nginx && claude --version && codex --version'
```

---

## 3b. 补 Phase 1 必需的环境变量

`install-server.sh` 自动生成的 `/etc/slr.env` 只含 Phase 0 字段,Phase 1+ 启动前必须追加 3 行:

```bash
ssh -i $PEM root@47.236.207.143 'cat >> /etc/slr.env <<EOF
ENCRYPTION_KEY='$(openssl rand -hex 32)'
BOOTSTRAP_ADMIN_EMAIL=你的邮箱@example.com
BOOTSTRAP_ADMIN_PASSWORD=请改成强密码至少10位
EOF
systemctl restart slr'
```

验证 bootstrap admin 创建成功:
```bash
ssh -i $PEM root@47.236.207.143 'journalctl -u slr -n 10 | grep bootstrap'
# 应看到:[bootstrap] admin created: ...
```

⚠️ `BOOTSTRAP_*` 只在 users 表为空时生效。

---

## 4. Certbot 签 HTTPS

```bash
ssh -i $PEM root@47.236.207.143 \
  'certbot --nginx -d slr.yourai.asia --redirect --non-interactive --agree-tos -m YOUR_EMAIL@example.com'
```

---

## 5. 首次绑定 LLM 凭证(每个用户做一次)

浏览器开 https://slr.yourai.asia/login,登录后进 `/account/credentials/new`:

### 5a. Claude(Anthropic)

- **API key 路径(推荐快速验证)**:
  - `/account/credentials/new?type=api_key` → 选 Anthropic → 粘 `sk-ant-...` → 提交
  - 系统会用 max_tokens=8 ping 一下,通过即 active

- **OAuth 订阅路径(Pro/Max 用户)**:
  - `/account/credentials/new?type=oauth&provider=anthropic` → 提交
  - 页面显示一个 URL,点开 → Anthropic 登录授权 → 复制 code → 粘回输入框 → 提交
  - 完成后 status=active,凭证落 `/var/lib/slr/user-homes/<user_id>/<credential_id>/.claude/`

### 5b. Codex(OpenAI)

- **API key 路径**:同上,粘 `sk-...`

- **OAuth 订阅路径(ChatGPT Plus / Pro)** — **本平台用 device-auth,headless server 友好**:
  - `/account/credentials/new?type=oauth&provider=openai` → 提交
  - 页面显示 URL `https://auth.openai.com/codex/device` + 一个大字号 device code(如 `C2O1-U5SXE`)
  - 浏览器打开 URL,**在浏览器输入 code**(不需要粘回平台)
  - 平台后台 poll,完成后自动跳成功页

---

## 6. 配置每步用什么模型(admin)

进 `/admin/settings`,6 个 step 各选模型:

| Step | 推荐默认 | 你可选 |
|---|---|---|
| Protocol | claude-sonnet-4-6 | 任意 standard 模型 |
| Search | claude-sonnet-4-6 | 任意 standard 模型 |
| Screening | claude-haiku-4-5 / gpt-4o-mini | 选 light 系列省钱 |
| Extraction | claude-opus-4 / gpt-5 | flagship,176 篇全跑约 $5-10 |
| Synthesis | claude-opus-4 / gpt-5 | flagship,质量为先 |
| Drafting | claude-sonnet-4-6 | standard 够用 |

留空 = 用步骤默认 tier。

---

## 7. 最终验证

```bash
curl -I https://slr.yourai.asia/                  # 200
curl -I http://slr.yourai.asia/                   # 301 → https
curl https://slr.yourai.asia/healthz              # {"ok":true,"db":true}
ssh -i $PEM root@47.236.207.143 '
  systemctl is-active slr nginx
  free -h | head -2
  sqlite3 /var/lib/slr/db/slr.db "SELECT COUNT(*) FROM sqlite_master WHERE type=\"table\";"
  # 应该是 23 张表
'
```

---

## 后续日常更新

```bash
# 本地改完代码
PEM=~/Desktop/workspace/知识分享/test.pem
rsync -avz --delete --exclude .git --exclude node_modules --exclude .data \
  -e "ssh -i $PEM" ./ root@47.236.207.143:/opt/slr/

ssh -i $PEM root@47.236.207.143 '
  chown -R slr:slr /opt/slr
  cd /opt/slr && runuser -u slr -- npm install --omit=dev
  systemctl restart slr
  systemctl status slr --no-pager | head -10
'
```

---

## 排查

```bash
# 日志
ssh -i $PEM root@47.236.207.143 'journalctl -u slr -f'

# Nginx
ssh -i $PEM root@47.236.207.143 'tail -50 /var/log/nginx/error.log'

# DB 直查
ssh -i $PEM root@47.236.207.143 'sqlite3 /var/lib/slr/db/slr.db "SELECT * FROM audit_events ORDER BY id DESC LIMIT 20;"'

# 用户的 LLM 调用历史
ssh -i $PEM root@47.236.207.143 'sqlite3 /var/lib/slr/db/slr.db "SELECT action_type, model, status, duration_ms, started_at FROM usage_logs ORDER BY id DESC LIMIT 20;"'

# Claude 凭证还活吗
ssh -i $PEM root@47.236.207.143 "sudo -u slr -H bash -c 'HOME=/var/lib/slr/user-homes/<user_id>/<credential_id> claude auth status'"

# Codex 凭证
ssh -i $PEM root@47.236.207.143 "sudo -u slr -H bash -c 'HOME=/var/lib/slr/user-homes/<user_id>/<credential_id> codex login status'"

# 端口冲突
ssh -i $PEM root@47.236.207.143 'ss -tlnp | grep -E ":(80|443|3001)"'
```
