/**
 * 复盘 & 协议迭代路由 (v2.0 mechanism)
 *
 * 挂载点(server.js):
 *   import projectIterateRouter from './routes/projects/iterate.js'
 *   app.use('/projects', requireUser, projectIterateRouter)
 *
 * 路由:
 *   GET  /:id/iterate              复盘入口页(展示 snapshot 关键指标 + 用户反馈输入 + 跑诊断按钮)
 *   POST /:id/iterate/diagnose     调 flagship + high reasoning 模型跑诊断,结果存 session
 *   GET  /:id/iterate/review       审阅 AI 给的 diagnosis + proposed new protocol(diff 视图)
 *   POST /:id/iterate/adopt        将 new_protocol 插成新版 (unapproved),redirect 到协议页让用户审批
 *   POST /:id/iterate/discard      丢弃 session 里的诊断结果(用户决定不用)
 */

import express from 'express'
import { runLlm } from '../../services/llm.js'
import { audit } from '../../services/audit.js'
import {
  gatherProjectSnapshot,
  ITERATION_SYSTEM,
  buildIterationUserPrompt,
  normalizeIterationOutput,
  adoptIterationAsNewProtocol,
  savePendingIteration,
  loadPendingIteration,
  deletePendingIteration,
} from '../../services/iteration.js'

const router = express.Router({ mergeParams: true })

function ownProjectOr404(db, projectId, userId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)
}

function buildSnapshotSummary(snapshot) {
  // 给 view 用的轻量摘要;也用于审计 payload + protocol.iteration_metadata
  const ta = snapshot.screening_stats?.title_abstract || {}
  return {
    from_version: snapshot.latest_protocol?.version ?? null,
    total_records: snapshot.record_counts.total,
    records_per_db: snapshot.record_counts.by_source.per_database || {},
    cross_db_dedup_count: snapshot.record_counts.by_source.cross_database_count || 0,
    screening_ta_decided: ta.decided_count ?? 0,
    screening_ta_include: ta.include ?? 0,
    screening_ta_exclude: ta.exclude ?? 0,
    screening_ta_include_rate: ta.include_rate,
    top_human_exclusion_count: snapshot.top_exclusion_reasons.human?.length || 0,
    themes_count: snapshot.themes?.length || 0,
  }
}

// ============================================================
// GET /:id/iterate — 入口页
// ============================================================
router.get('/:id/iterate', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  // 抓 snapshot 用于展示"系统看到了什么"
  let snapshot, summary, snapshotError = null
  try {
    snapshot = gatherProjectSnapshot(db, project.id)
    summary = buildSnapshotSummary(snapshot)
  } catch (e) {
    snapshotError = e.message
  }

  // 从 DB 读 pending(不再用 cookie-session,避免 Set-Cookie 撑爆 nginx buffer)
  const pendingDiagnosis = loadPendingIteration(db, { projectId: project.id, userId: req.user.id })

  res.render('projects/iterate', {
    title: `复盘迭代 · ${project.title}`,
    project,
    snapshot,
    summary,
    snapshotError,
    pendingDiagnosis,
  })
})

// ============================================================
// POST /:id/iterate/diagnose — 跑 AI 诊断
// ============================================================
// 防双击锁:同一 projectId 已在跑就拒绝(避免连点烧 LLM)
const inFlightDiagnose = new Set()

router.post('/:id/iterate/diagnose', async (req, res, next) => {
  const projectId = req.params.id
  if (inFlightDiagnose.has(projectId)) {
    if ((req.get('Accept') || '').includes('application/json')) {
      return res.status(409).json({ ok: false, error: '该项目已有诊断在跑,等完成再试' })
    }
    req.session.flash = { type: 'error', message: '该项目已有诊断在跑(可能 5-10 分钟),完成后再试' }
    return res.redirect(`/projects/${projectId}/iterate`)
  }
  inFlightDiagnose.add(projectId)

  // 整体 try/finally — 任何阶段抛错都正常释放锁,且不让 unhandled rejection 崩进程
  try {
    await doDiagnose(req, res)
  } catch (e) {
    return next(e)
  } finally {
    inFlightDiagnose.delete(projectId)
  }
})

async function doDiagnose(req, res) {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const userFeedback = String(req.body.user_feedback || '').trim().slice(0, 1500)

  let snapshot
  try {
    snapshot = gatherProjectSnapshot(db, project.id)
  } catch (e) {
    req.session.flash = { type: 'error', message: '收集项目快照失败:' + (e.message || String(e)) }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  const userPrompt = buildIterationUserPrompt({ snapshot, userFeedback })

  audit(db, req, {
    eventType: 'iteration_diagnose_requested',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      from_version: snapshot.latest_protocol?.version,
      total_records: snapshot.record_counts.total,
      include_rate: snapshot.screening_stats?.title_abstract?.include_rate,
      user_feedback_len: userFeedback.length,
      per_record_decisions_count: Array.isArray(snapshot.per_record_decisions)
        ? snapshot.per_record_decisions.length : 0,
      per_record_decisions_total: snapshot.per_record_decisions?.totalCandidates ?? null,
      per_record_decisions_truncated: !!snapshot.per_record_decisions?.truncated,
    },
  })

  let result
  try {
    result = await runLlm(db, {
      userId: req.user.id,
      actionType: 'iteration',         // 触发 STEP_SPECS['iteration'](flagship + high)
      projectId: project.id,
      system: ITERATION_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      // 'heavy' / 'flagship' alias 会通过 resolveStepModel 走 iteration step,
      // 默认 tier=flagship(opus-4-7 或 gpt-5.5 按 provider),reasoning=high
      model: 'flagship',
      maxTokens: 8192,                 // diagnosis + 完整新协议,留足空间
      timeoutMs: 600_000,              // 10 分钟 — high reasoning + 大 prompt
    })
  } catch (e) {
    console.error('[iterate/diagnose] runLlm threw:', e)
    req.session.flash = { type: 'error', message: '诊断失败:' + (e.message || String(e)).slice(0, 200) }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  if (!result.ok) {
    audit(db, req, {
      eventType: 'iteration_diagnose_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: { status: result.status, error: (result.error || '').slice(0, 300) },
    })
    req.session.flash = { type: 'error', message: `诊断失败:${result.status} — ${(result.error || '').slice(0, 200)}` }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  const normalized = normalizeIterationOutput(result.data || null)
  if (!normalized.ok) {
    audit(db, req, {
      eventType: 'iteration_diagnose_failed',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        status: 'normalize_failed',
        error: normalized.error,
        model: result.model,
        raw_text_head: typeof result.text === 'string' ? result.text.slice(0, 800) : null,
      },
    })
    req.session.flash = { type: 'error', message: `AI 输出无效:${normalized.error}` }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  // 存入 DB 替代 cookie-session(大对象塞 cookie 会触发 nginx upstream
  // sent too big header → 502 Bad Gateway)
  try {
    savePendingIteration(db, {
      projectId: project.id,
      userId: req.user.id,
      data: normalized.data,
      snapshotSummary: buildSnapshotSummary(snapshot),
      model: result.model,
      reasoning: result.reasoning,
      durationMs: result.durationMs,
      userFeedback,
    })
  } catch (e) {
    console.error('[iterate/diagnose] savePendingIteration failed:', e)
    req.session.flash = { type: 'error', message: '保存诊断结果失败:' + (e.message || String(e)).slice(0, 200) }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  audit(db, req, {
    eventType: 'iteration_diagnose_ok',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      model: result.model,
      reasoning: result.reasoning,
      duration_ms: result.durationMs,
      confidence: normalized.data.diagnosis.confidence,
      proposed_changes_count: normalized.data.proposed_changes.length,
      new_protocol_rq_count: normalized.data.new_protocol.research_questions.length,
      new_protocol_cg_count: normalized.data.new_protocol.concept_groups.length,
    },
  })

  res.redirect(`/projects/${project.id}/iterate/review`)
}   // doDiagnose end

// ============================================================
// GET /:id/iterate/review — 审阅诊断 + 新协议
// ============================================================
router.get('/:id/iterate/review', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const pending = loadPendingIteration(db, { projectId: project.id, userId: req.user.id })
  if (!pending) {
    req.session.flash = { type: 'error', message: '没有待审阅的诊断结果,请先跑一次诊断。' }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  // 拿当前协议做 diff 展示
  const currentProtocol = db.prepare(
    `SELECT version, research_questions, inclusion_criteria, exclusion_criteria,
            concept_groups, approved_by_user
     FROM protocols WHERE project_id = ? AND approved_by_user = 1
     ORDER BY version DESC LIMIT 1`
  ).get(project.id)

  res.render('projects/iterate-review', {
    title: `审阅复盘 · ${project.title}`,
    project,
    pending,
    currentProtocol: currentProtocol ? {
      version: currentProtocol.version,
      research_questions: safeArr(currentProtocol.research_questions),
      inclusion_criteria: safeArr(currentProtocol.inclusion_criteria),
      exclusion_criteria: safeArr(currentProtocol.exclusion_criteria),
      concept_groups: safeArr(currentProtocol.concept_groups),
    } : null,
  })
})

// ============================================================
// POST /:id/iterate/adopt — 写成新 protocol version (unapproved)
// ============================================================
router.post('/:id/iterate/adopt', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const pending = loadPendingIteration(db, { projectId: project.id, userId: req.user.id })
  if (!pending) {
    req.session.flash = { type: 'error', message: '没有待审阅的诊断结果。' }
    return res.redirect(`/projects/${project.id}/iterate`)
  }

  let inserted
  try {
    inserted = adoptIterationAsNewProtocol(db, {
      projectId: project.id,
      iterationData: pending.data,
      snapshotSummary: pending.snapshotSummary,
      llmModel: pending.model,
      llmReasoning: pending.reasoning,
      userIdForAudit: req.user.id,
    })
  } catch (e) {
    console.error('[iterate/adopt] insert failed:', e)
    req.session.flash = { type: 'error', message: '入库失败:' + (e.message || String(e)) }
    return res.redirect(`/projects/${project.id}/iterate/review`)
  }

  audit(db, req, {
    eventType: 'iteration_adopted',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      new_protocol_id: inserted.id,
      new_version: inserted.version,
      from_version: pending.snapshotSummary?.from_version,
      confidence: pending.data.diagnosis.confidence,
      model: pending.model,
    },
  })

  // 删除 pending,跳到协议页让用户审批
  try { deletePendingIteration(db, { projectId: project.id, userId: req.user.id }) } catch { /* ignore */ }
  req.session.flash = {
    type: 'success',
    message: `已生成协议 v${inserted.version}(未审批)。请审阅 + 编辑 + 审批后,再去检索页重跑 exploration / 主检索。`,
  }
  res.redirect(`/projects/${project.id}#protocol-v${inserted.version}`)
})

// ============================================================
// POST /:id/iterate/discard — 丢弃 pending 诊断
// ============================================================
router.post('/:id/iterate/discard', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).send('not found')
  try { deletePendingIteration(db, { projectId: project.id, userId: req.user.id }) } catch { /* ignore */ }
  req.session.flash = { type: 'success', message: '已丢弃 AI 诊断结果。' }
  res.redirect(`/projects/${project.id}/iterate`)
})

function safeArr(s) {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export default router
