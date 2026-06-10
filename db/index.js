import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '.data', 'slr.db')
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

export function initDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // 2026-06-10 审计修复:better-sqlite3 默认 busy_timeout=0,后台 LLM 任务与网页请求
  // 并发写时会立刻抛 SQLITE_BUSY("database is locked")。等 5s 再失败,配合 WAL 消除偶发锁错。
  db.pragma('busy_timeout = 5000')

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)

  // ─── 增量迁移(幂等) ─────────────────────────────────────────
  // 已存在的 DB 上 CREATE TABLE IF NOT EXISTS 不会改 schema,
  // 这里用 ALTER TABLE ADD COLUMN + try/catch 处理后续字段。
  runMigrations(db)

  return db
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((r) => r.name === column)
}

function tableExists(db, table) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
  return !!row
}

function runMigrations(db) {
  // M1:users.is_super_admin —— 超级管理员标记位
  if (!columnExists(db, 'users', 'is_super_admin')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_super_admin ON users(is_super_admin)`)
  }

  // M2:projects.search_locked_at —— 用户落盘最终检索方案的时间戳
  if (!columnExists(db, 'projects', 'search_locked_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN search_locked_at TEXT`)
  }
  // M4:projects.search_concept_set_json —— 所有库共用的"概念规格"
  //    (concept_groups + year_range + document_types + excluded_document_types
  //     + language)。每库的 query_text 都是这套规格的语法渲染。
  if (!columnExists(db, 'projects', 'search_concept_set_json')) {
    db.exec(`ALTER TABLE projects ADD COLUMN search_concept_set_json TEXT`)
  }

  // M3:final_search_records —— 每个项目 × 每个目标库的"最终用了什么检索式"快照
  db.exec(`
    CREATE TABLE IF NOT EXISTS final_search_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      database_name TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      strategy_id TEXT,
      query_text TEXT,
      result_count INTEGER,
      search_date TEXT,
      notes TEXT,
      locked_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE (project_id, database_name)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_final_search_project ON final_search_records(project_id)`)

  // M5:records.source_databases —— 该文献被哪些数据库收录(JSON 字符串数组)
  //    例:["wos"] 单库;["wos","scopus"] 跨两库收录的同一篇(跨库去重时合并)
  //    用于:① 导入时按 DOI/normalized_title 去重并 merge;
  //          ② records 列表/详情页展示来源 badge;
  //          ③ PRISMA 报告里"records identified per database"统计。
  if (!columnExists(db, 'records', 'source_databases')) {
    db.exec(`ALTER TABLE records ADD COLUMN source_databases TEXT`)
  }

  // M6:protocols.iteration_metadata —— 当该 protocol 是由"复盘 & 迭代"
  //    机制生成时,保存 AI 的 diagnosis + 看过哪些前序数据,以便审计追踪。
  if (!columnExists(db, 'protocols', 'iteration_metadata')) {
    db.exec(`ALTER TABLE protocols ADD COLUMN iteration_metadata TEXT`)
  }

  // M8:records.language —— WoS / Scopus / PubMed CSV 里的 Language 字段原文。
  //    例:"English" / "English; Korean" / "Chinese". 用于:
  //    ① UI 显示语言徽章;② 多语言论文亮黄(WoS LA= 查"包含英文",
  //    韩国期刊英文摘要 + 韩文全文会漏进结果,UI 标记便于人工排查)。
  if (!columnExists(db, 'records', 'language')) {
    db.exec(`ALTER TABLE records ADD COLUMN language TEXT`)
  }

  // M7.5: screening_decisions.ai_matched_concepts —— AI 初筛新版 prompt
  //    要求 include 时必须命中至少 1 个概念组,这一列记录命中的组名,
  //    用于:① UI 展示"为什么 include";② normalize 阶段做硬约束校验
  //    (exclude 不能既无 matched_exclusion 又有 matched_concepts)。
  if (!columnExists(db, 'screening_decisions', 'ai_matched_concepts')) {
    db.exec(`ALTER TABLE screening_decisions ADD COLUMN ai_matched_concepts TEXT`)
  }

  // M7.6: projects.screening_target_include_pct —— 用户期望的初筛纳入率
  //    INTEGER,0-100 之间(NULL = 未设定,LLM 不接受软目标)。
  //    用作软目标注入 screening prompt:边缘 include/exclude 时按这个比例调,
  //    但**绝不破坏**客观决策树底线(命中排除标准 / 类型不符 / 无概念重叠)。
  //    用户可手填,也可点"AI 推荐"按钮让 LLM 根据协议反推一个值。
  if (!columnExists(db, 'projects', 'screening_target_include_pct')) {
    db.exec(`ALTER TABLE projects ADD COLUMN screening_target_include_pct INTEGER`)
  }

  // M8: step_model_presets —— 超管配置 3 套模型方案(高性能 / 平衡 / 经济)
  //   id 固定枚举 ('performance' | 'balanced' | 'economy')
  //   config_json 存:{ step_model: {...}, step_reasoning: {...} } 全部 7 个 step
  //   is_default = 1 的那条作为新用户默认 + 兼容旧用户(step_model_preset NULL 时用此)
  //   seed 由 services/step-presets.js seedDefaultPresets() 在 bootstrap 时跑。
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_model_presets (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
    )
  `)

  // M8.5: users.step_model_preset —— 用户选了哪个预设
  //   NULL = 用默认 preset(is_default = 1 那条),向后兼容老用户。
  if (!columnExists(db, 'users', 'step_model_preset')) {
    db.exec(`ALTER TABLE users ADD COLUMN step_model_preset TEXT`)
  }

  // M9: users.advanced_extraction_enabled —— "高级抽取功能" 权限位
  //   超管/admin 默认 1,新注册用户默认 0(只能下载 xlsx 手动填)。
  //   控制:批量 AI 抽取 / 单条 AI 抽取 / Zotero 上传 / 任何带 PDF 处理的功能。
  //   超管在 /admin/users 控制 (类似 plan toggle)。
  if (!columnExists(db, 'users', 'advanced_extraction_enabled')) {
    db.exec(`ALTER TABLE users ADD COLUMN advanced_extraction_enabled INTEGER NOT NULL DEFAULT 0`)
    // 已有的超管 + admin 自动 = 1
    db.exec(`UPDATE users SET advanced_extraction_enabled = 1 WHERE is_super_admin = 1 OR role = 'admin'`)
  }

  // M10: projects.matrix_ai_customized_at_version —— "AI 定制矩阵列" 调过的协议版本号
  //   每次成功跑完"🎯 让 AI 定制本项目专属列"(suggest + rewrite + batch-add),
  //   把当前 protocol.version 写进来。再次点击时:若当前协议版本 ≤ 已定制版本 → 拒绝。
  //   想再来一次?重新审批协议(version 自增)解锁。
  //   NULL = 从未跑过。
  if (!columnExists(db, 'projects', 'matrix_ai_customized_at_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN matrix_ai_customized_at_version INTEGER`)
  }

  // M13: projects.rob_marked_done_at —— Step 5 偏倚风险:站内工具暂未开放,
  //   用户在外部用 RoB 2 / ROBINS-I / NOS 完成后,点"我已外部完成"自报告,
  //   stepStatus.rob 据此变 done,8/8 进度可达。NULL = 未标记。
  if (!columnExists(db, 'projects', 'rob_marked_done_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN rob_marked_done_at TEXT`)
  }

  // M14: users.storage_quota_bytes —— 每用户的存储配额(字节)。
  //   NULL = 用默认值:
  //     advanced_extraction_enabled=1 → 默认 1 GB (1073741824)
  //     advanced_extraction_enabled=0 → 默认 0
  //   超管可在 /admin/users/:id 单独设(更多或更少)。
  //   覆盖范围:zotero_packages.size_bytes + attachments.size_bytes(用户所有项目合计)。
  if (!columnExists(db, 'users', 'storage_quota_bytes')) {
    db.exec(`ALTER TABLE users ADD COLUMN storage_quota_bytes INTEGER`)
  }

  // M11: zotero_packages.reconciliation_json —— Zotero 包二次匹配报告。
  //   ingest 完成后,把 Zotero 包里的论文与系统中已 human_decision='include' 的
  //   records 做 DOI / normalized_title+author / normalized_title+year 匹配,
  //   把 matched + extra_in_zotero + extra_in_system 三组结果落盘,供包详情页展示。
  //   合并阶段(zotero-merge.js)按这份报告把 zotero 的更全字段(abstract、
  //   keywords、PDF)补到系统 record 上,不新增 record、不动 screening 决定。
  if (!columnExists(db, 'zotero_packages', 'reconciliation_json')) {
    db.exec(`ALTER TABLE zotero_packages ADD COLUMN reconciliation_json TEXT`)
  }

  // M12: batch_jobs —— 后台批量任务进度持久化(防服务重启丢状态)
  //   kind: 'matrix_extraction' | 'screening' | 'extraction(legacy)' 等
  //   status: 'running' | 'finished' | 'aborted_by_restart' | 'failed'
  //   pid: 启动进程的 PID(initDb 时把残留 running + pid != current PID 标 aborted)
  //   progress_json: { total, done, failed, current: { id, title } }
  //   每个 project_id × kind 同时只允许一个 running
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      total INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      progress_json TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      finished_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_project_kind ON batch_jobs(project_id, kind, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status)`)

  // 启动时把"上次进程的 running 任务"标记为 aborted_by_restart
  // pid 字段:如果非空且不等于当前 PID,且 status='running',就是上次留下的孤儿
  try {
    db.prepare(
      `UPDATE batch_jobs
          SET status = 'aborted_by_restart',
              finished_at = datetime('now', '+8 hours'),
              error_message = COALESCE(error_message, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE status = 'running'
          AND (pid IS NULL OR pid != ?)`
    ).run(process.pid)
  } catch (e) { console.error('[init] reset stale batch_jobs failed:', e.message) }

  // M7:pending_iterations —— 跑完 diagnose 但用户还没决定 adopt/discard 的
  //    LLM 输出。之前放在 cookie-session 里,几 KB 的 JSON 把 Set-Cookie
  //    header 撑爆,Nginx proxy_buffer_size 8K 直接 502 Bad Gateway。
  //    现在入库;session 只存 trigger 标志位。
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_iterations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      snapshot_summary_json TEXT,
      model TEXT,
      reasoning TEXT,
      duration_ms INTEGER,
      user_feedback TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_iterations_project ON pending_iterations(project_id, user_id)`)

  // ─── Batch 4 ─────────────────────────────────────────────────

  // M17: usage_logs.credential_id FK 加 ON DELETE SET NULL —— 已记的注释
  //   SQLite 无法 ALTER 现有列加 FK,schema.sql 的 CREATE TABLE 已经写了
  //   `FOREIGN KEY (credential_id) REFERENCES user_credentials(id)`,
  //   但缺 ON DELETE SET NULL。新建的库会带正确 FK(下次 schema 重建),
  //   老库靠 `scripts/cleanup-old-logs.sh` 兜底删 90 天前的孤儿行。
  //   这里**不做** ALTER —— 列已存在 + better-sqlite3 不支持 PRAGMA legacy_alter_table。

  // M18: password_reset_tokens —— B4.5 密码重设流程
  //   token: 32 字符 hex(crypto.randomBytes(16))
  //   expires_at: created_at + 15 min
  //   used_at: 一次性,用过即作废
  //   超管 dashboard 拉未过期未用的列表,人工转发链接给用户(MVP 无邮件)
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      requested_ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at)`)

  // ─── Batch 2 ─────────────────────────────────────────────────

  // M19: storage_reservations —— B2.2 配额两阶段提交。
  //   原 bug:用户同时开两个 tab 各上传 600MB,storageUsedByUser 只看 DB 已落盘的;
  //         两次预检都看到 used=0 + incoming=600M ≤ 1GB,都放行 → 总占用 1.2 GB 超额。
  //   方案:上传开始前 INSERT 一行 reservation(预占),storageUsedByUser 把
  //         未过期的 reservation 也算进去;上传完成/失败 DELETE。
  //   expires_at = 上传开始 + 30 分钟(估算 1 GB 上传上限),超过自动失效避免泄漏。
  //   reservation 不进 zotero_packages.size_bytes,落盘后真实 size 才进。
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_reservations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_storage_reservations_user ON storage_reservations(user_id, expires_at)`)
  // 启动时清理已过期的 reservation(上次进程崩了/上传卡死)
  try {
    db.exec(`DELETE FROM storage_reservations WHERE expires_at <= datetime('now', '+8 hours')`)
  } catch (e) { console.error('[init] cleanup expired reservations failed:', e.message) }

  // M20: batch_jobs.boot_id + last_error + can_retry —— B2.3 + B2.4。
  //   B2.3:process.pid 在 systemd 重启时可能轮回到同一数字,导致"上次 running"
  //         被误判为"还在跑";改用进程启动时生成的随机 boot_id 比较。
  //         pid 列保留(老数据兼容),新 row 同时写 boot_id;
  //         init 时按 boot_id != current_boot_id 标 aborted_by_restart。
  //   B2.4:aborted_by_restart 的 row 标 can_retry=1,UI 显示重启按钮;
  //         last_error 存最近一次错误(给用户看)。
  if (!columnExists(db, 'batch_jobs', 'boot_id')) {
    db.exec(`ALTER TABLE batch_jobs ADD COLUMN boot_id TEXT`)
  }
  if (!columnExists(db, 'batch_jobs', 'last_error')) {
    db.exec(`ALTER TABLE batch_jobs ADD COLUMN last_error TEXT`)
  }
  if (!columnExists(db, 'batch_jobs', 'can_retry')) {
    db.exec(`ALTER TABLE batch_jobs ADD COLUMN can_retry INTEGER NOT NULL DEFAULT 0`)
  }

  // M21: records.pdf_status —— 区分 "暂无 PDF" 跟 "已确认找不到(容缺)"。
  //   值:
  //     NULL  → 暂无,刚导入没人审过(默认)
  //     'unavailable' → 用户已确认这篇真的找不到原文,允许 LLM 用 "标题+摘要" 模式跑
  //   只有 'unavailable' 才进入 Step 4 "容缺原文" 批量;NULL/暂无的不进 — 因为还没人确认,
  //   可能用户只是没补传过、本来能找到的。
  //   has_pdf=1 时此列被自动清空(NULL):有真 PDF 后"容缺"标记就过时了。
  if (!columnExists(db, 'records', 'pdf_status')) {
    db.exec(`ALTER TABLE records ADD COLUMN pdf_status TEXT`)
  }
  // 启动重置(B2.3 新版):优先按 boot_id,fallback 按 pid。
  //   每次 server.js 启动时把 process.env.SLR_BOOT_ID 传进来 — 这里只做一次扫一次。
  //   注意:这段逻辑跟上面 M12 的 pid-only reset 重复 — 老 pid-only 留作 fallback。
  try {
    const bootId = process.env.SLR_BOOT_ID || null
    if (bootId) {
      db.prepare(
        `UPDATE batch_jobs
            SET status = 'aborted_by_restart',
                finished_at = datetime('now', '+8 hours'),
                can_retry = 1,
                last_error = COALESCE(last_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
          WHERE status = 'running'
            AND (boot_id IS NULL OR boot_id != ?)`
      ).run(bootId)
    }
  } catch (e) { console.error('[init] M20 reset stale batch_jobs by boot_id failed:', e.message) }

  // M22: matrix_master_prompt_{batch,copy} + _at_version
  //   一键优化总 prompt 功能 — LLM 综合协议 + AI 定制列 + 入选论文样本(标题+摘要)
  //   产出两个版本:
  //     batch    — 系统跑批量抽取时实际用的(可能更长更细,含 few-shot 提示等)
  //     copy     — 给用户复制到外部 AI 平台的简化版(去掉 few-shot 等冗余,~1-2KB)
  //   每个协议版本只能优化一次 — _at_version 记录;改协议(version 自增)解锁。
  //   优化前:buildAutomatedMasterPrompt 走默认模板;优化后:fall back 到 batch 字段。
  if (!columnExists(db, 'projects', 'matrix_master_prompt_batch')) {
    db.exec(`ALTER TABLE projects ADD COLUMN matrix_master_prompt_batch TEXT`)
  }
  if (!columnExists(db, 'projects', 'matrix_master_prompt_copy')) {
    db.exec(`ALTER TABLE projects ADD COLUMN matrix_master_prompt_copy TEXT`)
  }
  if (!columnExists(db, 'projects', 'matrix_master_prompt_at_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN matrix_master_prompt_at_version INTEGER`)
  }

  // M23: matrix_master_prompt_optimize_started_at —— in-flight lock
  //   优化总 prompt 的 LLM 调用要 5-8 分钟。在此期间 *_at_version 还没更新,
  //   用户刷新页面会发现按钮"又能点了",一不小心触发第二次 Opus 调用(浪费 $)。
  //   解决:点击瞬间写 started_at,完成时(成功或失败)清回 NULL。
  //   UI 看到 started_at 非空就显示"进行中,已 X:XX",并禁按。
  //   兜底:> 15 分钟视为"上次崩溃留下的孤儿",允许覆盖(防卡死)。
  if (!columnExists(db, 'projects', 'matrix_master_prompt_optimize_started_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN matrix_master_prompt_optimize_started_at TEXT`)
  }

  // M24: Step 5 Risk of Bias —— per-study 评估表 + project 级 overlay 提示词
  //
  // 5 工具 multi-instrument:本地按 matrix.study_design 路由到对应工具,
  //   rob2 (RCT) / robins_i (非随机干预) / nos (cohort/case-control)
  //   / jbi_cs (cross-sectional) / mmat (qual/mixed/兜底)
  // 每条 record 1 行(rater_pass=1);Phase 2 IRR 第二人评估走 rater_pass=2 +
  //   parent_assessment_id 关联第一人。schema 提前占位避免后续 migration。
  // judgments_json 存完整 LLM 输出({tool, tool_version, effect_of_interest?,
  //   judgments:[{domain, judgment, signaling_answers_summary, rationale,
  //              evidence_quote, page_ref, confidence}]})
  // overall_rating / overall_rationale 是本地 roll-up 算法(LLM 不参与)
  //   per-tool 算法见 services/rob.js computeOverallRating()
  if (!tableExists(db, 'rob_assessments')) {
    db.exec(`
      CREATE TABLE rob_assessments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('rob2','robins_i','nos','jbi_cs','mmat')),
        tool_version TEXT NOT NULL,
        judgments_json TEXT NOT NULL,
        overall_rating TEXT,
        overall_rationale TEXT,
        signaling_answers_json TEXT,
        evidence_quotes_json TEXT,
        filled_by TEXT NOT NULL DEFAULT 'ai' CHECK (filled_by IN ('ai','user','ai_edited')),
        model_used TEXT,
        usage_log_id INTEGER,
        rater_pass INTEGER NOT NULL DEFAULT 1,
        parent_assessment_id TEXT,
        reviewed_by_user_id TEXT,
        reviewed_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_assessment_id) REFERENCES rob_assessments(id) ON DELETE SET NULL,
        UNIQUE(record_id, rater_pass)
      )
    `)
    db.exec(`CREATE INDEX idx_rob_project ON rob_assessments(project_id)`)
    db.exec(`CREATE INDEX idx_rob_tool ON rob_assessments(project_id, tool)`)
  }

  // M24 cont.: project 级 overlay 提示词(类似 matrix M22+M23 的 overlay 模式)
  //   _overlay JSON {rob2: '...', robins_i: '...', nos: '...', jbi_cs: '...', mmat: '...'} —
  //     5 个工具各自的项目特异性指引,由 Opus 4.8 一次性生成
  //   _at_version 记录是基于哪个协议版本生成的(协议改了要重生成)
  //   _optimize_started_at 是 in-flight lock(15 min stale timeout,跟 matrix 同模式)
  if (!columnExists(db, 'projects', 'rob_master_prompt_overlay')) {
    db.exec(`ALTER TABLE projects ADD COLUMN rob_master_prompt_overlay TEXT`)
  }
  if (!columnExists(db, 'projects', 'rob_master_prompt_at_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN rob_master_prompt_at_version INTEGER`)
  }
  if (!columnExists(db, 'projects', 'rob_master_prompt_optimize_started_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN rob_master_prompt_optimize_started_at TEXT`)
  }

  // ============================================================
  // M25: Step 6 主题聚类升级 — 接入 Step 1-5 完整数据
  // ============================================================
  //
  // 现状:Step 6 LLM 输入只有 title + research_questions,看不见 matrix(Step 4 重做后
  //   完成度 0.97)+ RoB(Step 5 brand new)+ 完整协议 PICO + 筛选理由,所以主题泛/浅。
  // M25 加:
  //   1. project 级 synthesis overlay(项目特异性聚类指引,Opus 生成,跟 matrix/rob 同模式)
  //   2. themes 表新字段:PICO 锚点 + 质量画像 + 方法学异质性 + 迭代追溯
  //   3. synthesis_meta 表:跨主题观察 + protocol 覆盖反查(PRISMA Item 21)
  if (!columnExists(db, 'projects', 'synthesis_master_prompt_overlay')) {
    db.exec(`ALTER TABLE projects ADD COLUMN synthesis_master_prompt_overlay TEXT`)
  }
  if (!columnExists(db, 'projects', 'synthesis_master_prompt_at_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN synthesis_master_prompt_at_version INTEGER`)
  }
  if (!columnExists(db, 'projects', 'synthesis_master_prompt_optimize_started_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN synthesis_master_prompt_optimize_started_at TEXT`)
  }

  // themes 表加新字段(已有表只 ALTER 补列,避免影响老数据)
  if (!columnExists(db, 'themes', 'maps_to_research_questions')) {
    db.exec(`ALTER TABLE themes ADD COLUMN maps_to_research_questions TEXT`)  // JSON array of RQ idx/strings
  }
  if (!columnExists(db, 'themes', 'maps_to_pico_concepts')) {
    db.exec(`ALTER TABLE themes ADD COLUMN maps_to_pico_concepts TEXT`)  // JSON array of concept labels
  }
  if (!columnExists(db, 'themes', 'study_design_mix')) {
    db.exec(`ALTER TABLE themes ADD COLUMN study_design_mix TEXT`)  // JSON {RCT:2, qual:8, ...}
  }
  if (!columnExists(db, 'themes', 'rob_profile')) {
    db.exec(`ALTER TABLE themes ADD COLUMN rob_profile TEXT`)  // JSON {good:N, middle:N, bad:N, unrated:N}
  }
  if (!columnExists(db, 'themes', 'methodological_note')) {
    db.exec(`ALTER TABLE themes ADD COLUMN methodological_note TEXT`)
  }
  if (!columnExists(db, 'themes', 'iteration_n')) {
    db.exec(`ALTER TABLE themes ADD COLUMN iteration_n INTEGER NOT NULL DEFAULT 1`)
  }
  if (!columnExists(db, 'themes', 'parent_theme_id')) {
    db.exec(`ALTER TABLE themes ADD COLUMN parent_theme_id TEXT`)  // iterate 时关联前版
  }

  // synthesis_meta 表:跨主题元信息(PRISMA 2020 Item 21 synthesis coverage)
  if (!tableExists(db, 'synthesis_meta')) {
    db.exec(`
      CREATE TABLE synthesis_meta (
        project_id TEXT PRIMARY KEY,
        cross_cutting_observations TEXT,    -- JSON array of strings
        protocol_coverage TEXT,             -- JSON {RQ1: [theme_ids], RQ3_uncovered: "..."}
        generated_at TEXT,
        model_used TEXT,
        usage_log_id INTEGER,
        iteration_n INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
  }

  // ============================================================
  // M26: Post-RoB 排除(Step 5 filter,不同于 Step 3 screening exclude)
  // ============================================================
  //
  // 场景:Step 5 RoB 评估后发现某篇虽然 Step 3 标了 include,但其实是
  //   纯理论框架 / 概念论文 / 全 no_information,不应该进入 Step 6 synthesis。
  // 跟 Step 3 screening exclude 的差别:
  //   - Step 3 是基于 title+abstract 判断"是否符合主题"
  //   - Step 5 post-RoB exclude 是基于全文 RoB 判断"是否有实证可评估"
  //   - 两者**独立**:论文仍然 Step 3 include(参与 PRISMA flow include 计数),
  //     但 Step 6/7/8 数据 fetch 时被 filter 掉
  //   - PRISMA flow 应单列 "excluded at synthesis stage with methodological reasons N 篇"
  // 全代码库 filter:routes/projects/synthesis.js、certainty.js、report.js
  //   在拉 include records 时加 `AND r.rob_excluded_at IS NULL`
  if (!columnExists(db, 'records', 'rob_excluded_at')) {
    db.exec(`ALTER TABLE records ADD COLUMN rob_excluded_at TEXT`)
  }
  if (!columnExists(db, 'records', 'rob_excluded_reason')) {
    db.exec(`ALTER TABLE records ADD COLUMN rob_excluded_reason TEXT`)
  }
  if (!columnExists(db, 'records', 'rob_excluded_by_user_id')) {
    db.exec(`ALTER TABLE records ADD COLUMN rob_excluded_by_user_id TEXT`)
  }

  // ============================================================
  // M27: AI 一键优化插图 prompt(Phase 9 Agent W 升级)
  // ============================================================
  //   通用 3 模板留着;Opus 一次性生成项目专属 3-5 张 figure prompt 存这里
  //   JSON {figures: [{id, title, when_to_use, copy_hint, prompt}], style_baseline_used}
  if (!columnExists(db, 'projects', 'figure_prompts_ai_optimized')) {
    db.exec(`ALTER TABLE projects ADD COLUMN figure_prompts_ai_optimized TEXT`)
  }
  if (!columnExists(db, 'projects', 'figure_prompts_optimized_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN figure_prompts_optimized_at TEXT`)
  }

  // ============================================================
  // M28: Deep verify 去重 — 防止已 Deep 验证过的论文被重复排队
  // ============================================================
  //
  // 原 bug:promotePass2ToPrimary 把 pass-2 顶到 pass-1 后,pass-2 行没了,
  //   下次 Deep verify 查 "pass2RidSet" 时找不到,误以为"没 Deep 过",重新排队。
  // 修复:在 records 表加 last_rob_deep_verified_at — Deep 一旦做过就永久标记,
  //   无论后来 pass-2 是否被 promote 都不变。
  // Deep verify 路由 skip 用这个字段(而不是 pass-2 是否存在)。
  if (!columnExists(db, 'records', 'last_rob_deep_verified_at')) {
    db.exec(`ALTER TABLE records ADD COLUMN last_rob_deep_verified_at TEXT`)
    // 一次性 backfill:对老数据(M28 之前已 Deep 验过的),根据现有 pass-2 行
    //   OR rob_pass2_promoted audit 事件 → 标 deep verified。idempotent:column 缺时才跑。
    try {
      db.exec(`
        UPDATE records SET last_rob_deep_verified_at = datetime('now', '+8 hours')
         WHERE id IN (SELECT record_id FROM rob_assessments WHERE rater_pass = 2)
            OR id IN (SELECT json_extract(payload, '$.record_id') FROM audit_events
                       WHERE event_type IN ('rob_pass2_promoted','rob_deep_verify_success'))
      `)
    } catch (e) {
      // audit_events 表 / payload JSON 可能不存在 — 忽略,只用 pass-2 行
      try {
        db.exec(`
          UPDATE records SET last_rob_deep_verified_at = datetime('now', '+8 hours')
           WHERE id IN (SELECT record_id FROM rob_assessments WHERE rater_pass = 2)
        `)
      } catch {}
    }
  }

  // ============================================================
  // M29: Step 6 synthesis run 异步化 — 让前端能轮询进度
  // ============================================================
  //
  // 之前 POST /synthesis/run 是同步 await runLlm(...) 阻塞 10-15 分钟,
  //   浏览器一直 spinning 没有任何反馈,体验极差。
  // 现在改成 setImmediate 后台跑 + 5 个状态列 + GET status.json 轮询。
  //
  //   synthesis_run_started_at  — 启动时间(也用作原子 lock,30 min 失效)
  //   synthesis_run_finished_at — 完成时间(成功或失败都写)
  //   synthesis_run_status      — running | success | failed | aborted_by_restart
  //   synthesis_run_error       — 失败时的错误消息(截断 500 字符)
  //   synthesis_run_meta        — JSON: { papers_count, themes_count, model, duration_ms, usage_log_id }
  for (const col of [
    'synthesis_run_started_at',
    'synthesis_run_finished_at',
    'synthesis_run_status',
    'synthesis_run_error',
    'synthesis_run_meta',
  ]) {
    if (!columnExists(db, 'projects', col)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`)
    }
  }
  // 启动时清理孤儿 — 任何 status='running' 的 synthesis 都是上次进程没跑完的
  //   (LLM call 在内存里,进程死了就没了)。标 aborted_by_restart 让 UI 显示重试按钮。
  try {
    db.prepare(
      `UPDATE projects
          SET synthesis_run_status = 'aborted_by_restart',
              synthesis_run_finished_at = datetime('now', '+8 hours'),
              synthesis_run_error = COALESCE(synthesis_run_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE synthesis_run_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale synthesis_run failed:', e.message) }

  // ============================================================
  // M30: Step 7 证据强度异步化 + 主题级 GRADE/CERQual rollup + overlay
  // ============================================================
  //
  // Step 7 之前是同步阻塞 + 模型硬编码 + 没主题级 rollup,跟 Step 6 升级前一个状况。
  // 本次升级镜像 Step 6 全套异步基础设施 + 加主题级 GRADE/CERQual 双轨。
  //
  //   certainty_run_started_at  — 启动时间(也用作原子 lock,60 min 失效)
  //   certainty_run_finished_at — 完成时间(成功或失败都写)
  //   certainty_run_status      — running | success | failed | aborted_by_restart
  //   certainty_run_error       — 失败错误消息(截断 500 字符)
  //   certainty_run_meta        — JSON {themes_count, framework_split, model, duration_ms, usage_log_id}
  //
  //   certainty_master_prompt_overlay      — Opus 为本项目生成的 GRADE/CERQual 专属指引
  //   certainty_master_prompt_at_version   — overlay 基于哪个协议版本生成
  //   certainty_master_prompt_optimize_started_at  — overlay 生成原子 lock
  for (const col of [
    'certainty_run_started_at',
    'certainty_run_finished_at',
    'certainty_run_status',
    'certainty_run_error',
    'certainty_run_meta',
    'certainty_master_prompt_overlay',
    'certainty_master_prompt_at_version',
    'certainty_master_prompt_optimize_started_at',
  ]) {
    if (!columnExists(db, 'projects', col)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`)
    }
  }

  // theme_certainty 主题级置信度 rollup(GRADE + CERQual 双轨)
  //   - GRADE 5 维 downgrade + 3 upgrade(grading_framework='grade'|'hybrid' 时填)
  //   - CERQual 4 维(grading_framework='cerqual'|'hybrid' 时填)
  //   - 共同:overall_certainty + body_of_evidence_summary + implications
  //   - 现有 grade_assessments(outcome 级)保留不动,作为本表的可选 drill-down
  db.exec(`
    CREATE TABLE IF NOT EXISTS theme_certainty (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      grading_framework TEXT NOT NULL,                        -- grade | cerqual | hybrid
      -- GRADE 维度
      grade_risk_of_bias TEXT,                                -- not_serious | serious | very_serious
      grade_inconsistency TEXT,
      grade_indirectness TEXT,
      grade_imprecision TEXT,
      grade_publication_bias TEXT,                            -- undetected | suspected | strongly_suspected
      grade_large_effect TEXT,                                -- none | large | very_large
      grade_dose_response INTEGER NOT NULL DEFAULT 0,
      grade_plausible_confounding TEXT,                       -- none | would_reduce | would_increase
      grade_rationales TEXT,                                  -- JSON {risk_of_bias: "...", ...}
      -- CERQual 维度
      cerqual_methodological_limitations TEXT,                -- no_or_minor | minor | moderate | serious
      cerqual_relevance TEXT,
      cerqual_coherence TEXT,
      cerqual_adequacy_of_data TEXT,
      cerqual_rationales TEXT,                                -- JSON
      -- 共同
      overall_certainty TEXT NOT NULL,                        -- high | moderate | low | very_low
      body_of_evidence_summary TEXT,                          -- 1-2 段叙事(英文)
      implications_for_practice TEXT,
      implications_for_research TEXT,
      generated_by TEXT NOT NULL,                             -- ai | user | ai_edited
      model_used TEXT,
      usage_log_id INTEGER,
      iteration_n INTEGER NOT NULL DEFAULT 1,
      manual_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(project_id, theme_id, iteration_n),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_theme_certainty_project ON theme_certainty(project_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_theme_certainty_theme ON theme_certainty(theme_id)`)

  // 启动时把残留 running 标 aborted_by_restart(对照 synthesis run 模式)
  try {
    db.prepare(
      `UPDATE projects
          SET certainty_run_status = 'aborted_by_restart',
              certainty_run_finished_at = datetime('now', '+8 hours'),
              certainty_run_error = COALESCE(certainty_run_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE certainty_run_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale certainty_run failed:', e.message) }

  // ============================================================
  // M31: Step 7 outcome 级 ai-suggest 异步化 + 心跳(per-theme lock)
  // ============================================================
  //
  // outcome 级 ai-suggest 之前是同步 await runLlm(几分钟阻塞)→ 浏览器干等无反馈。
  // 加 5 列到 themes 表(per-theme 锁,主题间独立),完全镜像主题级 rollup 异步 pattern。
  for (const col of [
    'outcome_run_started_at',
    'outcome_run_finished_at',
    'outcome_run_status',                     // running | success | failed | aborted_by_restart
    'outcome_run_error',
    'outcome_run_meta',                       // JSON: { heartbeat_at, outcomes_count, model, duration_ms, usage_log_id }
  ]) {
    if (!columnExists(db, 'themes', col)) {
      db.exec(`ALTER TABLE themes ADD COLUMN ${col} TEXT`)
    }
  }
  // boot cleanup outcome runs(同 certainty pattern)
  try {
    db.prepare(
      `UPDATE themes
          SET outcome_run_status = 'aborted_by_restart',
              outcome_run_finished_at = datetime('now', '+8 hours'),
              outcome_run_error = COALESCE(outcome_run_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE outcome_run_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale outcome_run failed:', e.message) }

  // ============================================================
  // M32-a: Step 8 撰写异步化(对照 Step 7 M30+M31 镜像)+ 动态章节 + Step 2 final query 锁定
  // ============================================================
  //   1. search_strategies 加 is_locked / locked_at → Step 2 用户标记"最终检索词"
  //      → Step 8 PRISMA Flow Identification 框从锁定 query 的 result_count 算 per-database 命中数
  //   2. projects 加 drafting_run_* 主进度(全章节统一 lock + heartbeat)+ drafting overlay 列
  //      + custom_sections_json(动态章节列表;若无 fallback target_journal_templates.sections,再 fallback 9 章节)
  //   3. draft_sections 加 section_run_* 5 列(per-section lock + heartbeat;并行写不同章节)
  if (!columnExists(db, 'search_strategies', 'is_locked')) {
    db.exec(`ALTER TABLE search_strategies ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnExists(db, 'search_strategies', 'locked_at')) {
    db.exec(`ALTER TABLE search_strategies ADD COLUMN locked_at TEXT`)
  }
  for (const col of [
    'drafting_run_started_at',
    'drafting_run_finished_at',
    'drafting_run_status',
    'drafting_run_error',
    'drafting_run_meta',
    'drafting_master_prompt_overlay',
    'drafting_master_prompt_at_version',
    'drafting_master_prompt_optimize_started_at',
    'custom_sections_json',
  ]) {
    if (!columnExists(db, 'projects', col)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`)
    }
  }
  for (const col of [
    'section_run_started_at',
    'section_run_finished_at',
    'section_run_status',
    'section_run_error',
    'section_run_meta',
  ]) {
    if (!columnExists(db, 'draft_sections', col)) {
      db.exec(`ALTER TABLE draft_sections ADD COLUMN ${col} TEXT`)
    }
  }

  // ---------- 2026-05-31 磁盘优化:PDF 源文件 offload ----------
  // chunk 成功后删 PDF 源文件腾空间,paper_chunks 保留。pdf_offloaded_at
  // 非空 = 源文件已删(SGT 时间戳);storage_path 保留作审计。
  if (!columnExists(db, 'attachments', 'pdf_offloaded_at')) {
    db.exec(`ALTER TABLE attachments ADD COLUMN pdf_offloaded_at TEXT`)
  }
  // boot cleanup drafting + per-section runs
  try {
    db.prepare(
      `UPDATE projects
          SET drafting_run_status = 'aborted_by_restart',
              drafting_run_finished_at = datetime('now', '+8 hours'),
              drafting_run_error = COALESCE(drafting_run_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE drafting_run_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale drafting_run failed:', e.message) }
  try {
    db.prepare(
      `UPDATE draft_sections
          SET section_run_status = 'aborted_by_restart',
              section_run_finished_at = datetime('now', '+8 hours'),
              section_run_error = COALESCE(section_run_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE section_run_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale section_run failed:', e.message) }

  // ---------- M32-c: figure_assets table for user-uploaded figures ----------
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        figure_key TEXT NOT NULL,
        original_filename TEXT,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        alt_text TEXT,
        caption TEXT,
        intended_section TEXT,
        uploaded_by_user_id TEXT,
        uploaded_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_figure_assets_project ON figure_assets(project_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_figure_assets_key ON figure_assets(project_id, figure_key)`)
  } catch (e) { console.warn('[M32-c] figure_assets table:', e?.message) }

  // ============================================================
  // M32-d: PRISMA checklist AI validation columns(Phase 8.D)
  // ============================================================
  //   Step 8.D 给 PRISMA 27 项清单加"AI 一键验证覆盖度"功能。
  //   Opus 4.8 通读已生成的所有 draft_sections,对照 27 项 PRISMA 2020 item,
  //   对每项打 covered / partial / missing 标签 + 提供 evidence_quote + recommendation。
  //
  //   prisma_checklist 加 3 列(per-item AI 结论 + 证据):
  //     ai_validated_at         — ISO 时间戳;NULL = 还没被 AI 验证过
  //     ai_validation_status    — covered | partial | missing
  //     ai_validation_evidence  — JSON {quote, section, recommendation}
  try {
    const cols = db.prepare(`PRAGMA table_info(prisma_checklist)`).all().map(r => r.name)
    if (!cols.includes('ai_validated_at')) db.exec(`ALTER TABLE prisma_checklist ADD COLUMN ai_validated_at TEXT`)
    if (!cols.includes('ai_validation_status')) db.exec(`ALTER TABLE prisma_checklist ADD COLUMN ai_validation_status TEXT`)   // covered | partial | missing
    if (!cols.includes('ai_validation_evidence')) db.exec(`ALTER TABLE prisma_checklist ADD COLUMN ai_validation_evidence TEXT`)  // JSON {quote, section, recommendation}
  } catch (e) { console.warn('[M32-d] prisma_checklist cols:', e?.message) }

  // run-status columns on projects(镜像 drafting/certainty M30/M32-a 模式)
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('prisma_validate_started_at')) db.exec(`ALTER TABLE projects ADD COLUMN prisma_validate_started_at TEXT`)
    if (!pcols.includes('prisma_validate_finished_at')) db.exec(`ALTER TABLE projects ADD COLUMN prisma_validate_finished_at TEXT`)
    if (!pcols.includes('prisma_validate_status')) db.exec(`ALTER TABLE projects ADD COLUMN prisma_validate_status TEXT`)
    if (!pcols.includes('prisma_validate_error')) db.exec(`ALTER TABLE projects ADD COLUMN prisma_validate_error TEXT`)
  } catch (e) { console.warn('[M32-d projects cols]:', e?.message) }

  // boot cleanup stale prisma_validate runs(镜像 drafting / certainty 模式)
  try {
    db.prepare(
      `UPDATE projects
          SET prisma_validate_status = 'aborted_by_restart',
              prisma_validate_finished_at = datetime('now', '+8 hours'),
              prisma_validate_error = COALESCE(prisma_validate_error, '') || ' [service restarted at ' || datetime('now', '+8 hours') || ']'
        WHERE prisma_validate_status = 'running'`
    ).run()
  } catch (e) { console.error('[init] reset stale prisma_validate failed:', e.message) }

  // ============================================================
  // M32-e: LaTeX template upload + LLM-filled tex + pdflatex render (Phase 8.E)
  // ============================================================
  //
  //   projects 加 9 列:
  //     latex_template_zip_path        — 用户上传的 .zip 原始路径
  //     latex_template_extracted_at    — 解压时间戳
  //     latex_template_extract_dir     — 解压目录(extracted/)
  //     latex_main_tex_filename        — 用户指定的 main.tex 相对路径
  //     authors_json                   — JSON [{ first, last, email, orcid, affiliation_id }]
  //     affiliations_json              — JSON [{ id, name, department, address }]
  //     correspondence_email           — 通讯作者 email
  //     funding_text                   — 致谢/资助声明
  //     acknowledgements_text          — 致谢
  //
  //   latex_renders 表:每次"渲染 PDF"一行记录(running / success / failed)
  //     + boot cleanup:任何 running 标 aborted_by_restart
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('latex_template_zip_path')) db.exec(`ALTER TABLE projects ADD COLUMN latex_template_zip_path TEXT`)
    if (!pcols.includes('latex_template_extracted_at')) db.exec(`ALTER TABLE projects ADD COLUMN latex_template_extracted_at TEXT`)
    if (!pcols.includes('latex_template_extract_dir')) db.exec(`ALTER TABLE projects ADD COLUMN latex_template_extract_dir TEXT`)
    if (!pcols.includes('latex_main_tex_filename')) db.exec(`ALTER TABLE projects ADD COLUMN latex_main_tex_filename TEXT`)
    if (!pcols.includes('authors_json')) db.exec(`ALTER TABLE projects ADD COLUMN authors_json TEXT`)
    if (!pcols.includes('affiliations_json')) db.exec(`ALTER TABLE projects ADD COLUMN affiliations_json TEXT`)
    if (!pcols.includes('correspondence_email')) db.exec(`ALTER TABLE projects ADD COLUMN correspondence_email TEXT`)
    if (!pcols.includes('funding_text')) db.exec(`ALTER TABLE projects ADD COLUMN funding_text TEXT`)
    if (!pcols.includes('acknowledgements_text')) db.exec(`ALTER TABLE projects ADD COLUMN acknowledgements_text TEXT`)
  } catch (e) { console.warn('[M32-e projects]:', e?.message) }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS latex_renders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        finished_at TEXT,
        status TEXT NOT NULL,         -- running | success | failed | aborted_by_restart
        pdf_path TEXT,
        log_path TEXT,
        tex_path TEXT,
        error TEXT,
        llm_usage_log_id INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_latex_renders_project ON latex_renders(project_id, started_at DESC)`)
  } catch (e) { console.warn('[M32-e latex_renders]:', e?.message) }

  // boot cleanup: mark any running render as aborted_by_restart
  try {
    db.prepare(`UPDATE latex_renders SET status='aborted_by_restart', finished_at=datetime('now', '+8 hours'), error='server restarted' WHERE status='running'`).run()
  } catch {}

  // ============================================================
  // M32-f: drafting plan (manuscript-level outline) + per-section peer summary
  // ============================================================
  //
  //   Plan-then-write upgrade for Step 8.
  //   projects:
  //     drafting_plan_json                     — full manuscript-level plan (JSON)
  //     drafting_plan_generated_at             — when the plan was produced
  //     drafting_plan_at_protocol_version      — protocol.version it was based on (stale gate)
  //     drafting_plan_started_at               — atomic-lock timestamp (10 min lease)
  //     drafting_plan_status                   — running | success | failed | aborted_by_restart
  //     drafting_plan_error                    — last error string (short)
  //
  //   draft_sections:
  //     peer_summary                           — 150-word abstract written by light model
  //                                              after each section completes;
  //                                              read by sibling sections for cohesion.
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('drafting_plan_json')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_json TEXT`)
    if (!pcols.includes('drafting_plan_generated_at')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_generated_at TEXT`)
    if (!pcols.includes('drafting_plan_at_protocol_version')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_at_protocol_version INTEGER`)
    if (!pcols.includes('drafting_plan_started_at')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_started_at TEXT`)
    if (!pcols.includes('drafting_plan_status')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_status TEXT`)
    if (!pcols.includes('drafting_plan_error')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_plan_error TEXT`)
  } catch (e) { console.warn('[M32-f projects]:', e?.message) }
  try {
    const dscols = db.prepare(`PRAGMA table_info(draft_sections)`).all().map(r => r.name)
    if (!dscols.includes('peer_summary')) db.exec(`ALTER TABLE draft_sections ADD COLUMN peer_summary TEXT`)
  } catch (e) { console.warn('[M32-f draft_sections]:', e?.message) }
  // boot cleanup: any 'running' plan from before restart → aborted
  try { db.prepare(`UPDATE projects SET drafting_plan_status='aborted_by_restart' WHERE drafting_plan_status='running'`).run() } catch {}

  // ---------- M32-g: journal-template PDF extract — async + status fields ----------
  // 原来 POST /:id/journal-template/upload 同步 await runLlm,大 PDF + Opus 4.8 常 30-90s,
  // 超过 nginx 60s 就显示"卡住"。改成 setImmediate 后台跑 + status.json 轮询。
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('journal_template_extract_started_at')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_started_at TEXT`)
    if (!pcols.includes('journal_template_extract_finished_at')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_finished_at TEXT`)
    if (!pcols.includes('journal_template_extract_status')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_status TEXT`)
    if (!pcols.includes('journal_template_extract_error')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_error TEXT`)
    if (!pcols.includes('journal_template_extract_pending_pdf_path')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_pending_pdf_path TEXT`)
    if (!pcols.includes('journal_template_extract_pending_filename')) db.exec(`ALTER TABLE projects ADD COLUMN journal_template_extract_pending_filename TEXT`)
  } catch (e) { console.warn('[M32-g projects]:', e?.message) }
  // boot cleanup
  try {
    db.prepare(`UPDATE projects SET journal_template_extract_status='aborted_by_restart',
                                    journal_template_extract_finished_at=datetime('now', '+8 hours'),
                                    journal_template_extract_error='server restarted during extraction'
                  WHERE journal_template_extract_status='running'`).run()
  } catch {}

  // ---------- M32-h: Session-continuity for one-shot drafting orchestrator ----------
  // 让 generate-all 在 Claude CLI 路径下把所有章节串进一个 session,
  // 每章 LLM 真的看到上一章原文(而不是 150w peer_summary 摘要)— 给"投高质量期刊
  // 语言一致性必须无瑕疵"用户使用。
  //   drafting_session_id                 — 当次跑用的 UUID(crypto.randomUUID)
  //   drafting_session_started_at         — 何时新开
  //   drafting_session_at_protocol_version — 协议升级后 session 视为 stale
  //   drafting_session_provider           — 记录是 anthropic-cli / anthropic-api / openai-cli / openai-api 哪条路;
  //                                          只有 anthropic-cli 真的能跨章节续会话
  //   drafting_session_first_section      — 诊断:这个 session 起始写的哪个 section
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('drafting_session_id')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_session_id TEXT`)
    if (!pcols.includes('drafting_session_started_at')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_session_started_at TEXT`)
    if (!pcols.includes('drafting_session_at_protocol_version')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_session_at_protocol_version INTEGER`)
    if (!pcols.includes('drafting_session_provider')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_session_provider TEXT`)
    if (!pcols.includes('drafting_session_first_section')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_session_first_section TEXT`)
  } catch (e) { console.warn('[M32-h projects]:', e?.message) }

  // ---------- M32-i: drafting overlay error tracking ----------
  // 之前 overlay 跑失败 → 只清 lock,不留 error message;用户看到"未生成"无从诊断。
  // 加 _optimize_error 列存最近一次失败的原因 + _optimize_failed_at 时间。
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('drafting_master_prompt_optimize_error')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_master_prompt_optimize_error TEXT`)
    if (!pcols.includes('drafting_master_prompt_optimize_failed_at')) db.exec(`ALTER TABLE projects ADD COLUMN drafting_master_prompt_optimize_failed_at TEXT`)
  } catch (e) { console.warn('[M32-i projects]:', e?.message) }

  // ---------- M32-j: LLM table-recommend (Phase A5) ----------
  //
  // Opus 看完项目全部数据 + 全部派生表 manifest 后,给出"该出现哪几张表 /
  // 哪些位置 / 推荐 caption / 还有哪些 registry 里没有但值得 user 自己加的表"。
  //
  //   projects:
  //     recommended_tables_json                       — Opus 输出 parse 后的标准化 JSON
  //     recommended_tables_at_protocol_version        — 协议 version 快照(stale gate)
  //     recommended_tables_at_system_version          — TABLE_RECOMMEND_SYSTEM_VERSION 快照
  //     recommend_tables_started_at                   — atomic lock 时间戳(10 min lease)
  //     recommend_tables_finished_at                  — 完成时间
  //     recommend_tables_status                       — running | success | failed | aborted_by_restart
  //     recommend_tables_error                        — 短错误描述
  //     recommend_tables_meta                         — JSON(model / usage_log_id / 计数等诊断)
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('recommended_tables_json'))                 db.exec(`ALTER TABLE projects ADD COLUMN recommended_tables_json TEXT`)
    if (!pcols.includes('recommended_tables_at_protocol_version'))  db.exec(`ALTER TABLE projects ADD COLUMN recommended_tables_at_protocol_version INTEGER`)
    if (!pcols.includes('recommended_tables_at_system_version'))    db.exec(`ALTER TABLE projects ADD COLUMN recommended_tables_at_system_version TEXT`)
    if (!pcols.includes('recommend_tables_started_at'))             db.exec(`ALTER TABLE projects ADD COLUMN recommend_tables_started_at TEXT`)
    if (!pcols.includes('recommend_tables_finished_at'))            db.exec(`ALTER TABLE projects ADD COLUMN recommend_tables_finished_at TEXT`)
    if (!pcols.includes('recommend_tables_status'))                 db.exec(`ALTER TABLE projects ADD COLUMN recommend_tables_status TEXT`)
    if (!pcols.includes('recommend_tables_error'))                  db.exec(`ALTER TABLE projects ADD COLUMN recommend_tables_error TEXT`)
    if (!pcols.includes('recommend_tables_meta'))                   db.exec(`ALTER TABLE projects ADD COLUMN recommend_tables_meta TEXT`)
  } catch (e) { console.warn('[M32-j projects]:', e?.message) }
  // boot cleanup: 服务重启时把"还在跑"的标 aborted,清 lock 以便用户重试
  try {
    db.prepare(`UPDATE projects SET recommend_tables_status='aborted_by_restart',
                                    recommend_tables_finished_at=datetime('now', '+8 hours'),
                                    recommend_tables_started_at=NULL
                  WHERE recommend_tables_status='running'`).run()
  } catch {}

  // ---------- M32-k: Per-table LLM polish cache (T3) ----------
  //
  // T3 让 Opus 把派生表当"原料",精修出 publication-ready 的 caption +
  // column headers + paragraph_lead + footnotes(可选行序),反编造校验
  // 通过 parseTablePolishOutput 5 条硬规则把守。**精修是 per-table** —
  // 每张表独立精修 + 独立 cache,不是 per-project 全套。
  //
  //   projects:
  //     polished_tables_json        — JSON: { [tableKey]: { polished_caption,
  //                                     polished_column_headers, polished_paragraph_lead,
  //                                     polished_footnotes, row_reorder_keys, model,
  //                                     generated_at, system_version, at_protocol_version,
  //                                     usage_log_id?, error? } }
  //     polish_tables_in_flight     — JSON: { [tableKey]: { started_at, model } }
  //                                   atomic lock(per-table,10 min lease)
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('polished_tables_json'))    db.exec(`ALTER TABLE projects ADD COLUMN polished_tables_json TEXT`)
    if (!pcols.includes('polish_tables_in_flight')) db.exec(`ALTER TABLE projects ADD COLUMN polish_tables_in_flight TEXT`)
  } catch (e) { console.warn('[M32-k projects]:', e?.message) }
  // boot cleanup: 服务重启时把还在跑的 per-table lock 清掉(JSON 字段无法用 SQL UPDATE
  // 直接清单个 key,这里粗暴整字段 NULL — 重启场景下用户不丢已完成的 polish(那写在
  // polished_tables_json 里,与 in_flight 字段完全分离)。
  try {
    db.prepare(`UPDATE projects SET polish_tables_in_flight = NULL
                  WHERE polish_tables_in_flight IS NOT NULL`).run()
  } catch {}

  // ---------- M32-l: Batch polish orchestrator (N2) ----------
  //
  // 让用户一键跑完所有 ★ 推荐表(13 张)的精修,不用逐个点。orchestrator
  // 单独 4 个字段 + 1 个 JSON meta,镜像 drafting_run_* / recommend_tables_*
  // 模式;per-table lock 仍然走 polish_tables_in_flight(老字段),由
  // orchestrator 顺序申请 / 释放。
  //
  //   projects:
  //     polish_batch_started_at   — orchestrator 开始时间(同时充当锁)
  //     polish_batch_finished_at  — 完成 / 失败 / 终止时间
  //     polish_batch_status       — running | success | partial | failed | aborted_by_restart
  //     polish_batch_meta         — JSON: { total, completed: [keys], failed: [{key, error}], current_key }
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('polish_batch_started_at'))  db.exec(`ALTER TABLE projects ADD COLUMN polish_batch_started_at TEXT`)
    if (!pcols.includes('polish_batch_finished_at')) db.exec(`ALTER TABLE projects ADD COLUMN polish_batch_finished_at TEXT`)
    if (!pcols.includes('polish_batch_status'))      db.exec(`ALTER TABLE projects ADD COLUMN polish_batch_status TEXT`)
    if (!pcols.includes('polish_batch_meta'))        db.exec(`ALTER TABLE projects ADD COLUMN polish_batch_meta TEXT`)
  } catch (e) { console.warn('[M32-l projects]:', e?.message) }
  // boot cleanup:进程重启时把 running 的 batch 标 aborted,释放锁
  try {
    db.prepare(`UPDATE projects SET polish_batch_status='aborted_by_restart',
                                    polish_batch_finished_at=datetime('now', '+8 hours'),
                                    polish_batch_started_at=NULL
                  WHERE polish_batch_status='running'`).run()
  } catch {}

  // ---------- M32-m: Figure prompts optimize 异步化(用户发现:同步阻塞) ----------
  //   projects.figure_prompts_ai_optimized / figure_prompts_optimized_at 已存(M27)。
  //   补 atomic lock + status 列,让 POST /report/optimize-figure-prompts 跟其他 8 个
  //   按钮一致用 setImmediate async + 5s 轮询模式。
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('figure_prompts_optimize_started_at'))
      db.exec(`ALTER TABLE projects ADD COLUMN figure_prompts_optimize_started_at TEXT`)
    if (!pcols.includes('figure_prompts_optimize_status'))
      db.exec(`ALTER TABLE projects ADD COLUMN figure_prompts_optimize_status TEXT`)
    if (!pcols.includes('figure_prompts_optimize_error'))
      db.exec(`ALTER TABLE projects ADD COLUMN figure_prompts_optimize_error TEXT`)
  } catch (e) { console.warn('[M32-m projects]:', e?.message) }
  // boot cleanup:running → aborted_by_restart(释放锁)
  try {
    db.prepare(`UPDATE projects SET figure_prompts_optimize_status='aborted_by_restart',
                                    figure_prompts_optimize_started_at=NULL
                  WHERE figure_prompts_optimize_status='running'`).run()
  } catch {}

  // ---------- M33: drafting quality lint(P0-6 citation hallucination + P2-13 unknown placeholders)----
  //   draft_sections 加两列:
  //     hallucinated_recs_json — LLM 引了不在 include 集合的 rec_id(JSON array)
  //     lint_warnings_json     — postProcessFigTblPlaceholders 发现的 unknown
  //                              [tbl:] / [fig:] key(JSON {tables:[], figures:[]})
  //   写入时机:runSectionInOrchestrator LLM 返回后调用 validateCitationsAgainstInclude
  //   view 读取:report.ejs banner / preview.ejs chip / export.md 顶部 HTML 注释
  try {
    const dscols = db.prepare(`PRAGMA table_info(draft_sections)`).all().map(r => r.name)
    if (!dscols.includes('hallucinated_recs_json'))
      db.exec(`ALTER TABLE draft_sections ADD COLUMN hallucinated_recs_json TEXT`)
    if (!dscols.includes('lint_warnings_json'))
      db.exec(`ALTER TABLE draft_sections ADD COLUMN lint_warnings_json TEXT`)
  } catch (e) { console.warn('[M33 draft_sections quality lint]:', e?.message) }

  // ---------- M34: figure_assets.title — 复用 LLM 推荐的 figure title ----------
  //   用户反馈:"图片的 title 你在生成图片提示词的时候就应该有了,不需要用户改/加"
  //   LLM 生成 figure prompt 时已经给出 title(figures.js parseFigurePromptsOutput.title),
  //   但 saveFigureAsset / figure_assets 表只有 caption + alt_text,丢了 title。
  //   现在加 title 列,上传时:
  //     - 用户传 title  → 用用户的
  //     - 用户不传 title 且 figure_key 匹配某 LLM prompt → 自动用 prompt.title
  //     - 用户不传 + 也无匹配 prompt → 仍 null(UI 显示 original_filename)
  try {
    const facols = db.prepare(`PRAGMA table_info(figure_assets)`).all().map(r => r.name)
    if (!facols.includes('title'))
      db.exec(`ALTER TABLE figure_assets ADD COLUMN title TEXT`)
  } catch (e) { console.warn('[M34 figure_assets.title]:', e?.message) }

  // ---------- M37: LaTeX overlay(模板专用 prompt)— 对应 drafting overlay 模式 ----------
  //   用户反馈:LaTeX 渲染步骤应该先基于模板 + 通用 prompt 生成"项目专用 LaTeX 填充
  //   指引",然后填的时候 顺便修常见格式问题(MD bold/italic 转 LaTeX / 表格 booktabs /
  //   caption 位置 / 引号风格等)。
  //   新列:
  //     latex_overlay_json                — Sonnet 抽出来的 JSON overlay
  //     latex_overlay_extracted_at        — 抽取时间
  //     latex_overlay_at_template_hash    — 抽取时对应模板的 hash,stale 检测用
  //     latex_overlay_at_system_version   — Sonnet system prompt version,bump 时重抽
  //     latex_overlay_extract_status      — running / success / failed
  //     latex_overlay_extract_started_at  — 15-min atomic lock
  //     latex_overlay_extract_error
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('latex_overlay_json'))             db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_json TEXT`)
    if (!pcols.includes('latex_overlay_extracted_at'))     db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_extracted_at TEXT`)
    if (!pcols.includes('latex_overlay_at_template_hash')) db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_at_template_hash TEXT`)
    if (!pcols.includes('latex_overlay_at_system_version'))db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_at_system_version TEXT`)
    if (!pcols.includes('latex_overlay_extract_status'))   db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_extract_status TEXT`)
    if (!pcols.includes('latex_overlay_extract_started_at'))db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_extract_started_at TEXT`)
    if (!pcols.includes('latex_overlay_extract_error'))    db.exec(`ALTER TABLE projects ADD COLUMN latex_overlay_extract_error TEXT`)
  } catch (e) { console.warn('[M37 projects latex_overlay_*]:', e?.message) }

  // ---------- M36: projects.methodology_capabilities_json — 学术诚信门 ----------
  //   背景:methods section system prompt 已经禁止 LLM 编造 "two independent
  //   reviewers / Cohen's kappa / PROSPERO 注册 / publication bias 评估"等
  //   学术诚信红线(P0-5)。
  //   但反过来:即使用户真的做了双人筛(Step 5 deep verify pass-2),也无法
  //   告诉 LLM 这一事实 → LLM 永远只能写 "lead reviewer + AI triage"。
  //
  //   M36 加 methodology_capabilities_json 列(JSON 对象):
  //   {
  //     dual_reviewer_screening: bool,    // 双人独立做了 title/abstract 筛选
  //     dual_reviewer_extraction: bool,   // 双人独立抽数据
  //     third_adjudicator: bool,          // 第三审稿人裁决
  //     cohens_kappa_value: number|null,  // 实测 kappa 值
  //     kappa_outcome_label: string,      // kappa 测的是哪个环节(如 "screening")
  //     prospero_id: string,              // CRD42025xxxx
  //     registered_protocol_url: string,  // OSF / PROSPERO URL
  //     publication_bias_assessed: bool,  // 跑了 funnel/Egger 等
  //     publication_bias_method: string,  // 用了什么方法
  //     follows_prisma_p: bool,           // 按 PRISMA-P 写了 protocol
  //     notes: string,                    // 其他自由说明
  //   }
  //   buildSectionUserPrompt 给 methods/abstract/limitations section 注入此块,
  //   LLM 收到后只能 VERBATIM 使用,不能扩展/夸大。
  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('methodology_capabilities_json'))
      db.exec(`ALTER TABLE projects ADD COLUMN methodology_capabilities_json TEXT`)
  } catch (e) { console.warn('[M36 projects.methodology_capabilities_json]:', e?.message) }

  // ---------- M35: records 加 volume / issue / pages — 引文高质量字段 ----------
  //   用户反馈:"参考文献格式预览时检查;导入了 zotero 的尽量用 zotero 带来的
  //              高质量格式化内容"
  //   Zotero RDF 有 bib:volume / bib:pages / bib:issue / prism:volume 等字段,
  //   但 zotero-ingest.js 之前只抽 title/authors/year/journal/doi,丢了 volume/issue/pages。
  //   reference-export 的 5 个 style 函数(APA / IEEE / Chicago / MLA / GB-T 7714)在
  //   完整学术引文里都需要 volume(issue), pages — 缺这 3 个字段每条引文都"半残"。
  //   M35 加列,zotero-ingest 后续补抽,5 style 格式函数升级用上。
  try {
    const rcols = db.prepare(`PRAGMA table_info(records)`).all().map(r => r.name)
    if (!rcols.includes('volume'))
      db.exec(`ALTER TABLE records ADD COLUMN volume TEXT`)
    if (!rcols.includes('issue'))
      db.exec(`ALTER TABLE records ADD COLUMN issue TEXT`)
    if (!rcols.includes('pages'))
      db.exec(`ALTER TABLE records ADD COLUMN pages TEXT`)
  } catch (e) { console.warn('[M35 records volume/issue/pages]:', e?.message) }

  // ============================================================
  // M38 (2026-05-31 Phase 1): 程序化驱动地基 — API token + autonomous + webhook
  // ============================================================
  //
  //   北极星目标:让本地 AI agent 用 token + HTTP/CLI 无人值守跑完整条综述流水线。
  //
  //   api_tokens —— 个人访问令牌(明文只发一次,存 SHA-256 hash;见 services/api-tokens.js)
  //     middleware/auth.js requireApiOrUser 认 `Authorization: Bearer slr_xxx` 或回退 session。
  //
  //   projects.autonomous_mode —— 自治模式开关(0/1)。开启后所有"人工 gate"走 AI 自动放行
  //     + 诚实披露(protocol 自动批准 / 检索式自动锁定 / AI 筛选结论即终审 / 矩阵列用 AI 建议)。
  //     **方法学诚实不破**:autonomous 产出在 methodology_capabilities 里如实标 single-AI-reviewer,
  //     PRISMA validator 照常 cap 相应条目(复用现有 honesty gate)。
  //
  //   projects.webhook_url —— 任务完成回调(P2.2)。batch_jobs finishJob 时若非空 → POST 通知,
  //     agent 可挂 webhook 代替轮询。NULL = 仅轮询。
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)`)

  try {
    const pcols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name)
    if (!pcols.includes('autonomous_mode'))
      db.exec(`ALTER TABLE projects ADD COLUMN autonomous_mode INTEGER NOT NULL DEFAULT 0`)
    if (!pcols.includes('webhook_url'))
      db.exec(`ALTER TABLE projects ADD COLUMN webhook_url TEXT`)
  } catch (e) { console.warn('[M38 projects autonomous_mode/webhook_url]:', e?.message) }

  // ── M39 (2026-06-10 性能审计):高频查询缺索引,全表扫随数据增长线性变慢 ──
  //   draft_sections(project_id, section_name):报告页/编排器按节取最新 version 的主路径
  //   usage_logs(project_id, started_at):配额/用量统计按项目+时间倒序
  //   usage_logs(user_id, started_at):per-user 用量视图
  //   screening_decisions(project_id, stage, human_decision):筛选进度统计 COUNT
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_draft_sections_proj_name ON draft_sections(project_id, section_name)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_proj_started ON usage_logs(project_id, started_at)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_user_started ON usage_logs(user_id, started_at)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_screening_proj_stage_decision ON screening_decisions(project_id, stage, human_decision)`)
  } catch (e) { console.warn('[M39 perf indexes]:', e?.message) }
}
