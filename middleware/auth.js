/**
 * 认证中间件:
 *   loadUser   — 任何请求都跑,如果 session 里有 user_id 就把 user 挂到 req.user 和 res.locals.user
 *   requireUser — 没登录 → 重定向 /login?next=...
 *   requireAdmin — 没登录或非 admin → 403
 *
 * 用法(server.js):
 *   app.use(loadUser(db))
 *   app.use('/admin', requireAdmin, adminRouter)
 *   app.use('/account', requireUser, accountRouter)
 */

export function loadUser(db) {
  const stmt = db.prepare('SELECT id, email, display_name, role, is_active FROM users WHERE id = ?')
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
    req.user = u
    res.locals.user = u
    next()
  }
}

export function requireUser(req, res, next) {
  if (!req.user) {
    const next_ = encodeURIComponent(req.originalUrl)
    return res.redirect(`/login?next=${next_}`)
  }
  next()
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
