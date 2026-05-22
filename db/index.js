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
}
