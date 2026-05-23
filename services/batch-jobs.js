/**
 * batch-jobs — 后台批量任务进度持久化。
 *
 * 之前各 route 用进程内 Map 跟踪批量任务进度,服务重启就丢。配合 db M12 的
 * batch_jobs 表把状态落库,initDb 启动时把"上次 PID 的 running"标 aborted。
 *
 * 用法:
 *   const job = startJob(db, { projectId, userId, kind: 'matrix_extraction', total: 50 })
 *   updateJobProgress(db, job.id, { done: 12, failed: 0, current: { id: 'rec_x', title: 'Foo' } })
 *   finishJob(db, job.id, { status: 'finished' })   // 或 'failed'
 *
 *   getActiveJob(db, projectId, kind)   // UI 轮询用
 *
 * kind:
 *   'matrix_extraction'  Step 4 AI 批量
 *   'screening'          Step 3 AI 初筛(将来迁过来)
 *   'extraction_legacy'  老 extractions 批量(将来迁过来)
 */

import { randomId } from './crypto.js'

const ACTIVE_STATUS = 'running'

/**
 * 启一个新任务。
 *   - 如果同 project_id × kind 有 active(running),抛错(防重复启动)。
 *   - 返回 { id, ...row }
 */
export function startJob(db, { projectId, userId, kind, total = 0, initial = {} }) {
  if (!projectId || !userId || !kind) throw new Error('startJob: missing args')
  const existing = db.prepare(
    `SELECT id FROM batch_jobs WHERE project_id = ? AND kind = ? AND status = ?`
  ).get(projectId, kind, ACTIVE_STATUS)
  if (existing) {
    throw new Error(`已有 ${kind} 任务在跑(job_id=${existing.id})`)
  }
  const id = randomId('bj')
  const progress = JSON.stringify({ done: 0, failed: 0, current: null, ...initial })
  // B2.3:boot_id 取自 server.js 启动时设置的 SLR_BOOT_ID env。系统重启后 boot_id 必然变化,
  //       initDb 的 M20 reset 会把 boot_id != current 的 running 行标 aborted_by_restart。
  //       process.pid 也写一份(老 reset 逻辑兼容)。
  const bootId = process.env.SLR_BOOT_ID || null
  db.prepare(
    `INSERT INTO batch_jobs (id, project_id, user_id, kind, status, pid, boot_id, total, done, failed, progress_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, datetime('now'))`
  ).run(id, projectId, userId, kind, ACTIVE_STATUS, process.pid, bootId, total, progress)
  return { id, project_id: projectId, user_id: userId, kind, status: ACTIVE_STATUS, total, done: 0, failed: 0 }
}

/**
 * 更新进度。patch 可包含 done / failed / current({id, title}) / 任意自定义字段(进 progress_json)。
 *   done / failed 直接写表;current 等进 progress_json。
 */
export function updateJobProgress(db, jobId, patch = {}) {
  if (!jobId) return
  const row = db.prepare(`SELECT progress_json, done, failed FROM batch_jobs WHERE id = ?`).get(jobId)
  if (!row) return
  let prev = {}
  try { prev = JSON.parse(row.progress_json || '{}') || {} } catch {}

  const newDone   = patch.done   != null ? patch.done   : row.done
  const newFailed = patch.failed != null ? patch.failed : row.failed

  // 合并 progress_json
  const merged = { ...prev }
  for (const k of Object.keys(patch)) {
    if (k === 'done' || k === 'failed') continue   // 列字段单独写
    merged[k] = patch[k]
  }
  merged.done = newDone
  merged.failed = newFailed

  db.prepare(
    `UPDATE batch_jobs
        SET done = ?, failed = ?, progress_json = ?
      WHERE id = ?`
  ).run(newDone, newFailed, JSON.stringify(merged), jobId)
}

/**
 * 完结任务。status 一般是 'finished' | 'failed'。
 * B2.4:status='failed' 或 'aborted_by_restart' 时自动 can_retry=1,UI 能渲染重启按钮。
 *       last_error 同步写一份(给 UI 直接读,不必从 error_message append 文本里抠)。
 */
export function finishJob(db, jobId, { status = 'finished', errorMessage = null } = {}) {
  if (!jobId) return
  const canRetry = (status === 'failed' || status === 'aborted_by_restart') ? 1 : 0
  db.prepare(
    `UPDATE batch_jobs
        SET status = ?,
            finished_at = datetime('now'),
            error_message = COALESCE(?, error_message),
            last_error = COALESCE(?, last_error),
            can_retry = ?
      WHERE id = ?`
  ).run(status, errorMessage, errorMessage, canRetry, jobId)
}

/**
 * 拿当前 active(running)任务 — UI 轮询用。
 * 没有就返回 null。如果有 finished/aborted 的最新一次(用户上次跑的)也一起带回供 UI 显示完成态。
 *
 * 返回结构:
 *   { id, status, total, done, failed, current, allowAbstractOnly?, startedAt, finishedAt, ... }
 */
export function getActiveJob(db, projectId, kind) {
  // 优先返回 running 的;没 running 就拿最近一次 finished/aborted/failed 的(供 UI 显示"上次跑完了")
  const running = db.prepare(
    `SELECT * FROM batch_jobs WHERE project_id = ? AND kind = ? AND status = 'running' LIMIT 1`
  ).get(projectId, kind)
  const row = running || db.prepare(
    `SELECT * FROM batch_jobs WHERE project_id = ? AND kind = ? ORDER BY started_at DESC LIMIT 1`
  ).get(projectId, kind)
  if (!row) return null
  let progress = {}
  try { progress = JSON.parse(row.progress_json || '{}') || {} } catch {}
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    done: row.done,
    failed: row.failed,
    current: progress.current || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    // B2.4:UI 用这两个字段渲染"↻ 重新启动剩余 X 篇"按钮。
    //       can_retry=1 时按钮可点;last_error 直接显示给用户看错误原因。
    canRetry: !!row.can_retry,
    lastError: row.last_error || null,
    // 把 progress_json 里的额外字段透出去(allowAbstractOnly, pdfCount 等)
    ...Object.fromEntries(
      Object.entries(progress).filter(([k]) => !['done','failed','current'].includes(k))
    ),
  }
}

/**
 * B2.4 retry — 把一个 aborted/failed 的 job 标记为"已忽略",清掉 can_retry,
 *               让 startJob 能开新 job(不会被"已有 running"挡住,因为之前的 status 是
 *               aborted/failed 不是 running;这里主要清 UI 提示)。
 *               真正的"接着跑"由调用方 route 重新调度 — 因为 done/failed records 已经
 *               在各业务表里有状态(extractions / screening_decisions 等),
 *               重启 batch 时跳过已 success 的就行。
 */
export function dismissJob(db, jobId) {
  if (!jobId) return
  db.prepare(`UPDATE batch_jobs SET can_retry = 0 WHERE id = ?`).run(jobId)
}

/**
 * 列出所有 running 任务(admin dashboard 用)。
 */
export function listRunningJobs(db) {
  const rows = db.prepare(
    `SELECT id, project_id, user_id, kind, total, done, failed, started_at, progress_json
       FROM batch_jobs WHERE status = 'running'
       ORDER BY started_at DESC`
  ).all()
  return rows.map((r) => {
    let p = {}; try { p = JSON.parse(r.progress_json || '{}') || {} } catch {}
    return { ...r, current: p.current || null }
  })
}
