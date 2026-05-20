/**
 * PRISMA 2020 服务 — 工作流进度 + 27 项清单种子。
 *
 * 加载顺序:
 *   - data/prisma-2020-checklist.json 是不可变的 spec
 *   - 每个新 project 创建时,把 42 条 items 拷一份到 prisma_checklist 表(status='not_started')
 *   - workflow_steps 数组里定义了 8 个 wizard 步骤,UI 用它渲染左侧 stepper
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.join(__dirname, '..', 'data', 'prisma-2020-checklist.json')

let SPEC = null
function loadSpec() {
  if (!SPEC) {
    SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
  }
  return SPEC
}

export function getWorkflowSteps() {
  return loadSpec().workflow_steps
}

export function getChecklistItems() {
  return loadSpec().items
}

/**
 * 项目创建时调用一次,把 42 条 items 写进 prisma_checklist。
 * 幂等:已存在的项目不重复种。
 */
export function seedChecklistForProject(db, projectId) {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM prisma_checklist WHERE project_id = ?')
    .get(projectId)
  if (existing && existing.n > 0) return { seeded: false, reason: 'already_exists' }

  const items = getChecklistItems()
  const stmt = db.prepare(`
    INSERT INTO prisma_checklist (project_id, item_number, section, topic, recommendation, workflow_step)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    for (const it of items) {
      stmt.run(projectId, it.item_number, it.section, it.topic, it.recommendation, it.workflow_step)
    }
  })
  tx()
  return { seeded: true, count: items.length }
}

/**
 * 计算项目在每个 wizard step 的进度。
 * 返回值:
 *   {
 *     stepStatus: {
 *       protocol: { status: 'done'|'in_progress'|'not_started'|'locked', summary: '...', evidence?: {...} },
 *       search: {...},
 *       ...
 *     },
 *     overallProgress: { donePct: 0-100, prismaItemsDone: n, prismaTotal: 42 },
 *   }
 *
 * 规则:
 *   - protocol: 找 protocols 表里 approved_by_user=1 → done;有任意 row → in_progress;否则 not_started
 *   - search: 找 search_strategies 表 → in_progress;且 result_count not null 至少一行 → done
 *   - screening / extraction / rob / synthesis / certainty / report: Phase 4+ 接入,先返回 'not_started' 占位
 *   - PRISMA item 进度按 status='done' 计数
 */
export function getProjectProgress(db, projectId) {
  const project = db.prepare('SELECT id, status FROM projects WHERE id = ?').get(projectId)
  if (!project) return null

  const stepStatus = {}

  // ---- 1. Protocol ----
  const protocolStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN approved_by_user = 1 THEN 1 ELSE 0 END) AS approved
    FROM protocols WHERE project_id = ?
  `).get(projectId)
  if (protocolStats.approved > 0) {
    stepStatus.protocol = { status: 'done', summary: `协议已审批(${protocolStats.total} 版)` }
  } else if (protocolStats.total > 0) {
    stepStatus.protocol = { status: 'in_progress', summary: `${protocolStats.total} 个未审批的版本` }
  } else {
    stepStatus.protocol = { status: 'not_started', summary: '尚未生成协议' }
  }

  // ---- 2. Search Strategy ----
  const searchStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result_count IS NOT NULL THEN 1 ELSE 0 END) AS logged
    FROM search_strategies WHERE project_id = ?
  `).get(projectId)
  if (searchStats.total === 0) {
    stepStatus.search = { status: 'not_started', summary: '尚未生成检索式' }
  } else if (searchStats.logged > 0) {
    stepStatus.search = { status: 'done', summary: `${searchStats.total} 条检索式,${searchStats.logged} 已记录命中数` }
  } else {
    stepStatus.search = { status: 'in_progress', summary: `${searchStats.total} 条检索式,未记录命中数` }
  }

  // ---- 3-8. 占位 ----
  for (const key of ['screening', 'extraction', 'rob', 'synthesis', 'certainty', 'report']) {
    stepStatus[key] = { status: 'not_started', summary: '尚未开放(Phase 4+)' }
  }

  // 简单的"锁"规则:协议未审批前后续不能开始
  if (stepStatus.protocol.status !== 'done') {
    for (const key of ['screening', 'extraction', 'rob', 'synthesis', 'certainty', 'report']) {
      stepStatus[key].status = 'locked'
    }
  }

  // ---- PRISMA 整体进度 ----
  const prismaStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
    FROM prisma_checklist WHERE project_id = ?
  `).get(projectId)

  return {
    stepStatus,
    prismaProgress: {
      total: prismaStats.total || 0,
      done: prismaStats.done || 0,
      in_progress: prismaStats.in_progress || 0,
      donePct: prismaStats.total
        ? Math.round((100 * (prismaStats.done || 0)) / prismaStats.total)
        : 0,
    },
  }
}
