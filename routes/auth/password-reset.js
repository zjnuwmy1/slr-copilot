/**
 * 密码重设流程(B4.5,MVP 无邮件版)
 *
 * 挂载方式(server.js):
 *   import passwordResetRouter from './routes/auth/password-reset.js'
 *   app.use('/', passwordResetRouter)   // 必须在 requireUser 之前,匿名可访问
 *
 * 路由:
 *   GET  /forgot-password          → 输 email 表单
 *   POST /forgot-password          → 生成 15 min token + audit + flash "已生成,
 *                                     请联系超管获取重置链接"
 *   GET  /reset-password/:token    → 验 token + 新密码表单
 *   POST /reset-password/:token    → 验 token + 写 hash + 标 used_at + redirect /login
 *
 * 反枚举:无论 email 是否存在,POST /forgot-password 都返回相同 flash 文案
 *         (但不存在的 email 不入库 + 不计入 rate limit)。
 *
 * Rate limit:同 email 5 分钟内已有未过期 token 直接静默拒(仍返回相同 flash)。
 */

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { audit } from '../../services/audit.js'

const router = Router()

const TOKEN_TTL_MIN = 15
const RATE_LIMIT_MIN = 5

function flash(req, type, message) {
  if (!req.session) return
  req.session.flash = { type, message }
}

function generateToken() {
  // 16 bytes → 32 hex chars,128 bit 熵足够防爆破(15 min TTL + 一次性)
  return crypto.randomBytes(16).toString('hex')
}

// ============== GET /forgot-password ==============

router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/account')
  res.render('auth/forgot-password', {
    title: '忘记密码',
    email: '',
    error: null,
  })
})

// ============== POST /forgot-password ==============

router.post('/forgot-password', (req, res) => {
  const db = req.app.locals.db
  const email = String(req.body.email || '').trim().toLowerCase()

  // 通用提示:不论成不成功都展示同样文案,避免泄露邮箱是否注册
  const genericMessage =
    '若邮箱已注册,我们已生成重置链接。' +
    '请联系超级管理员获取重置链接(MVP 阶段未开放邮件发送)。'

  if (!email || !email.includes('@')) {
    return res.status(400).render('auth/forgot-password', {
      title: '忘记密码',
      email,
      error: '请填写有效邮箱',
    })
  }

  const user = db.prepare('SELECT id, email, is_active FROM users WHERE email = ?').get(email)

  if (!user || !user.is_active) {
    // 不存在 / 已停用:静默 audit + 通用 flash + redirect login
    audit(db, req, {
      eventType: 'password_reset_requested',
      payload: { email, outcome: 'unknown_or_inactive_email' },
    })
    flash(req, 'success', genericMessage)
    return res.redirect('/login')
  }

  // Rate limit:5 分钟内任何 token(无论已用与否)就静默拒
  // 防"反复点忘记密码刷链接给超管看"和"暴力枚举 token 空间"两种姿势
  const recent = db.prepare(`
    SELECT token FROM password_reset_tokens
    WHERE user_id = ?
      AND created_at >= datetime('now', '-${RATE_LIMIT_MIN} minutes')
    LIMIT 1
  `).get(user.id)

  if (recent) {
    audit(db, req, {
      eventType: 'password_reset_requested',
      userId: user.id,
      payload: { email, outcome: 'rate_limited' },
    })
    flash(req, 'success', genericMessage)
    return res.redirect('/login')
  }

  // 生成 token + 入库
  const token = generateToken()
  db.prepare(`
    INSERT INTO password_reset_tokens (token, user_id, expires_at, requested_ip)
    VALUES (?, ?, datetime('now', '+${TOKEN_TTL_MIN} minutes'), ?)
  `).run(token, user.id, req.ip || null)

  audit(db, req, {
    eventType: 'password_reset_requested',
    userId: user.id,
    payload: { email, outcome: 'token_created', ttl_min: TOKEN_TTL_MIN },
  })

  flash(req, 'success', genericMessage)
  res.redirect('/login')
})

// ============== GET /reset-password/:token ==============

router.get('/reset-password/:token', (req, res) => {
  const db = req.app.locals.db
  const token = String(req.params.token || '').trim()

  const row = db.prepare(`
    SELECT token, user_id, expires_at, used_at
    FROM password_reset_tokens
    WHERE token = ?
  `).get(token)

  if (!row || row.used_at || new Date(row.expires_at + 'Z') < new Date()) {
    // 简化:任何一种失败都展示相同错误,避免泄露 token 存在性
    return res.status(400).render('auth/reset-password', {
      title: '重置密码',
      token,
      error: '链接无效或已过期,请重新申请。',
      invalid: true,
    })
  }

  res.render('auth/reset-password', {
    title: '重置密码',
    token,
    error: null,
    invalid: false,
  })
})

// ============== POST /reset-password/:token ==============

router.post('/reset-password/:token', async (req, res) => {
  const db = req.app.locals.db
  const token = String(req.params.token || '').trim()
  const password = String(req.body.password || '')
  const password_confirm = String(req.body.password_confirm || '')

  function fail(message) {
    return res.status(400).render('auth/reset-password', {
      title: '重置密码',
      token,
      error: message,
      invalid: false,
    })
  }

  const row = db.prepare(`
    SELECT prt.token, prt.user_id, prt.expires_at, prt.used_at,
           u.email, u.is_active
    FROM password_reset_tokens prt
    LEFT JOIN users u ON u.id = prt.user_id
    WHERE prt.token = ?
  `).get(token)

  if (!row || row.used_at || new Date(row.expires_at + 'Z') < new Date()) {
    return res.status(400).render('auth/reset-password', {
      title: '重置密码',
      token,
      error: '链接无效或已过期,请重新申请。',
      invalid: true,
    })
  }

  if (!row.is_active) {
    return fail('账户已被停用,请联系管理员')
  }

  if (!password || password.length < 10) return fail('密码至少 10 位')
  if (password !== password_confirm) return fail('两次输入的密码不一致')

  let hash
  try {
    hash = await bcrypt.hash(password, 12)
  } catch (e) {
    console.error('[reset-password] bcrypt error:', e.message)
    return fail('重置失败,请重试')
  }

  // 事务:更新密码 + 标 token used,顺手把同一 user 其他未用 token 全部作废
  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, row.user_id)
    db.prepare(`
      UPDATE password_reset_tokens
      SET used_at = datetime('now')
      WHERE token = ?
    `).run(token)
    // 同一用户的所有其他未用 token 立即作废(防"我点了链接但又申请了一次"的二次重置窗口)
    db.prepare(`
      UPDATE password_reset_tokens
      SET used_at = datetime('now')
      WHERE user_id = ? AND used_at IS NULL AND token != ?
    `).run(row.user_id, token)
  })

  try {
    tx()
  } catch (e) {
    console.error('[reset-password] tx error:', e.message)
    return fail('重置失败,请重试')
  }

  audit(db, req, {
    eventType: 'password_reset_completed',
    userId: row.user_id,
    actorUserId: row.user_id,
    payload: { email: row.email },
  })

  flash(req, 'success', '密码已重置,请用新密码登录')
  res.redirect('/login')
})

export default router
