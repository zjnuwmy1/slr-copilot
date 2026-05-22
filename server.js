import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDb } from './db/index.js'
import { bootstrapAdmin } from './services/bootstrap.js'
import { loadUser, requireUser, requireAdmin } from './middleware/auth.js'

// Phase 1 routers
import authRouter from './routes/auth.js'
import adminUsersRouter from './routes/admin/users.js'
import adminUsageRouter from './routes/admin/usage.js'
import adminAuditRouter from './routes/admin/audit.js'
import adminProjectsRouter from './routes/admin/projects.js'
import adminSettingsRouter from './routes/admin/settings.js'
import adminStorageRouter from './routes/admin/storage.js'
import credentialsRouter from './routes/account/credentials.js'
import oauthRouter from './routes/account/oauth.js'
import llmRouter from './routes/account/llm.js'
import projectsRouter from './routes/projects/index.js'
import projectSearchRouter from './routes/projects/search.js'
import projectPrismaRouter from './routes/projects/prisma.js'
import projectZoteroRouter from './routes/projects/zotero.js'
import projectRecordsRouter from './routes/projects/records.js'
import projectScreeningRouter from './routes/projects/screening.js'
import projectExtractionRouter from './routes/projects/extraction.js'
import projectCertaintyRouter from './routes/projects/certainty.js'
import projectImportCsvRouter from './routes/projects/import-csv.js'
import projectMatrixRouter from './routes/projects/matrix.js'
import projectJournalTemplateRouter from './routes/projects/journal-template.js'

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

// 把 db 暴露给 router(必须在 router 注册之前)
app.locals.db = db

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

// 让所有视图都能访问 req 和 flash
app.use((req, res, next) => {
  res.locals.req = req
  res.locals.flash = req.session?.flash
  if (req.session) delete req.session.flash
  next()
})

// === 公开页 ===
app.get('/', (req, res) => {
  res.render('index', {
    title: 'SLR Copilot',
    phase: 'Phase 1 已上线 · 认证 / 凭证 / 管理员',
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

// === Phase 1 路由挂载 ===
// 顺序很关键:更具体的路径必须先注册,Express 才会先匹配

// Agent A:认证(/login /logout /register)
app.use('/', authRouter)

// Agent B + C:用户账户与凭证(/account/*)
app.use('/account/credentials', requireUser, credentialsRouter)
app.use('/account/oauth', requireUser, oauthRouter)
app.use('/account/llm', requireUser, llmRouter)
// 项目子路由:E 的 router 内部用 /:id/search/* 前缀,挂在 /projects;
// F 的 router 用 mergeParams 模式,挂在 /projects/:id/prisma。先具体后通用。
app.use('/projects/:id/prisma', requireUser, projectPrismaRouter)
app.use('/projects/:id/zotero', requireUser, projectZoteroRouter)
app.use('/projects', requireUser, projectSearchRouter)
app.use('/projects', requireUser, projectRecordsRouter)
app.use('/projects', requireUser, projectScreeningRouter)
app.use('/projects', requireUser, projectExtractionRouter)
app.use('/projects', requireUser, projectCertaintyRouter)
app.use('/projects/:id/import/csv', requireUser, projectImportCsvRouter)
app.use('/projects', requireUser, projectMatrixRouter)
app.use('/projects', requireUser, projectJournalTemplateRouter)
app.use('/projects', requireUser, projectsRouter)  // 主路由(含 synthesis + report 自挂)放最后

// /account 仪表盘:登录用户的快速总览
app.get('/account', requireUser, (req, res) => {
  const credCounts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
    FROM user_credentials
    WHERE user_id = ?
  `).get(req.user.id)
  res.render('account/index', {
    title: '我的账户',
    credCounts: credCounts || { total: 0, active: 0 },
  })
})

// 管理员后台(/admin/*)— 更具体的子路径先挂,Express 按注册顺序匹配
app.use('/admin/usage', requireAdmin, adminUsageRouter)
app.use('/admin/audit', requireAdmin, adminAuditRouter)
app.use('/admin/projects', requireAdmin, adminProjectsRouter)
app.use('/admin/settings', requireAdmin, adminSettingsRouter)
app.use('/admin/storage', requireAdmin, adminStorageRouter)
app.use('/admin', requireAdmin, adminUsersRouter)

// 404 fallback
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
