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
