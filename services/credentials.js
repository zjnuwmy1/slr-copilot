/**
 * user_credentials 中间层。
 *
 * 数据库行字段(见 db/schema.sql):
 *   id, user_id, provider ('anthropic'|'openai'),
 *   auth_type ('api_key'|'oauth'), label,
 *   credential_blob_enc (base64 AES-256-GCM),
 *   status ('active'|'expired'|'revoked'|'error'),
 *   last_validated_at, last_validation_error, last_used_at,
 *   created_at
 *
 * 对外:
 *   createApiKeyCredential(db, { userId, provider, label, apiKey }) → credentialId
 *   revokeCredential(db, { userId, credentialId }) → boolean
 *   retestCredential(db, { userId, credentialId }) → { ok, error?, latencyMs }
 *   listForUser(db, userId) → 行数组(脱敏:不含 credential_blob_enc)
 *   getById(db, { userId, credentialId }) → 行(脱敏)
 *   getDecrypted(db, { userId, credentialId }) → { provider, auth_type, label, apiKey? , ... }
 */

import { encryptJson, decryptJson, randomId } from './crypto.js'
import * as anthropicApi from './providers/anthropic-api.js'
import * as openaiApi from './providers/openai-api.js'

const SUPPORTED_PROVIDERS = ['anthropic', 'openai']

function providerAdapter(provider) {
  if (provider === 'anthropic') return anthropicApi
  if (provider === 'openai') return openaiApi
  throw new Error(`unsupported provider: ${provider}`)
}

const SAFE_COLUMNS = `
  id, user_id, provider, auth_type, label, status,
  last_validated_at, last_validation_error, last_used_at, created_at
`

export function listForUser(db, userId) {
  return db
    .prepare(
      `SELECT ${SAFE_COLUMNS}
       FROM user_credentials
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
    .all(userId)
}

export function getById(db, { userId, credentialId }) {
  return db
    .prepare(
      `SELECT ${SAFE_COLUMNS}
       FROM user_credentials
       WHERE id = ? AND user_id = ?`
    )
    .get(credentialId, userId)
}

/**
 * 取出完整凭证(含解密后明文)。仅给汇总层 / LLM router 用。
 * 路由层 NEVER 调,前端 NEVER 看到。
 */
export function getDecrypted(db, { userId, credentialId }) {
  const row = db
    .prepare(
      `SELECT id, user_id, provider, auth_type, label, credential_blob_enc, status
       FROM user_credentials
       WHERE id = ? AND user_id = ?`
    )
    .get(credentialId, userId)
  if (!row) return null
  let blob = {}
  try {
    blob = decryptJson(row.credential_blob_enc) || {}
  } catch (e) {
    throw new Error(`failed to decrypt credential ${credentialId}: ${e.message}`)
  }
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    auth_type: row.auth_type,
    label: row.label,
    status: row.status,
    ...blob, // api_key 或 home_path
  }
}

/**
 * 用户粘贴 API key,先测活,再写库。
 * 失败抛 Error。成功返回新 credential 的 id。
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.userId
 * @param {'anthropic'|'openai'} args.provider
 * @param {string} args.label
 * @param {string} args.apiKey
 * @returns {Promise<string>} credentialId
 */
export async function createApiKeyCredential(db, { userId, provider, label, apiKey }) {
  if (!userId) throw new Error('userId required')
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(`unsupported provider: ${provider}`)
  }
  const trimmedLabel = String(label || '').trim()
  if (!trimmedLabel) throw new Error('label required')
  if (trimmedLabel.length > 120) throw new Error('label too long (max 120 chars)')

  const key = String(apiKey || '').trim()
  if (!key) throw new Error('apiKey required')

  // 测活
  const adapter = providerAdapter(provider)
  const result = await adapter.testApiKey(key)
  if (!result.ok) {
    const err = new Error(result.error || 'validation_failed')
    err.code = result.error || 'validation_failed'
    err.latencyMs = result.latencyMs
    throw err
  }

  const id = randomId('cred')
  const blob = encryptJson({ api_key: key })

  db.prepare(
    `INSERT INTO user_credentials
       (id, user_id, provider, auth_type, label, credential_blob_enc,
        status, last_validated_at, last_validation_error)
     VALUES (?, ?, ?, 'api_key', ?, ?, 'active', datetime('now'), NULL)`
  ).run(id, userId, provider, trimmedLabel, blob)

  return id
}

/**
 * 标记 revoked。WHERE user_id 防越权。
 * 返回 true 表示真的更新了一行。
 */
export function revokeCredential(db, { userId, credentialId }) {
  const upd = db
    .prepare(
      `UPDATE user_credentials
       SET status = 'revoked'
       WHERE id = ? AND user_id = ?`
    )
    .run(credentialId, userId)
  return upd.changes === 1
}

/**
 * 取出加密 blob、按 provider + auth_type 重新测活,落 last_validated_at /
 * last_validation_error / status。
 */
export async function retestCredential(db, { userId, credentialId }) {
  const row = db
    .prepare(
      `SELECT id, user_id, provider, auth_type, credential_blob_enc, status
       FROM user_credentials
       WHERE id = ? AND user_id = ?`
    )
    .get(credentialId, userId)

  if (!row) {
    return { ok: false, error: 'not_found', latencyMs: 0 }
  }
  if (row.status === 'revoked') {
    return { ok: false, error: 'revoked', latencyMs: 0 }
  }

  if (row.auth_type !== 'api_key') {
    // Phase 1 只支持 api_key 测活;OAuth 留给 Agent C
    return { ok: false, error: 'unsupported_auth_type', latencyMs: 0 }
  }

  let blob
  try {
    blob = decryptJson(row.credential_blob_enc)
  } catch (e) {
    db.prepare(
      `UPDATE user_credentials
       SET status = 'error',
           last_validated_at = datetime('now'),
           last_validation_error = ?
       WHERE id = ?`
    ).run('decrypt_failed', row.id)
    return { ok: false, error: 'decrypt_failed', latencyMs: 0 }
  }

  const apiKey = blob?.api_key
  if (!apiKey) {
    db.prepare(
      `UPDATE user_credentials
       SET status = 'error',
           last_validated_at = datetime('now'),
           last_validation_error = ?
       WHERE id = ?`
    ).run('missing_api_key', row.id)
    return { ok: false, error: 'missing_api_key', latencyMs: 0 }
  }

  const adapter = providerAdapter(row.provider)
  const result = await adapter.testApiKey(apiKey)

  const nextStatus = result.ok ? 'active' : 'error'
  db.prepare(
    `UPDATE user_credentials
     SET status = ?,
         last_validated_at = datetime('now'),
         last_validation_error = ?
     WHERE id = ?`
  ).run(nextStatus, result.ok ? null : result.error || 'unknown', row.id)

  return result
}

/**
 * 读取用户 quota(可能不存在)。
 *
 * @returns {{
 *   allowedProviders: string[] | null,
 *   allowedAuthTypes: string[] | null,
 * }}
 */
export function getUserQuotaLimits(db, userId) {
  const row = db
    .prepare(
      `SELECT allowed_providers, allowed_auth_types
       FROM user_quotas
       WHERE user_id = ?`
    )
    .get(userId)
  if (!row) return { allowedProviders: null, allowedAuthTypes: null }

  function parseJsonArr(s) {
    if (!s) return null
    try {
      const arr = JSON.parse(s)
      return Array.isArray(arr) ? arr : null
    } catch {
      return null
    }
  }

  return {
    allowedProviders: parseJsonArr(row.allowed_providers),
    allowedAuthTypes: parseJsonArr(row.allowed_auth_types),
  }
}

/**
 * 在 POST 创建之前调用,返回 null 表示允许,返回字符串表示拒绝原因。
 */
export function checkProviderAllowed(db, { userId, provider, authType }) {
  const { allowedProviders, allowedAuthTypes } = getUserQuotaLimits(db, userId)
  if (allowedProviders && !allowedProviders.includes(provider)) {
    return `provider_not_allowed: 您的账户暂未开通 ${provider},请联系管理员`
  }
  if (allowedAuthTypes && !allowedAuthTypes.includes(authType)) {
    return `auth_type_not_allowed: 您的账户暂未开通 ${authType} 方式,请联系管理员`
  }
  return null
}

// ============================================================
// 凭证共享(Phase 3+)
// ============================================================

/**
 * Owner 把自己的凭证共享给指定 email 对应的用户。
 * 返回 { ok: true, targetUserId } 或 { ok: false, reason }。
 */
export function shareCredentialWithEmail(db, { credentialId, ownerUserId, targetEmail, notes }) {
  // 1) 校验凭证归属
  const cred = db
    .prepare(`SELECT id, user_id, status FROM user_credentials WHERE id = ? AND user_id = ?`)
    .get(credentialId, ownerUserId)
  if (!cred) return { ok: false, reason: 'credential_not_found_or_not_owner' }
  if (cred.status !== 'active') return { ok: false, reason: 'credential_not_active', detail: cred.status }

  // 2) 找目标用户
  const email = String(targetEmail || '').trim().toLowerCase()
  if (!email) return { ok: false, reason: 'empty_email' }
  const target = db
    .prepare(`SELECT id, is_active FROM users WHERE email = ?`)
    .get(email)
  if (!target) return { ok: false, reason: 'user_not_found' }
  if (!target.is_active) return { ok: false, reason: 'user_inactive' }
  if (target.id === ownerUserId) return { ok: false, reason: 'cannot_share_with_self' }

  // 3) UPSERT(同 owner 重复 share 同一人 → 更新 notes)
  db.prepare(`
    INSERT INTO credential_shares (credential_id, shared_with_user_id, shared_by_user_id, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (credential_id, shared_with_user_id) DO UPDATE SET
      notes = excluded.notes
  `).run(credentialId, target.id, ownerUserId, String(notes || '').slice(0, 500) || null)

  return { ok: true, targetUserId: target.id, targetEmail: email }
}

/** Owner 取消共享 */
export function unshareCredential(db, { credentialId, ownerUserId, targetUserId }) {
  // 校验凭证归属(WHERE user_id 防越权:别人不能撤销我设置的共享)
  const cred = db
    .prepare(`SELECT id FROM user_credentials WHERE id = ? AND user_id = ?`)
    .get(credentialId, ownerUserId)
  if (!cred) return { ok: false, reason: 'credential_not_found_or_not_owner' }

  const r = db
    .prepare(`DELETE FROM credential_shares WHERE credential_id = ? AND shared_with_user_id = ?`)
    .run(credentialId, targetUserId)
  return { ok: r.changes > 0, changes: r.changes }
}

/** 一个 credential 共享给了哪些人 — owner 视角 */
export function listSharesOfCredential(db, credentialId) {
  return db.prepare(`
    SELECT cs.shared_with_user_id AS user_id,
           u.email, u.display_name, u.is_active,
           cs.notes, cs.created_at
    FROM credential_shares cs
    JOIN users u ON u.id = cs.shared_with_user_id
    WHERE cs.credential_id = ?
    ORDER BY cs.created_at DESC
  `).all(credentialId)
}

/** 共享给我的所有凭证 — 用户视角(脱敏,不返回 blob) */
export function listSharedWithUser(db, userId) {
  return db.prepare(`
    SELECT uc.id, uc.provider, uc.auth_type, uc.label, uc.status,
           uc.last_validated_at, uc.last_used_at,
           cs.shared_by_user_id, owner.email AS owner_email,
           cs.notes, cs.created_at AS shared_at
    FROM credential_shares cs
    JOIN user_credentials uc ON uc.id = cs.credential_id
    JOIN users owner ON owner.id = uc.user_id
    WHERE cs.shared_with_user_id = ?
    ORDER BY cs.created_at DESC
  `).all(userId)
}

/** Admin 视角:全平台所有共享 */
export function listAllShares(db) {
  return db.prepare(`
    SELECT uc.id AS credential_id, uc.provider, uc.auth_type, uc.label,
           owner.email AS owner_email,
           target.email AS target_email,
           cs.notes, cs.created_at
    FROM credential_shares cs
    JOIN user_credentials uc ON uc.id = cs.credential_id
    JOIN users owner ON owner.id = uc.user_id
    JOIN users target ON target.id = cs.shared_with_user_id
    ORDER BY cs.created_at DESC
  `).all()
}

/**
 * 给 LLM router 用的解密:允许 owner OR 被共享对象访问。
 * 返回解密后的明文凭证(含 api_key / home_path)。
 */
export function getDecryptedForUsage(db, { userId, credentialId }) {
  // owner 自有
  const own = db.prepare(`
    SELECT id, user_id, provider, auth_type, label, credential_blob_enc, status
    FROM user_credentials WHERE id = ? AND user_id = ? AND status = 'active'
  `).get(credentialId, userId)
  if (own) {
    try { return { ...own, ...decryptJson(own.credential_blob_enc), via: 'owner' } }
    catch (e) { throw new Error(`decrypt_failed: ${e.message}`) }
  }
  // 共享给我的
  const shared = db.prepare(`
    SELECT uc.id, uc.user_id AS owner_user_id, uc.provider, uc.auth_type, uc.label,
           uc.credential_blob_enc, uc.status
    FROM credential_shares cs
    JOIN user_credentials uc ON uc.id = cs.credential_id
    WHERE cs.credential_id = ? AND cs.shared_with_user_id = ? AND uc.status = 'active'
  `).get(credentialId, userId)
  if (shared) {
    try { return { ...shared, ...decryptJson(shared.credential_blob_enc), via: 'shared', ownerUserId: shared.owner_user_id } }
    catch (e) { throw new Error(`decrypt_failed: ${e.message}`) }
  }
  throw new Error('credential_not_accessible')
}

/**
 * 给 LLM router 用的"找一条可用凭证":先看 owner 自有,再看共享给我的。
 * 返回 active 凭证元数据数组(脱敏)+ via 标记。
 */
export function listUsableForUser(db, userId) {
  const own = db.prepare(`
    SELECT ${SAFE_COLUMNS}, 'owner' AS via, NULL AS owner_email
    FROM user_credentials
    WHERE user_id = ? AND status = 'active'
    ORDER BY created_at DESC
  `).all(userId)

  const shared = db.prepare(`
    SELECT uc.id, uc.provider, uc.auth_type, uc.label, uc.status,
           uc.last_validated_at, uc.last_used_at, uc.created_at,
           'shared' AS via,
           owner.email AS owner_email
    FROM credential_shares cs
    JOIN user_credentials uc ON uc.id = cs.credential_id
    JOIN users owner ON owner.id = uc.user_id
    WHERE cs.shared_with_user_id = ? AND uc.status = 'active'
    ORDER BY cs.created_at DESC
  `).all(userId)

  // owner 自有的优先,后接共享
  return [...own, ...shared]
}
