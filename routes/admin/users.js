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
import { getPlatformStorage, formatBytes } from '../../services/storage.js'
import { PRESET_IDS, getDefaultPresetId, getPreset } from '../../services/step-presets.js'
import { canManageUser, visibleUserScope } from '../../services/admin-scope.js'
import {
  getUserQuotaSummary,
  effectiveQuotaForUser,
  parseGbToBytes,
  formatBytes as fmtBytes,
  ONE_GB,
} from '../../services/storage-quota.js'

const router = Router()

function requireSuperAdminInline(req, res, redirectTo = '/admin/users') {
  if (!req.user?.is_super_admin) {
    flash(req, 'error', '此操作仅超级管理员可执行')
    res.redirect(redirectTo)
    return false
  }
  return true
}

// 邀请码列表 SQL 片段(普通 admin 只看自己创建的)
function inviteScopeWhere(req) {
  if (req.user?.is_super_admin) return { sql: '', params: [] }
  return { sql: ' AND created_by_user_id = ?', params: [req.user.id] }
}

// 在 POST 路由里统一校验,失败 flash + redirect false
function ensureCanManageUser(req, res, db, targetUserId, redirectTo = '/admin/users') {
  if (canManageUser(req, db, targetUserId)) return true
  flash(req, 'error', '该用户不在你的管理范围内(仅你邀请的用户可管)')
  res.redirect(redirectTo)
  return false
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
  const scope = visibleUserScope(req, db)

  // 用户计数 — 按 viewer 可见范围
  let userCount, activeCount, inviteCount
  if (scope.scope === 'all') {
    userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
    activeCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get().c
    inviteCount = db.prepare(
      'SELECT COUNT(*) AS c FROM invite_codes WHERE used_by_user_id IS NULL'
    ).get().c
  } else if (scope.ids.length === 0) {
    userCount = 0; activeCount = 0
    inviteCount = db.prepare(
      'SELECT COUNT(*) AS c FROM invite_codes WHERE used_by_user_id IS NULL AND created_by_user_id = ?'
    ).get(req.user.id).c
  } else {
    const ph = scope.ids.map(() => '?').join(',')
    userCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE id IN (${ph})`).get(...scope.ids).c
    activeCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE id IN (${ph}) AND is_active = 1`).get(...scope.ids).c
    inviteCount = db.prepare(
      'SELECT COUNT(*) AS c FROM invite_codes WHERE used_by_user_id IS NULL AND created_by_user_id = ?'
    ).get(req.user.id).c
  }

  // === 新增 widget 数据 ===

  // 1) 近 24h LLM 错误数(含错误类型拆分)
  let llmErrors24h = { total: 0, byStatus: [] }
  try {
    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM usage_logs
      WHERE status IN ('error','timeout','rate_limited','quota_exceeded')
        AND started_at >= datetime('now','-1 day')
    `).get().c
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS c FROM usage_logs
      WHERE status IN ('error','timeout','rate_limited','quota_exceeded')
        AND started_at >= datetime('now','-1 day')
      GROUP BY status
      ORDER BY c DESC
    `).all()
    llmErrors24h = { total, byStatus }
  } catch { /* usage_logs 缺失 */ }

  // 2) 各 plan 用户数(NULL 算 default preset)
  const defaultPresetId = getDefaultPresetId(db)
  let presetCounts = []
  try {
    const rows = db.prepare(`
      SELECT step_model_preset AS preset, COUNT(*) AS c
      FROM users
      WHERE is_active = 1
      GROUP BY step_model_preset
    `).all()
    // 把 NULL 折叠到 default
    const map = new Map()
    for (const id of PRESET_IDS) map.set(id, 0)
    for (const r of rows) {
      const id = r.preset || defaultPresetId
      if (!map.has(id)) map.set(id, 0)
      map.set(id, map.get(id) + r.c)
    }
    presetCounts = PRESET_IDS.map((id) => {
      const p = getPreset(db, id)
      return {
        id,
        label: p?.label || id,
        count: map.get(id) || 0,
        isDefault: id === defaultPresetId,
      }
    })
  } catch { /* preset 表缺失 */ }

  // 3) 磁盘 + DB 大小(复用 services/storage.js)
  let storageSummary = null
  try {
    const ps = getPlatformStorage(db)
    storageSummary = {
      totalLabel:    formatBytes(ps.total_bytes),
      dbLabel:       formatBytes(ps.breakdown.db.bytes),
      uploadsLabel:  formatBytes(ps.breakdown.uploads.bytes),
      userHomesLabel:formatBytes(ps.breakdown.user_homes.bytes),
    }
  } catch { /* 文件系统读不到时跳过 */ }

  // 4) 最近 10 个 audit event(JOIN users 拿 email)
  let recentAudit = []
  try {
    recentAudit = db.prepare(`
      SELECT ae.id, ae.event_type, ae.created_at, ae.ip_address,
             ae.user_id, ae.actor_user_id, ae.target_user_id,
             u_user.email   AS user_email,
             u_actor.email  AS actor_email,
             u_target.email AS target_email
      FROM audit_events ae
      LEFT JOIN users u_user   ON u_user.id   = ae.user_id
      LEFT JOIN users u_actor  ON u_actor.id  = ae.actor_user_id
      LEFT JOIN users u_target ON u_target.id = ae.target_user_id
      ORDER BY ae.created_at DESC
      LIMIT 10
    `).all()
  } catch { /* audit_events 缺失 */ }

  // 5) 未处理的密码重置请求(B4.5)— MVP 阶段无邮件,超管需要把链接转给用户
  //    只列未用 + 未过期的;按申请时间倒序
  let pendingResets = []
  try {
    pendingResets = db.prepare(`
      SELECT prt.token, prt.expires_at, prt.created_at, prt.requested_ip,
             u.email, u.display_name
      FROM password_reset_tokens prt
      JOIN users u ON u.id = prt.user_id
      WHERE prt.used_at IS NULL
        AND prt.expires_at > datetime('now')
      ORDER BY prt.created_at DESC
      LIMIT 10
    `).all()
  } catch { /* password_reset_tokens 缺失 */ }

  res.render('admin/dashboard', {
    title: '管理后台',
    stats: { userCount, activeCount, inviteCount },
    llmErrors24h,
    presetCounts,
    storageSummary,
    recentAudit,
    pendingResets,
  })
})

// ============== 用户列表 ==============

router.get('/users', (req, res) => {
  const db = req.app.locals.db
  const scope = visibleUserScope(req, db)

  // 用户列表 — 按 scope 过滤
  // LEFT JOIN invite_codes + 邀请人 users — 拿到"是被谁邀请来的"(超管列表里展示)
  // 同 user 可能历史上用过多个邀请码,取最近用过的那条(MAX(used_at))
  const baseSelect = `
    SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.is_super_admin,
           u.step_model_preset, u.advanced_extraction_enabled,
           u.storage_quota_bytes,
           u.created_at, u.last_login_at,
           u.invite_code_used,
           ic.created_by_user_id AS inviter_id,
           inviter.email         AS inviter_email,
           inviter.display_name  AS inviter_display_name,
           inviter.is_super_admin AS inviter_is_super
      FROM users u
      LEFT JOIN invite_codes ic ON ic.code = u.invite_code_used
      LEFT JOIN users inviter   ON inviter.id = ic.created_by_user_id
  `
  let users
  if (scope.scope === 'all') {
    users = db.prepare(`${baseSelect} ORDER BY u.created_at DESC`).all()
  } else if (scope.ids.length === 0) {
    users = []
  } else {
    const placeholders = scope.ids.map(() => '?').join(',')
    users = db.prepare(
      `${baseSelect} WHERE u.id IN (${placeholders}) ORDER BY u.created_at DESC`
    ).all(...scope.ids)
  }

  // B2.7:N+1 → 单查询。原代码对 N 个用户跑 2N 次 SUM 子查询,
  //         50 个用户 = 100 次 DB 往返,慢且锁竞争。
  //         现一次 UNION ALL + GROUP BY user_id 取所有用户的合计 bytes。
  //         注意:zotero 的 size_bytes 是 user_id 直接归属,attachments 要
  //         经 records → projects → user_id 三跳。
  // B2.6 也在这里生效:非超管的列表 viewer 不需要存储数据,跳过计算节流量。
  if (req.user.is_super_admin && users.length > 0) {
    const usageMap = new Map()
    try {
      const rows = db.prepare(`
        SELECT user_id, SUM(b) AS total FROM (
          SELECT user_id, COALESCE(SUM(size_bytes), 0) AS b
            FROM zotero_packages
           WHERE status != 'failed' AND size_bytes IS NOT NULL
           GROUP BY user_id
          UNION ALL
          SELECT p.user_id, COALESCE(SUM(a.size_bytes), 0) AS b
            FROM attachments a
            JOIN records  r ON r.id = a.record_id
            JOIN projects p ON p.id = r.project_id
           WHERE a.size_bytes IS NOT NULL
           GROUP BY p.user_id
        )
        GROUP BY user_id
      `).all()
      for (const r of rows) usageMap.set(r.user_id, Number(r.total) || 0)
    } catch (e) {
      console.error('[admin/users] bulk storage usage failed:', e.message)
    }
    for (const u of users) {
      const quota = effectiveQuotaForUser(u)
      const used = usageMap.get(u.id) || 0
      u.storage = {
        quota,
        used,
        pct: quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0,
        quotaLabel: fmtBytes(quota),
        usedLabel: fmtBytes(used),
        isExplicit: u.storage_quota_bytes != null,
      }
    }
  }

  // 邀请码 — admin 只看自己创建的
  const inviteW = inviteScopeWhere(req)
  const invites = db.prepare(
    `SELECT code, preset_role, note, expires_at, created_at, created_by_user_id
       FROM invite_codes
       WHERE used_by_user_id IS NULL ${inviteW.sql}
       ORDER BY created_at DESC
       LIMIT 20`
  ).all(...inviteW.params)

  // 默认 preset(列表渲染时用,显示"跟随默认 → X")
  const defaultPresetRow = db
    .prepare(`SELECT id FROM step_model_presets WHERE is_default = 1 LIMIT 1`)
    .get()

  // 给 UI 展示"作用域"说明
  const visibilityNote = req.user.is_super_admin
    ? { mode: 'super', count: users.length, total: users.length }
    : {
        mode: 'admin',
        count: users.length,
        total: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      }

  res.render('admin/users-list', {
    title: '用户管理',
    users,
    invites,
    defaultPresetId: defaultPresetRow ? defaultPresetRow.id : 'balanced',
    presetIds: ['performance', 'balanced', 'economy'],
    visibilityNote,
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
    'SELECT code, used_by_user_id, preset_role, created_by_user_id FROM invite_codes WHERE code = ?'
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
  // 守卫:普通 admin 只能删自己创建的邀请码(super admin 可删任意)
  if (!req.user.is_super_admin && row.created_by_user_id !== req.user.id) {
    flash(req, 'error', '只能删除自己创建的邀请码')
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
  if (!canManageUser(req, db, id)) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: '该用户不在你的管理范围内 — 仅你邀请的用户(及你自己)可查看。请联系超级管理员。',
    })
  }
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
  // 把 is_super_admin + advanced_extraction_enabled + storage_quota_bytes 也带过去
  const fullUser = db.prepare(
    'SELECT is_super_admin, advanced_extraction_enabled, storage_quota_bytes FROM users WHERE id = ?'
  ).get(id)
  const targetEnriched = {
    ...user,
    is_super_admin: !!fullUser?.is_super_admin,
    advanced_extraction_enabled: !!fullUser?.advanced_extraction_enabled,
    storage_quota_bytes: fullUser?.storage_quota_bytes ?? null,
  }
  // B2.6:存储用量/配额是敏感数据(尤其超管显式 quota),仅超管 viewer 可见。
  // 普通 admin 看自己邀请的用户时不算 + 不渲染该卡。
  const viewerIsSuper = !!req.user.is_super_admin
  const storageSummary = viewerIsSuper ? getUserQuotaSummary(db, targetEnriched) : null
  res.render('admin/user-detail', {
    title: `用户:${user.display_name || user.email}`,
    target: targetEnriched,
    quota,
    allowedProviders,
    allowedAuthTypes,
    isSelf: req.user.id === user.id,
    viewerIsSuperAdmin: viewerIsSuper,
    storageSummary,
    storageQuotaGb: (storageSummary && storageSummary.quota > 0) ? (storageSummary.quota / ONE_GB) : 0,
    fmtBytes,
  })
})

// ============== 改用户的存储配额 — 超管专用 ==============
// POST /users/:id/storage-quota
//   body.quota_gb: 数字(GB,可小数) | 'default' | '' → NULL(走默认)
router.post('/users/:id/storage-quota', (req, res) => {
  if (!requireSuperAdminInline(req, res)) return
  const db = req.app.locals.db
  const id = String(req.params.id)
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  const raw = String(req.body.quota_gb || '').trim()
  let bytes = null
  if (raw === '' || raw === 'default') {
    bytes = null   // 重置为默认
  } else {
    bytes = parseGbToBytes(raw)
    if (bytes == null) {
      flash(req, 'error', '配额值无效(请输入非负数字,单位 GB,留空 = 重置为默认)')
      return res.redirect(`/admin/users/${encodeURIComponent(id)}`)
    }
  }
  db.prepare(`UPDATE users SET storage_quota_bytes = ? WHERE id = ?`).run(bytes, id)
  audit(db, req, {
    eventType: 'admin_user_storage_quota_changed',
    userId: req.user.id, actorUserId: req.user.id, targetUserId: id,
    payload: {
      user_id: id,
      email: u.email,
      new_quota_bytes: bytes,
      new_quota_gb: bytes != null ? +(bytes / ONE_GB).toFixed(3) : null,
    },
  })
  flash(req, 'success', bytes == null
    ? `${u.email} 的存储配额已重置为默认(开通高级抽取 = 1 GB,否则 0)`
    : `${u.email} 的存储配额已设为 ${fmtBytes(bytes)}`)
  res.redirect(`/admin/users/${encodeURIComponent(id)}`)
})

// ============== 启用 / 停用 ==============

router.post('/users/:id/activate', (req, res) => {
  const db = req.app.locals.db
  const id = String(req.params.id)
  if (!ensureCanManageUser(req, res, db, id)) return
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
  if (!ensureCanManageUser(req, res, db, id)) return
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
  if (!ensureCanManageUser(req, res, db, id)) return
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

// ============== 改用户的 "高级抽取" 权限位 — 超管专用 ==============
// POST /users/:id/advanced
//   body.enabled: '1' / '' (空 = 关)
router.post('/users/:id/advanced', (req, res) => {
  if (!requireSuperAdminInline(req, res)) return
  const db = req.app.locals.db
  const id = String(req.params.id)
  const u = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id)
  if (!u) {
    flash(req, 'error', '用户不存在')
    return res.redirect('/admin/users')
  }
  const enabled = String(req.body.enabled || '').trim() === '1' ? 1 : 0
  db.prepare(`UPDATE users SET advanced_extraction_enabled = ? WHERE id = ?`).run(enabled, id)
  audit(db, req, {
    eventType: 'admin_user_advanced_toggled',
    userId: req.user.id, actorUserId: req.user.id, targetUserId: id,
    payload: { user_id: id, email: u.email, advanced: enabled },
  })
  flash(req, 'success', enabled
    ? `已为 ${u.email} 开通"高级抽取"(可批量 AI 抽取 + 上传 PDF)`
    : `已关闭 ${u.email} 的"高级抽取"(回到 xlsx 手填流程)`)
  const ref = (req.get('Referer') || '').endsWith('/admin/users') ? '/admin/users' : `/admin/users/${encodeURIComponent(id)}`
  res.redirect(ref)
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
  // B2.1:真 IDOR 修复 — 之前任意普通 admin 都能 GET 此路由看其他用户项目。
  // 现按 canManageUser:超管全通,普通 admin 只能看自己邀请的用户。
  if (!canManageUser(req, db, id)) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: '该用户不在你的管理范围内(仅你邀请的用户可管)',
    })
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
