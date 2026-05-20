import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDb } from './db/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 3001
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'

const db = initDb()

const app = express()

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.set('trust proxy', 1)

app.use(express.urlencoded({ extended: true, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use(
  cookieSession({
    name: 'slr_sess',
    secret: SESSION_SECRET,
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
)

app.get('/', (req, res) => {
  res.render('index', {
    title: 'SLR Copilot',
    phase: 'Phase 0 — 基础设施已就绪,等待 Phase 1 接入',
    dbPath: process.env.DB_PATH || '(default: ./.data/slr.db)',
    nodeEnv: process.env.NODE_ENV || 'development',
  })
})

app.get('/healthz', (req, res) => {
  try {
    const row = db.prepare('SELECT 1 AS ok').get()
    res.json({ ok: true, db: row?.ok === 1, ts: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: '页面不存在' })
})

app.use((err, req, res, _next) => {
  console.error('[unhandled]', err)
  res.status(500).render('error', { title: 'Server Error', message: '服务器内部错误' })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[slr-copilot] listening on 127.0.0.1:${PORT}`)
})
