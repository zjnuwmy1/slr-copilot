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
      locked_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
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
              finished_at = datetime('now'),
              error_message = COALESCE(error_message, '') || ' [service restarted at ' || datetime('now') || ']'
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_storage_reservations_user ON storage_reservations(user_id, expires_at)`)
  // 启动时清理已过期的 reservation(上次进程崩了/上传卡死)
  try {
    db.exec(`DELETE FROM storage_reservations WHERE expires_at <= datetime('now')`)
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
                finished_at = datetime('now'),
                can_retry = 1,
                last_error = COALESCE(last_error, '') || ' [service restarted at ' || datetime('now') || ']'
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
}
