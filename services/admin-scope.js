/**
 * admin-scope — 后台路由按邀请关系做用户可见性隔离的共享 helper。
 *
 * 规则:
 *   - super_admin       → 看所有用户、所有用户的项目、所有邀请码
 *   - 普通 admin        → 只看自己邀请的用户(invite_codes.created_by_user_id = 我
 *                          AND used_by_user_id = 目标),加上自己
 *   - 邀请码             → 普通 admin 只看 / 删自己创建的;super 看 / 删全部
 *
 * 通过 invite_codes 链路判断(谁创建的码 → 谁注册时用了该码)。
 */

/**
 * 该 admin 是否有权管理 targetUserId。
 *   - super_admin → 永远 true
 *   - admin 看自己 → 永远 true
 *   - admin 看 invite_codes 链接到自己的用户 → true
 */
export function canManageUser(req, db, targetUserId) {
  if (!req.user) return false
  if (req.user.is_super_admin) return true
  if (req.user.id === targetUserId) return true
  const row = db.prepare(
    `SELECT 1 FROM invite_codes
      WHERE created_by_user_id = ? AND used_by_user_id = ?
      LIMIT 1`
  ).get(req.user.id, targetUserId)
  return !!row
}

/**
 * 拿"该 admin 可见的所有 user_id"。
 *   super_admin → { scope: 'all' }
 *   admin       → { scope: 'invited', ids: [self, ...邀请过的] }(去重)
 *
 * B2.5:`used_by_user_id IS NOT NULL` 是关键过滤 —— 未使用的邀请码(还没人注册过)
 *       不算"被邀请的用户"。这条 SQL 永远只返回已经被某个真实用户用掉的码。
 *       未使用码的 created_by 仍归属创建者(admin 在 /admin/users 里只看自己创建的
 *       未用码,见 inviteScopeWhere)。两者维度不同,各管各的。
 *       不要把这俩混到一起 — 否则 admin 看到的"自己邀请过的人数"会算上还没注册的码。
 */
export function visibleUserScope(req, db) {
  if (!req.user) return { scope: 'invited', ids: [] }
  if (req.user.is_super_admin) return { scope: 'all' }
  const invited = db.prepare(
    `SELECT used_by_user_id AS id FROM invite_codes
      WHERE created_by_user_id = ? AND used_by_user_id IS NOT NULL`
  ).all(req.user.id).map((r) => r.id)
  const ids = Array.from(new Set([req.user.id, ...invited]))
  return { scope: 'invited', ids }
}
