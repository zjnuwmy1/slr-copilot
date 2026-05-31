/**
 * 认证相关路由(顶层):/login /logout /register
 * 挂载方式(在 server.js 里):
 *   import authRouter from './routes/auth.js'
 *   app.use('/', authRouter)
 *
 * 注意:本 router 内部不依赖 requireUser/requireAdmin,因为这些都是匿名页面。
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { randomId } from '../services/crypto.js'
import { audit } from '../services/audit.js'

const router = Router()

// 简单的 next 校验:必须以 / 开头,不能是 //(scheme-relative)
function safeNext(next) {
  if (!next || typeof next !== 'string') return null
  if (!next.startsWith('/')) return null
  if (next.startsWith('//')) return null
  return next
}

// ============== /login ==============

router.get('/login', (req, res) => {
  // 已登录就直接回首页(或 next)
  if (req.user) {
    const n = safeNext(req.query.next)
    return res.redirect(n || '/')
  }
  res.render('auth/login', {
    title: '登录',
    next: typeof req.query.next === 'string' ? req.query.next : '',
    email: '',
    error: null,
  })
})

router.post('/login', async (req, res) => {
  const db = req.app.locals.db
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  const nextRaw = typeof req.body.next === 'string' ? req.body.next : ''
  const next = safeNext(nextRaw)

  function fail(message) {
    audit(db, req, {
      eventType: 'login_fail',
      payload: { email, reason: message },
    })
    return res.status(401).render('auth/login', {
      title: '登录',
      next: nextRaw,
      email,
      error: message,
    })
  }

  if (!email || !password) {
    return fail('请输入邮箱和密码')
  }

  const row = db
    .prepare('SELECT id, email, password_hash, is_active FROM users WHERE email = ?')
    .get(email)

  if (!row) return fail('邮箱或密码错误')
  if (!row.is_active) return fail('账户已被停用,请联系管理员')

  let ok = false
  try {
    ok = await bcrypt.compare(password, row.password_hash)
  } catch (e) {
    console.error('[login] bcrypt error:', e.message)
    return fail('登录失败,请重试')
  }
  if (!ok) return fail('邮箱或密码错误')

  // 成功
  db.prepare("UPDATE users SET last_login_at = datetime('now', '+8 hours') WHERE id = ?").run(row.id)
  req.session.user_id = row.id
  audit(db, req, {
    eventType: 'login_success',
    userId: row.id,
    actorUserId: row.id,
    payload: { email },
  })

  res.redirect(next || '/')
})

// ============== /logout ==============

router.post('/logout', (req, res) => {
  const db = req.app.locals.db
  const uid = req.session?.user_id
  if (uid) {
    audit(db, req, {
      eventType: 'logout',
      userId: uid,
      actorUserId: uid,
    })
  }
  req.session = null
  res.redirect('/')
})

// ============== /register ==============

router.get('/register', (req, res) => {
  if (req.user) {
    return res.redirect('/')
  }
  const code = typeof req.query.code === 'string' ? req.query.code.trim().toUpperCase() : ''
  res.render('auth/register', {
    title: '注册',
    invite_code: code,
    email: '',
    display_name: '',
    error: null,
  })
})

router.post('/register', async (req, res) => {
  const db = req.app.locals.db
  const invite_code = String(req.body.invite_code || '').trim().toUpperCase()
  const email = String(req.body.email || '').trim().toLowerCase()
  const display_name = String(req.body.display_name || '').trim().slice(0, 80)
  const password = String(req.body.password || '')
  const password_confirm = String(req.body.password_confirm || '')

  function fail(message) {
    return res.status(400).render('auth/register', {
      title: '注册',
      invite_code,
      email,
      display_name,
      error: message,
    })
  }

  if (!invite_code) return fail('请填写邀请码')
  if (!email || !email.includes('@')) return fail('请填写有效邮箱')
  if (!password || password.length < 10) return fail('密码至少 10 位')
  if (password !== password_confirm) return fail('两次输入的密码不一致')

  // 校验邀请码
  const invite = db
    .prepare(
      'SELECT code, preset_role, used_by_user_id, expires_at FROM invite_codes WHERE code = ?'
    )
    .get(invite_code)
  if (!invite) return fail('邀请码无效')
  if (invite.used_by_user_id) return fail('邀请码已被使用')
  if (invite.expires_at) {
    const exp = new Date(invite.expires_at + 'Z') // schema 用 datetime('now', '+8 hours'),按 UTC 解释
    const expRaw = new Date(invite.expires_at)
    const now = Date.now()
    // 容错处理:如果两种解释都已过期才判定为过期
    if (
      (!isNaN(exp.getTime()) && exp.getTime() < now) &&
      (!isNaN(expRaw.getTime()) && expRaw.getTime() < now)
    ) {
      return fail('邀请码已过期')
    }
  }

  // email 唯一
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) return fail('该邮箱已被注册')

  let hash
  try {
    hash = await bcrypt.hash(password, 12)
  } catch (e) {
    console.error('[register] bcrypt error:', e.message)
    return fail('注册失败,请重试')
  }

  const id = randomId('user')
  const role = invite.preset_role === 'admin' ? 'admin' : 'user'

  // 在事务里:插 user + 标记 invite,如果 invite 已经被并发使用就回滚
  const tx = db.transaction(() => {
    // 新用户默认 economy 预设(超管可在 /admin/users 后台改;用户自己也能去 /account/preferences 改)
    db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, invite_code_used, step_model_preset)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'economy')`
    ).run(id, email, display_name || email.split('@')[0], hash, role, invite_code)

    const upd = db
      .prepare(
        `UPDATE invite_codes
         SET used_by_user_id = ?, used_at = datetime('now', '+8 hours')
         WHERE code = ? AND used_by_user_id IS NULL`
      )
      .run(id, invite_code)

    if (upd.changes !== 1) {
      // 邀请码在我们 SELECT 之后被别人用了
      throw new Error('invite_code_race')
    }
  })

  try {
    tx()
  } catch (e) {
    if (e.message === 'invite_code_race') {
      return fail('邀请码已被使用,请向管理员重新申请')
    }
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return fail('该邮箱已被注册')
    }
    console.error('[register] tx error:', e.message)
    return fail('注册失败,请重试')
  }

  audit(db, req, {
    eventType: 'signup',
    userId: id,
    actorUserId: id,
    payload: { invite_code, role, email },
  })

  // 自动登录
  req.session.user_id = id
  db.prepare("UPDATE users SET last_login_at = datetime('now', '+8 hours') WHERE id = ?").run(id)
  req.session.flash = { type: 'success', message: '欢迎加入 SLR Copilot' }
  res.redirect('/account')
})

export default router
