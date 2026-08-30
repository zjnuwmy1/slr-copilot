# SLR Copilot · 系统性文献综述协作工作台

> **🇨🇳 中文版** · [English](./README.en.md)

AI 辅助的系统性文献综述(Systematic Literature Review)平台。从研究主题到 PRISMA 2020 合规的可投稿初稿,8 步完整闭环。

🌐 **生产环境**:https://slr.yourai.asia · 单机部署 · 内存占用 < 100 MB

---

## 工作流(8 步)

```
理清研究问题  →  准备检索词  →  导入文献  →  整理矩阵  →
RoB(可选) →  主题综合   →  GRADE 评级 →  写成可投稿综述
```

| Step | 用户在干 | LLM 在干 |
|---|---|---|
| **1** 协议 | 输入主题、纳排标准、概念组 | 旗舰模型从输入起草研究问题、纳入/排除标准、PICO 概念组 |
| **2** 检索式 | 按勾选的数据库自动生成 → 真实跑命中 → 回填数 → 锁定最终方案 | 按用户实际勾的库(WoS/Scopus/PubMed)各 3 版 + 1 条 AI 优化主检索(共享概念规格,跨库一致,仅语法不同) |
| **3** 导入 CSV/XLSX | 一次拖多个库的导出文件 | — |
| **4** 文献矩阵 | 在线表格填字段 / 下 XLSX 模板线下填 / AI 自动抽 | 可选每列复制 prompt 到外部 AI 协助 |
| **5** RoB | (站内工具暂未开放,在 GRADE 步骤的 risk_of_bias 维度评级或外部用 RoB 2 等) | — |
| **6** 综合 | 跨论文主题聚类、Evidence Matrix、一致/矛盾发现 | 旗舰模型从矩阵主动聚类 + 找证据空白 |
| **7** GRADE | 五维度 certainty 评级(RoB / inconsistency / indirectness / imprecision / publication bias)+ SoF 表 | — |
| **8** 成稿 | 一键生成 9 章节 + PRISMA flow + 27 项 checklist 附录 + Markdown 导出 | 旗舰模型按 PRISMA 2020 合规渲染英文成稿(中文输入,英文输出),每条事实自动挂回原文献 |

**🔄 全流程任意阶段都可触发"复盘 & 迭代协议"**(第 v_next 版本):AI 综合所有前序数据(协议 + 检索 + 导入 + 筛选 + 每条 AI 判断 + 排除原因 + 主题 + GRADE)反推问题,产出优化后的新协议供用户重新审批。

---

## 核心特性

### 🔐 三层用户体系 + 平台共享凭证
- **Super Admin**(唯一)— 配置平台 Claude / Codex token,所有其他用户共享。`zjnuwmy1@gmail.com` 自动晋升
- **Admin** — 用户管理 / 看使用记录 / 储存空间;不能创建管理员、不能改平台凭证
- **User** — 走平台凭证调 LLM,无需自己绑

### 🤝 协议→检索→筛选→优化 的闭环
- 协议审批后 → 检索式按协议年份/文献类型/语言**逐字**生成(代码层守卫,LLM 不能漂移)
- 每条 query 都包含 4 类过滤(概念组 + 年份 + 文献类型 NOT 排除 + 语言),跨库共享同一套概念规格
- AI 主检索可基于用户期望命中数微调 concept_set 广度
- 用户锁定最终方案后才允许上传 CSV

### 🔍 复盘 & 迭代机制(v2.0 protocol)
- 项目页右上角 **🔄 复盘 & 迭代** 按钮(常驻)
- 筛选页纳入率 < 10% 自动弹 callout 建议
- LLM 拿到:用户反馈 + 协议 + 检索式 + 命中数 + 锁定方案 + **每条 record 的 AI ↔ human 判断**(按信号强度分桶 disagree/uncertain/agree/ai_only,最多 2000 条)+ Top 排除原因 + 主题 + GRADE
- 用 `flagship + high reasoning`(Claude Opus 4.7 ultrathink 或 GPT-5.5 high)
- 输出 diagnosis(置信度色编码)+ proposed_changes(typed)+ 完整新协议 + next_steps
- 用户审批 → 写新 protocol version,iteration_metadata 完整保存审计链

### 📚 多源文献管理
- 一次上传多个文件(WoS xlsx + Scopus csv + PubMed csv)
- 跨库去重:同一篇被多库收录,自动合并 `source_databases: ["wos","scopus"]`
- records 列表用颜色 badge 显示来源(蓝/琥珀/绿)
- WoS Export-to-Excel(.xlsx)直接拖,自动 sheet_to_csv 进同一识别 pipeline

### 🌏 双语流
- 用户工作过程用中文(协议 / 主题 / 笔记 / 反馈)
- 最终论文导出强制英文(SLR 学术规范);PRISMA flow / SoF table / 27 项附录全英文

### 🤖 LLM 路由
- Anthropic OAuth(Claude Code CLI)+ Anthropic API + OpenAI OAuth(Codex CLI device-auth)+ OpenAI API 四路径
- 每步可独立配置模型 + **思考强度**(Claude:think / think hard / ultrathink;Codex:minimal / low / medium / high)
- 跨 provider 翻译:配置 "ultrathink" 在 OpenAI 自动映射为 "high"
- 协议合规守卫:LLM 私改年份/文献类型/语言时自动改回 + 警告

---

## 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 应用框架 | Node 18+ / Express / EJS | partial include 模式,无构建 |
| 数据库 | SQLite (better-sqlite3) | ~28 张表,WAL,单文件 |
| 前端 | Tailwind CDN + Inter / JetBrains Mono | 无构建,生产 prod 直接服务 |
| LLM | Anthropic + OpenAI(API + CLI 共 4 通道) | provider 抽象层 |
| 凭证加密 | AES-256-GCM,`ENCRYPTION_KEY` 32 字节 | OAuth token / API key 全加密 |
| PDF | pdf-parse + 启发式 section 切分 | 章节切分 + chunk |
| Excel | xlsx(社区版) | WoS Export 直拖 + 矩阵模板 |
| Zotero | fast-xml-parser + adm-zip | RDF zip + PDF 附件 |
| 部署 | systemd + Nginx + Certbot | proxy_buffer_size 64K,timeout 1h |

---

## 数据模型

主表(完整 28 张):

```
users  ─ invite_codes ─ user_credentials ─ user_quotas ─ credential_shares
       └ projects ─ protocols ─ search_strategies ─ final_search_records
                  ├ records ─ attachments
                  ├ paper_chunks ─ screening_decisions ─ extractions
                  ├ literature_matrix ─ matrix_columns
                  ├ themes ─ evidence_points ─ grade_assessments
                  ├ draft_sections
                  ├ prisma_checklist
                  ├ target_journal_templates
                  └ pending_iterations
audit_events / usage_logs / system_settings / oauth_bind_sessions
zotero_packages
```

迁移幂等:`db/index.js` 启动时 `ALTER TABLE ADD COLUMN` 增量字段(`is_super_admin` / `search_locked_at` / `search_concept_set_json` / `source_databases` / `iteration_metadata`)。

---

## 部署

```bash
# 服务器准备
adduser --system --group --home /opt/slr --shell /bin/bash slr
mkdir -p /opt/slr /var/lib/slr/{uploads,pdfs,db,claude-home}
chown -R slr:slr /opt/slr /var/lib/slr

# 系统装 Claude / Codex CLI
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude login'

# 部署代码
cd /opt/slr && npm install --omit=dev
cp deploy/slr.env /etc/slr.env  # 编辑 SESSION_SECRET / ENCRYPTION_KEY
cp deploy/slr.service /etc/systemd/system/
cp deploy/nginx.conf /etc/nginx/sites-available/slr
ln -sf /etc/nginx/sites-available/slr /etc/nginx/sites-enabled/
systemctl enable --now slr
certbot --nginx -d slr.yourai.asia --redirect
```

`.env` 关键变量:`PORT=3001` / `DB_PATH=/var/lib/slr/db/slr.db` / `SESSION_SECRET=...` / `ENCRYPTION_KEY=...`(64 hex)/ `BOOTSTRAP_ADMIN_EMAIL=zjnuwmy1@gmail.com` / `BOOTSTRAP_ADMIN_PASSWORD=...`

---

## 关键稳定性修复(已知雷区)

| 问题 | 根因 | 修复 |
|---|---|---|
| 复盘 502 Bad Gateway | LLM 输出几 KB 塞进 cookie-session,Set-Cookie 超过 nginx `proxy_buffer_size 8K` | 改为 `pending_iterations` 表存,session 只存触发标志;nginx buffer bump 到 64K |
| 用户复制锁定 query 后 WoS 语言过滤失效 | EJS `<%= %>` + 多余的 `.replace(/"/g, '&quot;')` 双重转义 | 删多余 .replace;DB 一次性清洗已脏 `&quot;` → `"` |
| LLM 中文输出 JSON 内嵌 `"` 没转义 | `summary: "协议要求"同时涉及"过窄"` parser 崩 | `tryParseLenient` 加 `repairInnerDoubleQuotes` 启发式,所有 LLM 调用受益 |
| Recommend normalize 误判 | 不同模型 envelope wrap / field naming 漂移 | BFS 递归深查 PRIMARY_KEY_RE,接受 11 个别名(primary / best / chosen / ...)|

---

## License

本项目采用 [MIT 协议](./LICENSE) 开源。© 2026 Mingyu

---

## 联系

Issues / 改动建议直接通过本仓库的 issue 反馈。
