/**
 * /admin/platform-credentials — 超级管理员配置平台共享凭证。
 *
 * 整个 router 在 server.js 用 requireSuperAdmin 保护:
 *   app.use('/admin/platform-credentials', requireSuperAdmin, platformCredentialsRouter)
 *
 * 路径(相对挂载点):
 *   GET    /                            → 配置页(显示当前 anthropic / openai 平台凭证 + 可选列表)
 *   POST   /:provider/set               body credential_id → 设为平台凭证
 *   POST   /:provider/clear             清除该 provider 的平台凭证
 */

import { Router } from 'express'
import {
  listPlatformCredentials,
  setPlatformCredential,
  clearPlatformCredential,
  PROVIDERS,
} from '../../services/platform-credentials.js'
import { listForUser } from '../../services/credentials.js'
import { audit } from '../../services/audit.js'

const router = Router()

function flash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const current = listPlatformCredentials(db)
  // 列超管自己拥有的、active 的凭证(只有自己的可以被选成平台默认)
  const myCreds = listForUser(db, req.user.id).filter((c) => c.status === 'active')
  // 按 provider 分组
  const byProvider = {}
  for (const p of PROVIDERS) {
    byProvider[p] = myCreds.filter((c) => c.provider === p)
  }
  res.render('admin/platform-credentials', {
    title: '平台凭证(共享给所有用户)',
    current,
    byProvider,
    providers: PROVIDERS,
  })
})

router.post('/:provider/set', (req, res) => {
  const db = req.app.locals.db
  const provider = String(req.params.provider).toLowerCase()
  const credentialId = String(req.body.credential_id || '').trim()
  try {
    setPlatformCredential(db, { provider, credentialId, setByUserId: req.user.id })
    audit(db, req, {
      eventType: 'platform_credential_set',
      userId: req.user.id,
      actorUserId: req.user.id,
      payload: { provider, credential_id: credentialId },
    })
    flash(req, 'success', `${provider} 平台凭证已设为该条`)
  } catch (e) {
    flash(req, 'error', '设置失败:' + e.message)
  }
  res.redirect('/admin/platform-credentials')
})

router.post('/:provider/clear', (req, res) => {
  const db = req.app.locals.db
  const provider = String(req.params.provider).toLowerCase()
  try {
    clearPlatformCredential(db, { provider, updatedByUserId: req.user.id })
    audit(db, req, {
      eventType: 'platform_credential_cleared',
      userId: req.user.id,
      actorUserId: req.user.id,
      payload: { provider },
    })
    flash(req, 'success', `${provider} 平台凭证已清除 —— 所有普通用户暂时无法调用 ${provider}`)
  } catch (e) {
    flash(req, 'error', '清除失败:' + e.message)
  }
  res.redirect('/admin/platform-credentials')
})

export default router
