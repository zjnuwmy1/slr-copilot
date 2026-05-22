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
