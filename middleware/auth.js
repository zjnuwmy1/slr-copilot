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
