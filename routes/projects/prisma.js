/**
 * PRISMA 2020 清单跟踪 — 路由
 *
 * 挂载点(由 server.js 在汇总层 mount):/projects/:id/prisma
 *
 * 路由:
 *   GET  /                  渲染 27 项清单页(42 条 items),按 section 分组
 *   POST /item/:itemNumber  更新单条 item 的 status / notes / evidence_url
 *   POST /bulk-mark-step    把某个 workflow_step 下所有 items 标成指定 status
 *   GET  /export.md         导出整张清单为 Markdown
 *
 * 越权防御:每个请求都先 ownProjectOr404(),所有 SQL 都带 project_id = ?。
 */

import express from 'express'
import { audit } from '../../services/audit.js'
import { getProjectProgress, getWorkflowSteps } from '../../services/prisma.js'

const router = express.Router({ mergeParams: true })

const ALLOWED_STATUSES = ['not_started', 'in_progress', 'done', 'not_applicable']
const ALLOWED_SECTIONS = ['Title', 'Abstract', 'Introduction', 'Methods', 'Results', 'Discussion', 'Other']

// ---------- 工具:校验项目归属 ----------
function ownProjectOr404(db, projectId, userId) {
  return db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
}

// 把扁平的 42 条 items 按 section 分组,保持 PRISMA 顺序
function groupBySection(items) {
  const map = new Map()
  for (const s of ALLOWED_SECTIONS) map.set(s, [])
  for (const it of items) {
    const sec = ALLOWED_SECTIONS.includes(it.section) ? it.section : 'Other'
    map.get(sec).push(it)
  }
  // 排序:按 item_number 自然顺序(支持 '10a' 这种子项)
  function itemSortKey(n) {
    const m = String(n).match(/^(\d+)([a-z]?)$/i)
    if (!m) return [9999, '']
    return [parseInt(m[1], 10), (m[2] || '').toLowerCase()]
  }
  for (const sec of ALLOWED_SECTIONS) {
    map.get(sec).sort((a, b) => {
      const [an, as] = itemSortKey(a.item_number)
      const [bn, bs] = itemSortKey(b.item_number)
      if (an !== bn) return an - bn
      return as.localeCompare(bs)
    })
  }
  // 转成数组并附统计
  return ALLOWED_SECTIONS.map((name) => {
    const arr = map.get(name) || []
    const done = arr.filter((x) => x.status === 'done').length
    const na = arr.filter((x) => x.status === 'not_applicable').length
    const inprog = arr.filter((x) => x.status === 'in_progress').length
    return {
      name,
      items: arr,
      total: arr.length,
      done,
      not_applicable: na,
      in_progress: inprog,
      effectiveTotal: arr.length - na,
      donePct: arr.length ? Math.round(100 * done / arr.length) : 0,
    }
  }).filter((g) => g.total > 0)
}

// ---------- GET /  渲染清单页 ----------
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const items = db
    .prepare('SELECT * FROM prisma_checklist WHERE project_id = ? ORDER BY id')
    .all(project.id)

  const groups = groupBySection(items)
  const progress = getProjectProgress(db, project.id)
  const workflowSteps = getWorkflowSteps()

  // 整体统计(用于顶部卡片)
  const totals = {
    total: items.length,
    done: items.filter((x) => x.status === 'done').length,
    in_progress: items.filter((x) => x.status === 'in_progress').length,
    not_started: items.filter((x) => x.status === 'not_started').length,
    not_applicable: items.filter((x) => x.status === 'not_applicable').length,
  }
  totals.donePct = totals.total ? Math.round(100 * totals.done / totals.total) : 0

  // 每个 workflow_step 的统计(方便"一键完成"按钮显示进度)
  const stepStats = {}
  for (const s of workflowSteps) {
    stepStats[s.id] = { total: 0, done: 0, label: s.label }
  }
  for (const it of items) {
    if (!stepStats[it.workflow_step]) continue
    stepStats[it.workflow_step].total += 1
    if (it.status === 'done') stepStats[it.workflow_step].done += 1
  }

  res.render('projects/prisma', {
    title: project.title + ' · PRISMA 清单',
    project,
    progress,
    groups,
    totals,
    workflowSteps,
    stepStats,
    flash: req.session.flash || null,
  })
  delete req.session.flash
})

// ---------- POST /item/:itemNumber  更新一条 ----------
router.post('/item/:itemNumber', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const itemNumber = String(req.params.itemNumber || '').trim()
  const status = String(req.body.status || '').trim()
  const notes = String(req.body.notes || '').trim().slice(0, 5000) || null
  const evidenceUrl = String(req.body.evidence_url || '').trim().slice(0, 1000) || null

  if (!ALLOWED_STATUSES.includes(status)) {
    req.session.flash = { type: 'error', message: 'status 非法,需是 not_started / in_progress / done / not_applicable' }
    return res.redirect(`/projects/${project.id}/prisma#item-${encodeURIComponent(itemNumber)}`)
  }

  // 先取旧值(用于审计 + 校验 item 存在)
  const before = db
    .prepare('SELECT id, item_number, status, notes, evidence_url FROM prisma_checklist WHERE project_id = ? AND item_number = ?')
    .get(project.id, itemNumber)
  if (!before) {
    return res.status(404).render('error', { title: 'Not Found', message: 'PRISMA item 不存在' })
  }

  db.prepare(
    `UPDATE prisma_checklist
       SET status = ?, notes = ?, evidence_url = ?, updated_at = datetime('now', '+8 hours')
     WHERE project_id = ? AND item_number = ?`
  ).run(status, notes, evidenceUrl, project.id, itemNumber)

  audit(db, req, {
    eventType: 'prisma_item_updated',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      item_number: itemNumber,
      from_status: before.status,
      to_status: status,
      notes_changed: (before.notes || null) !== notes,
      evidence_changed: (before.evidence_url || null) !== evidenceUrl,
    },
  })

  req.session.flash = { type: 'success', message: `Item ${itemNumber} 已更新为 ${status}` }
  res.redirect(`/projects/${project.id}/prisma#item-${encodeURIComponent(itemNumber)}`)
})

// ---------- POST /bulk-mark-step  批量标记 ----------
router.post('/bulk-mark-step', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const workflowStep = String(req.body.workflow_step || '').trim()
  const status = String(req.body.status || 'done').trim()
  const validSteps = new Set(getWorkflowSteps().map((s) => s.id))

  if (!validSteps.has(workflowStep)) {
    req.session.flash = { type: 'error', message: `workflow_step 非法:${workflowStep}` }
    return res.redirect(`/projects/${project.id}/prisma`)
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    req.session.flash = { type: 'error', message: `status 非法:${status}` }
    return res.redirect(`/projects/${project.id}/prisma`)
  }

  // 取出受影响的 items(审计 + 计数)
  const affected = db
    .prepare('SELECT item_number, status FROM prisma_checklist WHERE project_id = ? AND workflow_step = ?')
    .all(project.id, workflowStep)

  const result = db
    .prepare(
      `UPDATE prisma_checklist
         SET status = ?, updated_at = datetime('now', '+8 hours')
       WHERE project_id = ? AND workflow_step = ?`
    )
    .run(status, project.id, workflowStep)

  audit(db, req, {
    eventType: 'prisma_bulk_marked',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      workflow_step: workflowStep,
      to_status: status,
      affected_count: result.changes,
      item_numbers: affected.map((r) => r.item_number),
      from_status_counts: affected.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1
        return acc
      }, {}),
    },
  })

  req.session.flash = {
    type: 'success',
    message: `已把 step "${workflowStep}" 的 ${result.changes} 条 item 标为 ${status}`,
  }
  res.redirect(`/projects/${project.id}/prisma`)
})

// ---------- GET /export.md  导出 Markdown ----------
router.get('/export.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).type('text/plain').send('项目不存在或无权访问')
  }

  const items = db
    .prepare('SELECT * FROM prisma_checklist WHERE project_id = ? ORDER BY id')
    .all(project.id)

  const groups = groupBySection(items)
  const total = items.length
  const done = items.filter((x) => x.status === 'done').length
  const pct = total ? Math.round(100 * done / total) : 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  const STATUS_ICON = {
    done: '✅ done',
    in_progress: '🟡 in_progress',
    not_started: '⚪ not_started',
    not_applicable: '⛔ not_applicable',
  }

  const lines = []
  lines.push(`# PRISMA 2020 Checklist — ${project.title}`)
  lines.push('')
  lines.push(`- 项目 ID: \`${project.id}\``)
  if (project.discipline) lines.push(`- 学科: ${project.discipline}`)
  if (project.review_type) lines.push(`- 综述类型: ${project.review_type}`)
  if (project.year_start || project.year_end) {
    lines.push(`- 年代范围: ${project.year_start || '?'}–${project.year_end || '?'}`)
  }
  lines.push(`- 生成于: ${now}`)
  lines.push(`- 完成度: ${done}/${total} (${pct}%)`)
  lines.push('')
  lines.push('> 本文件由 SLR Copilot 自动导出,适合作为系统综述附录。')
  lines.push('')

  for (const g of groups) {
    lines.push(`## ${g.name}`)
    lines.push('')
    lines.push(`_${g.done}/${g.total} 已完成_`)
    lines.push('')
    for (const it of g.items) {
      const icon = STATUS_ICON[it.status] || it.status
      lines.push(`### ${it.item_number}. ${it.topic} · ${icon}`)
      lines.push('')
      lines.push(`> ${it.recommendation}`)
      lines.push('')
      if (it.workflow_step) {
        lines.push(`**Workflow step:** \`${it.workflow_step}\``)
        lines.push('')
      }
      if (it.notes) {
        lines.push(`**Notes:** ${it.notes}`)
        lines.push('')
      }
      if (it.evidence_url) {
        lines.push(`**Evidence:** ${it.evidence_url}`)
        lines.push('')
      }
      if (it.updated_at) {
        lines.push(`_updated: ${it.updated_at}_`)
        lines.push('')
      }
    }
  }

  audit(db, req, {
    eventType: 'prisma_exported',
    userId: req.user.id,
    projectId: project.id,
    payload: { format: 'markdown', total, done, pct },
  })

  // 文件名安全化
  const safeTitle = project.title.replace(/[^\w一-龥\-]+/g, '_').slice(0, 50)
  res.type('text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="prisma-${safeTitle}-${project.id}.md"`)
  res.send(lines.join('\n'))
})

export default router
