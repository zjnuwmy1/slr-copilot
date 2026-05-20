import express from 'express'

const router = express.Router()

/**
 * GET /admin/audit — 审计日志列表
 * 支持过滤:
 *   ?user=<user_id|email>
 *   ?event=<event_type>
 *   ?since=YYYY-MM-DD
 *   ?limit=300(默认 300,最大 2000)
 */
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 300, 1), 2000)

  const where = []
  const params = []

  if (req.query.user) {
    const u = String(req.query.user).trim().toLowerCase()
    const userRow = db.prepare('SELECT id FROM users WHERE id = ? OR email = ?').get(u, u)
    if (userRow) {
      where.push('(ae.user_id = ? OR ae.actor_user_id = ? OR ae.target_user_id = ?)')
      params.push(userRow.id, userRow.id, userRow.id)
    } else {
      where.push('1=0')
    }
  }
  if (req.query.event) {
    where.push('ae.event_type = ?')
    params.push(String(req.query.event))
  }
  if (req.query.since) {
    where.push('ae.created_at >= ?')
    params.push(String(req.query.since))
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT ae.id, ae.event_type, ae.user_id, ae.actor_user_id, ae.target_user_id,
           u_user.email AS user_email,
           u_actor.email AS actor_email,
           u_target.email AS target_email,
           ae.payload, ae.ip_address, ae.user_agent, ae.created_at
    FROM audit_events ae
    LEFT JOIN users u_user ON u_user.id = ae.user_id
    LEFT JOIN users u_actor ON u_actor.id = ae.actor_user_id
    LEFT JOIN users u_target ON u_target.id = ae.target_user_id
    ${whereSql}
    ORDER BY ae.id DESC
    LIMIT ?
  `).all(...params, limit)

  // 解析 payload JSON,方便模板渲染
  for (const r of rows) {
    if (r.payload) {
      try { r.payloadParsed = JSON.parse(r.payload) } catch { r.payloadParsed = null }
    }
  }

  // 已出现过的 event_type 列表(filter dropdown 用)
  const eventTypes = db.prepare(`
    SELECT DISTINCT event_type FROM audit_events ORDER BY event_type
  `).all().map(r => r.event_type)

  res.render('admin/audit', {
    title: '审计日志',
    rows,
    eventTypes,
    filters: {
      user: req.query.user || '',
      event: req.query.event || '',
      since: req.query.since || '',
      limit,
    },
  })
})

export default router
