/**
 * Quota service — 在 LLM 调用前校验用户是否超限。
 * 配额来自 user_quotas 表(可能没行 = 全无限制)。
 *
 * 调用方:services/llm.js
 */

export function checkQuotaBeforeCall(db, { userId, provider, authType }) {
  const q = db.prepare('SELECT * FROM user_quotas WHERE user_id = ?').get(userId)
  if (!q) return { ok: true }

  // 1) provider 白名单
  if (q.allowed_providers) {
    try {
      const allowed = JSON.parse(q.allowed_providers)
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(provider)) {
        return {
          ok: false,
          reason: 'provider_not_allowed',
          message: `当前配额禁止使用 ${provider}(允许:${allowed.join(', ')})`,
        }
      }
    } catch {
      // 损坏 JSON 当不限制处理
    }
  }

  // 2) auth_type 白名单
  if (q.allowed_auth_types) {
    try {
      const allowed = JSON.parse(q.allowed_auth_types)
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(authType)) {
        return {
          ok: false,
          reason: 'auth_type_not_allowed',
          message: `当前配额禁止使用 ${authType}(允许:${allowed.join(', ')})`,
        }
      }
    } catch {
      // 损坏 JSON 当不限制处理
    }
  }

  // 3) 24h 调用次数上限
  if (q.daily_call_limit != null) {
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_logs
         WHERE user_id = ? AND started_at >= datetime('now', '-1 day')`
      )
      .get(userId)
    if (count >= q.daily_call_limit) {
      return {
        ok: false,
        reason: 'daily_call_limit_exceeded',
        message: `24h 内已调用 ${count}/${q.daily_call_limit} 次`,
      }
    }
  }

  // 4) 30d token 上限(只有 API key 路径有真实 token 数据)
  if (q.monthly_token_limit != null) {
    const { tokens } = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)), 0) AS tokens
         FROM usage_logs
         WHERE user_id = ? AND started_at >= datetime('now', '-30 day') AND status = 'success'`
      )
      .get(userId)
    if (tokens >= q.monthly_token_limit) {
      return {
        ok: false,
        reason: 'monthly_token_limit_exceeded',
        message: `30 天内已用 ${tokens}/${q.monthly_token_limit} tokens`,
      }
    }
  }

  return { ok: true }
}
