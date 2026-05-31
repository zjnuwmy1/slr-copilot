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

  // ---- 3. Screening 真实状态 ----
  //   - 没 records  → not_started
  //   - 有 records 但人工决定未覆盖 → in_progress
  //   - 全部 records(去重后)都有人工决定 → done
  for (const key of ['screening', 'extraction', 'rob', 'synthesis', 'certainty', 'report']) {
    stepStatus[key] = { status: 'not_started', summary: '尚未开始' }
  }
  try {
    const recRow = db.prepare(
      `SELECT COUNT(*) AS total FROM records
       WHERE project_id = ? AND duplicate_of_record_id IS NULL`
    ).get(projectId)
    const totalRecords = recRow.total || 0
    if (totalRecords > 0) {
      const sdRow = db.prepare(
        `SELECT
           SUM(CASE WHEN COALESCE(sd.ai_suggestion, 'not_run') != 'not_run' THEN 1 ELSE 0 END) AS ai_done,
           SUM(CASE WHEN COALESCE(sd.human_decision, 'not_decided') != 'not_decided' THEN 1 ELSE 0 END) AS hu_done
         FROM records r
         LEFT JOIN screening_decisions sd ON sd.record_id = r.id AND sd.stage = 'title_abstract'
         WHERE r.project_id = ? AND r.duplicate_of_record_id IS NULL`
      ).get(projectId)
      const aiDone = sdRow.ai_done || 0
      const humanDone = sdRow.hu_done || 0
      if (humanDone >= totalRecords) {
        stepStatus.screening = { status: 'done', summary: `${humanDone}/${totalRecords} 已人工决定` }
      } else if (aiDone > 0 || humanDone > 0) {
        stepStatus.screening = {
          status: 'in_progress',
          summary: `AI 跑了 ${aiDone}/${totalRecords},人工决定 ${humanDone}/${totalRecords}`,
        }
      } else {
        stepStatus.screening = { status: 'in_progress', summary: `已导入 ${totalRecords} 篇,等待 AI/人工筛选` }
      }
    }
  } catch (e) { /* keep not_started */ }

  // ---- 4. Extraction / Matrix(2026-05 新版 Step 4)----
  //   双路径取最大值:
  //     ① 老 extractions(human_verified=1)
  //     ② 新 literature_matrix(任何 fields 非空 + completeness>=0.2)
  //   覆盖率达到 include 的 100% → done;有任何 → in_progress
  try {
    // 必须 JOIN records 过滤 duplicate_of_record_id IS NOT NULL — 那些是 dedup 合并的副本,
    //   它们继承的 include 决定已经"过户"给主记录,不应该重复计数。
    //   不过滤的话:用户看到 "已抽取 121/123 篇" — 分母 123 是含 dup 的 raw 决定数,
    //   分子 121 是 literature_matrix 实际行(已 dedup),永远凑不齐 → 误以为没抽完。
    const incRow = db.prepare(
      `SELECT COUNT(*) AS c
         FROM screening_decisions sd
         JOIN records r ON r.id = sd.record_id
        WHERE sd.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
    ).get(projectId)
    const includeCount = incRow.c || 0

    // 用 DISTINCT record_id 跨两表合并去重
    const extractedRow = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT record_id FROM extractions
         WHERE project_id = ? AND extracted_json IS NOT NULL AND extracted_json != ''
        UNION
        SELECT record_id FROM literature_matrix
         WHERE project_id = ? AND fields IS NOT NULL AND fields != '{}'
           AND completeness >= 0.2
      )
    `).get(projectId, projectId)
    const extCount = extractedRow.c || 0

    // Step 4 状态 — 之前只看"有没有填过矩阵行",抽取没开始就显"未开始",
    //   但用户其实从 Step 3 一旦标了 include 就进入 Step 4 准备阶段(配 PDF / 让 AI 定制矩阵列)。
    //   现在按业务进度细分:
    //     done         矩阵已填到 include 100%(或全部论文已抽过)
    //     in_progress  已抽过部分,或已配过 AI 定制矩阵列,或已上传过 Zotero 包,
    //                  或仅"有 include 但还没动手"(用户进入了准备阶段就算)
    //     not_started  连一条 include 都没有(Step 3 都没开始勾"纳入")
    const prepRow = db.prepare(`
      SELECT
        (SELECT matrix_ai_customized_at_version FROM projects WHERE id = ?) AS matrix_customized,
        (SELECT COUNT(*) FROM zotero_packages WHERE project_id = ?) AS zotero_pkg_count
    `).get(projectId, projectId) || {}
    const hasPrep = !!prepRow.matrix_customized || (prepRow.zotero_pkg_count || 0) > 0

    if (extCount > 0 && includeCount > 0 && extCount >= includeCount) {
      stepStatus.extraction = { status: 'done', summary: `${extCount}/${includeCount} 篇已抽取(矩阵)` }
    } else if (extCount > 0 && includeCount > 0) {
      stepStatus.extraction = { status: 'in_progress', summary: `已抽取 ${extCount}/${includeCount} 篇` }
    } else if (extCount > 0) {
      stepStatus.extraction = { status: 'in_progress', summary: `已抽取 ${extCount} 篇` }
    } else if (includeCount > 0 && hasPrep) {
      stepStatus.extraction = { status: 'in_progress', summary: `${includeCount} 篇待抽取(已开始准备)` }
    } else if (includeCount > 0) {
      stepStatus.extraction = { status: 'in_progress', summary: `${includeCount} 篇待抽取` }
    }
  } catch (e) { /* keep not_started */ }

  // ---- 5. RoB(risk of bias)----
  //   Phase 1 已上 5 工具(MMAT/RoB2/ROBINS-I/NOS/JBI-CS)— Step 5 状态联动 rob_assessments 行数:
  //     完成 ≥ 80% include → done
  //     完成 1+ 但 < 80% → in_progress
  //     完成 0 但有 rob_marked_done_at(外部完成自报告)→ done(兜底)
  //     完成 0 + 无自报告 → not_started(默认)
  try {
    // 同 Step 4 — 过滤 dup 才能拿到真正"应评估"的 include 数(否则分母虚高)
    const includeCount = db.prepare(
      `SELECT COUNT(*) AS c
         FROM screening_decisions sd
         JOIN records r ON r.id = sd.record_id
        WHERE sd.project_id = ? AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
          AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
    ).get(projectId).c || 0
    const robCount = db.prepare(
      `SELECT COUNT(*) AS c FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`
    ).get(projectId).c || 0
    const projRow = db.prepare(`SELECT rob_marked_done_at FROM projects WHERE id = ?`).get(projectId)

    if (includeCount > 0 && robCount >= Math.ceil(includeCount * 0.8)) {
      stepStatus.rob = { status: 'done', summary: `已评估 ${robCount}/${includeCount} 篇(AI + 人工)` }
    } else if (robCount > 0) {
      stepStatus.rob = { status: 'in_progress', summary: `已评估 ${robCount}/${includeCount} 篇` }
    } else if (projRow && projRow.rob_marked_done_at) {
      stepStatus.rob = { status: 'done', summary: '已外部完成(自报告)' }
    }
  } catch {}

  // ---- 6. Synthesis(主题聚类 + evidence matrix)----
  //   Bug fix(2026-05-24):三元两个分支都是 'in_progress' 的 typo,
  //   导致只要 themes > 0,Step 6 永远显示"进行中"而不是"已完成"。
  //   正确逻辑:
  //     - synthesis_run_status='running' 且 in lock window → 'in_progress'(正在跑 LLM)
  //     - themes > 0 → 'done'(已生成主题)
  //     - evidence_points > 0 但 themes = 0 → 'in_progress'(异常,部分数据)
  //     - 都没 → 'not_started'
  try {
    const thRow = db.prepare(`SELECT COUNT(*) AS c FROM themes WHERE project_id = ?`).get(projectId)
    const epRow = db.prepare(`SELECT COUNT(*) AS c FROM evidence_points WHERE project_id = ?`).get(projectId)
    const runRow = db.prepare(`SELECT synthesis_run_status, synthesis_run_started_at FROM projects WHERE id = ?`).get(projectId)
    const isRunning = !!(
      runRow?.synthesis_run_status === 'running' && runRow?.synthesis_run_started_at &&
      (Date.now() - new Date(runRow.synthesis_run_started_at + ' UTC').getTime() < 60 * 60 * 1000)
    )
    const themesCount = thRow.c || 0
    const epCount = epRow.c || 0
    if (isRunning) {
      stepStatus.synthesis = {
        status: 'in_progress',
        summary: `正在生成主题聚类(LLM 跑中)…`,
      }
    } else if (themesCount > 0) {
      stepStatus.synthesis = {
        status: 'done',
        summary: `${themesCount} 个主题,${epCount} 个证据点`,
      }
    } else if (epCount > 0) {
      stepStatus.synthesis = {
        status: 'in_progress',
        summary: `${epCount} 个证据点但无主题(异常状态)`,
      }
    }
  } catch (e) { /* keep not_started */ }

  // ---- 7. Certainty (主题级 + outcome 级) ----
  //   - certainty_run_status='running' OR 任何主题 outcome_run_status='running' → in_progress
  //   - 主题级 theme_certainty 全覆盖 OR outcome 级 grade_assessments 存在 → done
  //   - 否则 not_started
  try {
    const runRow = db.prepare(`SELECT certainty_run_status, certainty_run_started_at FROM projects WHERE id = ?`).get(projectId)
    const themeRunning = !!(
      runRow?.certainty_run_status === 'running' && runRow?.certainty_run_started_at &&
      (Date.now() - new Date(runRow.certainty_run_started_at + ' UTC').getTime() < 75 * 60 * 1000)
    )
    const outcomeRunning = db.prepare(
      `SELECT COUNT(*) AS c FROM themes WHERE project_id = ? AND outcome_run_status = 'running'
         AND outcome_run_started_at > datetime('now', '-20 minutes')`
    ).get(projectId).c || 0
    const tcRow = db.prepare(`SELECT COUNT(*) AS c FROM theme_certainty WHERE project_id = ?`).get(projectId).c || 0
    const themesRow = db.prepare(`SELECT COUNT(*) AS c FROM themes WHERE project_id = ?`).get(projectId).c || 0
    const grRow = db.prepare(`SELECT COUNT(*) AS c FROM grade_assessments WHERE project_id = ?`).get(projectId).c || 0
    if (themeRunning || outcomeRunning > 0) {
      stepStatus.certainty = { status: 'in_progress', summary: themeRunning ? '主题级 certainty 跑中…' : `${outcomeRunning} 个主题 outcome 跑中…` }
    } else if (themesRow > 0 && tcRow >= themesRow) {
      stepStatus.certainty = { status: 'done', summary: `${tcRow} 主题级评估 + ${grRow} outcome` }
    } else if (tcRow > 0 || grRow > 0) {
      stepStatus.certainty = { status: 'in_progress', summary: `${tcRow}/${themesRow} 主题已评 + ${grRow} outcome` }
    }
  } catch {}

  // ---- 8. Report (drafting) ----
  try {
    const dsRow = db.prepare(`SELECT COUNT(*) AS c FROM draft_sections WHERE project_id = ?`).get(projectId)
    if ((dsRow.c || 0) > 0) {
      stepStatus.report = {
        status: dsRow.c >= 5 ? 'done' : 'in_progress',  // 假设 5+ 个章节算完整
        summary: `${dsRow.c} 个章节已生成`,
      }
    }
  } catch (e) { /* keep not_started */ }

  // ---- 9. Submission (LaTeX + finalize) ----
  //   - 有 latex_renders 行(status='success')→ in_progress / done(看是否有 finalize zip)
  //   - 否则 not_started
  stepStatus.submission = { status: 'not_started', summary: '' }
  try {
    const lr = db.prepare(
      `SELECT COUNT(*) AS c FROM latex_renders WHERE project_id = ? AND status = 'success'`
    ).get(projectId).c || 0
    if (lr > 0) {
      stepStatus.submission = { status: 'in_progress', summary: `LaTeX 已渲染 ${lr} 次,可一键打包投稿包` }
    }
    // 看 /var/lib/slr/uploads/finalized/ 是否有该项目的 zip — 这里只看 DB 信号,
    // 文件系统检查交给路由层。如果用户已点过 finalize 至少一次,记为 done。
    // 暂时无 DB 标记 finalize 已跑;留待后续填充。
  } catch {}

  // 简单的"锁"规则:协议未审批前后续不能开始
  if (stepStatus.protocol.status !== 'done') {
    for (const key of ['screening', 'extraction', 'rob', 'synthesis', 'certainty', 'report', 'submission']) {
      stepStatus[key].status = 'locked'
    }
  }
  // Step 9 投稿:仅当 Step 8 撰写 in_progress 或 done 才解锁
  if (stepStatus.protocol.status === 'done'
      && stepStatus.report.status !== 'done'
      && stepStatus.report.status !== 'in_progress') {
    stepStatus.submission.status = 'locked'
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
