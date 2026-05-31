/**
 * services/api-tokens.js — P1.1 (2026-05-31)
 * -----------------------------------------------------------------------------
 * 程序化 API token:让本地 AI agent / CLI 无需 cookie-session 即可调平台。
 *
 * 设计(对齐 GitHub PAT 模式):
 *   - token 明文形如 `slr_<64 hex>`(crypto.randomBytes(32))。**只在生成时返回一次**,
 *     之后只存 SHA-256 hash(token_hash),无法反查明文。
 *   - 用 SHA-256(快哈希)而非 bcrypt:token 本身 256-bit 高熵,无暴力空间;且需要
 *     O(1) 索引查找(每个 API 请求都要查),bcrypt 的慢哈希在这里既无必要又不可索引。
 *   - revoked_at 非空 = 已吊销;verify 时过滤。
 *   - last_used_at 每次成功验证更新(节流到分钟级以减少写放大见 verifyApiToken)。
 *
 * 安全:token 明文绝不落库 / 不进日志 / 不进 audit payload。调用方只在生成响应里
 *   见一次,自己保存(写进 agent 的 SLR_API_TOKEN env)。
 */

import crypto from 'node:crypto'
import { randomId } from './crypto.js'

const TOKEN_PREFIX = 'slr_'

/** SHA-256 hex of a string. */
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/**
 * 生成一个新 API token。
 * @returns {{ id, token, label, created_at }} token 是明文,只此一次。
 */
export function generateApiToken(db, { userId, label = null }) {
  if (!userId) throw new Error('missing_userId')
  const id = randomId('tok')
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex')
  const tokenHash = sha256hex(token)
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, token_hash, label, created_at)
     VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))`
  ).run(id, userId, tokenHash, label ? String(label).slice(0, 100) : null)
  const row = db.prepare(
    `SELECT id, label, created_at FROM api_tokens WHERE id = ?`
  ).get(id)
  return { id: row.id, token, label: row.label, created_at: row.created_at }
}

/**
 * 用明文 token 验证 → 返回对应 user 行(字段对齐 middleware/auth.js loadUser),
 * 或 null(token 无效 / 已吊销 / 用户不存在或停用)。
 * 成功时顺带更新 last_used_at(节流:仅当上次使用 > 60s 前才写,降低写放大)。
 */
export function verifyApiToken(db, token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null
  const tokenHash = sha256hex(token)
  const tok = db.prepare(
    `SELECT id, user_id, revoked_at, last_used_at FROM api_tokens WHERE token_hash = ?`
  ).get(tokenHash)
  if (!tok || tok.revoked_at) return null

  const u = db.prepare(
    `SELECT id, email, display_name, role, is_active, is_super_admin,
            advanced_extraction_enabled, storage_quota_bytes
       FROM users WHERE id = ?`
  ).get(tok.user_id)
  if (!u || !u.is_active) return null
  u.is_super_admin = !!u.is_super_admin
  u.advanced_extraction_enabled = !!u.advanced_extraction_enabled

  // 节流更新 last_used_at:避免每个请求都写一次(SGT now)。
  try {
    db.prepare(
      `UPDATE api_tokens
          SET last_used_at = datetime('now', '+8 hours')
        WHERE id = ?
          AND (last_used_at IS NULL
               OR last_used_at <= datetime('now', '+8 hours', '-60 seconds'))`
    ).run(tok.id)
  } catch { /* 非致命 */ }

  return u
}

/** 列出某用户的所有 token(不含 hash / 明文)。 */
export function listApiTokens(db, userId) {
  return db.prepare(
    `SELECT id, label, created_at, last_used_at, revoked_at
       FROM api_tokens
      WHERE user_id = ?
      ORDER BY (revoked_at IS NOT NULL), created_at DESC`
  ).all(userId)
}

/** 吊销一个 token(只能吊销自己的,除非 caller 已做权限判断)。幂等。 */
export function revokeApiToken(db, { userId, tokenId }) {
  const res = db.prepare(
    `UPDATE api_tokens
        SET revoked_at = datetime('now', '+8 hours')
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
  ).run(tokenId, userId)
  return res.changes > 0
}
