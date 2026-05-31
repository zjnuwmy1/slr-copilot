/**
 * services/pipeline-orchestrator.js — P1.4 (2026-05-31): 自治流水线编排器
 *
 * 北极星:让本地 agent 一条命令把项目从 protocol 跑到成稿(autonomous mode)。
 *
 * 设计原则:
 *   1. **零业务逻辑复制**:编排器不重写任何 step 的 LLM/解析/落库逻辑;它通过
 *      进程内 HTTP 自调用复用现有 route 端点(同一套代码,网页和 agent 共享)。
 *      为此需把 /projects 路由从 requireUser 换成 requireApiOrUser(server.js),
 *      编排器临时铸一枚短期 API token 自调用,跑完吊销。
 *   2. **状态来自真值**:每步是否"完成"一律查 services/prisma.js getProjectProgress
 *      (与网页 stepper / /api status 同源),不自己记 step 状态 → 天然幂等 + 断电可恢复:
 *      重启后重跑 /run,已完成的步骤自动跳过,从卡住处继续。
 *   3. **失败/缺数据 → 停 + 标明**:任何步骤缺前置数据(无 records / 无 LaTeX 模板 /
 *      检索命中数需人工)或 LLM 失败 → 停下,pipeline_run 记 blocked_step + reason,
 *      agent 可读 /run/status 知道卡在哪、为什么,补数据后再 /run 继续。
 *   4. **方法学诚实不破**:autonomous 只自动过"流程 gate"(协议自动批准、AI 筛选结论
 *      bulk-accept 即终审),不伪造"双人评审"。methodology-capabilities 仍如实标
 *      single-AI-reviewer,PRISMA validator 照常 cap —— 这些由既有 step 逻辑保证,
 *      编排器不碰。
 *
 * 可恢复任务:kind='pipeline_run' 的 batch_job(initDb M20 在重启时标 aborted_by_restart)。
 */

import * as batchJobsSvc from './batch-jobs.js'
import { getProjectProgress } from './prisma.js'
import { generateApiToken, revokeApiToken } from './api-tokens.js'

export const PIPELINE_KIND = 'pipeline_run'

// review_type → 步骤序列。P3 会细化;现在 systematic 全跑,scoping 跳 rob+certainty。
//   注:search 不在自治序列里 —— 真实库检索命中数需人工/外部(autonomous 从"已导入
//   records"起步),搜索式生成是文档动作,不阻塞;records 由 agent 预先导入(Zotero/CSV)。
const FULL = ['protocol', 'screening', 'extraction', 'rob', 'synthesis', 'certainty', 'report']
const STEP_SEQUENCES = {
  systematic_review: FULL,
  meta_analysis: FULL,
  mixed_methods: FULL,
  scoping_review: ['protocol', 'screening', 'extraction', 'synthesis', 'report'],
  bibliometric: ['protocol', 'screening', 'extraction', 'synthesis', 'report'],
}

function sequenceFor(reviewType) {
  return STEP_SEQUENCES[reviewType] || FULL
}

// 进程内自调用基址(server.js listen 在 127.0.0.1:PORT)
function selfBase() {
  return `http://127.0.0.1:${Number(process.env.PORT) || 3001}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 认证 POST 到自身某 /projects 路由(fire trigger)。返回 { ok, status }。
async function selfPost(token, path, body) {
  try {
    const res = await fetch(selfBase() + path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: body ? JSON.stringify(body) : '{}',
      redirect: 'manual',   // 触发器多为 302 重定向,不跟随
    })
    // 2xx / 3xx(重定向)视为已接受;4xx/5xx 视为拒绝
    return { ok: res.status < 400, httpStatus: res.status }
  } catch (e) {
    return { ok: false, httpStatus: 0, error: e?.message }
  }
}

// 轮询直到 cond() 为真或超时。cond 同步读 DB。
async function pollUntil(cond, { maxMs, intervalMs = 5000 }) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    let done = false
    try { done = !!cond() } catch {}
    if (done) return true
    await sleep(intervalMs)
  }
  return false
}

// 某步是否已完成(查真值)
function stepDone(db, projectId, key) {
  try {
    const p = getProjectProgress(db, projectId)
    return p?.stepStatus?.[key]?.status === 'done'
  } catch { return false }
}

function countIncludedRecords(db, projectId) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS c FROM screening_decisions sd JOIN records r ON r.id = sd.record_id
        WHERE sd.project_id = ? AND sd.stage='title_abstract' AND sd.human_decision='include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id='')`
    ).get(projectId).c || 0
  } catch { return 0 }
}

function countRecords(db, projectId) {
  try {
    return db.prepare(
      `SELECT COUNT(*) AS c FROM records WHERE project_id = ? AND (duplicate_of_record_id IS NULL OR duplicate_of_record_id='')`
    ).get(projectId).c || 0
  } catch { return 0 }
}

// ── 各步执行器 ───────────────────────────────────────────────
// 每个返回 { status: 'done'|'blocked'|'failed', reason? }。
// 复用现有端点;完成判定查 getProjectProgress(真值)。

async function runProtocol(db, ctx) {
  const { token, projectId, autonomous } = ctx
  if (stepDone(db, projectId, 'protocol')) return { status: 'done' }
  // 没有任何 protocol → 触发生成
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM protocols WHERE project_id = ?`).get(projectId).c || 0
  if (existing === 0) {
    const r = await selfPost(token, `/projects/${projectId}/protocol/generate`, {})
    if (!r.ok) return { status: 'failed', reason: `protocol_generate_trigger_failed_http_${r.httpStatus}` }
    // 等到出现至少一个 protocol 版本(LLM ~1-3 min)
    const got = await pollUntil(
      () => (db.prepare(`SELECT COUNT(*) AS c FROM protocols WHERE project_id = ?`).get(projectId).c || 0) > 0,
      { maxMs: 10 * 60 * 1000 },
    )
    if (!got) return { status: 'failed', reason: 'protocol_generation_timeout' }
  }
  if (!autonomous) {
    // 非自治:协议生成了但需人工审批 → 停,等人工
    return stepDone(db, projectId, 'protocol') ? { status: 'done' } : { status: 'blocked', reason: 'awaiting_human_protocol_approval' }
  }
  // 自治:自动批准最新未批准版本
  if (!stepDone(db, projectId, 'protocol')) {
    const latest = db.prepare(
      `SELECT id FROM protocols WHERE project_id = ? ORDER BY version DESC LIMIT 1`
    ).get(projectId)
    if (latest) {
      const r = await selfPost(token, `/projects/${projectId}/protocol/${latest.id}/approve`, {})
      if (!r.ok) return { status: 'failed', reason: `protocol_approve_failed_http_${r.httpStatus}` }
    }
  }
  return stepDone(db, projectId, 'protocol') ? { status: 'done' } : { status: 'failed', reason: 'protocol_not_done_after_approve' }
}

async function runScreening(db, ctx) {
  const { token, projectId, autonomous } = ctx
  if (stepDone(db, projectId, 'screening')) return { status: 'done' }
  // 前置:必须有 records(autonomous 不能凭空检索)
  if (countRecords(db, projectId) === 0) {
    return { status: 'blocked', reason: 'no_records_imported — 请先用 Zotero / CSV 导入文献(检索由人工/agent在外部完成)' }
  }
  // 触发批量 AI 初筛(run-batch 会跳过已成功、补跑未跑/失败的 — 见 P0.5)
  const r = await selfPost(token, `/projects/${projectId}/screening/run-batch`, {})
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `screening_trigger_failed_http_${r.httpStatus}` }
  // 等批量任务结束(screening_batch job 不再 running)
  await pollUntil(
    () => { const j = safeActiveJob(db, projectId, 'screening_batch'); return !j || j.status !== 'running' },
    { maxMs: 60 * 60 * 1000 },
  )
  if (!autonomous) {
    return stepDone(db, projectId, 'screening') ? { status: 'done' } : { status: 'blocked', reason: 'awaiting_human_screening_decisions' }
  }
  // 自治:把 AI 结论 bulk-accept 为终审(include/exclude;uncertain 保留 → 仍可能未 done)
  const r2 = await selfPost(token, `/projects/${projectId}/screening/bulk-accept-ai`, {})
  if (!r2.ok) return { status: 'failed', reason: `screening_bulk_accept_failed_http_${r2.httpStatus}` }
  // bulk-accept 后:若仍有 uncertain 未决 → screening 不算 done,但有 include 即可继续下游
  if (stepDone(db, projectId, 'screening')) return { status: 'done' }
  if (countIncludedRecords(db, projectId) > 0) return { status: 'done' }   // 有纳入即可推进(uncertain 留待人工,不阻塞)
  return { status: 'blocked', reason: 'no_included_after_screening — AI 初筛后无纳入文献,检查协议纳排标准或文献池' }
}

function safeActiveJob(db, projectId, kind) {
  try { return batchJobsSvc.getActiveJob(db, projectId, kind) } catch { return null }
}

async function runExtraction(db, ctx) {
  const { token, projectId } = ctx
  if (stepDone(db, projectId, 'extraction')) return { status: 'done' }
  if (countIncludedRecords(db, projectId) === 0) return { status: 'blocked', reason: 'no_included_records_for_extraction' }
  const r = await selfPost(token, `/projects/${projectId}/matrix/run-batch-ai`, {})
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `matrix_trigger_failed_http_${r.httpStatus}` }
  await pollUntil(
    () => { const j = safeActiveJob(db, projectId, 'matrix_extraction'); return !j || j.status !== 'running' },
    { maxMs: 90 * 60 * 1000 },
  )
  return stepDone(db, projectId, 'extraction') ? { status: 'done' } : { status: 'done' }  // 矩阵部分完成也推进(不硬卡)
}

async function runRob(db, ctx) {
  const { token, projectId } = ctx
  if (stepDone(db, projectId, 'rob')) return { status: 'done' }
  if (countIncludedRecords(db, projectId) === 0) return { status: 'blocked', reason: 'no_included_records_for_rob' }
  const r = await selfPost(token, `/projects/${projectId}/rob/run-batch-ai`, { mode: 'fast' })
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `rob_trigger_failed_http_${r.httpStatus}` }
  await pollUntil(
    () => { const j = safeActiveJob(db, projectId, 'rob_batch'); return !j || j.status !== 'running' },
    { maxMs: 90 * 60 * 1000 },
  )
  return stepDone(db, projectId, 'rob') ? { status: 'done' } : { status: 'done' }   // 80% 阈值未达也推进
}

async function runSynthesis(db, ctx) {
  const { token, projectId } = ctx
  if (stepDone(db, projectId, 'synthesis')) return { status: 'done' }
  const r = await selfPost(token, `/projects/${projectId}/synthesis/run`, {})
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `synthesis_trigger_failed_http_${r.httpStatus}` }
  // synthesis_run_status 列 → success/failed
  const ok = await pollUntil(
    () => db.prepare(`SELECT synthesis_run_status AS s FROM projects WHERE id = ?`).get(projectId)?.s !== 'running',
    { maxMs: 60 * 60 * 1000 },
  )
  if (!ok) return { status: 'failed', reason: 'synthesis_timeout' }
  return stepDone(db, projectId, 'synthesis') ? { status: 'done' } : { status: 'failed', reason: 'synthesis_no_themes' }
}

async function runCertainty(db, ctx) {
  const { token, projectId } = ctx
  if (stepDone(db, projectId, 'certainty')) return { status: 'done' }
  const r = await selfPost(token, `/projects/${projectId}/certainty/run-themes`, {})
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `certainty_trigger_failed_http_${r.httpStatus}` }
  await pollUntil(
    () => db.prepare(`SELECT certainty_run_status AS s FROM projects WHERE id = ?`).get(projectId)?.s !== 'running',
    { maxMs: 90 * 60 * 1000 },
  )
  return stepDone(db, projectId, 'certainty') ? { status: 'done' } : { status: 'done' }  // 部分完成也推进
}

async function runReport(db, ctx) {
  const { token, projectId } = ctx
  if (stepDone(db, projectId, 'report')) return { status: 'done' }
  const r = await selfPost(token, `/projects/${projectId}/report/generate-all`, {})
  if (!r.ok && r.httpStatus !== 409) return { status: 'failed', reason: `report_trigger_failed_http_${r.httpStatus}` }
  const ok = await pollUntil(
    () => db.prepare(`SELECT drafting_run_status AS s FROM projects WHERE id = ?`).get(projectId)?.s !== 'running',
    { maxMs: 120 * 60 * 1000 },
  )
  if (!ok) return { status: 'failed', reason: 'report_timeout' }
  return stepDone(db, projectId, 'report') ? { status: 'done' } : { status: 'failed', reason: 'report_no_sections' }
}

const EXECUTORS = {
  protocol: runProtocol,
  screening: runScreening,
  extraction: runExtraction,
  rob: runRob,
  synthesis: runSynthesis,
  certainty: runCertainty,
  report: runReport,
}

/**
 * 计算流水线计划(只读,供 /run/status 预览):返回每步 done/pending + 当前应跑步骤。
 */
export function computePipelinePlan(db, project) {
  const seq = sequenceFor(project.review_type)
  const steps = seq.map((key) => ({ key, done: stepDone(db, project.id, key) }))
  const next = steps.find((s) => !s.done) || null
  return { sequence: seq, steps, next_step: next ? next.key : null, all_done: steps.every((s) => s.done) }
}

/**
 * 启动一次自治流水线运行(可恢复 batch_job)。返回 { ok, jobId } 或 { ok:false, error }。
 * 在 setImmediate 后台跑;调用方立即拿到 jobId,之后轮询 /run/status。
 */
export function startPipelineRun(db, { project, userId }) {
  const autonomous = !!project.autonomous_mode
  const seq = sequenceFor(project.review_type)
  let job
  try {
    job = batchJobsSvc.startJob(db, {
      projectId: project.id, userId, kind: PIPELINE_KIND,
      total: seq.length,
      initial: { autonomous, sequence: seq, blocked_step: null, blocked_reason: null, current_step: null },
    })
  } catch (e) {
    return { ok: false, error: 'pipeline_already_running_or_start_failed', detail: e?.message }
  }
  const jobId = job.id

  setImmediate(async () => {
    let token = null, tokenId = null
    let done = 0
    try {
      const minted = generateApiToken(db, { userId, label: `pipeline_run:${jobId}` })
      token = minted.token; tokenId = minted.id
      const ctx = { token, projectId: project.id, autonomous }

      for (const key of seq) {
        if (stepDone(db, project.id, key)) { done++; batchJobsSvc.updateJobProgress(db, jobId, { done, current: { id: key, title: `${key} (already done)` } }); continue }
        batchJobsSvc.updateJobProgress(db, jobId, { current: { id: key, title: `running: ${key}` }, current_step: key })
        const exec = EXECUTORS[key]
        if (!exec) { done++; continue }   // 序列里没有执行器的步骤(理论不会)跳过
        let res
        try { res = await exec(db, ctx) } catch (e) { res = { status: 'failed', reason: `executor_threw: ${(e?.message || e).slice(0, 200)}` } }
        if (res.status === 'done') { done++; batchJobsSvc.updateJobProgress(db, jobId, { done }); continue }
        // blocked 或 failed → 停下,记原因
        batchJobsSvc.updateJobProgress(db, jobId, { done, blocked_step: key, blocked_reason: res.reason || res.status, current: null })
        batchJobsSvc.finishJob(db, jobId, { status: res.status === 'blocked' ? 'finished' : 'failed', errorMessage: `${res.status}@${key}: ${res.reason || ''}` })
        return
      }
      // 全部完成
      batchJobsSvc.updateJobProgress(db, jobId, { done, current: null, blocked_step: null, blocked_reason: null })
      batchJobsSvc.finishJob(db, jobId, { status: 'finished' })
    } catch (e) {
      console.error('[pipeline-orchestrator] crashed:', e)
      try { batchJobsSvc.finishJob(db, jobId, { status: 'failed', errorMessage: (e?.message || String(e)).slice(0, 300) }) } catch {}
    } finally {
      if (tokenId) { try { revokeApiToken(db, { userId, tokenId }) } catch {} }
    }
  })

  return { ok: true, jobId, autonomous, sequence: seq }
}

/**
 * 读流水线运行状态(供 /run/status)。
 */
export function getPipelineStatus(db, project) {
  let job = null
  try { job = batchJobsSvc.getActiveJob(db, project.id, PIPELINE_KIND) } catch {}
  const plan = computePipelinePlan(db, project)
  return {
    running: !!(job && job.status === 'running'),
    job: job ? {
      status: job.status,
      done: job.done, total: job.total,
      current_step: job.current_step || job.current?.id || null,
      blocked_step: job.blocked_step || null,
      blocked_reason: job.blocked_reason || null,
      started_at: job.startedAt, finished_at: job.finishedAt,
      last_error: job.lastError || null,
    } : null,
    plan,
  }
}
