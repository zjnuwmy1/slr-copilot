import bcrypt from 'bcryptjs'
import { randomId } from './crypto.js'

/**
 * 首次启动 bootstrap:
 * - 如果 users 表为空 + BOOTSTRAP_ADMIN_EMAIL/PASSWORD 都设了 → 创建一个 admin
 * - 否则跳过(已经有用户的情况下,admin 通过 admin/users/new 邀请码创建别人)
 */
export async function bootstrapAdmin(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get()
  if (count > 0) return { skipped: true, reason: 'users-exist' }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL
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
    INSERT INTO users (id, email, display_name, password_hash, role, is_active)
    VALUES (?, ?, ?, ?, 'admin', 1)
  `).run(id, email.toLowerCase(), email.split('@')[0], hash)

  db.prepare(`
    INSERT INTO audit_events (user_id, actor_user_id, event_type, payload)
    VALUES (?, ?, 'bootstrap_admin_created', ?)
  `).run(id, id, JSON.stringify({ email }))

  console.log(`[bootstrap] admin created: ${email} (id=${id})`)
  return { created: true, id, email }
}
