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

/**
 * 邀请码:16 位易读字符 ([A-HJ-NP-Z2-9],去掉 I O 0 1 防混淆)。
 *
 * 长度 & 字符集:
 *   - 长度 16(register.ejs 的 input maxlength=16 对齐)。
 *   - 字符集 32 个 = 5 bit/字符 ⇒ 共 80 bit 熵,够暴力 / 撞库 / 离线枚举防御。
 *   - 历史上只有 8 字符(40 bit),已升级。
 *
 * 大小写:
 *   - 故意只用大写。routes/auth.js 在 register POST 时对 invite_code 做 toUpperCase()
 *     标准化,所以加小写没意义反而破坏匹配。如果以后去掉那个 toUpperCase,可把
 *     alphabet 换成 [A-Za-z2-9](≈ 5.85 bit/字符,16 位 ≈ 94 bit)。
 *
 * 采样方式:
 *   - rejection sampling,避免 `bytes[i] % 32` 在 256 % 32 = 0 时的非均匀性
 *     (其实 32 整除 256 没有偏差,但显式 mask 更安全也更直观,改了字符集大小
 *      也不用重新分析)。
 */
export function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 chars,去掉易混的 I O 0 1
  const len = 16
  let out = ''
  // 一次抓足够多的随机字节(每个字符最多消耗 2 字节 worst case),不够再补
  let pool = crypto.randomBytes(len * 2)
  let pi = 0
  while (out.length < len) {
    if (pi >= pool.length) { pool = crypto.randomBytes(len * 2); pi = 0 }
    const v = pool[pi++]
    // mask 到 5 bit 区间(0..31)— alphabet 长度刚好 32,无偏。
    out += alphabet[v & 0x1f]
  }
  return out
}
