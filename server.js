import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDb } from './db/index.js'
import { bootstrapAdmin } from './services/bootstrap.js'
import { loadUser, requireUser, requireAdmin } from './middleware/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 3001
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'

const db = initDb()
await bootstrapAdmin(db)

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
app.use(loadUser(db))

// 让所有视图都能访问 req
app.use((req, res, next) => {
  res.locals.req = req
  res.locals.flash = req.session?.flash
  if (req.session) delete req.session.flash
  next()
})

// 公开页
app.get('/', (req, res) => {
  res.render('index', {
    title: 'SLR Copilot',
    phase: 'Phase 0 + Phase 1 地基已就绪',
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

// === 占位路由,Agent A/B/C 完成后会替换为真实 router ===
// Agent A:routes/auth.js + routes/admin/users.js
// Agent B:routes/account/credentials.js
// Agent C:routes/account/oauth.js
// 汇总层:routes/admin/usage.js + routes/admin/audit.js
//
// 暂时给一个统一的"开发中"占位
app.get(['/login', '/logout', '/register', '/account', '/account/*', '/admin', '/admin/*'], (req, res) => {
  res.status(501).render('error', {
    title: 'Not Yet Implemented',
    message: `${req.path} 还没接入(等 Agent A/B/C 完成后会激活)`,
  })
})

// 把 db 暴露给后续 router(挂在 app.locals 上)
app.locals.db = db

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

export { app, db, requireUser, requireAdmin }
