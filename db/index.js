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

  return db
}
