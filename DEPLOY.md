# 部署到 slr.yourai.asia — 操作 checklist

> 本地代码已在 `/Users/mingyu/Desktop/workspace/slr-copilot`,Phase 0 + Phase 1 地基已就绪。下面是把它推到 `47.236.207.143` 的步骤,**按顺序执行**,每步都有验证命令。
>
> **Phase 1 新增**:认证 + 用户角色 + 凭证绑定 + 管理员后台。`/etc/slr.env` 需要新增 3 个变量(见步骤 3 之后)。

---

## 0. 准备:你这边需要的东西

- 阿里云 SSH 私钥 `test.pem`(跟知识分享部署用的同一把)
- 域名 `yourai.asia` 的 DNS 控制台权限
- 一个邮箱(用于 Certbot 续期通知)
- 你订阅的 Claude 账号(后面 OAuth 用)

---

## 1. DNS

去域名控制台加 A 记录:

```
slr.yourai.asia    A    47.236.207.143    TTL 300
```

**验证(等 1-5 分钟生效):**
```bash
dig +short slr.yourai.asia
# 应返回 47.236.207.143
```

⚠️ DNS 没生效就跑 Certbot 会失败。

---

## 2. 推代码

在 `/Users/mingyu/Desktop/workspace/slr-copilot` 下执行(把 `~/test.pem` 改成你实际的 key 路径):

```bash
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .data \
  -e "ssh -i ~/test.pem" \
  ./ root@47.236.207.143:/opt/slr/
```

---

## 3. 服务器一次性安装

```bash
ssh -i ~/test.pem root@47.236.207.143 'bash /opt/slr/deploy/install-server.sh'
```

这个脚本会:
- 建 `slr` 系统用户
- 建 `/opt/slr` 和 `/var/lib/slr/{uploads,pdfs,db,claude-home}`
- 安装 Claude Code CLI(全局 npm)
- 生成 `/etc/slr.env`(已经塞好随机 SESSION_SECRET)
- 安装 systemd unit + Nginx 站点
- `npm install --omit=dev`
- 启动 `slr.service`

完成后服务器上应该是:
```bash
ssh -i ~/test.pem root@47.236.207.143 'systemctl is-active slr nginx'
# 都是 active
```

---

## 3b. 补 Phase 1 环境变量

`install-server.sh` 自动生成的 `/etc/slr.env` 只包含 Phase 0 的字段,Phase 1 上线前要追加 3 行:

```bash
ssh -i ~/test.pem root@47.236.207.143 'cat >> /etc/slr.env <<EOF
ENCRYPTION_KEY='$(openssl rand -hex 32)'
BOOTSTRAP_ADMIN_EMAIL=你的邮箱@example.com
BOOTSTRAP_ADMIN_PASSWORD=请改成强密码至少10位
EOF
systemctl restart slr'
```

**验证 bootstrap admin:**
```bash
ssh -i ~/test.pem root@47.236.207.143 'journalctl -u slr -n 10 | grep bootstrap'
# 应该看到:[bootstrap] admin created: 你的邮箱@example.com (id=...)
```

之后浏览器打开 https://slr.yourai.asia/login,用 bootstrap 的邮箱密码登录 → 进 /admin 生成邀请码邀请其他用户。

> ⚠️ BOOTSTRAP_* 只在 users 表为空时生效。之后即便改了这两个变量也不会自动重新创建。

## 4. Claude OAuth 登录(只跑一次)

这是 headless 服务器上的 OAuth dance,**会在终端打印一个 URL,要在你本地浏览器打开授权,然后把回调里的 token 粘回服务器**。

```bash
ssh -i ~/test.pem root@47.236.207.143 \
  "sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude login'"
```

按提示走完。完成后凭证落在 `/var/lib/slr/claude-home/.claude/`,只有 `slr` 用户能读。

**验证:**
```bash
ssh -i ~/test.pem root@47.236.207.143 \
  "sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude -p \"reply with just OK\" --output-format text'"
# 应返回 OK
```

---

## 5. Certbot 签 HTTPS

```bash
ssh -i ~/test.pem root@47.236.207.143 \
  'certbot --nginx -d slr.yourai.asia --redirect --non-interactive --agree-tos -m YOUR_EMAIL@example.com'
```

把 `YOUR_EMAIL` 换成你的邮箱。Certbot 会自动:
- 80 端口 ACME 验证
- 拿证书
- 改 Nginx,加 443 段
- 加 80→443 跳转

---

## 6. 最终验证

```bash
# HTTPS 200
curl -I https://slr.yourai.asia/

# 80 跳转
curl -I http://slr.yourai.asia/

# healthz
curl https://slr.yourai.asia/healthz

# 服务状态
ssh -i ~/test.pem root@47.236.207.143 '
  echo "=== systemd ==="
  systemctl is-active slr nginx
  echo "=== mem ==="
  free -h | head -2
  echo "=== slr mem ==="
  systemctl status slr --no-pager -l | grep -E "Memory|Active"
'
```

浏览器打开 `https://slr.yourai.asia/`,应该看到 SLR Copilot Phase 0 占位页。

---

## 后续日常更新代码

```bash
# 本地改完代码后
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude .data \
  -e "ssh -i ~/test.pem" \
  ./ root@47.236.207.143:/opt/slr/

# 服务器侧
ssh -i ~/test.pem root@47.236.207.143 '
  chown -R slr:slr /opt/slr
  cd /opt/slr && runuser -u slr -- npm install --omit=dev
  systemctl restart slr
  systemctl status slr --no-pager -l | head -10
'
```

---

## 出问题排查

```bash
# 日志
ssh -i ~/test.pem root@47.236.207.143 'journalctl -u slr -f'

# Nginx 日志
ssh -i ~/test.pem root@47.236.207.143 'tail -50 /var/log/nginx/error.log'

# Claude CLI 是否能跑
ssh -i ~/test.pem root@47.236.207.143 \
  "sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude -p \"ping\"'"

# 端口被占用
ssh -i ~/test.pem root@47.236.207.143 'ss -tlnp | grep -E ":(80|443|3001)"'
```
