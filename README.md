# SLR Copilot

AI 辅助的系统性文献综述(Systematic Literature Review)平台。

## 当前状态:Phase 0

Phase 0 只交付基础设施:子域 + HTTPS + 空 Express 应用跑起来。
功能性的 Project Wizard / 检索式生成 / Zotero ingest / PDF 抽取 / Evidence Matrix / 综述生成,从 Phase 1 起逐步接入。

完整计划见 `~/.claude/plans/1-partitioned-ritchie.md`。

## 技术栈

- Node 18+ / Express / EJS / Tailwind(CDN)
- SQLite(better-sqlite3)
- Claude Code CLI(headless,`claude -p --output-format json`)
- 部署:systemd + Nginx + Certbot

## 目录结构

```
slr-copilot/
├── server.js              # 入口
├── db/
│   ├── index.js           # SQLite 初始化
│   └── schema.sql         # 表结构(随 phase 扩展)
├── views/                 # EJS 模板
│   ├── partials/          # header / footer
│   ├── index.ejs
│   └── error.ejs
├── public/                # 静态资源
│   └── styles.css
├── services/              # LLM / Zotero / PDF / extraction(Phase 1+ 填)
├── routes/                # 路由模块(Phase 1+ 填)
├── deploy/
│   ├── install-server.sh  # 服务器侧一次性安装
│   ├── slr.service        # systemd unit
│   └── nginx.conf         # nginx server block
└── .env.example           # 环境变量模板
```

## 本地开发

```bash
npm install
cp .env.example .env       # 改 SESSION_SECRET / COOKIE_SECURE=false
npm run dev
# 访问 http://127.0.0.1:3001
```

## 部署到 slr.yourai.asia

详细步骤见 `DEPLOY.md`(或下方 checklist)。

```bash
# 本地 → 服务器
rsync -avz --exclude .git --exclude node_modules --exclude .data \
  -e "ssh -i test.pem" \
  ./ root@47.236.207.143:/opt/slr/

# 服务器侧一次性安装
ssh -i test.pem root@47.236.207.143 'bash /opt/slr/deploy/install-server.sh'

# Claude OAuth 登录(交互,只跑一次)
ssh -i test.pem root@47.236.207.143 \
  "sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude login'"

# Certbot 签证书
ssh -i test.pem root@47.236.207.143 \
  'certbot --nginx -d slr.yourai.asia --redirect --non-interactive --agree-tos -m you@example.com'
```

## 验证

```bash
curl -I https://slr.yourai.asia/        # 200
curl https://slr.yourai.asia/healthz    # {"ok":true,"db":true,...}
```

## MVP 不做的事(防 scope creep)

- 不连 WoS / Scopus API(走 Zotero 手动导入)
- 不自动下载 PDF
- 不做 meta-analysis
- 不做向量检索
- 不做多用户协作
