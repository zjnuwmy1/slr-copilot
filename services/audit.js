/**
 * 审计日志:每个关键事件都落一条到 audit_events 表。
 * 使用方式:audit(db, req, { eventType, ... })
 */

export function audit(db, req, {
  eventType,
  userId = null,
  actorUserId = null,
  targetUserId = null,
  projectId = null,
  payload = null,
}) {
  try {
    db.prepare(`
      INSERT INTO audit_events
        (project_id, user_id, actor_user_id, event_type, target_user_id, payload, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      userId,
      actorUserId ?? userId,
      eventType,
      targetUserId,
      payload == null ? null : JSON.stringify(payload),
      req?.ip ?? null,
      req?.get?.('user-agent')?.slice(0, 500) ?? null,
    )
  } catch (e) {
    console.error('[audit] failed to log event:', eventType, e.message)
  }
}
