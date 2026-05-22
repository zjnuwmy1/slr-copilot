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
 *   POST   /users/invites/:code/delete → 删除未使用的邀请码
 *
 * 超管专属(下面这些路由内部用 req.user.is_super_admin 守卫):
 *   - 创建/晋升角色为 admin
 *   - 把别的 admin 改成 super_admin(本期不暴露 UI,只在 bootstrap 自动完成)
 */

import { Router } from 'express'
import { generateInviteCode } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { listProjectsForUser } from './projects.js'

const router = Router()

function requireSuperAdminInline(req, res, redirectTo = '/admin/users') {
  if (!req.user?.is_super_admin) {
    flash(req, 'error', '此操作仅超级管理员可执行')
    res.redirect(redirectTo)
    return false
  }
  return true
}

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
      `SELECT id, email, display_name, role, is_active, is_super_admin,
              step_model_preset,
              created_at, last_login_at
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
  // 默认 preset(列表渲染时用,显示"跟随默认 → X")
  const defaultPresetRow = db
    .prepare(`SELECT id FROM step_model_presets WHERE is_default = 1 LIMIT 1`)
    .get()
  res.render('admin/users-list', {
    title: '用户管理',
    users,
    invites,
    defaultPresetId: defaultPresetRow ? defaultPresetRow.id : 'balanced',
    presetIds: ['performance', 'balanced', 'economy'],
  })
})

// ============== 生成邀请码:GET 表单 + POST 创建 ==============

router.get('/users/new', (req, res) => {
  res.render('admin/user-new', {
    title: '生成邀请码',
    error: null,
    form: { preset_role: 'user', note: '', expires_days: '7' },
    isSuperAdmin: !!req.user.is_super_admin,
  })
})

router.post('/users/invites', (req, res) => {
  const db = req.app.locals.db
  let preset_role = req.body.preset_role === 'admin' ? 'admin' : 'user'
  // 守卫:只有超管能签发 admin 邀请码
  if (preset_role === 'admin' && !req.user.is_super_admin) {
    return res.status(403).render('admin/user-new', {
      title: '生成邀请码',
      error: '仅超级管理员可以创建管理员账号',
      form: { preset_role: 'user', note: req.body.note || '', expires_days: req.body.expires_days || '7' },
      isSuperAdmin: false,
    })
  }
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
        isSuperAdmin: !!req.user.is_super_admin,
      })
    }
  } else if (expiresDays) {
    const n = Number(expiresDays)
    if (!Number.isFinite(n) || n <= 0 || n > 365) {
      return res.status(400).render('admin/user-new', {
        title: '生成邀请码',
        error: '过期天数请填 1-365 之间的整数',
        form: { preset_role, note: note || '', expires_days: expiresDays },
        isSuperAdmin: !!req.user.is_super_admin,
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

// ============== 删除邀请码(仅未使用的) ==============

router.post('/users/invites/:code/delete', (req, res) => {
  const db = req.app.locals.db
  const code = String(req.params.code || '').trim()
  if (!code) {
    flash(req, 'error', '缺少邀请码')
    return res.redirect('/admin/users')
  }
  const row = db.prepare(
    'SELECT code, used_by_user_id, preset_role FROM invite_codes WHERE code = ?'
  ).get(code)
  if (!row) {
    flash(req, 'error', '邀请码不存在')
    return res.redirect('/admin/users')
  }
  if (row.used_by_user_id) {
    flash(req, 'error', '该邀请码已被使用,无法删除(保留作为注册记录)')
    return res.redirect('/admin/users')
  }
  // 守卫:admin 邀请码只有超管能删(普通 admin 也不能签发,自然不能删)
  if (row.preset_role === 'admin' && !req.user.is_super_admin) {
    flash(req, 'error', '只有超级管理员可以删除管理员邀请码')
    return res.redirect('/admin/users')
  }
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code)
  audit(db, req, {
    eventType: 'invite_deleted',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: { code, preset_role: row.preset_role },
  })
  flash(req, 'success', `邀请码 ${code} 已删除`)
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
  // 把 is_super_admin 也带到 view
  const fullUser = db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(id)
  res.render('admin/user-detail', {
    title: `用户:${user.display_name || user.email}`,
    target: { ...user, is_super_admin: !!fullUser?.is_super_admin },
    quota,
    allowedProviders,
    allowedAuthTypes,
    isSelf: req.user.id === user.id,
    viewerIsSuperAdmin: !!req.user.is_super_admin,
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

  // 守卫:只有超管能改任何用户的角色(普通 admin 无权晋升 / 降级他人)
  if (!req.user.is_super_admin) {
    flash(req, 'error', '仅超级管理员可调整用户角色')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }

  if (id === req.user.id && role !== 'admin') {
    flash(req, 'error', '不能把自己降级,请让另一个超管操作')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }

  const u = db.prepare('SELECT id, role, is_super_admin FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  // 安全:不允许把仅剩的一个超管降级为 user
  if (u.is_super_admin && role === 'user') {
    const otherSupers = db.prepare(
      'SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1 AND id != ?'
    ).get(id).c
    if (otherSupers === 0) {
      flash(req, 'error', '不能降级最后一名超级管理员')
      return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
    }
    // 降为 user 时同时清掉 super_admin 标志
    db.prepare('UPDATE users SET is_super_admin = 0 WHERE id = ?').run(id)
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

// ============== 改用户的 plan(step_model_preset)— 超管专用 ==============
// POST /users/:id/preset
//   body.preset: 'performance' | 'balanced' | 'economy' | '' (空 = 跟随默认)
router.post('/users/:id/preset', (req, res) => {
  if (!requireSuperAdminInline(req, res)) return
  const db = req.app.locals.db
  const id = String(req.params.id)
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  const PRESET_IDS = ['performance', 'balanced', 'economy']
  const raw = String(req.body.preset || '').trim()
  let preset = null
  if (raw === '' || raw === 'default') {
    preset = null  // NULL = 跟随系统默认
  } else if (PRESET_IDS.includes(raw)) {
    preset = raw
  } else {
    flash(req, 'error', '无效的 plan 值')
    return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
  }

  db.prepare(`UPDATE users SET step_model_preset = ? WHERE id = ?`).run(preset, id)

  audit(db, req, {
    eventType: 'admin_user_plan_changed',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: id,
    payload: { user_id: id, email: u.email, new_preset: preset },
  })

  flash(req, 'success', preset
    ? `已把 ${u.email} 的 plan 设为 "${preset}"`
    : `已清除 ${u.email} 的自选 plan(改为跟随系统默认)`)
  // 来路:用户列表来的就回列表,从详情页来的就回详情
  const ref = (req.get('Referer') || '').endsWith('/admin/users') ? '/admin/users' : `/admin/users/${encodeURIComponent(id)}`
  res.redirect(ref)
})

// ============== 该用户的项目(只读列表)==============

router.get('/users/:id/projects', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  const user = db
    .prepare(`SELECT id, email, display_name, role, is_active FROM users WHERE id = ?`)
    .get(id)
  if (!user) {
    return res.status(404).render('error', { title: 'Not Found', message: '用户不存在' })
  }

  const filters = {
    status: req.query.status ? String(req.query.status) : '',
    q: req.query.q ? String(req.query.q).slice(0, 200) : '',
  }
  const rows = listProjectsForUser(db, user.id, filters, 200)

  audit(db, req, {
    eventType: 'admin_listed_user_projects',
    userId: req.user.id,
    actorUserId: req.user.id,
    targetUserId: user.id,
    payload: {
      admin_email: req.user.email,
      target_email: user.email,
      filters: { status: filters.status || null, q: filters.q || null },
      result_count: rows.length,
    },
  })

  res.render('admin/projects/list', {
    title: `${user.display_name || user.email} 的项目`,
    rows,
    filters: { userQuery: '', status: filters.status, q: filters.q },
    allowedStatus: [
      'draft','protocol_pending','protocol_approved','searching','screening',
      'extracting','synthesizing','complete','archived',
    ],
    scopeUser: user,
  })
})

export default router
