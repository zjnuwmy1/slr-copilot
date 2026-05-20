/**
 * /account/credentials — 用户自助绑定 API key。
 *
 * 整体被 requireUser 保护(在 server.js 挂载时套上,也可以在 router 内部 use)。
 *
 * 路由:
 *   GET    /                  — 列表
 *   GET    /new               — 表单(?type=api_key|oauth, ?provider=...)
 *   POST   /                  — 创建(粘 API key + 测活)
 *   GET    /:id               — 详情
 *   POST   /:id/retest        — 重新测活
 *   POST   /:id/revoke        — 撤销
 *
 * 挂载方式(server.js):
 *   import credentialsRouter from './routes/account/credentials.js'
 *   app.use('/account/credentials', requireUser, credentialsRouter)
 */

import { Router } from 'express'
import { audit } from '../../services/audit.js'
import {
  createApiKeyCredential,
  revokeCredential,
  retestCredential,
  listForUser,
  getById,
  checkProviderAllowed,
} from '../../services/credentials.js'

const router = Router()

const SUPPORTED_PROVIDERS = ['anthropic', 'openai']

function setFlash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

// ============== GET / — 列表 ==============

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const credentials = listForUser(db, req.user.id)
  res.render('account/credentials/list', {
    title: '我的凭证',
    credentials,
  })
})

// ============== GET /new — 表单 ==============

router.get('/new', (req, res) => {
  const type = String(req.query.type || 'api_key')
  const provider = String(req.query.provider || 'anthropic')

  if (type === 'oauth') {
    // OAuth 流由 Agent C 实现;这里只转发
    const p = SUPPORTED_PROVIDERS.includes(provider) ? provider : 'anthropic'
    return res.redirect(`/account/oauth/start?provider=${encodeURIComponent(p)}`)
  }

  res.render('account/credentials/new', {
    title: '添加 API Key',
    selectedProvider: SUPPORTED_PROVIDERS.includes(provider) ? provider : 'anthropic',
    label: '',
    error: null,
  })
})

// ============== POST / — 创建 ==============

router.post('/', async (req, res) => {
  const db = req.app.locals.db
  const provider = String(req.body.provider || '').trim()
  const label = String(req.body.label || '').trim()
  const apiKey = String(req.body.api_key || '').trim()

  function fail(message, status = 400) {
    return res.status(status).render('account/credentials/new', {
      title: '添加 API Key',
      selectedProvider: SUPPORTED_PROVIDERS.includes(provider) ? provider : 'anthropic',
      label,
      error: message,
    })
  }

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return fail('请选择有效的 provider')
  }
  if (!label || label.length < 1) return fail('请填写 label')
  if (label.length > 120) return fail('label 过长(<= 120 字符)')
  if (!apiKey) return fail('请粘贴 API key')

  // quota 校验
  const denyReason = checkProviderAllowed(db, {
    userId: req.user.id,
    provider,
    authType: 'api_key',
  })
  if (denyReason) {
    return fail(denyReason, 403)
  }

  let credentialId
  try {
    credentialId = await createApiKeyCredential(db, {
      userId: req.user.id,
      provider,
      label,
      apiKey,
    })
  } catch (e) {
    // 注意:不要把 apiKey 回显
    const msg = e?.code || e?.message || 'unknown_error'
    if (msg === 'invalid_key') {
      return fail('该 API key 无效或权限不足(invalid_key)')
    }
    if (msg === 'timeout') {
      return fail('测活请求超时,请稍后再试(timeout)')
    }
    if (msg && msg.startsWith && msg.startsWith('http_')) {
      return fail(`供应商返回错误:${msg}`)
    }
    if (msg && msg.startsWith && msg.startsWith('network')) {
      return fail(`网络错误:${msg}`)
    }
    return fail(`测活失败:${msg}`)
  }

  audit(db, req, {
    eventType: 'credential_bind',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: { provider, auth_type: 'api_key', label, credential_id: credentialId },
  })

  setFlash(req, 'success', '凭证已添加并验证通过')
  res.redirect('/account/credentials')
})

// ============== GET /:id — 详情 ==============

router.get('/:id', (req, res) => {
  const db = req.app.locals.db
  const cred = getById(db, { userId: req.user.id, credentialId: req.params.id })
  if (!cred) {
    return res.status(404).render('error', {
      title: 'Not Found',
      message: '凭证不存在或不属于当前用户',
    })
  }
  res.render('account/credentials/detail', {
    title: cred.label,
    cred,
  })
})

// ============== POST /:id/retest — 重新测活 ==============

router.post('/:id/retest', async (req, res) => {
  const db = req.app.locals.db
  const credentialId = req.params.id

  // 越权检查 + 存在性
  const cred = getById(db, { userId: req.user.id, credentialId })
  if (!cred) {
    return res.status(404).render('error', {
      title: 'Not Found',
      message: '凭证不存在或不属于当前用户',
    })
  }

  const result = await retestCredential(db, { userId: req.user.id, credentialId })

  audit(db, req, {
    eventType: 'credential_validated',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: {
      credential_id: credentialId,
      provider: cred.provider,
      ok: !!result.ok,
      error: result.ok ? null : result.error,
      latency_ms: result.latencyMs,
    },
  })

  if (result.ok) {
    setFlash(req, 'success', `测活成功(${result.latencyMs} ms)`)
  } else {
    setFlash(req, 'error', `测活失败:${result.error || 'unknown'}`)
  }
  res.redirect(`/account/credentials/${encodeURIComponent(credentialId)}`)
})

// ============== POST /:id/revoke — 撤销 ==============

router.post('/:id/revoke', (req, res) => {
  const db = req.app.locals.db
  const credentialId = req.params.id

  // 越权检查
  const cred = getById(db, { userId: req.user.id, credentialId })
  if (!cred) {
    return res.status(404).render('error', {
      title: 'Not Found',
      message: '凭证不存在或不属于当前用户',
    })
  }

  const ok = revokeCredential(db, { userId: req.user.id, credentialId })

  if (ok) {
    audit(db, req, {
      eventType: 'credential_revoke',
      userId: req.user.id,
      actorUserId: req.user.id,
      payload: { credential_id: credentialId, provider: cred.provider, label: cred.label },
    })
    setFlash(req, 'success', '凭证已撤销')
  } else {
    setFlash(req, 'error', '撤销失败,凭证不存在或已撤销')
  }

  res.redirect('/account/credentials')
})

export default router
