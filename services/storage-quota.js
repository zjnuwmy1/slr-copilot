/**
 * storage-quota — 用户存储配额服务。
 *
 * 配额来源:
 *   1. users.storage_quota_bytes(超管显式设置) — 数字 ≥ 0 / NULL = 用默认
 *   2. 默认:advanced_extraction_enabled=1 → 1 GB,否则 0
 *
 * 使用量计算(基于 DB,跑遍用户所有项目):
 *   - zotero_packages.size_bytes(原始 zip / RDF 包)
 *   - attachments.size_bytes(record 附件,主要是 PDF)
 *
 * 调用方:
 *   - routes/projects/zotero.js POST /upload 前 ensureRoomForUpload
 *   - routes/admin/users.js admin UI 显示
 *   - routes/account/index.js 用户自己查看
 */

export const ONE_GB = 1024 * 1024 * 1024
export const DEFAULT_QUOTA_ADVANCED = 1 * ONE_GB    // 1 GB
export const DEFAULT_QUOTA_BASIC    = 0              // 没开高级抽取的没配额

// B2.2:reservation 默认 30 分钟过期 — 1 GB 上传上限按客户端最慢 5 Mbps 也只需 ~27 分钟。
//       上传完成/失败正常应主动 release;过期是兜底,防进程崩或客户端断开后 reservation 永久泄漏。
export const RESERVATION_TTL_MS = 30 * 60 * 1000

/** 决定用户的配额(bytes)。explicit value 优先,否则按 advanced flag 取默认。*/
export function effectiveQuotaForUser(user) {
  if (!user) return 0
  if (user.storage_quota_bytes != null) return Math.max(0, Number(user.storage_quota_bytes) || 0)
  return user.advanced_extraction_enabled ? DEFAULT_QUOTA_ADVANCED : DEFAULT_QUOTA_BASIC
}

/** 从 DB 跑一遍用户已用空间(bytes)。失败包不算。
 *  B2.2:加 storage_reservations 里未过期的预占,防并发上传超额。
 *        无 storage_reservations 表(老库)时 try/catch 兜底回退到旧行为。
 */
export function storageUsedByUser(db, userId) {
  if (!userId) return 0
  try {
    // attachments 去重:Zotero ingest 跟 merge 会为同一个 PDF 文件各插一行
    //   (一行指向 extracted/..., 一行指向 /pdfs/<sys>.pdf 走 hardlink 同 inode)。
    //   按 (size_bytes + record_id 所属 zotero_item_id) 这类组合很难严格判等,
    //   实用近似:同 size_bytes + 同 attachment_kind + 在同一 records.duplicate_group_id 内
    //   只算一次。先按 size_bytes 聚合,每个唯一 size 只算一次的 SUM。
    //   保守对策:用 MAX(size_bytes) per (size_bytes, attachment_kind) 去重。
    //   更简单(也更安全):只 SUM 每个 record_id 下最大的那个 attachment.size_bytes
    //   — 同一 record 两行(extracted + /pdfs)是同一文件,取较大者(应一致)即可。
    const r = db.prepare(`
      SELECT
        COALESCE(
          (SELECT SUM(size_bytes) FROM zotero_packages
            WHERE user_id = ? AND status != 'failed' AND size_bytes IS NOT NULL),
          0
        )
        +
        COALESCE(
          (SELECT SUM(per_record_max)
             FROM (
               SELECT MAX(a.size_bytes) AS per_record_max
                 FROM attachments a
                 JOIN records r  ON r.id = a.record_id
                 JOIN projects p ON p.id = r.project_id
                WHERE p.user_id = ? AND a.size_bytes IS NOT NULL
                  AND a.attachment_kind = 'pdf'
                GROUP BY a.record_id
             )
          ),
          0
        )
        AS used
    `).get(userId, userId)
    let used = Number(r?.used) || 0
    // 加未过期 reservation(B2.2 两阶段提交)
    try {
      const rsv = db.prepare(
        `SELECT COALESCE(SUM(bytes), 0) AS pending
           FROM storage_reservations
          WHERE user_id = ? AND expires_at > datetime('now')`
      ).get(userId)
      used += Number(rsv?.pending) || 0
    } catch (_) { /* 表不存在(老库) — 忽略 */ }
    return used
  } catch (e) {
    console.error('[storage-quota] storageUsedByUser failed:', e?.message)
    return 0
  }
}

/**
 * B2.2:占一段配额。返回 reservation id,调用方必须在上传结束时 release(成功/失败都要)。
 *   - bytes 必须 > 0
 *   - 不再校验是否超额(那是 ensureRoomForUpload 的事);这里只占位
 *   - 失败抛错(表缺失等)
 */
export function createReservation(db, userId, bytes, kind = 'upload') {
  if (!userId || !bytes || bytes <= 0) return null
  // 用 crypto 避开 randomId 引入循环依赖
  const id = 'rsv_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare(
    `INSERT INTO storage_reservations (id, user_id, bytes, kind, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, userId, Math.round(bytes), kind, expiresAt)
  return id
}

/** B2.2:释放 reservation(上传完成/失败都要调一次,幂等)。 */
export function releaseReservation(db, reservationId) {
  if (!reservationId) return
  try {
    db.prepare(`DELETE FROM storage_reservations WHERE id = ?`).run(reservationId)
  } catch (e) {
    console.error('[storage-quota] release reservation failed:', e?.message)
  }
}

/** 一次性拿配额 + 已用 + 剩余 + 百分比,UI 通常一次性显示。 */
export function getUserQuotaSummary(db, user) {
  const quota = effectiveQuotaForUser(user)
  const used  = storageUsedByUser(db, user.id)
  const remaining = Math.max(0, quota - used)
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0
  return { quota, used, remaining, pct, isExplicit: user.storage_quota_bytes != null }
}

/** 上传前判断是否还有空间。返回 { ok, reason, quota, used, remaining, incomingBytes }。*/
export function ensureRoomForUpload(db, user, incomingBytes) {
  const incoming = Math.max(0, Number(incomingBytes) || 0)
  const { quota, used, remaining } = getUserQuotaSummary(db, user)
  if (quota === 0) {
    return {
      ok: false, reason: 'no_quota',
      message: '你没有存储配额(需要管理员开通"高级抽取")',
      quota, used, remaining, incoming,
    }
  }
  if (used + incoming > quota) {
    return {
      ok: false, reason: 'exceeds_quota',
      message: `本次上传 ${formatBytes(incoming)} 会超过你的剩余配额(剩 ${formatBytes(remaining)} / 总 ${formatBytes(quota)})`,
      quota, used, remaining, incoming,
    }
  }
  return { ok: true, quota, used, remaining, incoming }
}

/** 字节 → 人类可读(B / KB / MB / GB)。 */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—'
  const n = Number(bytes)
  if (n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** GB → bytes(超管表单输入用)。无效返回 null。 */
export function parseGbToBytes(rawGb) {
  if (rawGb === '' || rawGb == null) return null
  const n = Number(rawGb)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * ONE_GB)
}
