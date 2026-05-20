/**
 * routes/account/oauth.js
 *
 * 挂载到 /account/oauth,所有路由 requireUser。
 *
 *   GET  /start?provider=...         → 渲染开始页(选 Claude / Codex)
 *   POST /start                       → 杀旧 awaiting → INSERT row → startLogin → redirect /:id
 *   GET  /:id                         → 渲染 awaiting/completed/failed view(自动按 state 选)
 *   GET  /:id/state.json              → 前端轮询用
 *   POST /:id/code                    → 把 code 写到 spawned 进程 stdin
 *   POST /:id/cancel                  → SIGTERM + state='failed' (user_cancelled)
 */

import express from 'express'
import path from 'node:path'
import { requireUser } from '../../middleware/auth.js'
import { randomId } from '../../services/crypto.js'
import {
  startLogin,
  submitCode,
  cancel,
  killUserActiveSessions,
  reconcileSession,
  getInMemorySession,
  constants as bridgeConstants,
} from '../../services/oauth-bridge.js'

const router = express.Router()
router.use(requireUser)

const VALID_PROVIDERS = new Set(['anthropic', 'openai'])

function getDb(req) {
  return req.app.locals.db
}

function flash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

// GET /start
router.get('/start', (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase()
  if (VALID_PROVIDERS.has(provider)) {
    // 简化:直接走 POST 等价逻辑 — 但为了避免 GET 副作用,渲染一个带预选的开始页。
    return res.render('account/oauth/start', {
      title: '绑定订阅(OAuth)',
      preselect: provider,
      mockClaude: (process.env.CLAUDE_BIN || '').toLowerCase() === 'mock',
      mockCodex: (process.env.CODEX_BIN || '').toLowerCase() === 'mock',
    })
  }
  res.render('account/oauth/start', {
    title: '绑定订阅(OAuth)',
    preselect: '',
    mockClaude: (process.env.CLAUDE_BIN || '').toLowerCase() === 'mock',
    mockCodex: (process.env.CODEX_BIN || '').toLowerCase() === 'mock',
  })
})

// POST /start
router.post('/start', (req, res) => {
  const db = getDb(req)
  const userId = req.user.id
  const provider = String(req.body.provider || '').toLowerCase()
  if (!VALID_PROVIDERS.has(provider)) {
    flash(req, 'error', '无效 provider')
    return res.redirect('/account/oauth/start')
  }

  // 杀掉旧的 awaiting 会话
  try {
    killUserActiveSessions(db, userId, req)
  } catch (e) {
    console.error('[oauth route] killUserActiveSessions failed:', e.message)
  }

  // 创建 session 行
  const sessionId = randomId('oauth')
  const stageHome = bridgeConstants.stageHomeFor(userId, sessionId)
  const expiresAt = new Date(Date.now() + bridgeConstants.TIMEOUT_MS).toISOString()
  try {
    db.prepare(
      `INSERT INTO oauth_bind_sessions
         (id, user_id, provider, stage_home_path, state, expires_at)
       VALUES (?, ?, ?, ?, 'awaiting_url', ?)`
    ).run(sessionId, userId, provider, stageHome, expiresAt)
  } catch (e) {
    console.error('[oauth route] INSERT session failed:', e.message)
    flash(req, 'error', `创建会话失败:${e.message}`)
    return res.redirect('/account/oauth/start')
  }

  // 异步 spawn — 立即返回
  try {
    startLogin({ db, sessionId, userId, provider, req })
  } catch (e) {
    console.error('[oauth route] startLogin threw:', e.message)
    // startLogin 内部应已经把 row 标 failed,不再处理
  }

  res.redirect(`/account/oauth/${encodeURIComponent(sessionId)}`)
})

function loadOwnSession(req, res) {
  const db = getDb(req)
  const id = String(req.params.id || '')
  const row = reconcileSession(db, id, req)
  if (!row) {
    res.status(404).render('error', { title: 'Not Found', message: '会话不存在' })
    return null
  }
  if (row.user_id !== req.user.id) {
    res.status(403).render('error', { title: 'Forbidden', message: '无权访问该会话' })
    return null
  }
  return row
}

// GET /:id  按 state 渲染对应视图
router.get('/:id', (req, res) => {
  const row = loadOwnSession(req, res)
  if (!row) return
  if (row.state === 'completed') {
    return res.render('account/oauth/completed', {
      title: '绑定成功',
      session: row,
    })
  }
  if (row.state === 'failed' || row.state === 'timeout') {
    return res.render('account/oauth/failed', {
      title: '绑定失败',
      session: row,
    })
  }
  // awaiting_url / awaiting_code
  // codex device-auth 流:把内存里的 device_code 一并塞进视图
  const mem = getInMemorySession(row.id)
  res.render('account/oauth/awaiting', {
    title: '正在绑定…',
    session: row,
    deviceCode: (mem && mem.deviceCode) || null,
  })
})

// GET /:id/state.json
router.get('/:id/state.json', (req, res) => {
  const db = getDb(req)
  const id = String(req.params.id || '')
  const row = reconcileSession(db, id, req)
  if (!row) return res.status(404).json({ error: 'not_found' })
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' })
  const finished = row.state === 'completed' || row.state === 'failed' || row.state === 'timeout'
  const mem = getInMemorySession(row.id)
  res.json({
    id: row.id,
    state: row.state,
    prompt_url: row.prompt_url || null,
    device_code: (mem && mem.deviceCode) || null,
    error_message: row.error_message || null,
    finished,
  })
})

// POST /:id/code
router.post('/:id/code', (req, res) => {
  const db = getDb(req)
  const row = loadOwnSession(req, res)
  if (!row) return
  if (row.state !== 'awaiting_code') {
    flash(req, 'error', `会话当前状态(${row.state})不允许提交 code`)
    return res.redirect(`/account/oauth/${encodeURIComponent(row.id)}`)
  }
  const code = String(req.body.code || '').trim()
  if (!code) {
    flash(req, 'error', '请粘贴授权 code')
    return res.redirect(`/account/oauth/${encodeURIComponent(row.id)}`)
  }
  const r = submitCode({ db, sessionId: row.id, code, req })
  if (!r.ok) {
    flash(req, 'error', `提交失败:${r.error}`)
  }
  res.redirect(`/account/oauth/${encodeURIComponent(row.id)}`)
})

// POST /:id/cancel
router.post('/:id/cancel', (req, res) => {
  const db = getDb(req)
  const row = loadOwnSession(req, res)
  if (!row) return
  if (row.state === 'completed') {
    flash(req, 'error', '已完成,无法取消')
    return res.redirect(`/account/oauth/${encodeURIComponent(row.id)}`)
  }
  cancel({ db, sessionId: row.id, reason: 'user_cancelled', req })
  flash(req, 'ok', '已取消该绑定会话')
  res.redirect('/account/credentials')
})

export default router
