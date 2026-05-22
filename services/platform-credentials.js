/**
 * 平台凭证 —— 超级管理员配置后,所有用户(非超管)的 LLM 调用统一走这套凭证。
 *
 * 存储:复用 system_settings 表
 *   key                              value (credential_id of super admin's credential)
 *   ──────────────────────────────────────────────────────────────
 *   platform_credential_anthropic    cred_xxx (anthropic provider)
 *   platform_credential_openai       cred_yyy (openai provider)
 *
 * 行为:
 *   - 超管 自己 调 LLM 时 → 走 platform 凭证(他就是 owner)
 *   - 普通 admin / user 调 LLM 时 → 也强制走 platform 凭证
 *     (跳过 user_credentials 自有列表,跳过 credential_shares)
 *   - 如果 platform 凭证未设置或失效 → runLlm 返回 status='no_platform_credential' +
 *     提示用户联系超管配置
 */

import { getSetting, setSetting } from './settings.js'

const KEY_PREFIX = 'platform_credential_'
const SUPPORTED_PROVIDERS = ['anthropic', 'openai']

export function platformKeyFor(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) return null
  return KEY_PREFIX + provider
}

/**
 * 拿某 provider 的平台凭证 id(string)或 null
 */
export function getPlatformCredentialId(db, provider) {
  const key = platformKeyFor(provider)
  if (!key) return null
  return getSetting(db, key) || null
}

/**
 * 拿到平台凭证完整 row(含 user_id / status 等)。
 * 自动校验:必须 active + 必须 owner 是超管。
 * 返回 null 表示未配置或已失效。
 */
export function getPlatformCredentialRow(db, provider) {
  const id = getPlatformCredentialId(db, provider)
  if (!id) return null
  const row = db.prepare(`
    SELECT uc.id, uc.user_id, uc.provider, uc.auth_type, uc.label, uc.status,
           uc.last_validated_at, uc.last_validation_error, uc.last_used_at,
           u.is_super_admin AS owner_is_super_admin,
           u.email          AS owner_email
    FROM user_credentials uc
    JOIN users u ON u.id = uc.user_id
    WHERE uc.id = ?
  `).get(id)
  if (!row) return null
  if (!row.owner_is_super_admin) {
    // owner 不再是超管(被降级了),平台凭证作废
    return null
  }
  return row
}

/**
 * 列出所有 provider 的平台凭证状态。给 admin UI 用。
 * 返回:[ { provider, credentialId, row, configured: bool, healthy: bool, reason } ]
 */
export function listPlatformCredentials(db) {
  const out = []
  for (const provider of SUPPORTED_PROVIDERS) {
    const id = getPlatformCredentialId(db, provider)
    if (!id) {
      out.push({ provider, credentialId: null, row: null, configured: false, healthy: false, reason: 'not_configured' })
      continue
    }
    const row = getPlatformCredentialRow(db, provider)
    if (!row) {
      out.push({ provider, credentialId: id, row: null, configured: true, healthy: false, reason: 'not_found_or_owner_demoted' })
      continue
    }
    const healthy = row.status === 'active'
    out.push({
      provider, credentialId: id, row,
      configured: true, healthy,
      reason: healthy ? null : ('cred_' + row.status),
    })
  }
  return out
}

/**
 * 把某条凭证设为某 provider 的平台凭证。
 * 强校验:owner 必须是超管 + provider 必须匹配 + 凭证必须 active。
 */
export function setPlatformCredential(db, { provider, credentialId, setByUserId }) {
  const key = platformKeyFor(provider)
  if (!key) throw new Error(`不支持的 provider: ${provider}`)
  if (!credentialId) throw new Error('credentialId 必填')

  const row = db.prepare(`
    SELECT uc.id, uc.user_id, uc.provider, uc.status,
           u.is_super_admin
    FROM user_credentials uc
    JOIN users u ON u.id = uc.user_id
    WHERE uc.id = ?
  `).get(credentialId)
  if (!row) throw new Error('凭证不存在')
  if (!row.is_super_admin) throw new Error('该凭证的拥有者不是超级管理员')
  if (row.provider !== provider) throw new Error(`provider 不匹配:期望 ${provider},实际 ${row.provider}`)
  if (row.status !== 'active') throw new Error(`凭证状态非 active:${row.status}`)

  setSetting(db, { key, value: credentialId, updatedByUserId: setByUserId })
  return { ok: true, credentialId, provider }
}

/**
 * 清除某 provider 的平台凭证。
 */
export function clearPlatformCredential(db, { provider, updatedByUserId }) {
  const key = platformKeyFor(provider)
  if (!key) throw new Error(`不支持的 provider: ${provider}`)
  setSetting(db, { key, value: '', updatedByUserId })
  return { ok: true }
}

export const PROVIDERS = SUPPORTED_PROVIDERS
