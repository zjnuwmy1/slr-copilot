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
}
