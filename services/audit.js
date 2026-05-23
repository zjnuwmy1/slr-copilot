/**
 * 审计日志:每个关键事件都落一条到 audit_events 表。
 * 使用方式:audit(db, req, { eventType, ... })
 *
 * 行为细节(Batch 4 调整):
 *   • B4.2:payload JSON.stringify 后做长度兜底
 *       - length ≤ 10_000      → 正常写入
 *       - 10_000 < length ≤ 50_000 → 写入但 console.warn(提示有热点)
 *       - length > 50_000      → 截断为 `{ _truncated, _original_size, _excerpt }`
 *         (前 2_000 字符做摘要)+ console.warn
 *     目的:防止某次 LLM 调用的 raw response 几 MB 直接灌进 audit_events,
 *     既撑爆 DB 又拖慢 /admin/audit 列表查询。
 *
 *   • B4.3:JSON.stringify + INSERT 放进 setImmediate
 *     better-sqlite3 是同步的,prepare/run 本身就阻塞调用线程;
 *     脱离当前 tick 让 caller 的响应先发出去,audit 写入排队到下一轮 event loop。
 *     audit 失败绝对不能影响业务,所有异常吞掉只 console.error。
 */

const PAYLOAD_WARN_THRESHOLD = 10_000   // 字符,超过 warn
const PAYLOAD_HARD_LIMIT     = 50_000   // 字符,超过截断
const PAYLOAD_EXCERPT_CHARS  = 2_000    // 截断时保留的前缀长度

function serializePayload(eventType, payload) {
  if (payload == null) return null
  let s
  try {
    s = JSON.stringify(payload)
  } catch (e) {
    // 含循环引用 / BigInt 等,降级为 String(payload)
    console.warn('[audit] payload stringify failed for', eventType, '-', e.message)
    return JSON.stringify({ _stringify_failed: true, _type_of: typeof payload, _error: e.message })
  }
  if (s == null) return null

  if (s.length > PAYLOAD_HARD_LIMIT) {
    console.warn(
      `[audit] payload too large for ${eventType}: ${s.length} chars > ${PAYLOAD_HARD_LIMIT}; truncating`
    )
    return JSON.stringify({
      _truncated: true,
      _original_size: s.length,
      _excerpt: s.slice(0, PAYLOAD_EXCERPT_CHARS),
    })
  }

  if (s.length > PAYLOAD_WARN_THRESHOLD) {
    console.warn(
      `[audit] payload large for ${eventType}: ${s.length} chars (writing in full but consider trimming caller)`
    )
  }

  return s
}

export function audit(db, req, {
  eventType,
  userId = null,
  actorUserId = null,
  targetUserId = null,
  projectId = null,
  payload = null,
}) {
  // 在当前 tick 抓快照(req 在 setImmediate 时可能已被回收,提前取出基本字段)
  const ip = req?.ip ?? null
  const ua = req?.get?.('user-agent')?.slice(0, 500) ?? null
  const effectiveActor = actorUserId ?? userId

  setImmediate(() => {
    try {
      const payloadStr = serializePayload(eventType, payload)
      db.prepare(`
        INSERT INTO audit_events
          (project_id, user_id, actor_user_id, event_type, target_user_id, payload, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        userId,
        effectiveActor,
        eventType,
        targetUserId,
        payloadStr,
        ip,
        ua,
      )
    } catch (e) {
      // audit 不能影响业务 — 吞掉所有异常,只留 server log
      console.error('[audit] failed to log event:', eventType, e.message)
    }
  })
}
