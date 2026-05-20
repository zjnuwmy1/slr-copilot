/**
 * services/credential-sharing.js
 * ================================================================
 * 凭证共享 facade(Agent Q)。
 *
 * 设计说明:
 *   底层实现实际写在 services/credentials.js 里(Agent B 阶段就一并落地了
 *   credential_shares 表的 CRUD,llm.js 已经在用),为了不破坏既有 API,
 *   这里只做一层 thin facade,把对外 API 暴露成本任务规格里的命名:
 *
 *     shareCredential               → credentials.shareCredentialWithEmail
 *     unshareCredential             → credentials.unshareCredential
 *     listSharesOfCredential        → credentials.listSharesOfCredential (+ ownership 检查)
 *     listCredentialsSharedToUser   → credentials.listSharedWithUser
 *     listAllUsableCredentialsFor   → credentials.listUsableForUser  (owner 优先)
 *
 * 这样路由层 / 视图层既可以用 facade 名(新代码),也可以保持现有 import
 * (老代码不动);两条路径走的都是同一份 SQL,不会出现行为漂移。
 *
 * 安全约束(由底层函数实现 + 这里再做一道断言):
 *   - shareCredential: owner 必须真的拥有 credentialId;target 必须 active;
 *     不允许 self;重复 share 同一人 → UPSERT 仅更新 notes。
 *   - unshareCredential: WHERE user_id = ownerUserId 防越权。
 *   - listSharesOfCredential: 这一层加 ownership 检查,只有 owner 看得到。
 *   - listCredentialsSharedToUser: 不含自己拥有的,只列共享给我的。
 *   - listAllUsableCredentialsFor: owner 自有的排前面,共享的排后面;
 *     每行带 is_own:true|false 标记,llm router 可据此优先。
 *
 * 审计:
 *   credential_shared / credential_unshared 由调用方(路由层)落 audit,
 *   因为 audit 需要 req(ip / ua),这里不直接依赖 express。
 */

import * as creds from './credentials.js'

/**
 * Owner 把自己的某条凭证共享给指定 email 的用户。
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.credentialId
 * @param {string} args.ownerUserId
 * @param {string} args.targetUserEmail
 * @param {string} [args.notes]
 * @returns {{ ok: boolean, error?: string, target_user_id?: string, target_email?: string }}
 */
export function shareCredential(db, { credentialId, ownerUserId, targetUserEmail, notes }) {
  const r = creds.shareCredentialWithEmail(db, {
    credentialId,
    ownerUserId,
    targetEmail: targetUserEmail,
    notes,
  })
  if (r.ok) {
    return { ok: true, target_user_id: r.targetUserId, target_email: r.targetEmail }
  }
  return { ok: false, error: r.reason, detail: r.detail }
}

/**
 * Owner 取消共享。
 */
export function unshareCredential(db, { credentialId, ownerUserId, targetUserId }) {
  const r = creds.unshareCredential(db, { credentialId, ownerUserId, targetUserId })
  if (r.ok) return { ok: true }
  return { ok: false, error: r.reason || 'unshare_failed' }
}

/**
 * Owner 看自己某条凭证当前共享给了谁。
 * 多做一道 ownership 检查 — 即便底层 SQL 没限制,这里也防被非 owner 拿到列表。
 *
 * @returns {Array<{ target_user_id: string, target_email: string, shared_at: string, notes: string|null }>}
 */
export function listSharesOfCredential(db, { credentialId, ownerUserId }) {
  // ownership 断言
  const own = db
    .prepare(`SELECT id FROM user_credentials WHERE id = ? AND user_id = ?`)
    .get(credentialId, ownerUserId)
  if (!own) return []

  const rows = creds.listSharesOfCredential(db, credentialId)
  return rows.map((r) => ({
    target_user_id: r.user_id,
    target_email: r.email,
    target_display_name: r.display_name || null,
    target_is_active: !!r.is_active,
    shared_at: r.created_at,
    notes: r.notes || null,
  }))
}

/**
 * 用户看哪些凭证被共享到自己(不含自己拥有的)。
 *
 * @returns {Array<{ credential_id, owner_user_id, owner_email, provider, auth_type, label, status, shared_at, notes }>}
 */
export function listCredentialsSharedToUser(db, userId) {
  const rows = creds.listSharedWithUser(db, userId)
  return rows.map((r) => ({
    credential_id: r.id,
    owner_user_id: r.shared_by_user_id,
    owner_email: r.owner_email,
    provider: r.provider,
    auth_type: r.auth_type,
    label: r.label,
    status: r.status,
    last_validated_at: r.last_validated_at,
    last_used_at: r.last_used_at,
    shared_at: r.shared_at,
    notes: r.notes || null,
  }))
}

/**
 * 该用户能用的全部凭证(自己 + 共享给自己),自己的排前面。
 * llm router 应该走这个函数选第一条 active。
 *
 * @returns {Array<{ credential_id, owner_user_id, is_own: boolean, provider, auth_type, label, status, ... }>}
 */
export function listAllUsableCredentialsFor(db, userId) {
  const rows = creds.listUsableForUser(db, userId) // 已经 owner-first 排序
  return rows.map((r) => ({
    credential_id: r.id,
    owner_user_id: r.user_id ?? userId, // owner 行直接是 user_id;共享行 listUsableForUser 没有暴露 owner_user_id, 用 email 即可
    is_own: r.via === 'owner',
    provider: r.provider,
    auth_type: r.auth_type,
    label: r.label,
    status: r.status,
    last_validated_at: r.last_validated_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    owner_email: r.owner_email || null,
    via: r.via, // 'owner' | 'shared'
  }))
}

/**
 * 便捷判断:userId 是否对 credentialId 有"使用权"(owner 或被共享)。
 * 路由层做权限断言时可以用。
 */
export function canUserUseCredential(db, { userId, credentialId }) {
  const own = db
    .prepare(`SELECT 1 FROM user_credentials WHERE id = ? AND user_id = ? AND status = 'active'`)
    .get(credentialId, userId)
  if (own) return { ok: true, via: 'owner' }

  const shared = db
    .prepare(`
      SELECT 1
      FROM credential_shares cs
      JOIN user_credentials uc ON uc.id = cs.credential_id
      WHERE cs.credential_id = ? AND cs.shared_with_user_id = ? AND uc.status = 'active'
    `)
    .get(credentialId, userId)
  if (shared) return { ok: true, via: 'shared' }

  return { ok: false }
}
