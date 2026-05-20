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

export default router
