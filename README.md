# SLR Copilot

AI 辅助的系统性文献综述(Systematic Literature Review)平台。从研究主题到完整综述初稿,8 步走完整条 PRISMA 2020 流水线。

**生产**: https://slr.yourai.asia · 单机部署,内存占用 ~35MB

---

## 功能矩阵(Phase 0-7 全部上线)

### 用户能干的(完整 SLR 闭环)

| Step | 功能 | LLM 调用 |
|---|---|---|
| **0** | 注册(凭邀请码)+ 登录 + 绑定 LLM 凭证 | — |
| **1 Protocol** | 输入主题 → AI 生成研究问题 + 纳入/排除标准 + 概念组 → 编辑 → 审批 | claude / gpt |
| **2 Search** | AI 生成 WoS / Scopus / PubMed × 高召回/平衡/高精确 共 9 条检索式 → 复制粘到数据库 → 回填命中数 → 导出 Markdown 附录 | claude / gpt |
| **Zotero 导入** | 上传 Zotero RDF zip(含 PDF 附件 + 笔记) → 自动解析 + 去重(DOI / normalized title) | — |
| **References 管理** | 增删改查 + Crossref DOI 自动填 + 5 种引文格式复制(APA/IEEE/GB-T-7714/Chicago/MLA)+ 批量导出 BibTeX/RIS/CSL JSON | — |
| **3 Screening** | 标题摘要 AI 初筛(include/exclude/uncertain)+ 人工最终决定 → 导出 PRISMA 风格 CSV | haiku / gpt-mini |
| **4 Extraction** | 全文 PDF 解析(pdf-parse + 章节切分)+ Claude 结构化抽取 JSON(study type / sample / findings / limitations / chunk 反向链)+ 人工审阅 | sonnet / opus / gpt |
| **5 RoB** | (Phase 8 GRADE 详细评估,暂占位) | — |
| **6 Synthesis** | 跨论文主题聚类 + Evidence Matrix(records × themes)+ 一致/矛盾 findings + 证据空白 | opus / gpt |
| **7 Certainty** | 人工标 evidence_strength(strong/moderate/weak/unclear) | — |
| **8 Drafting** | AI 写 9 章节(title/abstract/intro/methods/results/discussion/limitations/conclusion/references)+ 引用占位符 `[record_id]` 强校验 + PRISMA flow Mermaid(从 DB 精确算)+ 整文 Markdown 导出 | sonnet / opus / gpt |

### 管理员额外功能

- `/admin` 仪表盘:总用户 / 活跃 / 邀请码 / 项目总数
- `/admin/users` 用户 CRUD + 角色 + 启停 + **配额**(每日调用上限 / 每月 token / 允许的 provider)
- `/admin/users/new` 生成邀请码(7 天过期默认)
- `/admin/users/:id/projects` 看任意用户的项目(只读)
- `/admin/projects` 全平台项目列表 + 详情 + 严格 405 防写
- `/admin/usage` 全平台 LLM 使用记录 + 24h/7d/30d 汇总
- `/admin/audit` 审计日志(登录 / 注册 / 凭证 / 共享 / admin 动作)
- `/admin/settings` **每步用什么模型**(空=用默认 tier,或选 alias / 具体型号)

### 凭证体系

- **绑定方式**:粘 API key(Anthropic / OpenAI)+ Web 化 OAuth 订阅绑定(Claude `auth login` paste-back + Codex `--device-auth` 输 code)
- **共享**:owner 可把自己绑的凭证共享给指定用户,被共享方调用时优先自己的、回落共享的
- **凭证库存**:5 个 Anthropic 模型(opus/sonnet/haiku/...)+ 5 个 OpenAI 模型(gpt-5/o3/gpt-4o/...)

---

## 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 应用框架 | Node 18+ / Express / EJS | partial include 模式 |
| 数据库 | SQLite(better-sqlite3) | 23 张表,WAL 模式,单文件 |
| 前端 | Tailwind via CDN + 少量 vanilla JS | 无构建步骤 |
| LLM 适配器 | Anthropic API + OpenAI API + Claude CLI(`claude auth login` + `-p`)+ Codex CLI(`codex login --device-auth` + `exec --json`) | 4 路径 |
| PDF 解析 | pdf-parse + 启发式 section 切分 | 8 种 section + chunk |
| Zotero | fast-xml-parser + adm-zip | 单文件 RDF zip 上传 |
| 凭证加密 | AES-256-GCM(`ENCRYPTION_KEY` 32 字节) | OAuth token / API key 全加密 |
| 部署 | systemd + Nginx + Certbot | knowledge-share 同机不冲突 |

---

## 目录结构

```
slr-copilot/
├── server.js                          # Express 入口,挂载所有 router
├── db/
│   ├── index.js                       # SQLite 初始化(WAL + FK)
│   └── schema.sql                     # 23 张表 schema
├── middleware/auth.js                 # loadUser / requireUser / requireAdmin
├── services/
│   ├── audit.js                       # 审计日志助手
│   ├── bootstrap.js                   # BOOTSTRAP_ADMIN_* 首次启动建 admin
│   ├── credentials.js                 # 凭证 CRUD + 加密 + 测活
│   ├── credential-sharing.js          # 共享 facade
│   ├── crossref.js                    # DOI 自动填
│   ├── crypto.js                      # AES-256-GCM + randomId + 邀请码
│   ├── llm.js                         # LLM 路由器(per-user + 模型 resolve)
│   ├── oauth-bridge.js                # Web 化 OAuth login dance
│   ├── oauth-bridge-mock.js           # 本地 mock(CLAUDE_BIN/CODEX_BIN=mock)
│   ├── pdf-parse.js                   # PDF 抽文本 + section 切分
│   ├── prisma.js                      # PRISMA 27 项 + 进度计算
│   ├── prisma-flow.js                 # PRISMA flow diagram 数据 + Mermaid
│   ├── settings.js                    # system_settings + step-model resolver
│   ├── zotero-ingest.js               # RDF 解析 + 去重
│   ├── dedup.js                       # DOI + normalized title 去重
│   ├── citation-format.js             # APA/IEEE/GB-T-7714/Chicago/MLA
│   ├── reference-export.js            # BibTeX/RIS/CSL JSON
│   ├── prompts/                       # 6 个 LLM 步骤 prompt 模块
│   │   ├── protocol.js
│   │   ├── search.js
│   │   ├── screening.js
│   │   ├── extraction.js
│   │   ├── synthesis.js
│   │   └── drafting.js
│   └── providers/                     # LLM 适配器
│       ├── anthropic-api.js
│       ├── anthropic-cli.js
│       ├── openai-api.js
│       └── openai-cli.js
├── routes/
│   ├── auth.js                        # /login /logout /register
│   ├── account/
│   │   ├── credentials.js             # /account/credentials/*
│   │   └── oauth.js                   # /account/oauth/* (Claude + Codex)
│   ├── admin/
│   │   ├── users.js                   # /admin /admin/users/*
│   │   ├── projects.js                # /admin/projects/*(只读)
│   │   ├── settings.js                # /admin/settings/*
│   │   ├── usage.js                   # /admin/usage
│   │   └── audit.js                   # /admin/audit
│   └── projects/
│       ├── index.js                   # /projects 主体(含 synthesis/report 子挂)
│       ├── search.js                  # /:id/search/*
│       ├── prisma.js                  # /:id/prisma/*
│       ├── zotero.js                  # /:id/zotero/*
│       ├── records.js                 # /:id/records/* + /:id/attachments/:id/download
│       ├── screening.js               # /:id/screening/*
│       ├── extraction.js              # /:id/extraction/*
│       ├── synthesis.js               # /:id/synthesis/*
│       └── report.js                  # /:id/report/*
├── views/                             # EJS 模板(全部)
├── deploy/                            # systemd / nginx / install 脚本
├── SUMMARY-A.md … SUMMARY-S.md        # 19 个并行 agent 的产出报告
└── DEPLOY.md                          # 部署操作手册
```

---

## 本地开发

```bash
cp .env.example .env
# 至少改 ENCRYPTION_KEY / BOOTSTRAP_ADMIN_PASSWORD,把 COOKIE_SECURE 改 false

npm install
npm run dev
# 访问 http://127.0.0.1:3001
```

本地无 Claude / Codex CLI 时,设 `CLAUDE_BIN=mock CODEX_BIN=mock` 跑 oauth 流是假数据但能完整走通流程。

---

## 部署到 slr.yourai.asia

详见 [DEPLOY.md](./DEPLOY.md)。

关键步骤:
1. DNS 设 A 记录
2. `rsync` 推到 /opt/slr
3. `bash deploy/install-server.sh`(幂等,自动装 Node deps + Claude CLI + Codex CLI + systemd + Nginx)
4. 补 `/etc/slr.env` 加 `ENCRYPTION_KEY` + `BOOTSTRAP_ADMIN_*`
5. `certbot --nginx -d slr.yourai.asia`
6. 用户在 `/account/credentials/new?type=oauth` 走浏览器 OAuth(交互一次)

---

## MVP 不做的事(防 scope creep,后续 Phase 8+ 可加)

- 不连 WoS / Scopus / PubMed 官方 API(走 Zotero 手动导入)
- 不自动下载 PDF(版权 + 反爬)
- 不做 meta-analysis(只做 narrative / thematic synthesis)
- 不做完整 GRADE 评估(只做 evidence_strength 4 档)
- 不做实时协作(单用户编辑)
- 不做 DOCX 导出(只 Markdown)
