import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { initDb } from './db/index.js'
import { bootstrapAdmin } from './services/bootstrap.js'
import { seedDefaultPresets } from './services/step-presets.js'
import { loadUser, requireUser, requireAdmin, requireSuperAdmin, requireApiOrUser } from './middleware/auth.js'
import { getEffectivePresetIdForUser, getPreset } from './services/step-presets.js'
import { getUserQuotaSummary as getStorageQuotaSummary, formatBytes as fmtStorageBytes } from './services/storage-quota.js'
import { randomId } from './services/crypto.js'
import { audit } from './services/audit.js'

// B2.3:本次启动的 boot UUID。systemd 重启后 process.pid 可能复用,boot_id 不会。
//        在 initDb 之前注入到 env,M20 reset 会按这个 id 判定"上次留下的 running 是孤儿"。
//        batch-jobs.startJob 也读这个 env,新建 row 时写进 boot_id 列。
process.env.SLR_BOOT_ID = process.env.SLR_BOOT_ID || randomId('boot')
export const BOOT_ID = process.env.SLR_BOOT_ID

// Phase 1 routers
import authRouter from './routes/auth.js'
import passwordResetRouter from './routes/auth/password-reset.js'
import adminUsersRouter from './routes/admin/users.js'
import adminUsageRouter from './routes/admin/usage.js'
import adminAuditRouter from './routes/admin/audit.js'
import adminProjectsRouter from './routes/admin/projects.js'
import adminSettingsRouter from './routes/admin/settings.js'
import adminStorageRouter from './routes/admin/storage.js'
import adminPlatformCredsRouter from './routes/admin/platform-credentials.js'
import adminStepPresetsRouter from './routes/admin/step-presets.js'
import accountPreferencesRouter from './routes/account/preferences.js'
import accountApiTokensRouter from './routes/account/api-tokens.js'
import credentialsRouter from './routes/account/credentials.js'
import oauthRouter from './routes/account/oauth.js'
import llmRouter from './routes/account/llm.js'
import projectsRouter from './routes/projects/index.js'
import apiRouter from './routes/api/index.js'
import projectSearchRouter from './routes/projects/search.js'
import projectPrismaRouter from './routes/projects/prisma.js'
import projectZoteroRouter from './routes/projects/zotero.js'
import projectRecordsRouter from './routes/projects/records.js'
import projectScreeningRouter from './routes/projects/screening.js'
import projectExtractionRouter from './routes/projects/extraction.js'
import projectCertaintyRouter from './routes/projects/certainty.js'
import projectImportCsvRouter from './routes/projects/import-csv.js'
import projectMatrixRouter from './routes/projects/matrix.js'
import projectRobRouter from './routes/projects/rob.js'
import projectJournalTemplateRouter from './routes/projects/journal-template.js'
import projectIterateRouter from './routes/projects/iterate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 3001
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'

// 生产环境硬性校验:SESSION_SECRET 不能用默认 dev 值 — 否则 cookie-session 可被任意伪造,
// 攻击者构造任意 user_id 拿任意账户。NODE_ENV=production 时直接退出。
if (process.env.NODE_ENV === 'production' &&
    (SESSION_SECRET === 'dev-insecure-secret-change-me' || SESSION_SECRET.length < 32)) {
  console.error(
    '[FATAL] SESSION_SECRET 未设置或太短(<32 字符)— 生产环境拒绝启动。\n' +
    '        生成方法:openssl rand -hex 32  → 写入 /etc/slr.env 的 SESSION_SECRET='
  )
  process.exit(1)
}

const db = initDb()
await bootstrapAdmin(db)
seedDefaultPresets(db)

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
// P0.4 (2026-05-31):每个请求分配 request-id,贯穿日志 / 错误页 / JSON 响应 /
//   audit,便于把"用户/agent 看到的报错"与服务器日志对上号。优先用上游(nginx)
//   传的 X-Request-Id,否则自生成。回写响应头让客户端/agent 能拿到。
app.use((req, res, next) => {
  const incoming = req.get('X-Request-Id')
  req.id = (incoming && /^[\w.-]{1,64}$/.test(incoming)) ? incoming : randomId('req')
  res.setHeader('X-Request-Id', req.id)
  next()
})

app.use(loadUser(db))

// 让所有视图都能访问 req 和 flash
app.use((req, res, next) => {
  res.locals.req = req
  res.locals.requestId = req.id || null
  res.locals.flash = req.session?.flash
  if (req.session) delete req.session.flash
  next()
})

// === 公开页 ===
app.get('/', (req, res) => {
  let projectCount = 0
  if (req.user) {
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(req.user.id)
      projectCount = row?.n || 0
    } catch { /* table not ready */ }
  }
  res.render('index', {
    title: 'SLR Copilot',
    projectCount,
  })
})

// /healthz:扩展为 db / disk / cli 三项检查(B4.7)
// 任一 check.ok=false → 整体 ok=false,但 HTTP 仍返回 200(给上游 LB 200 即活,
// 详细健康状态通过 JSON 体暴露给监控)。
// 只有 DB 直接抛异常(connection 都建不起来)才 500。
const DISK_LOW_THRESHOLD = 0.2  // 剩余 < 20% 视为 warn
const CLAUDE_BIN_PATH = process.env.CLAUDE_BIN || '/usr/local/bin/claude'

function checkDisk() {
  try {
    // statvfs 在 macOS 没有 Node 包装;直接 spawn df -P 拿百分比(POSIX 标准格式)
    // -P:posix mode,保证一行输出;-k:KB 单位
    const out = execSync('df -P -k /var/lib/slr 2>/dev/null || df -P -k /', {
      encoding: 'utf8',
      timeout: 2000,
    })
    const lines = out.trim().split('\n')
    if (lines.length < 2) return { ok: true, note: 'df parse failed', skipped: true }
    // Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
    const parts = lines[1].split(/\s+/)
    const total = Number(parts[1])
    const avail = Number(parts[3])
    if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) {
      return { ok: true, note: 'df numeric parse failed', skipped: true }
    }
    const freeRatio = avail / total
    const ok = freeRatio >= DISK_LOW_THRESHOLD
    return {
      ok,
      free_ratio: Number(freeRatio.toFixed(3)),
      avail_kb: avail,
      total_kb: total,
      threshold: DISK_LOW_THRESHOLD,
    }
  } catch (e) {
    return { ok: true, note: 'df failed: ' + e.message, skipped: true }
  }
}

function checkClaudeCli() {
  try {
    const exists = fs.existsSync(CLAUDE_BIN_PATH)
    return { ok: exists, path: CLAUDE_BIN_PATH }
  } catch (e) {
    return { ok: false, error: e.message, path: CLAUDE_BIN_PATH }
  }
}

app.get('/healthz', (req, res) => {
  const checks = {}

  // DB:必须能连
  try {
    const row = db.prepare('SELECT 1 AS ok').get()
    checks.db = { ok: row?.ok === 1 }
  } catch (e) {
    // DB 死了就直接 500,LB 应该把节点摘掉
    return res.status(500).json({ ok: false, error: e.message, ts: new Date().toISOString() })
  }

  checks.disk = checkDisk()
  checks.cli = checkClaudeCli()

  // FD 数:macOS 没 /proc/self/fd,Linux 上才能查;跳过(plan 明确说不做)
  // const fdCount = fs.readdirSync('/proc/self/fd').length  // Linux only

  const overallOk = Object.values(checks).every((c) => c.ok)
  res.json({ ok: overallOk, checks, ts: new Date().toISOString() })
})

// === Phase 1 路由挂载 ===
// 顺序很关键:更具体的路径必须先注册,Express 才会先匹配

// Agent A:认证(/login /logout /register)
app.use('/', authRouter)
// B4.5:密码重设(匿名页面,挂在 requireUser 之前)
app.use('/', passwordResetRouter)

// Agent B + C:用户账户与凭证(/account/*)
app.use('/account/credentials', requireUser, credentialsRouter)
app.use('/account/oauth', requireUser, oauthRouter)
app.use('/account/llm', requireUser, llmRouter)
// P1.1:个人 API token 管理(给本地 agent / CLI 程序化驱动用)
app.use('/account/api-tokens', requireUser, accountApiTokensRouter)
// 项目子路由:E 的 router 内部用 /:id/search/* 前缀,挂在 /projects;
// F 的 router 用 mergeParams 模式,挂在 /projects/:id/prisma。先具体后通用。
// P1.4:全部用 requireApiOrUser(db) —— Bearer token(agent / 编排器自调用)或回退
//   cookie-session(浏览器,行为与旧 requireUser 完全一致:未登录 → /login)。
//   这让本地 agent 能用 token 直接驱动任何项目步骤端点,编排器也靠它进程内自调用复用逻辑。
const projGuard = requireApiOrUser(db)
app.use('/projects/:id/prisma', projGuard, projectPrismaRouter)
app.use('/projects/:id/zotero', projGuard, projectZoteroRouter)
app.use('/projects', projGuard, projectSearchRouter)
app.use('/projects', projGuard, projectRecordsRouter)
app.use('/projects', projGuard, projectScreeningRouter)
app.use('/projects', projGuard, projectExtractionRouter)
app.use('/projects', projGuard, projectCertaintyRouter)
app.use('/projects/:id/import/csv', projGuard, projectImportCsvRouter)
app.use('/projects', projGuard, projectMatrixRouter)
app.use('/projects', projGuard, projectRobRouter)
app.use('/projects', projGuard, projectJournalTemplateRouter)
app.use('/projects', projGuard, projectIterateRouter)
app.use('/projects', projGuard, projectsRouter)  // 主路由(含 synthesis + report 自挂)放最后

// P1.3:程序化 JSON API(本地 agent / CLI)。requireApiOrUser = Bearer token 或 session。
//   挂在 /api,与网页 /projects 完全分离;统一 JSON 信封。
app.use('/api', requireApiOrUser(db), apiRouter)

// /account 仪表盘:登录用户的快速总览
app.get('/account', requireUser, (req, res) => {
  const credCounts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
    FROM user_credentials
    WHERE user_id = ?
  `).get(req.user.id)

  // 当前 plan(effective preset)
  let plan = null
  try {
    const presetId = getEffectivePresetIdForUser(db, req.user.id)
    const preset = getPreset(db, presetId)
    plan = {
      id: presetId,
      label: preset?.label || presetId,
      description: preset?.description || '',
      isUserChosen: !!req.user.step_model_preset,
    }
  } catch { /* preset 表缺失 */ }

  // 本月 LLM 用量(总数 + 按 status 拆分)
  let usageThisMonth = { total: 0, success: 0, error: 0, timeout: 0, rate_limited: 0, quota_exceeded: 0 }
  try {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM usage_logs
      WHERE user_id = ? AND started_at >= datetime('now','start of month')
    `).get(req.user.id).c
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS c FROM usage_logs
      WHERE user_id = ? AND started_at >= datetime('now','start of month')
      GROUP BY status
    `).all(req.user.id)
    usageThisMonth.total = total
    for (const r of byStatus) {
      if (r.status in usageThisMonth) usageThisMonth[r.status] = r.c
    }
  } catch { /* usage_logs 缺失 */ }

  // 存储配额(zotero 上传 + PDF 附件占用 vs. 配额)
  // B1.5 后:loadUser 已把 storage_quota_bytes + advanced_extraction_enabled 带进 req.user,直接用。
  let storage = null
  try {
    const ss = getStorageQuotaSummary(db, req.user)
    storage = {
      ...ss,
      usedLabel: fmtStorageBytes(ss.used),
      quotaLabel: fmtStorageBytes(ss.quota),
      remainingLabel: fmtStorageBytes(ss.remaining),
    }
  } catch (e) { /* storage 表缺失 */ }

  res.render('account/index', {
    title: '我的账户',
    credCounts: credCounts || { total: 0, active: 0 },
    plan,
    advancedExtractionEnabled: !!req.user.advanced_extraction_enabled,
    usageThisMonth,
    storage,
  })
})

// 管理员后台(/admin/*)— 更具体的子路径先挂,Express 按注册顺序匹配
app.use('/admin/platform-credentials', requireSuperAdmin, adminPlatformCredsRouter)
app.use('/admin/step-presets',         requireSuperAdmin, adminStepPresetsRouter)
app.use('/account/preferences',        requireUser,       accountPreferencesRouter)
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

// P0.4:全局错误兜底 —— 带 request-id 落日志 + 写 audit(尽力而为),并按客户端
//   期望返回 JSON(agent / AJAX)或错误页(浏览器)。request-id 同时回给客户端,
//   用户/agent 报错时报这个 id 就能在日志里精确定位。
app.use((err, req, res, _next) => {
  const reqId = req?.id || 'no-req-id'
  console.error(`[unhandled][${reqId}] ${req?.method || '?'} ${req?.originalUrl || req?.url || '?'} —`, err)

  // 写 audit(独立 try,审计失败绝不能盖住原始错误)。复用 audit() helper:
  //   它内部 setImmediate + 吞异常 + payload 长度兜底,正好适合错误兜底场景。
  try {
    const auditDb = req?.app?.locals?.db
    if (auditDb) {
      audit(auditDb, req, {
        eventType: 'unhandled_error',
        userId: req?.user?.id || null,
        projectId: req?.params?.id || null,
        payload: {
          request_id: reqId,
          method: req?.method || null,
          path: (req?.originalUrl || req?.url || '').slice(0, 300),
          message: (err?.message || String(err)).slice(0, 500),
          stack: (err?.stack || '').slice(0, 1500),
        },
      })
    }
  } catch (e) {
    console.error(`[unhandled][${reqId}] audit write failed:`, e?.message)
  }

  if (res.headersSent) return  // 响应已开始 → 交给 express 默认处理,避免二次写头崩

  const wantsJson =
    (req.get?.('Accept') || '').includes('application/json') ||
    req.get?.('X-Requested-With') === 'XMLHttpRequest' ||
    (req.path || '').startsWith('/api/')
  if (wantsJson) {
    return res.status(500).json({ ok: false, error: 'internal_error', request_id: reqId })
  }
  res.status(500).render('error', { title: 'Server Error', message: '服务器内部错误', requestId: reqId })
})

// ── 2026-06-10 审计修复:进程级兜底 ──
//   后台 setImmediate 闭包(screening/matrix/rob/synthesis 批量、LaTeX 渲染)若内部漏了
//   try-catch,async 异常会变成 unhandledRejection —— Node ≥15 默认直接杀进程,
//   所有 in-flight 任务戛然而止且无日志。这里:
//   - unhandledRejection:记日志 + 继续运行(单个后台任务失败不应拖死整个服务;
//     卡 running 的 batch_jobs 行由用户重试或下次重启的 boot_id 收尸逻辑处理)
//   - uncaughtException:记日志 + 退出(同步异常后进程状态不可信,交给 systemd 拉起,
//     启动时 M20 boot_id 逻辑会把 stale running 任务标 aborted_by_restart + can_retry)
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason?.stack || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException (exiting, systemd will restart):', err?.stack || err)
  process.exit(1)
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[slr-copilot] listening on 127.0.0.1:${PORT}`)
})

export { app, db, requireUser, requireAdmin }
