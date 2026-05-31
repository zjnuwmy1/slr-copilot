/**
 * /account/api-tokens — P1.1:个人 API token 管理。
 *
 * 挂载(server.js):
 *   app.use('/account/api-tokens', requireUser, accountApiTokensRouter)
 *
 * token 明文只在生成后这一次显示(POST 后直接 render,带 newToken;不存、不 redirect)。
 * 之后只能看到 label / 创建时间 / 最后使用 / 是否吊销。
 */

import { Router } from 'express'
import { generateApiToken, listApiTokens, revokeApiToken } from '../../services/api-tokens.js'
import { audit } from '../../services/audit.js'

const router = Router()

function flash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const tokens = listApiTokens(db, req.user.id)
  res.render('account/api-tokens', {
    title: 'API 访问令牌',
    tokens,
    newToken: null,
    apiBase: `${req.protocol}://${req.get('host')}`,
  })
})

// POST /account/api-tokens — 生成新 token,明文只此一次显示
router.post('/', (req, res) => {
  const db = req.app.locals.db
  const label = String(req.body.label || '').trim().slice(0, 100) || null
  let created = null
  try {
    created = generateApiToken(db, { userId: req.user.id, label })
    audit(db, req, {
      eventType: 'api_token_created',
      userId: req.user.id,
      payload: { token_id: created.id, label },   // 明文绝不进 audit
    })
  } catch (e) {
    flash(req, 'error', '生成失败:' + (e?.message || e))
    return res.redirect('/account/api-tokens')
  }
  const tokens = listApiTokens(db, req.user.id)
  res.render('account/api-tokens', {
    title: 'API 访问令牌',
    tokens,
    newToken: created.token,   // 明文 — 仅此一次
    apiBase: `${req.protocol}://${req.get('host')}`,
  })
})

// POST /account/api-tokens/:id/revoke — 吊销
router.post('/:id/revoke', (req, res) => {
  const db = req.app.locals.db
  const ok = revokeApiToken(db, { userId: req.user.id, tokenId: req.params.id })
  if (ok) {
    audit(db, req, {
      eventType: 'api_token_revoked',
      userId: req.user.id,
      payload: { token_id: req.params.id },
    })
    flash(req, 'success', '令牌已吊销。使用此令牌的 agent / CLI 将立即失效。')
  } else {
    flash(req, 'error', '吊销失败(令牌不存在或已吊销)。')
  }
  res.redirect('/account/api-tokens')
})

export default router
