import bcrypt from 'bcryptjs'
import { randomId } from './crypto.js'

/**
 * 首次启动 bootstrap:
 * - 如果 users 表为空 + BOOTSTRAP_ADMIN_EMAIL/PASSWORD 都设了 → 创建一个 super admin
 * - 已有用户但没有任何超管 + BOOTSTRAP_ADMIN_EMAIL 对应账号是 admin → 提升为超管
 *   (用于把老的 admin 账号升级到超管)
 * - 如果没有任何超管也找不到匹配账号,把最早注册的 admin 升为超管(防呆)
 * - 否则跳过
 *
 * 超管 = 唯一能配置平台 LLM 凭证 + 创建/晋升其他管理员的角色。
 */
export async function bootstrapAdmin(db) {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim()

  // —— 情形 A:users 表为空,直接创建超管 ——
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get()
  if (count === 0) {
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
    if (!email || !password) {
      return { skipped: true, reason: 'env-not-set' }
    }
    if (password.length < 10) {
      console.error('[bootstrap] BOOTSTRAP_ADMIN_PASSWORD too short, need >= 10 chars; skipping')
      return { skipped: true, reason: 'password-too-short' }
    }

    const id = randomId('user')
    const hash = await bcrypt.hash(password, 12)
    db.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, role, is_active, is_super_admin)
      VALUES (?, ?, ?, ?, 'admin', 1, 1)
    `).run(id, email, email.split('@')[0], hash)

    db.prepare(`
      INSERT INTO audit_events (user_id, actor_user_id, event_type, payload)
      VALUES (?, ?, 'bootstrap_super_admin_created', ?)
    `).run(id, id, JSON.stringify({ email }))

    console.log(`[bootstrap] super admin created: ${email} (id=${id})`)
    return { created: true, id, email, role: 'super_admin' }
  }

  // —— 情形 B:已有任何超管,跳过 ——
  const { count: superCount } = db.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE is_super_admin = 1'
  ).get()
  if (superCount > 0) {
    return { skipped: true, reason: 'super-admin-exists' }
  }

  // —— 情形 C:把 BOOTSTRAP_ADMIN_EMAIL 对应的 admin 升为超管 ——
  if (email) {
    const target = db.prepare(
      'SELECT id, email, role FROM users WHERE email = ?'
    ).get(email)
    if (target && target.role === 'admin') {
      db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(target.id)
      db.prepare(`
        INSERT INTO audit_events (user_id, actor_user_id, event_type, payload)
        VALUES (?, ?, 'super_admin_promoted', ?)
      `).run(target.id, target.id, JSON.stringify({ email, reason: 'bootstrap-promote' }))
      console.log(`[bootstrap] promoted existing admin to super admin: ${email}`)
      return { promoted: true, id: target.id, email }
    }
  }

  // —— 情形 D:兜底,把最早注册的 admin 升为超管 ——
  const firstAdmin = db.prepare(
    `SELECT id, email FROM users WHERE role = 'admin' AND is_active = 1
     ORDER BY created_at ASC LIMIT 1`
  ).get()
  if (firstAdmin) {
    db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(firstAdmin.id)
    db.prepare(`
      INSERT INTO audit_events (user_id, actor_user_id, event_type, payload)
      VALUES (?, ?, 'super_admin_promoted', ?)
    `).run(firstAdmin.id, firstAdmin.id, JSON.stringify({ email: firstAdmin.email, reason: 'bootstrap-fallback' }))
    console.log(`[bootstrap] fallback: promoted earliest admin to super admin: ${firstAdmin.email}`)
    return { promoted: true, id: firstAdmin.id, email: firstAdmin.email, fallback: true }
  }

  return { skipped: true, reason: 'no-admin-to-promote' }
}
