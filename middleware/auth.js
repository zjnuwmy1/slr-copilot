/**
 * 认证中间件:
 *   loadUser         — 任何请求都跑,如果 session 里有 user_id 就把 user 挂到 req.user / res.locals.user
 *   requireUser      — 没登录 → 重定向 /login?next=...
 *   requireAdmin     — 没登录或非 admin(普通管理员或超管均可)→ 403
 *   requireSuperAdmin — 必须是超级管理员;否则 403
 *
 * 用法(server.js):
 *   app.use(loadUser(db))
 *   app.use('/admin', requireAdmin, adminRouter)
 *   app.use('/admin/platform-credentials', requireSuperAdmin, platformCredentialsRouter)
 *   app.use('/account', requireUser, accountRouter)
 */

import { verifyApiToken } from '../services/api-tokens.js'

export function loadUser(db) {
  // B1.5:storage_quota_bytes 必须包进来 — 否则 req.user 传给 effectiveQuotaForUser 时 storage_quota_bytes=undefined,
  //       超管为用户显式设置的配额(比如改成 3 GB)会被静默忽略,fallback 回默认 1 GB,导致上传错误拒绝/放行。
  const stmt = db.prepare(
    'SELECT id, email, display_name, role, is_active, is_super_admin, advanced_extraction_enabled, storage_quota_bytes FROM users WHERE id = ?'
  )
  return function loadUserMiddleware(req, res, next) {
    res.locals.user = null
    req.user = null
    const uid = req.session?.user_id
    if (!uid) return next()
    const u = stmt.get(uid)
    if (!u || !u.is_active) {
      req.session = null
      return next()
    }
    // 规整化 boolean
    u.is_super_admin = !!u.is_super_admin
    u.advanced_extraction_enabled = !!u.advanced_extraction_enabled
    req.user = u
    res.locals.user = u
    next()
  }
}

/**
 * requireAdvancedExtraction — 守 batch AI 抽取 / PDF 上传等高级功能。
 *   超管 / admin 默认有(migration 自动开),普通用户需要超管手动 toggle。
 *   不通过 → 403 + 友好提示走"下载 xlsx 手动填"流程。
 */
export function requireAdvancedExtraction(req, res, next) {
  if (!req.user) {
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
  // toggle 是单一权威源(advanced_extraction_enabled)。
  // 仅 super admin 兜底放行 — 避免超管不小心把自己关了之后无法自救。
  // 普通 admin 不再 fallback,toggle=0 就 lock(超管可在 /admin/users 帮其开回)。
  if (req.user.advanced_extraction_enabled || req.user.is_super_admin) {
    return next()
  }
  // JSON 模式
  if ((req.get('Accept') || '').includes('application/json') ||
      req.get('X-Requested-With') === 'XMLHttpRequest') {
    return res.status(403).json({
      ok: false,
      error: 'advanced_extraction_disabled',
      message: '此功能(AI 批量抽取 / PDF 上传)需要管理员开通。请联系管理员,或使用下载 XLSX 模板手动填写。',
    })
  }
  return res.status(403).render('error', {
    title: 'Forbidden',
    message: '此功能(AI 批量抽取 / PDF 上传)需要管理员开通。请联系管理员,或在矩阵页用"下载 XLSX 模板 + 复制总 prompt"手动填写。',
  })
}

export function requireUser(req, res, next) {
  if (!req.user) {
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
  next()
}

/**
 * requireApiOrUser(db) — P1.1:程序化入口认证。
 *   - 先认 `Authorization: Bearer slr_xxx`(查 api_tokens)。命中 → 把对应 user 挂 req.user,
 *     req.authVia='api_token',并强制走 JSON 响应语义(agent / CLI 客户端)。
 *   - 否则回退到 cookie-session(loadUser 已经在前面跑过,req.user 可能已就绪)。
 *   - 两者都没有 → 401 JSON(带 Bearer token 但无效)或重定向 /login(纯浏览器)。
 *
 *   用法(工厂,需要 db 查 token):
 *     app.use('/api', requireApiOrUser(db), apiRouter)
 *   也可挂在已有路由前替换 requireUser,让同一路由既服务网页又服务 agent。
 */
export function requireApiOrUser(db) {
  return function requireApiOrUserMiddleware(req, res, next) {
    const authHeader = req.get('Authorization') || ''
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
    if (m && m[1]) {
      const token = m[1].trim()
      let user = null
      try { user = verifyApiToken(db, token) } catch (e) { console.warn('[auth] verifyApiToken threw:', e?.message) }
      if (user) {
        req.user = user
        res.locals.user = user
        req.authVia = 'api_token'
        return next()
      }
      // 提供了 Bearer 但无效 → 明确 401(不静默回退 session,避免误导)
      return res.status(401).json({ ok: false, error: 'invalid_api_token' })
    }

    // 无 Bearer → 回退 cookie-session(loadUser 已挂 req.user)
    if (req.user) {
      req.authVia = req.authVia || 'session'
      return next()
    }
    // 都没有 → JSON 客户端 401,浏览器重定向登录。
    //   注意:app.use('/api', mw) 下 req.path 已被剥掉 /api 前缀,要用 originalUrl / baseUrl 判断。
    const wantsJson =
      (req.get('Accept') || '').includes('application/json') ||
      req.get('X-Requested-With') === 'XMLHttpRequest' ||
      (req.originalUrl || '').startsWith('/api/') ||
      (req.baseUrl || '').startsWith('/api')
    if (wantsJson) {
      return res.status(401).json({ ok: false, error: 'authentication_required' })
    }
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Forbidden', message: '需要管理员权限' })
  }
  next()
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
  if (!req.user.is_super_admin) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: '此操作仅超级管理员可执行',
    })
  }
  next()
}
