/**
 * 检索式锁定服务。
 *
 * 工作流:
 *   1) 用户跑 exploration / 优化主检索,反复改
 *   2) 拍板 — 锁定每个库实际用的最终检索式(used / unused + query + count + date)
 *   3) CSV 上传必须在锁定后才允许
 *
 * 存储:projects.search_locked_at(NULL=未锁) + final_search_records 表
 *      (project_id, database_name) UNIQUE,一个库一条快照。
 *
 * 锁定时:
 *   - 入参里每个 target database 都必须出现一次
 *   - 标 used=1 的库:query_text 必须非空(无论是从 strategy 复制的还是用户自己改的)
 *   - 标 used=0 的库:其它字段可以全空
 */

import { randomId } from './crypto.js'
import { resolveTargetDatabases } from './prompts/search.js'

/**
 * 拿项目锁定状态 + 每库的 final record(若已写入)。
 * 返回:
 *   {
 *     lockedAt: 'YYYY-MM-DD HH:MM:SS' | null,
 *     targetDatabases: ['wos','scopus','pubmed'],
 *     records: { wos: {...} | null, scopus: {...} | null, pubmed: {...} | null },
 *   }
 */
export function getLockState(db, project) {
  const targetDatabases = resolveTargetDatabases(project.databases)
  const rows = db
    .prepare(
      `SELECT id, database_name, used, strategy_id, query_text, result_count,
              search_date, notes, locked_at
       FROM final_search_records
       WHERE project_id = ?`
    )
    .all(project.id)
  const records = {}
  for (const k of targetDatabases) records[k] = null
  for (const r of rows) {
    records[r.database_name] = { ...r, used: !!r.used }
  }
  return {
    lockedAt: project.search_locked_at || null,
    isLocked: !!project.search_locked_at,
    targetDatabases,
    records,
  }
}

/**
 * 落盘最终检索方案。
 *
 * @param {*} db
 * @param {string} projectId
 * @param {Array} entries  每条 { database, used, strategy_id?, query_text?, result_count?, search_date?, notes? }
 * @param {string[]} targetDatabases  本项目目标库列表
 * @returns {{ ok: boolean, error?: string, locked_at?: string, written?: number }}
 */
export function lockSearch(db, projectId, entries, targetDatabases) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: '没有提交任何检索记录' }
  }
  // 按 database 索引,校验
  const byDb = {}
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const dbKey = String(e.database || '').trim().toLowerCase()
    if (!dbKey) continue
    byDb[dbKey] = e
  }

  // 每个目标库必须有一条
  const missing = targetDatabases.filter((d) => !byDb[d])
  if (missing.length) {
    return { ok: false, error: `缺少这些库的最终记录:${missing.join(', ')}` }
  }

  // 至少 1 个 used=1(否则等于"什么库都没用",显然非法)
  const usedCount = targetDatabases.filter((d) => byDb[d].used).length
  if (usedCount === 0) {
    return { ok: false, error: '至少要标 1 个库为"已使用",才能锁定方案' }
  }

  // 标 used 的库必须有 query_text
  for (const d of targetDatabases) {
    const e = byDb[d]
    if (e.used && !(typeof e.query_text === 'string' && e.query_text.trim())) {
      return { ok: false, error: `${d.toUpperCase()} 标为已使用,但没填检索式` }
    }
  }

  // 校验 strategy_id(若给)必须属于本项目
  const strategyIds = entries
    .map((e) => (e && typeof e.strategy_id === 'string') ? e.strategy_id.trim() : '')
    .filter(Boolean)
  if (strategyIds.length) {
    const placeholders = strategyIds.map(() => '?').join(',')
    const valid = new Set(
      db
        .prepare(`SELECT id FROM search_strategies WHERE project_id = ? AND id IN (${placeholders})`)
        .all(projectId, ...strategyIds)
        .map((r) => r.id)
    )
    for (const sid of strategyIds) {
      if (!valid.has(sid)) {
        return { ok: false, error: `引用了不存在的 strategy_id: ${sid}` }
      }
    }
  }

  // Upsert
  const upsert = db.prepare(`
    INSERT INTO final_search_records
      (id, project_id, database_name, used, strategy_id, query_text,
       result_count, search_date, notes, locked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, database_name) DO UPDATE SET
      used         = excluded.used,
      strategy_id  = excluded.strategy_id,
      query_text   = excluded.query_text,
      result_count = excluded.result_count,
      search_date  = excluded.search_date,
      notes        = excluded.notes,
      locked_at    = excluded.locked_at
  `)

  let written = 0
  const tx = db.transaction(() => {
    for (const d of targetDatabases) {
      const e = byDb[d]
      const queryText = e.used ? String(e.query_text || '').trim() : (e.query_text ? String(e.query_text).trim() : null)
      const strategyId = e.strategy_id ? String(e.strategy_id).trim() : null
      const rc = numOrNull(e.result_count)
      const sd = isDateStr(e.search_date) ? e.search_date.trim() : null
      const notes = e.notes ? String(e.notes).trim().slice(0, 800) : null

      // existing id?
      const ex = db
        .prepare('SELECT id FROM final_search_records WHERE project_id = ? AND database_name = ?')
        .get(projectId, d)
      const id = ex?.id || randomId('fsr')

      upsert.run(
        id, projectId, d,
        e.used ? 1 : 0,
        strategyId,
        queryText || null,
        rc, sd, notes,
      )
      written++
    }

    db.prepare(`UPDATE projects SET search_locked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(projectId)
  })
  tx()

  return { ok: true, locked_at: new Date().toISOString(), written }
}

/**
 * 解锁(允许用户修改后重锁)。不删 final_search_records,只清 projects.search_locked_at。
 */
export function unlockSearch(db, projectId) {
  db.prepare(`UPDATE projects SET search_locked_at = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(projectId)
  return { ok: true }
}

function numOrNull(v) {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v)
  if (typeof v === 'string') {
    const m = v.trim().match(/^\d+$/)
    if (m) {
      const n = Number.parseInt(m[0], 10)
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return null
}

function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
}
