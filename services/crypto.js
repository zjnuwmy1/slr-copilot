import crypto from 'node:crypto'

const ALG = 'aes-256-gcm'

function getKey() {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error('ENCRYPTION_KEY not set (need 64 hex chars = 32 bytes)')
  }
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars), got ${buf.length}`)
  }
  return buf
}

/**
 * 加密任意 JSON-serializable 值,返回 base64 字符串。
 * 输出格式:base64(iv ‖ authTag ‖ ciphertext)
 */
export function encryptJson(value) {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALG, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptJson(blob) {
  const key = getKey()
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = crypto.createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(dec.toString('utf8'))
}

/** 给凭证 / OAuth 会话 / 邀请码用的随机 ID */
export function randomId(prefix = '', bytes = 16) {
  const hex = crypto.randomBytes(bytes).toString('hex')
  return prefix ? `${prefix}_${hex}` : hex
}

/** 邀请码:8 位大写字母数字,易读 */
export function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I O 0 1
  let out = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}
