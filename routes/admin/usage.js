import express from 'express'

const router = express.Router()

/**
 * GET /admin/usage — LLM 使用记录列表
 * 支持过滤:
 *   ?user=<user_id|email>
 *   ?provider=anthropic|openai
 *   ?status=success|rate_limited|timeout|error|quota_exceeded
 *   ?since=YYYY-MM-DD
 *   ?limit=200(默认 200,最大 1000)
 */
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000)

  const where = []
  const params = []

  if (req.query.user) {
    const u = String(req.query.user).trim().toLowerCase()
    const userRow = db.prepare('SELECT id FROM users WHERE id = ? OR email = ?').get(u, u)
    if (userRow) {
      where.push('ul.user_id = ?')
      params.push(userRow.id)
    } else {
      where.push('1=0')
    }
  }
  if (req.query.provider && ['anthropic', 'openai'].includes(req.query.provider)) {
    where.push('ul.provider = ?')
    params.push(req.query.provider)
  }
  if (req.query.status) {
    where.push('ul.status = ?')
    params.push(String(req.query.status))
  }
  if (req.query.since) {
    where.push('ul.started_at >= ?')
    params.push(String(req.query.since))
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT ul.id, ul.user_id, u.email AS user_email, u.display_name,
           ul.action_type, ul.provider, ul.auth_type, ul.model,
           ul.prompt_tokens, ul.completion_tokens, ul.duration_ms,
           ul.status, ul.error_message, ul.started_at, ul.finished_at
    FROM usage_logs ul
    LEFT JOIN users u ON u.id = ul.user_id
    ${whereSql}
    ORDER BY ul.started_at DESC
    LIMIT ?
  `).all(...params, limit)

  // 简要汇总:今天 / 7 天 / 30 天调用次数 + 错误率
  const summary = db.prepare(`
    SELECT
      SUM(CASE WHEN started_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS d1_total,
      SUM(CASE WHEN started_at >= datetime('now', '-1 day') AND status != 'success' THEN 1 ELSE 0 END) AS d1_errors,
      SUM(CASE WHEN started_at >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS d7_total,
      SUM(CASE WHEN started_at >= datetime('now', '-30 day') THEN 1 ELSE 0 END) AS d30_total
    FROM usage_logs
  `).get()

  res.render('admin/usage', {
    title: '使用记录',
    rows,
    summary: summary || { d1_total: 0, d1_errors: 0, d7_total: 0, d30_total: 0 },
    filters: {
      user: req.query.user || '',
      provider: req.query.provider || '',
      status: req.query.status || '',
      since: req.query.since || '',
      limit,
    },
  })
})

/**
 * GET /admin/usage/by-user-model — 用户 × 模型 用量矩阵
 *   ?days=7|30|90|all(默认 30)
 */
router.get('/by-user-model', (req, res) => {
  const db = req.app.locals.db
  const daysQ = String(req.query.days || '30').trim()
  const days = ['7', '30', '90', 'all'].includes(daysQ) ? daysQ : '30'

  const whereParts = []
  const params = []
  if (days !== 'all') {
    whereParts.push(`ul.started_at >= datetime('now', '-${parseInt(days, 10)} day')`)
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''

  const rows = db.prepare(`
    SELECT
      ul.user_id,
      COALESCE(u.email, '(已删)') AS user_email,
      COALESCE(u.display_name, '') AS user_name,
      u.step_model_preset AS user_preset,
      ul.provider,
      COALESCE(ul.model, '(未知)') AS model,
      ul.action_type,
      COUNT(*) AS calls,
      SUM(CASE WHEN ul.status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN ul.status != 'success' THEN 1 ELSE 0 END) AS errors,
      SUM(COALESCE(ul.prompt_tokens, 0)) AS in_tokens,
      SUM(COALESCE(ul.completion_tokens, 0)) AS out_tokens,
      SUM(COALESCE(ul.duration_ms, 0)) AS total_ms,
      MAX(ul.started_at) AS last_call_at
    FROM usage_logs ul
    LEFT JOIN users u ON u.id = ul.user_id
    ${whereSql}
    GROUP BY ul.user_id, ul.provider, ul.model, ul.action_type
    ORDER BY user_email ASC, calls DESC
  `).all(...params)

  // 汇总到 (user, model) 二维(各 action_type 合并),给 UI 主视图用
  const byUserModel = {}
  // 也按 (user) 总和 + (model) 总和给小计
  const userTotals = {}
  const modelTotals = {}
  for (const r of rows) {
    const userKey = r.user_id || '_null'
    const modelKey = `${r.provider}|${r.model}`
    const cellKey = `${userKey}::${modelKey}`
    if (!byUserModel[cellKey]) {
      byUserModel[cellKey] = {
        user_id: r.user_id, user_email: r.user_email, user_name: r.user_name, user_preset: r.user_preset,
        provider: r.provider, model: r.model,
        calls: 0, success: 0, errors: 0,
        in_tokens: 0, out_tokens: 0, total_ms: 0,
        last_call_at: null, by_action: {},
      }
    }
    const c = byUserModel[cellKey]
    c.calls += r.calls
    c.success += r.success
    c.errors += r.errors
    c.in_tokens += r.in_tokens
    c.out_tokens += r.out_tokens
    c.total_ms += r.total_ms
    if (!c.last_call_at || r.last_call_at > c.last_call_at) c.last_call_at = r.last_call_at
    c.by_action[r.action_type] = (c.by_action[r.action_type] || 0) + r.calls

    if (!userTotals[userKey]) userTotals[userKey] = { user_email: r.user_email, calls: 0, in_tokens: 0, out_tokens: 0 }
    userTotals[userKey].calls += r.calls
    userTotals[userKey].in_tokens += r.in_tokens
    userTotals[userKey].out_tokens += r.out_tokens

    if (!modelTotals[modelKey]) modelTotals[modelKey] = { provider: r.provider, model: r.model, calls: 0, in_tokens: 0, out_tokens: 0 }
    modelTotals[modelKey].calls += r.calls
    modelTotals[modelKey].in_tokens += r.in_tokens
    modelTotals[modelKey].out_tokens += r.out_tokens
  }
  const cells = Object.values(byUserModel).sort((a, b) =>
    (a.user_email || '').localeCompare(b.user_email || '') || b.calls - a.calls
  )

  res.render('admin/usage-by-user-model', {
    title: '用量按用户 × 模型',
    cells,
    userTotals: Object.values(userTotals).sort((a, b) => b.calls - a.calls),
    modelTotals: Object.values(modelTotals).sort((a, b) => b.calls - a.calls),
    days,
  })
})

export default router
