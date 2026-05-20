/**
 * Admin 后台路由。整个 router 在 server.js 用 requireAdmin 中间件保护:
 *   import adminRouter from './routes/admin/users.js'
 *   app.use('/admin', requireAdmin, adminRouter)
 *
 * 路径(相对挂载点 /admin):
 *   GET    /                      → dashboard
 *   GET    /users                 → 用户列表
 *   GET    /users/new             → 生成邀请码表单
 *   POST   /users/invites         → 创建邀请码
 *   GET    /users/:id             → 用户详情
 *   POST   /users/:id/activate    → 启用
 *   POST   /users/:id/deactivate  → 停用(不能停自己)
 *   POST   /users/:id/role        → 改角色(不能降自己)
 *   POST   /users/:id/quota       → 设/改配额
 */

import { Router } from 'express'
import { generateInviteCode } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'

const router = Router()

function flash(req, type, message) {
  if (!req.session) return
  req.session.flash = { type, message }
}

// 解析 "YYYY-MM-DD" 或 "YYYY-MM-DDTHH:mm" → SQLite datetime 字符串(UTC)
// 失败返回 null
function parseExpires(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (isNaN(d.getTime())) return null
  // 返回 'YYYY-MM-DD HH:MM:SS' UTC 格式,和 SQLite datetime('now') 一致
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// 解析 checkbox 数组(单值或多值)
function asArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function parseIntOrNull(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
  return n
}

// ============== Dashboard ==============

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  const activeCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get().c
  const inviteCount = db
    .prepare('SELECT COUNT(*) AS c FROM invite_codes WHERE used_by_user_id IS NULL')
    .get().c
  res.render('admin/dashboard', {
    title: '管理后台',
    stats: { userCount, activeCount, inviteCount },
  })
})

// ============== 用户列表 ==============

router.get('/users', (req, res) => {
  const db = req.app.locals.db
  const users = db
    .prepare(
      `SELECT id, email, display_name, role, is_active, created_at, last_login_at
       FROM users
       ORDER BY created_at DESC`
    )
    .all()
  const invites = db
    .prepare(
      `SELECT code, preset_role, note, expires_at, created_at
       FROM invite_codes
       WHERE used_by_user_id IS NULL
       ORDER BY created_at DESC
       LIMIT 20`
    )
    .all()
  res.render('admin/users-list', {
    title: '用户管理',
    users,
    invites,
  })
})

// ============== 生成邀请码:GET 表单 + POST 创建 ==============

router.get('/users/new', (req, res) => {
  res.render('admin/user-new', {
    title: '生成邀请码',
    error: null,
    form: { preset_role: 'user', note: '', expires_days: '7' },
  })
})

router.post('/users/invites', (req, res) => {
  const db = req.app.locals.db
  const preset_role = req.body.preset_role === 'admin' ? 'admin' : 'user'
  const note = String(req.body.note || '').trim().slice(0, 200) || null

  // expires_days(更友好)或 expires_at(显式时间);留空 = 永不过期
  let expires_at = null
  const expiresDays = String(req.body.expires_days || '').trim()
  const expiresAtRaw = String(req.body.expires_at || '').trim()
  if (expiresAtRaw) {
    expires_at = parseExpires(expiresAtRaw)
    if (!expires_at) {
      return res.status(400).render('admin/user-new', {
        title: '生成邀请码',
        error: '过期时间格式无效',
        form: { preset_role, note: note || '', expires_days: expiresDays },
      })
    }
  } else if (expiresDays) {
    const n = Number(expiresDays)
    if (!Number.isFinite(n) || n <= 0 || n > 365) {
      return res.status(400).render('admin/user-new', {
        title: '生成邀请码',
        error: '过期天数请填 1-365 之间的整数',
        form: { preset_role, note: note || '', expires_days: expiresDays },
      })
    }
    const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
    expires_at = d.toISOString().slice(0, 19).replace('T', ' ')
  }

  // 重试几次以防极小概率的 PK 冲突
  let code = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateInviteCode()
    try {
      db.prepare(
        `INSERT INTO invite_codes (code, created_by_user_id, preset_role, note, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(candidate, req.user.id, preset_role, note, expires_at)
      code = candidate
      break
    } catch (e) {
      if (e.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && e.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
        console.error('[invite] insert error:', e.message)
        return res.status(500).render('admin/user-new', {
          title: '生成邀请码',
          error: '生成失败,请重试',
          form: { preset_role, note: note || '', expires_days: expiresDays },
        })
      }
      // 撞了重试
    }
  }
  if (!code) {
    return res.status(500).render('admin/user-new', {
      title: '生成邀请码',
      error: '生成失败,请重试',
      form: { preset_role, note: note || '', expires_days: expiresDays },
    })
  }

  audit(db, req, {
    eventType: 'invite_created',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: { code, preset_role, note, expires_at },
  })

  flash(req, 'success', `邀请码 ${code} 已生成,分享给用户(注册链接:/register?code=${code})`)
  res.redirect('/admin/users')
})

// ============== 用户详情 ==============

router.get('/users/:id', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  const user = db
    .prepare(
      `SELECT id, email, display_name, role, is_active, created_at, last_login_at, invite_code_used
       FROM users WHERE id = ?`
    )
    .get(id)
  if (!user) {
    return res.status(404).render('error', { title: 'Not Found', message: '用户不存在' })
  }
  const quota = db.prepare('SELECT * FROM user_quotas WHERE user_id = ?').get(id) || null
  // 反序列化 JSON 字段以便 view 使用
  let allowedProviders = null
  let allowedAuthTypes = null
  if (quota) {
    try {
      allowedProviders = quota.allowed_providers ? JSON.parse(quota.allowed_providers) : null
    } catch (_) {
      allowedProviders = null
    }
    try {
      allowedAuthTypes = quota.allowed_auth_types ? JSON.parse(quota.allowed_auth_types) : null
    } catch (_) {
      allowedAuthTypes = null
    }
  }
  res.render('admin/user-detail', {
    title: `用户:${user.display_name || user.email}`,
    target: user,
    quota,
    allowedProviders,
    allowedAuthTypes,
    isSelf: req.user.id === user.id,
  })
})

// ============== 启用 / 停用 ==============

router.post('/users/:id/activate', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(id)
  audit(db, req, {
    eventType: 'user_activated',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: id,
  })
  flash(req, 'success', '用户已启用')
  res.redirect(`/admin/users/${encodeURIComponent(id)}`)
})

router.post('/users/:id/deactivate', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  if (id === req.user.id) {
    flash(req, 'error', '不能停用自己,请让另一个 admin 操作')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id)
  audit(db, req, {
    eventType: 'user_deactivated',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: id,
  })
  flash(req, 'success', '用户已停用')
  res.redirect(`/admin/users/${encodeURIComponent(id)}`)
})

// ============== 改角色 ==============

router.post('/users/:id/role', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  const role = req.body.role === 'admin' ? 'admin' : 'user'

  if (id === req.user.id && role !== 'admin') {
    flash(req, 'error', '不能把自己降级,请让另一个 admin 操作')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }

  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  if (u.role === role) {
    flash(req, 'success', '角色没有变化')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  audit(db, req, {
    eventType: 'role_changed',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: id,
    payload: { from: u.role, to: role },
  })
  flash(req, 'success', `角色已改为 ${role}`)
  res.redirect(`/admin/users/${encodeURIComponent(id)}`)
})

// ============== 配额 ==============

router.post('/users/:id/quota', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }

  const daily = parseIntOrNull(req.body.daily_call_limit)
  const monthly = parseIntOrNull(req.body.monthly_token_limit)

  const providersIn = asArray(req.body.allowed_providers).filter((v) =>
    ['anthropic', 'openai'].includes(v)
  )
  const authTypesIn = asArray(req.body.allowed_auth_types).filter((v) =>
    ['api_key', 'oauth'].includes(v)
  )
  // 空数组 = 全允许(NULL)
  const providersJson = providersIn.length ? JSON.stringify(providersIn) : null
  const authTypesJson = authTypesIn.length ? JSON.stringify(authTypesIn) : null

  const notes = String(req.body.notes || '').trim().slice(0, 500) || null

  db.prepare(
    `INSERT INTO user_quotas
       (user_id, daily_call_limit, monthly_token_limit, allowed_providers, allowed_auth_types, notes, updated_at, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id) DO UPDATE SET
       daily_call_limit = excluded.daily_call_limit,
       monthly_token_limit = excluded.monthly_token_limit,
       allowed_providers = excluded.allowed_providers,
       allowed_auth_types = excluded.allowed_auth_types,
       notes = excluded.notes,
       updated_at = datetime('now'),
       updated_by_user_id = excluded.updated_by_user_id`
  ).run(id, daily, monthly, providersJson, authTypesJson, notes, req.user.id)

  audit(db, req, {
    eventType: 'quota_updated',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: id,
    payload: {
      daily_call_limit: daily,
      monthly_token_limit: monthly,
      allowed_providers: providersIn.length ? providersIn : null,
      allowed_auth_types: authTypesIn.length ? authTypesIn : null,
      notes,
    },
  })

  flash(req, 'success', '配额已更新')
  res.redirect(`/admin/users/${encodeURIComponent(id)}`)
})

export default router
