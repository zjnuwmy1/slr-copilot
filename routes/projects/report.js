/**
 * Phase 6 Agent O — 综述初稿编辑器(章节起草 + PRISMA flow + 整文导出)
 *
 * Step 8 Agent B (Phase 8.A) 重写:
 *   - 老的 in-memory inFlightJobs Map 删了,改 DB 状态(projects.drafting_run_*
 *     主进度 + draft_sections.section_run_* 单章节锁,镜像 certainty M30/M31)。
 *   - 老的硬编码 SECTION_ORDER 9 章节 → loadSectionsForProject 动态章节
 *     (含自定义 / 期刊模板 / fallback)。
 *   - generate-section 改成 per-section 异步 + heartbeat;
 *     generate-all 改成 topo-sort orchestrator + 主 heartbeat,abstract 章节
 *     使用 ABSTRACT_FROM_DRAFT_SYSTEM 二次 pass。
 *
 * 挂载点(由 routes/projects/index.js 中转挂载):
 *   projectsRouter.use('/', reportRouter)   // 内部 path: /:id/report/*
 *
 * 路由清单:
 *   GET  /:id/report                                综述编辑器页(PRISMA flow + section 卡片)
 *   POST /:id/report/generate-section/:section      跑 LLM 写单个章节(异步 + 心跳)
 *   POST /:id/report/generate-all                   deps-aware 编排全部章节(后台,setImmediate)
 *   POST /:id/report/section/:sectionId/edit        人工编辑某章节
 *   GET  /:id/report/progress.json                  老路由(DB 状态版本)
 *   GET  /:id/report/section/:section/status.json   单章节状态轮询
 *   GET  /:id/report/run/status.json                整文 orchestrator 状态轮询
 *   GET  /:id/report/export.md                      完整 Markdown 导出
 *   POST /:id/report/optimize-figure-prompts        Opus 一键生成项目专属插图 prompt(同步,保持不动)
 */

import express from 'express'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { randomId } from '../../services/crypto.js'
import { audit } from '../../services/audit.js'
import { runLlm, runFileOpsLlm } from '../../services/llm.js'
// 优化打磨包 / Session-continuity:detect heavy-model provider + user creds
import { inferProviderFromModelName } from '../../services/settings.js'
import { getEffectiveConfigForUser as stepPresetsGetEffectiveConfigForUser } from '../../services/step-presets.js'
import { listUsableForUser } from '../../services/credentials.js'
import { exportReferencesSection, buildInlineCitationMap } from '../../services/reference-export.js'
import { renderSoFMarkdown } from '../../services/grade.js'
import * as draftingPrompts from '../../services/prompts/drafting.js'
import {
  computePrismaFlow,
  renderPrismaMermaid,
  renderPrismaTextSummary,
} from '../../services/prisma-flow.js'
import { getProjectProgress, getChecklistItems } from '../../services/prisma.js'
import {
  getJournalTemplate,
  buildSectionStyleHint,
} from '../../services/journal-template.js'
import {
  generateYearTrendData,
  generateEvidenceMapData,
  generateFigurePrompts,
  renderYearTrendSvg,
  renderEvidenceMapSvg,
  OPTIMIZE_FIGURE_PROMPTS_SYSTEM,
  FIGURE_SYSTEM_VERSION,
  buildOptimizeFigurePromptsUserPrompt,
  parseFigurePromptsOutput,
} from '../../services/figures.js'
// Phase B (figure prompt enrichment): 10 数据源 helpers
import {
  loadAllThemeCertainty,
  loadSynthesisMetaForCertainty,
  indexLatestCertaintyByTheme,
  loadAllThemesWithMeta,
} from '../../services/certainty-helpers.js'
import { loadApprovedProtocolFull } from '../../services/synthesis-helpers.js'
import {
  saveFigureAsset,
  listFigureAssets,
  getFigureAsset,
  deleteFigureAsset,
  deleteAllFigureAssets,
  updateFigureAsset,
  buildFigureUrl,
} from '../../services/figure-assets.js'
import { renderTableExport } from '../../services/review-tables.js'
import { validateCitationsAgainstInclude } from '../../services/citation-validator.js'
import {
  loadCapabilities,
  saveCapabilities,
  buildCapabilitiesPromptBlock,
  summarizeCapabilities,
} from '../../services/methodology-capabilities.js'
import {
  buildAllRegisteredTables,
  listTableKeys,
  getAllTableDefs,
} from '../../services/table-registry.js'
import {
  PRISMA_VALIDATOR_SYSTEM,
  PRISMA_VALIDATOR_SYSTEM_VERSION,
  buildPrismaValidatorUserPrompt,
  parsePrismaValidatorOutput,
} from '../../services/prompts/prisma-validator.js'
import {
  LATEX_FILL_SYSTEM,
  LATEX_FILL_SYSTEM_VERSION,
  buildLatexFillUserPrompt,
  parseLatexFillOutput,
  // 2026-05-26 v5:per-section 分段填充 pipeline(保留但默认不走)
  LATEX_FILL_SECTION_SYSTEM,
  LATEX_FILL_SECTION_SYSTEM_VERSION,
  buildLatexFillSectionUserPrompt,
  parseLatexFillSectionOutput,
  assembleSectionsIntoTemplate,
  // 2026-05-26 v6:Claude CLI file-ops 模式(默认路径)
  LATEX_FILL_FILEOPS_INSTRUCTIONS_VERSION,
  buildLatexFillopsInstructions,
  generateBibtex,
} from '../../services/prompts/latex-fill.js'
// 2026-05-26:LaTeX overlay(Phase 1 模板专用 prompt 抽取)
import {
  LATEX_OVERLAY_SYSTEM,
  LATEX_OVERLAY_SYSTEM_VERSION,
  buildLatexOverlayUserPrompt,
  parseLatexOverlayOutput,
  renderLatexOverlayBlock,
} from '../../services/prompts/latex-overlay.js'
import {
  TABLE_RECOMMEND_SYSTEM,
  TABLE_RECOMMEND_SYSTEM_VERSION,
  buildTableRecommendUserPrompt,
  parseTableRecommendOutput,
} from '../../services/prompts/table-recommend.js'
import {
  TABLE_POLISH_SYSTEM,
  TABLE_POLISH_SYSTEM_VERSION,
  buildTablePolishUserPrompt,
  parseTablePolishOutput,
  computeTablePolishStale,
} from '../../services/prompts/table-polish.js'
import {
  LATEX_TEMPLATES_DIR,
  LATEX_RENDERS_DIR,
  ensureDir as ensureLatexDir,
  extractZipToDir,
  listTexFilesInSync,
  runPdflatex,
  packageRenderSource,
  sanitizeLatexPlaceholders,   // N4/N6 safety net — 兜底转换 LLM 漏处理的 [tbl:]/[fig:]
} from '../../services/latex-render.js'
import { requireAdvancedExtraction } from '../../middleware/auth.js'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import AdmZip from 'adm-zip'

// Phase 8.F:投稿包(finalize)落盘根目录
const DATA_DIR_FALLBACK_F = '/var/lib/slr'
const FINALIZED_DIR = path.join(process.env.DATA_DIR || DATA_DIR_FALLBACK_F, 'uploads', 'finalized')

// Phase 8.C: multer — 用 dynamic import + try/catch,缺包不崩,只让 upload 路由返 503
let figureUpload = null
let figureUploadImportError = null
let latexTemplateUpload = null
try {
  const multerMod = await import('multer')
  const multer = multerMod.default || multerMod
  figureUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },   // 10 MB
    fileFilter(_req, file, cb) {
      const mime = (file.mimetype || '').toLowerCase()
      const okMime = (
        mime === 'image/png' ||
        mime === 'image/jpeg' ||
        mime === 'image/jpg' ||
        mime === 'image/svg+xml' ||
        mime === 'application/pdf'
      )
      if (okMime) return cb(null, true)
      cb(new Error('只接受 PNG / JPG / SVG / PDF (10 MB 内)'))
    },
  })
  // Phase 8.E:LaTeX 模板 zip 上传(50 MB 上限,只接受 zip mime)
  latexTemplateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },   // 50 MB
    fileFilter(_req, file, cb) {
      const mime = (file.mimetype || '').toLowerCase()
      const name = (file.originalname || '').toLowerCase()
      const okMime = (
        mime === 'application/zip' ||
        mime === 'application/x-zip-compressed' ||
        mime === 'multipart/x-zip' ||
        mime === 'application/octet-stream' ||   // some browsers send this for .zip
        mime === ''
      )
      if (okMime && /\.zip$/.test(name)) return cb(null, true)
      cb(new Error('只接受 .zip 模板(50 MB 内)'))
    },
  })
} catch (e) {
  figureUploadImportError = e
  console.warn('[report] multer not available, /figures/upload + /latex/upload will return 503:',
    e?.message || e)
}

// ─── Agent A helpers (容错 import) ────────────────────────────────────────
//   Phase 8.A 的 services/drafting-helpers.js 由 Agent A 写。如果 Agent A 还
//   没落地,这里的 import 不能直接 ESM `import` — ESM import 失败会让整个
//   模块加载崩,把整个项目的 web server 拖死。所以用 try/catch + dynamic
//   import 在路由命中时再 fail，给前端一条清晰的 503 error message。
let draftingHelpers = null
let draftingHelpersImportError = null
try {
  draftingHelpers = await import('../../services/drafting-helpers.js')
} catch (e) {
  draftingHelpersImportError = e
  console.warn('[report] services/drafting-helpers.js not yet available — '
    + 'routes will return 503 until Agent A lands. Error: ' + (e?.message || e))
}

// Fallback 兜底:Agent A helpers 缺失时用最小默认值,让 GET /report 还能渲染。
const FALLBACK_SECTIONS_LOCAL = [
  { name: 'title',        label: '题目(Title)',         deps: [],                                          required: true  },
  { name: 'abstract',     label: '摘要(Abstract)',      deps: ['introduction', 'methods', 'results',
                                                                'discussion', 'conclusion'],                required: true  },
  { name: 'introduction', label: '引言(Introduction)',  deps: [],                                          required: true  },
  { name: 'methods',      label: '方法(Methods)',       deps: [],                                          required: true  },
  { name: 'results',      label: '结果(Results)',       deps: ['methods'],                                 required: true  },
  { name: 'discussion',   label: '讨论(Discussion)',    deps: ['results'],                                 required: true  },
  { name: 'limitations',  label: '局限(Limitations)',   deps: ['discussion'],                              required: false },
  { name: 'conclusion',   label: '结论(Conclusion)',    deps: ['discussion'],                              required: true  },
  { name: 'references',   label: '参考文献(References)', deps: [],                                          required: true  },
]

const router = express.Router({ mergeParams: true })

// ============================================================
// 工具
// ============================================================

function helpersOrReject(res) {
  if (!draftingHelpers) {
    res.status(503).json({
      ok: false,
      error: 'drafting_helpers_unavailable',
      message: 'services/drafting-helpers.js 还没落地(Agent A 写中)— 请稍后重试',
      import_error: (draftingHelpersImportError?.message || String(draftingHelpersImportError) || 'unknown'),
    })
    return null
  }
  return draftingHelpers
}

function getCustomSections(db, projectId) {
  if (draftingHelpers?.loadSectionsForProject) {
    try {
      const out = draftingHelpers.loadSectionsForProject(db, projectId)
      if (Array.isArray(out) && out.length) return out
    } catch (e) {
      console.warn('[report] loadSectionsForProject failed:', e?.message)
    }
  }
  return FALLBACK_SECTIONS_LOCAL
}

function topoSort(sections) {
  if (draftingHelpers?.topoSortSections) {
    try {
      return draftingHelpers.topoSortSections(sections)
    } catch (e) {
      console.warn('[report] topoSortSections failed, falling back to linear:', e?.message)
    }
  }
  // Fallback:线性,abstract 永远最后一批
  const noAbs = sections.filter((s) => s.name !== 'abstract')
  const abs = sections.filter((s) => s.name === 'abstract')
  return abs.length ? [noAbs, abs] : [noAbs]
}

function parseJsonArrayField(v) {
  if (!v) return []
  try {
    const x = JSON.parse(v)
    return Array.isArray(x) ? x : []
  } catch {
    return []
  }
}

function parseProject(row) {
  if (!row) return null
  return {
    ...row,
    databases: parseJsonArrayField(row.databases),
    language_limits: parseJsonArrayField(row.language_limits),
    document_types: parseJsonArrayField(row.document_types),
    seed_titles: parseJsonArrayField(row.seed_titles),
  }
}

function ownProjectOr404(db, projectId, userId) {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId)
  return parseProject(row)
}

function getApprovedProtocol(db, projectId) {
  const row = db
    .prepare(
      `SELECT * FROM protocols
       WHERE project_id = ? AND approved_by_user = 1
       ORDER BY version DESC LIMIT 1`
    )
    .get(projectId)
  if (!row) return null
  return {
    ...row,
    research_questions: parseJsonArrayField(row.research_questions),
    inclusion_criteria: parseJsonArrayField(row.inclusion_criteria),
    exclusion_criteria: parseJsonArrayField(row.exclusion_criteria),
  }
}

function listThemes(db, projectId) {
  const rows = db
    .prepare(
      `SELECT * FROM themes
       WHERE project_id = ?
       ORDER BY COALESCE(display_order, 9999) ASC, created_at ASC`
    )
    .all(projectId)
  return rows.map((row) => ({
    ...row,
    supporting_record_ids: parseJsonArrayField(row.supporting_record_ids),
    consistent_findings: parseJsonArrayField(row.consistent_findings),
    conflicting_findings: parseJsonArrayField(row.conflicting_findings),
    evidence_gaps: parseJsonArrayField(row.evidence_gaps),
  }))
}

function listEvidencePoints(db, projectId) {
  return db
    .prepare(
      `SELECT id, record_id, theme_id, finding, evidence_type, strength, section, page
       FROM evidence_points WHERE project_id = ? ORDER BY created_at ASC`
    )
    .all(projectId)
}

function listSearchStrategies(db, projectId) {
  return db
    .prepare(
      `SELECT id, database_name, query_type, query_text, result_count, version
       FROM search_strategies
       WHERE project_id = ?
       ORDER BY version DESC, database_name ASC, query_type ASC`
    )
    .all(projectId)
}

function listIncludedRecords(db, projectId) {
  // 用于:1) References 章节;2) citation_map 校验集合;3) prompt 里的"可引用论文列表"
  // M26:过滤掉 post-RoB excluded(纯理论/无实证那种)— 它们不参与 results/discussion/citations
  try {
    return db.prepare(`
      SELECT DISTINCT r.*
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
      WHERE r.project_id = ?
        AND (e.human_verified = 1 OR sd.human_decision = 'include')
        AND r.rob_excluded_at IS NULL
      ORDER BY r.year DESC, r.title ASC
    `).all(projectId)
  } catch {
    return []
  }
}

// =============================================================================
// P0.2 (2026-05-31):引文幻觉校验 + [tbl:]/[fig:] 占位 lint —— 抽成共享 helper。
//
// 背景:之前只有 orchestrator(generate-all)路径在生成后校验引文并把
//   hallucinated_recs_json / lint_warnings_json 落库;单章节"直接生成"路径
//   (setImmediate → generateSectionLlm → finishSection)不校验,导致同一篇手稿
//   的引文可信度取决于"你用哪个按钮生成的",autonomous 无人值守时尤其危险。
//
// 现在两条路径都调本 helper,保证:
//   - includeSet 严格取 listIncludedRecords(human_decision='include' 或
//     human_verified=1,且未被 post-RoB 排除)—— 非 include 的 [rec_xxx]
//     一律标 hallucinated(真校验,不只是格式校验)。
//   - [tbl:key]/[fig:id] 占位 key 不在注册表/figure assets 内 → 记 lint。
//
// 同步函数(validateCitationsAgainstInclude / listTableKeys / listFigureAssets
//   都是同步的),返回 { hallucinatedRecs:string[], lintWarnings:object|null }。
// 不抛异常:任一子步骤失败只 warn,返回已算出的部分。
// =============================================================================
function computeCitationLintForSection(db, projectId, contentMarkdown, citationMap) {
  let hallucinatedRecs = []
  try {
    const included = listIncludedRecords(db, projectId)
    const includeSet = new Set(included.map((rec) => rec.id))
    const result = validateCitationsAgainstInclude(
      contentMarkdown || '',
      includeSet,
      Array.isArray(citationMap) ? citationMap : [],
    )
    hallucinatedRecs = result.hallucinated || []
  } catch (e) {
    console.warn('[computeCitationLintForSection] citation validation failed:', e?.message)
  }

  let lintWarnings = null
  try {
    const validTableKeys = new Set(listTableKeys() || [])
    const figureAssets = listFigureAssets(db, projectId) || []
    const figureIdSet = new Set(figureAssets.map((a) => a.id))
    const unknownTables = new Set()
    const unknownFigures = new Set()
    const re = /\[(tbl|fig):([A-Za-z0-9_-]+)\]/g
    const md = contentMarkdown || ''
    let pm
    while ((pm = re.exec(md)) !== null) {
      const kind = pm[1]
      const id = pm[2]
      if (kind === 'tbl') {
        if (!validTableKeys.has(id)) unknownTables.add(id)
      } else {
        if (id !== 'prisma' && !figureIdSet.has(id)) unknownFigures.add(id)
      }
    }
    if (unknownTables.size > 0 || unknownFigures.size > 0) {
      lintWarnings = {
        unknown_tables: Array.from(unknownTables),
        unknown_figures: Array.from(unknownFigures),
      }
    }
  } catch (e) {
    console.warn('[computeCitationLintForSection] lint scan failed:', e?.message)
  }

  return { hallucinatedRecs, lintWarnings }
}

function shortRecordLabel(r) {
  const first = (() => {
    try {
      const arr = JSON.parse(r.authors_json || '[]')
      if (Array.isArray(arr) && arr.length) {
        return arr[0].surname || arr[0].family || arr[0].full || ''
      }
    } catch {}
    if (r.authors_text) return r.authors_text.split(/[,;]/)[0].trim()
    return ''
  })()
  return `${first || '?'} ${r.year || 'n.d.'} — ${(r.title || '').slice(0, 80)}`
}

/**
 * 列出 draft_sections 的最新版(每个 section_name 一行)。
 * 注意:Step 8.A 里 placeholder version(status='running' + 空 content)也会在
 * 这里出现 — view 层需要看 content_markdown 是否为空来判断 placeholder。
 */
function listLatestSections(db, projectId) {
  const rows = db.prepare(`
    SELECT ds.*
    FROM draft_sections ds
    JOIN (
      SELECT section_name, MAX(version) AS max_v
      FROM draft_sections
      WHERE project_id = ?
      GROUP BY section_name
    ) m ON m.section_name = ds.section_name AND m.max_v = ds.version
    WHERE ds.project_id = ?
  `).all(projectId, projectId)
  const map = {}
  for (const r of rows) {
    map[r.section_name] = {
      ...r,
      citation_map: parseJsonArrayField(r.citation_map),
    }
  }
  return map
}

/**
 * 取该 section 最新非 placeholder 的 content(给 abstract 二次 pass 用)。
 * Placeholder = 空 content_markdown(由 generate-section 在锁定时占位的行)。
 */
function getLatestNonEmptySection(db, projectId, sectionName) {
  const r = db.prepare(`
    SELECT * FROM draft_sections
     WHERE project_id = ? AND section_name = ?
       AND content_markdown IS NOT NULL AND content_markdown != ''
     ORDER BY version DESC LIMIT 1
  `).get(projectId, sectionName)
  return r || null
}

function getMaxSectionVersion(db, projectId, sectionName) {
  const r = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM draft_sections WHERE project_id = ? AND section_name = ?`
  ).get(projectId, sectionName)
  return r?.v || 0
}

/**
 * 计算单 section 的 inFlight 状态(用于 view & status.json)。
 * 仅看该 section_name 的最新 row。
 */
function getSectionRunState(db, projectId, sectionName) {
  const row = db.prepare(
    `SELECT id, version, section_run_status, section_run_started_at, section_run_finished_at,
            section_run_error, section_run_meta, content_markdown
       FROM draft_sections
      WHERE project_id = ? AND section_name = ?
      ORDER BY version DESC LIMIT 1`
  ).get(projectId, sectionName)
  if (!row) return { exists: false, in_flight: false, status: null }
  const started = row.section_run_started_at
  const status = row.section_run_status
  const elapsedS = started ? Math.max(0, Math.floor((Date.now() - new Date(started + ' UTC').getTime()) / 1000)) : 0
  // 单章节最长容忍 30 min(8.A 单 LLM call 上限 ~10-15 min,留余量)
  const inFlight = !!(status === 'running' && started && elapsedS < 30 * 60)
  let meta = null
  try { meta = row.section_run_meta ? JSON.parse(row.section_run_meta) : null } catch {}
  return {
    exists: true,
    row_id: row.id,
    version: row.version,
    in_flight: inFlight,
    status,
    started_at: started,
    finished_at: row.section_run_finished_at,
    error: row.section_run_error,
    elapsed_s: elapsedS,
    meta,
  }
}

/**
 * 主 orchestrator 的 inFlight 状态。
 */
function getOrchestratorState(project) {
  const started = project.drafting_run_started_at
  const status = project.drafting_run_status
  const elapsedS = started ? Math.max(0, Math.floor((Date.now() - new Date(started + ' UTC').getTime()) / 1000)) : 0
  // 整文最长容忍 90 min(8.A 顺序 8 章 × ~5 min = 40 min,留余量)
  const inFlight = !!(status === 'running' && started && elapsedS < 90 * 60)
  let meta = null
  try { meta = project.drafting_run_meta ? JSON.parse(project.drafting_run_meta) : null } catch {}
  return {
    in_flight: inFlight,
    status,
    started_at: started,
    finished_at: project.drafting_run_finished_at,
    error: project.drafting_run_error,
    elapsed_s: elapsedS,
    meta,
  }
}

// ============================================================
// Phase 8.F · 投稿包就绪度计算(供 GET /:id/report 顶部状态卡 + finalize 路由复用)
// ============================================================
function computeFinalizationReady(db, project, { customSections, latexLastRender }) {
  // 1) 章节完成度(required 章节)
  const sectionsMap = listLatestSections(db, project.id)
  const requiredSections = (customSections || []).filter((s) => s.required !== false)
  let sectionsDone = 0
  const missingRequired = []
  for (const s of requiredSections) {
    const row = sectionsMap[s.name]
    if (row && row.content_markdown && row.content_markdown.trim()) sectionsDone++
    else missingRequired.push(s.name)
  }
  const sectionsReady = sectionsDone >= requiredSections.length && requiredSections.length > 0

  // 2) PRISMA 验证(>= 24/27 covered)
  let prismaRow
  try {
    prismaRow = db.prepare(
      `SELECT
          COUNT(*)                                                          AS total,
          SUM(CASE WHEN ai_validation_status IS NOT NULL THEN 1 ELSE 0 END) AS validated_n,
          SUM(CASE WHEN ai_validation_status = 'covered' THEN 1 ELSE 0 END) AS covered_n,
          SUM(CASE WHEN ai_validation_status = 'partial' THEN 1 ELSE 0 END) AS partial_n,
          SUM(CASE WHEN ai_validation_status = 'missing' THEN 1 ELSE 0 END) AS missing_n
       FROM prisma_checklist WHERE project_id = ?`
    ).get(project.id)
  } catch { prismaRow = null }
  const covered = (prismaRow && prismaRow.covered_n) || 0
  const partial = (prismaRow && prismaRow.partial_n) || 0
  const missing = (prismaRow && prismaRow.missing_n) || 0
  const validated = (prismaRow && prismaRow.validated_n) || 0
  const total = (prismaRow && prismaRow.total) || 0
  const unrated = Math.max(0, total - validated)
  const prismaReady = validated > 0 && covered >= 24

  // 3) Figures 上传数
  let figuresN = 0
  try { figuresN = listFigureAssets(db, project.id).length } catch {}

  // 4) Authors 填写数
  let authorsN = 0
  try {
    if (project.authors_json) {
      const arr = JSON.parse(project.authors_json)
      if (Array.isArray(arr)) authorsN = arr.length
    }
  } catch {}

  // 5) LaTeX 渲染
  let last_status = null, has_pdf = false, last_at = null
  if (latexLastRender) {
    last_status = latexLastRender.status || null
    last_at = latexLastRender.finished_at || latexLastRender.started_at || null
    has_pdf = !!(latexLastRender.pdf_path && fs.existsSync(latexLastRender.pdf_path))
  }
  const latexReady = last_status === 'success' && has_pdf

  // overall_ready:章节 + PRISMA + LaTeX
  //   优化打磨包:Authors 改为可选(用户可下载 zip 后自己手填) — 不再 hard gate
  //   figures 可为 0(纯文 review 无图)
  const overall_ready = sectionsReady && prismaReady && latexReady

  return {
    sections_done: sectionsDone,
    sections_total_required: requiredSections.length,
    sections_ready: sectionsReady,
    missing_required: missingRequired,
    prisma_validated: { covered, partial, missing, unrated, total, validated, ready: prismaReady },
    figures_uploaded: figuresN,
    authors_filled: authorsN,
    authors_optional: true,    // 新增标志:Authors 容缺(UI 用)
    latex_rendered: { last_status, has_pdf, last_at, ready: latexReady },
    overall_ready,
  }
}

// ============================================================
// GET /:id/report
// ============================================================
router.get('/:id/report', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const prismaCounts = computePrismaFlow(db, project.id)
  const mermaid = renderPrismaMermaid(prismaCounts)
  const themes = listThemes(db, project.id)
  const sections = listLatestSections(db, project.id)

  // Phase 8.A:动态 section 列表(替代硬编码 SECTION_ORDER)
  const customSections = getCustomSections(db, project.id)

  // Phase 8.A:per-section 状态汇总(Agent A 的 summarizeDraftSections 优先)
  let draftSummary = null
  if (draftingHelpers?.summarizeDraftSections) {
    try {
      draftSummary = draftingHelpers.summarizeDraftSections(db, project.id, customSections)
    } catch (e) {
      console.warn('[report] summarizeDraftSections failed, computing inline:', e?.message)
    }
  }
  if (!draftSummary) {
    // Fallback:简单 summary
    draftSummary = customSections.map((s) => {
      const st = getSectionRunState(db, project.id, s.name)
      const row = sections[s.name]
      return {
        section_name: s.name,
        label: s.label || draftingPrompts.SECTION_LABELS?.[s.name] || s.name,
        has_content: !!(row && row.content_markdown),
        version: row?.version || 0,
        user_edited: !!row?.user_edited,
        ...st,
      }
    })
  }

  // 主 orchestrator 状态
  const orchestrator = getOrchestratorState(project)

  // ────────────────────────────────────────────────────────────────────────
  // Phase 8.B:drafting overlay 状态(用于顶部 overlay 卡)
  //   - draftingOverlay: { overlay_text, system_version, at_protocol_version } | null
  //   - draftingOverlayStale: { stale, reason, ... }
  //   - draftingOverlayInFlight: boolean(锁是否被持有,且 15 min 内)
  // ────────────────────────────────────────────────────────────────────────
  let draftingOverlay = null
  let draftingOverlayStale = { stale: false, reason: null }
  let draftingOverlayInFlight = false
  try {
    if (draftingHelpers?.loadDraftingOverlay) {
      const raw = draftingHelpers.loadDraftingOverlay(project)
      if (raw && raw.overlay_text) {
        draftingOverlay = {
          overlay_text: raw.overlay_text,
          system_version: raw.system_version || null,
          at_protocol_version: project.drafting_master_prompt_at_version || null,
        }
        if (draftingHelpers.computeDraftingOverlayStale) {
          const protRow = db.prepare(
            `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
          ).get(project.id)
          const currentProtocolVersion = protRow?.version ?? null
          draftingOverlayStale = draftingHelpers.computeDraftingOverlayStale(
            raw,
            draftingPrompts.DRAFTING_SYSTEM_VERSION,
            { at: project.drafting_master_prompt_at_version, current: currentProtocolVersion }
          )
        }
      }
    }
    const lockStarted = project.drafting_master_prompt_optimize_started_at
    if (lockStarted) {
      const ms = Date.now() - new Date(lockStarted + ' UTC').getTime()
      draftingOverlayInFlight = ms < 15 * 60 * 1000
    }
  } catch (e) {
    console.warn('[report] drafting overlay state failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // M32-f · Manuscript Plan card state(plan-then-write)
  //   draftingPlan: { manuscript_thesis, narrative_arc, sections, ... } | null
  //   draftingPlanStale: stale 当 protocol 已升级到比 plan 生成时更高的 version
  //   draftingPlanInFlight: lock 是否在 10 min 内
  // ────────────────────────────────────────────────────────────────────────
  let draftingPlan = null
  let draftingPlanInFlight = false
  let draftingPlanStale = false
  let draftingPlanStaleReason = null   // 'protocol_upgraded' | 'overlay_added' | 'overlay_updated' | null
  let draftingPlanGeneratedAt = project.drafting_plan_generated_at || null
  const draftingPlanLockStarted = project.drafting_plan_started_at || ''
  try {
    if (project.drafting_plan_json) {
      const parsed = JSON.parse(project.drafting_plan_json)
      if (parsed && typeof parsed === 'object') draftingPlan = parsed
    }
  } catch (e) {
    console.warn('[report] parse drafting_plan_json failed:', e?.message)
  }
  try {
    if (draftingPlanLockStarted) {
      const ms = Date.now() - new Date(draftingPlanLockStarted + ' UTC').getTime()
      draftingPlanInFlight = ms < 10 * 60 * 1000
    }
  } catch {}
  try {
    if (draftingPlan) {
      // (a) protocol 升级了?
      if (project.drafting_plan_at_protocol_version != null) {
        const protRow = db.prepare(
          `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
        ).get(project.id)
        const currentV = protRow?.version
        if (currentV != null && Number(currentV) > Number(project.drafting_plan_at_protocol_version)) {
          draftingPlanStale = true
          draftingPlanStaleReason = 'protocol_upgraded'
        }
      }
      // (b) 优化打磨包:overlay 在 plan 之后才有 / 升级了 → plan 没看到当前 overlay → stale
      if (!draftingPlanStale) {
        const planSawOverlay = !!draftingPlan.with_overlay
        const planOverlayVersion = draftingPlan.overlay_at_version || null
        const currentOverlayVersion = project.drafting_master_prompt_at_version || null
        const hasOverlayNow = !!project.drafting_master_prompt_overlay
        if (hasOverlayNow && !planSawOverlay) {
          // plan 跑时没 overlay,现在有 overlay → plan 没受益于 overlay
          draftingPlanStale = true
          draftingPlanStaleReason = 'overlay_added'
        } else if (hasOverlayNow && planSawOverlay && currentOverlayVersion && planOverlayVersion
                   && Number(currentOverlayVersion) > Number(planOverlayVersion)) {
          draftingPlanStale = true
          draftingPlanStaleReason = 'overlay_updated'
        }
      }
    }
  } catch {}

  const progress = (() => { try { return getProjectProgress(db, project.id) } catch { return null } })()
  const stepItems = getChecklistItems().filter((it) => it.workflow_step === 'report')

  // ────────────────────────────────────────────────────────────────────────
  // Phase 8.D:PRISMA 27 项 AI 验证状态(全量清单 + 已 AI 验证标签)
  //   - prismaValidateInFlight: 验证 LLM 是否正在跑(15 min 内的锁)
  //   - prismaValidateStatus / Started / Finished / Error: run-status 列
  //   - prismaChecklistFull: 整张清单(42 行包含 sub-items)+ ai_validation_* 字段,
  //     给底部"PRISMA 27 项覆盖度"卡渲染。注意 stepItems 只是 workflow_step='report' 的子集,
  //     验证按钮要看的是全量。
  //   - prismaValidateCounts: 已 validated 的 covered / partial / missing / unrated 计数
  // ────────────────────────────────────────────────────────────────────────
  let prismaChecklistFull = []
  let prismaValidateCounts = { total: 0, validated: 0, covered: 0, partial: 0, missing: 0, unrated: 0 }
  try {
    prismaChecklistFull = db.prepare(
      `SELECT id, item_number, section, topic, recommendation, workflow_step,
              status, notes, evidence_url, updated_at,
              ai_validated_at, ai_validation_status, ai_validation_evidence
         FROM prisma_checklist
        WHERE project_id = ?
        ORDER BY id ASC`
    ).all(project.id)
    for (const it of prismaChecklistFull) {
      // 解 evidence JSON,给 view 直接用 (quote/section/recommendation)
      let ev = null
      try { ev = it.ai_validation_evidence ? JSON.parse(it.ai_validation_evidence) : null } catch {}
      it.ai_validation_evidence_parsed = ev
      prismaValidateCounts.total++
      if (it.ai_validation_status) {
        prismaValidateCounts.validated++
        if (it.ai_validation_status === 'covered') prismaValidateCounts.covered++
        else if (it.ai_validation_status === 'partial') prismaValidateCounts.partial++
        else if (it.ai_validation_status === 'missing') prismaValidateCounts.missing++
      } else {
        prismaValidateCounts.unrated++
      }
    }
  } catch (e) {
    console.warn('[report] prisma_checklist full load failed:', e?.message)
  }
  const _prismaValidateStarted = project.prisma_validate_started_at || ''
  let prismaValidateInFlight = false
  // 2026-05-26 BUG FIX:同时检查 status='running' — 否则服务重启后 status 已被
  //   boot logic 标 'aborted_by_restart',但 started_at 还在 → UI 误显示"验证中"
  //   直到 15 min 自然超时。镜像下方 recommend / polish 等的修复模式。
  if (_prismaValidateStarted && project.prisma_validate_status === 'running') {
    try {
      const ms = Date.now() - new Date(_prismaValidateStarted + ' UTC').getTime()
      prismaValidateInFlight = ms < 15 * 60 * 1000
    } catch {}
  }
  const prismaValidateOverallScore = prismaValidateCounts.total
    ? Math.round((100 * (prismaValidateCounts.covered + 0.5 * prismaValidateCounts.partial)) / prismaValidateCounts.total)
    : 0
  // 最近一次 ai_validated_at(展示给用户看上次跑的时间)
  let prismaValidateLastAt = null
  for (const it of prismaChecklistFull) {
    if (it.ai_validated_at && (!prismaValidateLastAt || it.ai_validated_at > prismaValidateLastAt)) {
      prismaValidateLastAt = it.ai_validated_at
    }
  }

  // Phase 9 Agent W:期刊模板状态 + 插图数据
  const journalTemplate = getJournalTemplate(db, project.id)
  const yearTrendData = generateYearTrendData(db, project.id)
  const evidenceMapData = generateEvidenceMapData(db, project.id)
  const yearTrendSvg = renderYearTrendSvg(yearTrendData)
  const evidenceMapSvg = renderEvidenceMapSvg(evidenceMapData)
  const figurePrompts = generateFigurePrompts(db, project.id)
  // M27: AI 优化后的项目专属 figure prompts(可能为空)
  let aiOptimizedFigures = []
  try {
    if (project.figure_prompts_ai_optimized) {
      const parsed = JSON.parse(project.figure_prompts_ai_optimized)
      if (parsed && Array.isArray(parsed.figures)) aiOptimizedFigures = parsed.figures
    }
  } catch {}

  // Phase 8.C: 用户外部生成 + 上传的图片资产
  const figureAssets = listFigureAssets(db, project.id)
  // 按 figure_key 分组,view 层在每张 AI 优化图卡片下渲染对应的上传缩略图
  const figureAssetsByKey = {}
  for (const fa of figureAssets) {
    const k = fa.figure_key || 'manual'
    if (!figureAssetsByKey[k]) figureAssetsByKey[k] = []
    figureAssetsByKey[k].push(fa)
  }

  // 审计:浏览图提示词的事件
  try {
    audit(db, req, {
      eventType: 'figure_prompts_viewed',
      userId: req.user.id,
      projectId: project.id,
      payload: { prompt_count: figurePrompts.length, has_template: !!journalTemplate },
    })
  } catch {}

  // ────────────────────────────────────────────────────────────────────────
  // Phase 8.E:LaTeX 模板状态 + 上次渲染 + authors 表单数据
  // ────────────────────────────────────────────────────────────────────────
  let latexTemplate = {
    zip_path: project.latex_template_zip_path || null,
    extracted_at: project.latex_template_extracted_at || null,
    extract_dir: project.latex_template_extract_dir || null,
    main_tex_filename: project.latex_main_tex_filename || null,
    tex_files: [],
  }
  try {
    if (latexTemplate.extract_dir) {
      latexTemplate.tex_files = listTexFilesInSync(latexTemplate.extract_dir)
    }
  } catch (e) {
    console.warn('[report] listTexFilesInSync failed:', e?.message)
  }
  let latexAuthors = {
    authors: [],
    affiliations: [],
    correspondence_email: project.correspondence_email || '',
    funding_text: project.funding_text || '',
    acknowledgements_text: project.acknowledgements_text || '',
  }
  try {
    if (project.authors_json) {
      const a = JSON.parse(project.authors_json)
      if (Array.isArray(a)) latexAuthors.authors = a
    }
    if (project.affiliations_json) {
      const a = JSON.parse(project.affiliations_json)
      if (Array.isArray(a)) latexAuthors.affiliations = a
    }
  } catch (e) { console.warn('[report] parse authors_json/affiliations_json failed:', e?.message) }
  let latexLastRender = null
  try {
    latexLastRender = db.prepare(
      `SELECT id, project_id, started_at, finished_at, status, pdf_path, log_path, tex_path, error, llm_usage_log_id
         FROM latex_renders
        WHERE project_id = ?
        ORDER BY started_at DESC
        LIMIT 1`
    ).get(project.id) || null
  } catch (e) { console.warn('[report] latex_renders load failed:', e?.message) }
  const latexRenderInFlight = !!(latexLastRender
    && latexLastRender.status === 'running'
    && latexLastRender.started_at
    && (Date.now() - new Date(latexLastRender.started_at + ' UTC').getTime() < 30 * 60 * 1000))

  // ────────────────────────────────────────────────────────────────────────
  // Phase 8.F — 投稿包就绪度(顶部状态总览卡)+ 最近一次 finalize 时间戳
  // ────────────────────────────────────────────────────────────────────────
  let finalizationReady = null
  try {
    finalizationReady = computeFinalizationReady(db, project, { customSections, latexLastRender })
  } catch (e) {
    console.warn('[report] computeFinalizationReady failed:', e?.message)
  }
  let lastFinalizedZip = null
  try {
    if (fs.existsSync(FINALIZED_DIR)) {
      const prefix = project.id + '_'
      const candidates = fs.readdirSync(FINALIZED_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.zip'))
        .map((f) => {
          const full = path.join(FINALIZED_DIR, f)
          let mtime = 0
          try { mtime = fs.statSync(full).mtimeMs } catch {}
          // 时间戳从文件名解析(<projectId>_<ts>.zip)
          const m = f.match(/_(\d+)\.zip$/)
          const ts = m ? Number(m[1]) : 0
          return { filename: f, full, mtime, ts }
        })
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length) lastFinalizedZip = candidates[0]
    }
  } catch (e) { console.warn('[report] lastFinalizedZip lookup failed:', e?.message) }

  // 兼容老 view — sectionList 用 customSections 派生(替代硬编码 SECTION_ORDER)
  const sectionList = customSections.map((s) => {
    const row = sections[s.name] || null
    return {
      section_name: s.name,
      label: s.label || draftingPrompts.SECTION_LABELS?.[s.name] || s.name,
      has_content: !!(row && row.content_markdown),
      content_preview: row && row.content_markdown ? row.content_markdown.slice(0, 200) : '',
      content_markdown: row?.content_markdown || '',
      version: row?.version || 0,
      user_edited: !!row?.user_edited,
      citation_count: row?.citation_map?.length || 0,
      updated_at: row?.updated_at || null,
      section_id: row?.id || null,
      deps: s.deps || [],
      required: s.required !== false,
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // 📋 数据型表(自动从 DB 派生,无需 LLM)
  //   Table 1: Characteristics of Included Studies(按主题分子表)
  //   Table 2: Summary of Findings(outcome 级 GRADE)
  //   Table 3a: RoB Traffic Light(逐 study × domain)
  //   Table 3b: RoB Domain Summary(stacked bar 数据)
  //   Table 4: Evidence Profile(主题级 GRADE/CERQual)
  //   渲染耗时:毫秒级,纯 SQL + 模板,0 token。
  // ────────────────────────────────────────────────────────────────────────
  let _reviewTables = null
  let _tableDefs = null
  try {
    _reviewTables = buildAllRegisteredTables(db, project.id)
    _tableDefs = getAllTableDefs()
  } catch (e) {
    console.warn('[report] buildAllRegisteredTables failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Phase A5 — ⚡ AI 表格推荐(Opus 看完项目数据 → 推荐用哪几张表)
  //   recommendedTables:   解析后的标准化 JSON(recommended_for_paper / proposed_custom_tables / ...)
  //   recommendInFlight:   bool — 锁是否在 10 min 内
  //   recommendStale:      bool — 协议升级 OR system_version 升级 → 现有推荐已过期
  //   recommendStaleReason: 'protocol_upgraded' | 'system_prompt_upgraded' | 'old_no_version' | null
  // ────────────────────────────────────────────────────────────────────────
  let recommendedTables = null
  let recommendInFlight = false
  let recommendStale = false
  let recommendStaleReason = null
  try {
    if (project.recommended_tables_json) {
      const parsed = JSON.parse(project.recommended_tables_json)
      if (parsed && typeof parsed === 'object') recommendedTables = parsed
    }
  } catch (e) {
    console.warn('[report] parse recommended_tables_json failed:', e?.message)
  }
  try {
    const lockStarted = project.recommend_tables_started_at
    // 2026-05-26 BUG FIX:status='running' gate(避免 aborted_by_restart 误报)
    if (lockStarted && project.recommend_tables_status === 'running') {
      const ms = Date.now() - new Date(lockStarted + ' UTC').getTime()
      recommendInFlight = ms < 10 * 60 * 1000
    }
  } catch {}
  try {
    if (recommendedTables) {
      // 协议升级?
      const atProto = project.recommended_tables_at_protocol_version
      if (atProto != null) {
        const r = db.prepare(
          `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
        ).get(project.id)
        if (r && r.version != null && Number(r.version) > Number(atProto)) {
          recommendStale = true
          recommendStaleReason = 'protocol_upgraded'
        }
      }
      // SYSTEM_VERSION 升级?
      if (!recommendStale) {
        const atSys = project.recommended_tables_at_system_version
        if (!atSys) {
          recommendStale = true
          recommendStaleReason = 'old_no_version'
        } else if (atSys !== TABLE_RECOMMEND_SYSTEM_VERSION) {
          recommendStale = true
          recommendStaleReason = 'system_prompt_upgraded'
        }
      }
    }
  } catch (e) {
    console.warn('[report] recommendStale compute failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // T3 · Per-table LLM 精修(polish)状态:
  //   polishedTablesByKey:  { [tableKey]: { polished_caption, polished_column_headers,
  //                          polished_paragraph_lead, polished_footnotes, row_reorder_keys,
  //                          model, generated_at, system_version, error? } | null }
  //   polishInFlightByKey:  { [tableKey]: { started_at, model } } — 仅锁还在 10 min 内的项
  // 注意:partial 用 typeof guard,所以即使两个 map 都是空 {} 也安全。
  // ────────────────────────────────────────────────────────────────────────
  let polishedTablesByKey = {}
  let polishInFlightByKey = {}
  try {
    if (project.polished_tables_json) {
      const parsed = JSON.parse(project.polished_tables_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        polishedTablesByKey = parsed
      }
    }
  } catch (e) {
    console.warn('[report] parse polished_tables_json failed:', e?.message)
  }
  try {
    if (project.polish_tables_in_flight) {
      const parsed = JSON.parse(project.polish_tables_in_flight)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 只保留 10 min 内的锁(过期当作没锁,让 UI 不卡"loading")
        const now = Date.now()
        for (const [k, v] of Object.entries(parsed)) {
          if (!v || !v.started_at) continue
          try {
            const ms = now - new Date(v.started_at + ' UTC').getTime()
            if (ms < 10 * 60 * 1000) polishInFlightByKey[k] = v
          } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('[report] parse polish_tables_in_flight failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // N3 · 精修 stale 检测(per-key)
  //   每条 polishedTablesByKey[k] 跟当前 system_version / protocol_version /
  //   recommendation_finished_at 比对,出 { stale, reason } —
  //   3 个触发条件:system_prompt_upgraded / protocol_upgraded / recommendation_updated.
  // ────────────────────────────────────────────────────────────────────────
  const polishStaleByKey = {}
  try {
    // 当前 approved protocol version(int)
    let currentProtoVer = null
    try {
      const r = db.prepare(
        `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
      ).get(project.id)
      currentProtoVer = (r && r.version != null) ? r.version : null
    } catch {}
    const currentRecAt = project.recommend_tables_finished_at || null
    for (const k of Object.keys(polishedTablesByKey)) {
      polishStaleByKey[k] = computeTablePolishStale(
        polishedTablesByKey[k],
        TABLE_POLISH_SYSTEM_VERSION,
        currentProtoVer,
        currentRecAt,
      )
    }
  } catch (e) {
    console.warn('[report] compute polishStaleByKey failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // N2 · 批量精修 orchestrator 状态
  //   page-load 时读 polish_batch_* — 让 UI 决定是显示"启动按钮"还是
  //   "进行中卡片"。前端 JS 会再用 status.json 5s 轮询拿动态进度。
  // ────────────────────────────────────────────────────────────────────────
  let polishBatchInFlight = false
  let polishBatchElapsedS = 0
  let polishBatchMeta = null
  try {
    if (project.polish_batch_started_at) {
      const ms = Date.now() - new Date(project.polish_batch_started_at + ' UTC').getTime()
      polishBatchElapsedS = Math.max(0, Math.floor(ms / 1000))
      polishBatchInFlight = ms < 60 * 60 * 1000 && project.polish_batch_status === 'running'
    }
    polishBatchMeta = project.polish_batch_meta ? JSON.parse(project.polish_batch_meta) : null
  } catch (e) {
    console.warn('[report] parse polish_batch_* failed:', e?.message)
  }

  // ────────────────────────────────────────────────────────────────────────
  // 撰写输入数据画像(view 顶部"📊 这一步会带入的输入数据"卡)
  //   对照 certainty / synthesis 同款,让用户看到 LLM 实际看见的所有数据来源。
  //   每条字段都对应一次后端真实 SQL 计数,不假设。
  // ────────────────────────────────────────────────────────────────────────
  let _ingestSummary = null
  try {
    // a) 协议 — protocols 表 schema:research_questions / concept_groups 是分开的 JSON 列
    //    (历史 bug:之前用了不存在的 protocol_json 列 → rqCount/picoCount 永远 0)
    let protRow = null
    let rqCount = 0
    let picoConceptCount = 0
    try {
      protRow = db.prepare(
        `SELECT version, created_at, research_questions, concept_groups
           FROM protocols
          WHERE project_id = ? AND approved_by_user = 1
          ORDER BY version DESC LIMIT 1`
      ).get(project.id)
      if (protRow?.research_questions) {
        try { const a = JSON.parse(protRow.research_questions); if (Array.isArray(a)) rqCount = a.length } catch {}
      }
      if (protRow?.concept_groups) {
        try { const a = JSON.parse(protRow.concept_groups); if (Array.isArray(a)) picoConceptCount = a.length } catch {}
      }
    } catch {}

    // b) 纳入论文(用于撰写) — records 去 dup + include
    //    优先 full_text include;若项目只跑了单阶段(title_abstract),退而用其 include 数
    //    (历史 bug:之前用了不存在的 sd.decision 列 — 实际列名是 sd.human_decision)
    let includedPapersN = 0
    try {
      const r = db.prepare(
        `SELECT COUNT(DISTINCT sd.record_id) AS n
           FROM screening_decisions sd
           JOIN records r ON r.id = sd.record_id
          WHERE sd.project_id = ?
            AND sd.stage = 'full_text'
            AND sd.human_decision = 'include'
            AND r.duplicate_of_record_id IS NULL`
      ).get(project.id)
      includedPapersN = r?.n || 0
    } catch {}
    if (includedPapersN === 0) {
      // Fallback:项目可能只跑 title_abstract 单阶段(对照 services/prisma-flow.js 同款 fallback)
      try {
        const r = db.prepare(
          `SELECT COUNT(DISTINCT sd.record_id) AS n
             FROM screening_decisions sd
             JOIN records r ON r.id = sd.record_id
            WHERE sd.project_id = ?
              AND sd.stage = 'title_abstract'
              AND sd.human_decision = 'include'
              AND r.duplicate_of_record_id IS NULL`
        ).get(project.id)
        includedPapersN = r?.n || 0
      } catch {}
    }

    // c) Step 4 文献矩阵行数(有 fields 的论文)
    let matrixRowsN = 0
    try {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM literature_matrix WHERE project_id = ?`
      ).get(project.id)
      matrixRowsN = r?.n || 0
    } catch {}

    // d) Step 5 RoB 评估行数(拆 pass-1 主评 + pass-2 复核)
    let robN = 0, robPass1N = 0, robPass2N = 0
    try {
      const a = db.prepare(`SELECT COUNT(*) AS n FROM rob_assessments WHERE project_id = ?`).get(project.id)
      robN = a?.n || 0
      const b = db.prepare(`SELECT COUNT(*) AS n FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`).get(project.id)
      robPass1N = b?.n || 0
      robPass2N = robN - robPass1N
    } catch {}

    // e) Step 6 主题数(themes 已 load)+ Step 6 synthesis_meta
    const themesN = themes.length
    let crossCuttingN = 0
    let coverageRqN = 0
    try {
      const meta = db.prepare(
        `SELECT cross_cutting_observations, protocol_coverage FROM synthesis_meta WHERE project_id = ? LIMIT 1`
      ).get(project.id)
      if (meta?.cross_cutting_observations) {
        try { const a = JSON.parse(meta.cross_cutting_observations); if (Array.isArray(a)) crossCuttingN = a.length } catch {}
      }
      if (meta?.protocol_coverage) {
        try { const c = JSON.parse(meta.protocol_coverage); if (c && typeof c === 'object') coverageRqN = Object.keys(c).length } catch {}
      }
    } catch {}

    // f) Step 7 主题级 certainty — DISTINCT theme(每主题最新 iteration 算 1 个)
    //    (历史 bug:COUNT(*) 算 N theme × M iterations = 24,误导用户以为有 24 个评估)
    let themeCertaintyN = 0, gradeN = 0, cerqualN = 0, hybridN = 0
    try {
      const rows = db.prepare(
        `SELECT theme_id, grading_framework FROM theme_certainty WHERE project_id = ?
          ORDER BY iteration_n DESC, updated_at DESC`
      ).all(project.id)
      const seen = new Set()
      for (const r of rows) {
        if (seen.has(r.theme_id)) continue
        seen.add(r.theme_id)
        if (r.grading_framework === 'grade') gradeN++
        else if (r.grading_framework === 'cerqual') cerqualN++
        else if (r.grading_framework === 'hybrid') hybridN++
      }
      themeCertaintyN = seen.size
    } catch {}

    // g) Step 7 outcome 级 GRADE(per-outcome SoF)
    let outcomeGradesN = 0
    try {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM grade_assessments WHERE project_id = ?`
      ).get(project.id)
      outcomeGradesN = r?.n || 0
    } catch {}

    // h) 期刊模板 + section guides + table_count(2026-05-25 新加给 chip / 推荐卡用)
    const journalSectionsN = (() => {
      try {
        if (!journalTemplate?.extracted_structure) return 0
        const s = typeof journalTemplate.extracted_structure === 'string'
          ? JSON.parse(journalTemplate.extracted_structure) : journalTemplate.extracted_structure
        return Array.isArray(s?.sections) ? s.sections.length : 0
      } catch { return 0 }
    })()
    const journalTableCount = (() => {
      try {
        if (!journalTemplate?.extracted_structure) return null
        const s = typeof journalTemplate.extracted_structure === 'string'
          ? JSON.parse(journalTemplate.extracted_structure) : journalTemplate.extracted_structure
        const n = Number(s?.table_count)
        return Number.isFinite(n) && n >= 0 ? n : null
      } catch { return null }
    })()
    const journalFigureCount = (() => {
      try {
        if (!journalTemplate?.extracted_structure) return null
        const s = typeof journalTemplate.extracted_structure === 'string'
          ? JSON.parse(journalTemplate.extracted_structure) : journalTemplate.extracted_structure
        const n = Number(s?.figure_count)
        return Number.isFinite(n) && n >= 0 ? n : null
      } catch { return null }
    })()

    // i) Figures(AI prompts + 用户上传)
    const figurePromptsN = (Array.isArray(aiOptimizedFigures) && aiOptimizedFigures.length)
      ? aiOptimizedFigures.length
      : (Array.isArray(figurePrompts) ? figurePrompts.length : 0)
    const figureUploadsN = Array.isArray(figureAssets) ? figureAssets.length : 0

    _ingestSummary = {
      protocol: {
        loaded: !!protRow,
        version: protRow?.version || null,
        rq_count: rqCount,
        pico_concept_count: picoConceptCount,
      },
      papers: { included_n: includedPapersN },
      matrix: { rows_n: matrixRowsN },
      rob: { rows_n: robN, pass1_n: robPass1N, pass2_n: robPass2N },
      synthesis: {
        themes_n: themesN,
        cross_cutting_n: crossCuttingN,
        protocol_coverage_rq_n: coverageRqN,
      },
      certainty: {
        theme_rollup_n: themeCertaintyN,
        grade_themes_n: gradeN,
        cerqual_themes_n: cerqualN,
        hybrid_themes_n: hybridN,
        outcome_sof_n: outcomeGradesN,
      },
      journal_template: {
        loaded: !!journalTemplate,
        sections_n: journalSectionsN,
        table_count: journalTableCount,
        figure_count: journalFigureCount,
      },
      overlay: {
        loaded: !!(draftingOverlay && !draftingOverlayStale?.stale),
        stale: !!draftingOverlayStale?.stale,
        at_version: draftingOverlay?.at_protocol_version || null,
      },
      plan: {
        loaded: !!draftingPlan,
        stale: !!draftingPlanStale,
        sections_planned_n: Array.isArray(draftingPlan?.sections) ? draftingPlan.sections.length : 0,
      },
      figures: {
        ai_prompts_n: figurePromptsN,
        user_uploaded_n: figureUploadsN,
      },
      sections: {
        total: customSections.length,
        with_target_words: customSections.filter((s) => s.target_words || s.target_word_count).length,
      },
      prisma: {
        identified_total: prismaCounts?.records_identified_total || 0,
        included: prismaCounts?.studies_included || 0,
      },
    }
  } catch (e) {
    console.warn('[report] ingest summary compute failed:', e?.message)
  }

  // 2026-05-25 M36:方法学 capability(双人筛 / kappa / PROSPERO 等)
  let methodologyCapabilities = null
  try {
    methodologyCapabilities = loadCapabilities(db, project.id)
  } catch (e) {
    console.warn('[report] loadCapabilities failed:', e?.message)
    methodologyCapabilities = null
  }

  res.render('projects/report', {
    title: `综述初稿 · ${project.title}`,
    project,
    progress,
    currentStep: 'report',
    stepLabel: '8. 综述初稿',
    stepItems,
    prismaCounts,
    prismaMermaid: mermaid,
    themes,
    sections,
    sectionList,
    methodologyCapabilities,
    methodologyCapabilitiesSummary: summarizeCapabilities(methodologyCapabilities),
    // Phase 8.A 新增 view data
    customSections,
    draftSummary,
    draftingRunStarted: project.drafting_run_started_at,
    draftingRunFinished: project.drafting_run_finished_at,
    draftingRunStatus: project.drafting_run_status,
    draftingRunError: project.drafting_run_error,
    draftingRunMeta: orchestrator.meta,
    draftingRunInFlight: orchestrator.in_flight,
    draftingRunElapsedS: orchestrator.elapsed_s,
    // 兼容老 view 中的 job 字段(已删 inFlightJobs Map)
    // 修(2026-05-24):view 用 job.sections.length,必须提供 sections 数组(不只 customSections 长度)
    job: orchestrator.in_flight ? {
      startedAt: project.drafting_run_started_at,
      done: false,
      current: orchestrator.meta?.current_section || null,
      completed: orchestrator.meta?.sections_completed || [],
      errors: orchestrator.meta?.sections_failed || [],
      sections: customSections.map((s) => s.name),
    } : (project.drafting_run_status ? {
      startedAt: project.drafting_run_started_at,
      finishedAt: project.drafting_run_finished_at,
      done: true,
      completed: orchestrator.meta?.sections_completed || [],
      errors: orchestrator.meta?.sections_failed || [],
      sections: customSections.map((s) => s.name),
    } : null),
    // Phase 9 Agent W
    journalTemplate,
    yearTrendData,
    evidenceMapData,
    yearTrendSvg,
    evidenceMapSvg,
    figurePrompts,
    aiOptimizedFigures,
    // N8 — figure prompts optimize 异步状态
    figureOptimizeInFlight: (() => {
      try {
        if (!project.figure_prompts_optimize_started_at) return false
        // 2026-05-26 BUG FIX:status='running' gate(避免 aborted_by_restart 误报)
        if (project.figure_prompts_optimize_status !== 'running') return false
        const ms = Date.now() - new Date(project.figure_prompts_optimize_started_at + ' UTC').getTime()
        return ms < 15 * 60 * 1000
      } catch { return false }
    })(),
    figureOptimizeStartedAt: project.figure_prompts_optimize_started_at || null,
    figureOptimizeStatus:    project.figure_prompts_optimize_status    || null,
    figureOptimizeError:     project.figure_prompts_optimize_error     || null,
    // Phase 8.C — 用户上传的外部生成图
    figureAssets,
    figureAssetsByKey,
    // Phase 8.B 新增 — drafting overlay state(EJS 使用如下变量名)
    draftingOverlay,
    draftingOverlayAtVersion: draftingOverlay?.at_protocol_version || null,
    draftingOverlayInFlight,
    draftingOverlayStale: !!draftingOverlayStale?.stale,
    draftingOverlayStaleReason: draftingOverlayStale?.reason || null,
    draftingOverlayLockStarted: project.drafting_master_prompt_optimize_started_at || '',
    // 优化打磨包:overlay 失败时把错误暴露给 UI(M32-i)
    draftingOverlayError: project.drafting_master_prompt_optimize_error || null,
    draftingOverlayFailedAt: project.drafting_master_prompt_optimize_failed_at || null,
    currentDraftingSystemVersion: draftingPrompts.DRAFTING_SYSTEM_VERSION || null,
    // M32-f — Manuscript Plan card
    draftingPlan,
    draftingPlanInFlight,
    draftingPlanStale,
    draftingPlanStaleReason,            // 优化打磨包:'protocol_upgraded' | 'overlay_added' | 'overlay_updated' | null
    draftingPlanGeneratedAt,
    draftingPlanAtProtocolVersion: project.drafting_plan_at_protocol_version || null,
    draftingPlanLockStarted,
    draftingPlanStatus: project.drafting_plan_status || null,
    draftingPlanError: project.drafting_plan_error || null,
    draftingPlanSystemVersion: draftingPrompts.DRAFTING_PLAN_SYSTEM_VERSION || null,
    draftingPlanWithOverlay: !!(draftingPlan && draftingPlan.with_overlay),
    // 📊 输入数据预览(让用户看清这一步会带入的所有数据源)
    ingestSummary: _ingestSummary,
    // 📑 引用覆盖率(2026-05-25 新加 — "哪些 include 论文被引、哪些没被引")
    //   computeCitationCoverage 失败不阻塞页面,view 收到 null 时折叠卡显示"暂无数据"
    citationCoverage: (function() {
      try {
        const included = listIncludedRecords(db, project.id)
        return draftingHelpers?.computeCitationCoverage
          ? draftingHelpers.computeCitationCoverage(db, project.id, included)
          : null
      } catch (e) {
        console.warn('[report] computeCitationCoverage failed:', e?.message)
        return null
      }
    })(),
    // 📋 自动派生的 4 张数据型表 + 10 张扩展派生表(共 15)
    reviewTables: _reviewTables,
    // registry 元数据(让 view 按注册顺序自动渲染)
    tableDefs:    _tableDefs,
    // 推荐表过滤(给 view 按优先级显示推荐表 + 折叠未推荐)
    //   recommendedTableKeys:  按 priority 排序的 key 数组(critical → important → supplementary)
    //   unrecommendedTableKeys: 没被推荐的 key(其他/fallback)
    //   若 recommendedTables 为 null,recommendedTableKeys 也为 null → view 全 15 张铺开
    ...(function() {
      if (!recommendedTables || !Array.isArray(recommendedTables.recommended_for_paper)) {
        return { recommendedTableKeys: null, unrecommendedTableKeys: null, recommendationByKey: null }
      }
      const PRIO_RANK = { critical: 0, important: 1, supplementary: 2 }
      const items = recommendedTables.recommended_for_paper
        .filter((r) => r && r.table_key && (_tableDefs || []).some((d) => d.key === r.table_key))
      items.sort((a, b) => {
        const pa = PRIO_RANK[a.priority] ?? 9
        const pb = PRIO_RANK[b.priority] ?? 9
        if (pa !== pb) return pa - pb
        // 同优先级:按 registry 注册顺序
        const ia = (_tableDefs || []).findIndex((d) => d.key === a.table_key)
        const ib = (_tableDefs || []).findIndex((d) => d.key === b.table_key)
        return ia - ib
      })
      const recKeys = items.map((r) => r.table_key)
      const recSet  = new Set(recKeys)
      const allKeys = (_tableDefs || []).map((d) => d.key)
      const unrecKeys = allKeys.filter((k) => !recSet.has(k))
      const byKey = Object.create(null)
      for (const r of items) byKey[r.table_key] = r
      return { recommendedTableKeys: recKeys, unrecommendedTableKeys: unrecKeys, recommendationByKey: byKey }
    })(),
    // Phase A5 — ⚡ AI 表格推荐
    recommendedTables,
    recommendInFlight,
    recommendStale,
    recommendStaleReason,
    recommendStatus:           project.recommend_tables_status || null,
    recommendStarted:          project.recommend_tables_started_at || null,
    recommendFinished:         project.recommend_tables_finished_at || null,
    recommendError:            project.recommend_tables_error || null,
    recommendAtProtocolVersion: project.recommended_tables_at_protocol_version || null,
    recommendAtSystemVersion:  project.recommended_tables_at_system_version || null,
    recommendSystemVersion:    TABLE_RECOMMEND_SYSTEM_VERSION,
    // T3 — Per-table LLM 精修(polish)cache
    polishedTablesByKey,
    polishInFlightByKey,
    tablePolishSystemVersion:  TABLE_POLISH_SYSTEM_VERSION,
    // N3 — 精修 stale 检测 { [tableKey]: { stale, reason } }
    polishStaleByKey,
    // N2 — 批量精修 orchestrator 状态
    polishBatchInFlight,
    polishBatchStatus:    project.polish_batch_status || null,
    polishBatchStartedAt: project.polish_batch_started_at || null,
    polishBatchFinishedAt: project.polish_batch_finished_at || null,
    polishBatchElapsedS,
    polishBatchMeta,
    // Phase 8.D — PRISMA 27 项 AI 验证状态
    prismaChecklistFull,
    prismaValidateCounts,
    prismaValidateOverallScore,
    prismaValidateInFlight,
    prismaValidateStatus: project.prisma_validate_status || null,
    prismaValidateStarted: _prismaValidateStarted,
    prismaValidateFinished: project.prisma_validate_finished_at || null,
    prismaValidateError: project.prisma_validate_error || null,
    prismaValidateLastAt,
    prismaValidatorSystemVersion: PRISMA_VALIDATOR_SYSTEM_VERSION,
    // Phase 8.E — LaTeX 模板 + 上次渲染 + authors 表单
    latexTemplate,
    latexAuthors,
    latexLastRender,
    latexRenderInFlight,
    latexFillSystemVersion: LATEX_FILL_SYSTEM_VERSION,
    // 2026-05-26 v4:LaTeX overlay status(Phase 1 模板专用 prompt 抽取)
    latexOverlay: (() => {
      try { return project.latex_overlay_json ? JSON.parse(project.latex_overlay_json) : null }
      catch { return null }
    })(),
    latexOverlayExtractedAt:    project.latex_overlay_extracted_at || null,
    latexOverlayExtractStatus:  project.latex_overlay_extract_status || null,
    latexOverlayExtractStartedAt: project.latex_overlay_extract_started_at || null,
    latexOverlayExtractError:   project.latex_overlay_extract_error || null,
    latexOverlayInFlight: (() => {
      try {
        const t = project.latex_overlay_extract_started_at
        if (!t) return false
        // 2026-05-26 BUG FIX:status='running' gate
        if (project.latex_overlay_extract_status !== 'running') return false
        const ms = Date.now() - new Date(t + ' UTC').getTime()
        return ms < 15 * 60 * 1000
      } catch { return false }
    })(),
    latexOverlaySystemVersion: LATEX_OVERLAY_SYSTEM_VERSION,
    // Phase 8.F — 投稿就绪状态卡
    finalizationReady,
    lastFinalizedZip,
    // 优化打磨包 / Session-continuity — drafting session diagnostics
    draftingSessionId: project.drafting_session_id || null,
    draftingSessionStartedAt: project.drafting_session_started_at || null,
    draftingSessionProvider: project.drafting_session_provider || null,
    draftingSessionFirstSection: project.drafting_session_first_section || null,
    draftingSessionAtProtocolVersion: project.drafting_session_at_protocol_version || null,
  })
})

// ============================================================
// GET /:id/submission — Step 9 投稿准备(LaTeX + finalize)
//   优化打磨包:把 LaTeX 模板 + 投稿包从 Step 8 撰写页拆出来,
//   走独立的 /:id/submission 路径渲染 submission.ejs。
//   所有 POST 仍然挂在 /:id/report/latex/* 和 /:id/report/finalize 上(不动后端 API)。
// ============================================================
router.get('/:id/submission', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  // 动态章节(用作投稿包就绪度判定 + 章节计数)
  const customSections = getCustomSections(db, project.id)

  // LaTeX 模板 + 上次渲染(同 GET /report 逻辑)
  let latexTemplate = {
    zip_path: project.latex_template_zip_path || null,
    extracted_at: project.latex_template_extracted_at || null,
    extract_dir: project.latex_template_extract_dir || null,
    main_tex_filename: project.latex_main_tex_filename || null,
    tex_files: [],
  }
  try {
    if (latexTemplate.extract_dir) {
      latexTemplate.tex_files = listTexFilesInSync(latexTemplate.extract_dir)
    }
  } catch (e) { console.warn('[submission] listTexFilesInSync failed:', e?.message) }
  let latexAuthors = {
    authors: [],
    affiliations: [],
    correspondence_email: project.correspondence_email || '',
    funding_text: project.funding_text || '',
    acknowledgements_text: project.acknowledgements_text || '',
  }
  try {
    if (project.authors_json) {
      const a = JSON.parse(project.authors_json)
      if (Array.isArray(a)) latexAuthors.authors = a
    }
    if (project.affiliations_json) {
      const a = JSON.parse(project.affiliations_json)
      if (Array.isArray(a)) latexAuthors.affiliations = a
    }
  } catch (e) { console.warn('[submission] parse authors/affiliations failed:', e?.message) }
  let latexLastRender = null
  try {
    latexLastRender = db.prepare(
      `SELECT id, project_id, started_at, finished_at, status, pdf_path, log_path, tex_path, error, llm_usage_log_id
         FROM latex_renders
        WHERE project_id = ?
        ORDER BY started_at DESC
        LIMIT 1`
    ).get(project.id) || null
  } catch {}
  const latexRenderInFlight = !!(latexLastRender
    && latexLastRender.status === 'running'
    && latexLastRender.started_at
    && (Date.now() - new Date(latexLastRender.started_at + ' UTC').getTime() < 30 * 60 * 1000))

  // 投稿就绪度
  let finalizationReady = null
  try {
    finalizationReady = computeFinalizationReady(db, project, { customSections, latexLastRender })
  } catch (e) {
    console.warn('[submission] computeFinalizationReady failed:', e?.message)
  }
  let lastFinalizedZip = null
  try {
    if (fs.existsSync(FINALIZED_DIR)) {
      const prefix = project.id + '_'
      const candidates = fs.readdirSync(FINALIZED_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.zip'))
        .map((f) => {
          const full = path.join(FINALIZED_DIR, f)
          let mtime = 0
          try { mtime = fs.statSync(full).mtimeMs } catch {}
          const m = f.match(/_(\d+)\.zip$/)
          const ts = m ? Number(m[1]) : 0
          return { filename: f, full, mtime, ts }
        })
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length) lastFinalizedZip = candidates[0]
    }
  } catch {}

  const progress = (() => { try { return getProjectProgress(db, project.id) } catch { return null } })()

  res.render('projects/submission', {
    title: `投稿准备 · ${project.title}`,
    project,
    progress,
    currentStep: 'submission',
    latexTemplate,
    latexAuthors,
    latexLastRender,
    latexRenderInFlight,
    latexFillSystemVersion: LATEX_FILL_SYSTEM_VERSION,
    // 2026-05-26 v4: LaTeX overlay(模板专用 prompt)状态
    latexOverlay: (() => {
      try { return project.latex_overlay_json ? JSON.parse(project.latex_overlay_json) : null }
      catch { return null }
    })(),
    latexOverlayExtractedAt:   project.latex_overlay_extracted_at || null,
    latexOverlayExtractStatus: project.latex_overlay_extract_status || null,
    latexOverlayExtractError:  project.latex_overlay_extract_error || null,
    latexOverlayInFlight: (() => {
      try {
        const t = project.latex_overlay_extract_started_at
        if (!t) return false
        // 2026-05-26 BUG FIX:status='running' gate
        if (project.latex_overlay_extract_status !== 'running') return false
        const ms = Date.now() - new Date(t + ' UTC').getTime()
        return ms < 15 * 60 * 1000
      } catch { return false }
    })(),
    latexOverlaySystemVersion: LATEX_OVERLAY_SYSTEM_VERSION,
    finalizationReady,
    lastFinalizedZip,
  })
})

// ============================================================
// POST /:id/report/optimize-overlay — Phase 8.B
//   Opus 一次性按本项目生成 drafting overlay
//   异步(setImmediate)+ 协议版本门 + system_version 门 + atomic lock(15 min)
//   镜像 certainty.js /optimize-overlay
// ============================================================
router.post('/:id/report/optimize-overlay', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const helpers = helpersOrReject(res)
  if (!helpers) return  // 503

  // 加载完整 approved protocol(buildOptimizeDraftingOverlayUserPrompt 需要 PICO + RQ)
  let synthHelpers
  try {
    synthHelpers = await import('../../services/synthesis-helpers.js')
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'synthesis_helpers_unavailable', message: e?.message })
  }
  const protocol = synthHelpers.loadApprovedProtocolFull(db, project.id)
  if (!protocol) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(400).json({ ok: false, error: 'no_approved_protocol' })
    }
    req.session.flash = { type: 'error', message: '协议还没批复' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 协议版本门 + system_version 门(同 certainty 路由)
  const optimizedVer = project.drafting_master_prompt_at_version
  let existingOverlayObj = null
  try { existingOverlayObj = project.drafting_master_prompt_overlay ? JSON.parse(project.drafting_master_prompt_overlay) : null } catch {}
  const currentSysVer = draftingPrompts.DRAFTING_SYSTEM_VERSION
  const sameProtocol = (optimizedVer != null && Number(protocol.version) <= Number(optimizedVer))
  const samePromptVersion = (existingOverlayObj?.system_version === currentSysVer)
  if (sameProtocol && samePromptVersion) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: 'already_optimized', protocol_version: protocol.version, optimized_at_version: optimizedVer, system_version: currentSysVer })
    }
    req.session.flash = { type: 'error', message: `已基于协议 v${optimizedVer} + 通用 prompt ${currentSysVer} 生成 — 协议或通用 prompt 升级后才能重生成` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Atomic lock(15 min)
  const lockAcquired = db.prepare(
    `UPDATE projects SET drafting_master_prompt_optimize_started_at = datetime('now', '+8 hours')
       WHERE id = ?
         AND (drafting_master_prompt_optimize_started_at IS NULL
              OR drafting_master_prompt_optimize_started_at < datetime('now','-15 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    if (req.get('X-Requested-With') === 'fetch') return res.status(409).json({ ok: false, error_code: 'in_flight' })
    req.session.flash = { type: 'error', message: '另一个 drafting overlay 生成请求正在进行(15 min 内)' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 准备 inputs(themes + themeCertainty + synthesisMeta + samplePapers + prismaCounts + journalTemplate)
  let inputs = null
  try {
    inputs = helpers.buildDraftingInputs(db, project.id, { includePdfChunks: false })
  } catch (e) {
    console.warn('[report/optimize-overlay] buildDraftingInputs failed:', e?.message)
  }
  const themes = inputs?.themes || []
  const themeCertainty = inputs ? Array.from(inputs.themeCertainty.values()) : []
  const synthesisMeta = inputs?.synthesisMeta || null
  const journalTemplate = inputs?.journalTemplate || null
  const prismaCounts = inputs?.prismaCounts || null

  // Pick 4 representative samples
  let samplePapers = []
  try {
    if (inputs && helpers.pickRepresentativeSamplePapers) {
      samplePapers = helpers.pickRepresentativeSamplePapers(inputs.papersByRid, themes, 4)
    }
  } catch (e) {
    console.warn('[report/optimize-overlay] sample picker failed:', e?.message)
  }

  // ──────────────────────────────────────────────────────────────────
  // T1 P0 fix: 5 extra data sources for overlay generation
  //   outcomeGrades / rawMatrixRows / availableTables / availableFigures / searchStrategies
  //   Each loader is try/catched — failure leaves the param null and
  //   buildOptimizeDraftingOverlayUserPrompt skips the corresponding section.
  // ──────────────────────────────────────────────────────────────────
  let outcomeGrades = null
  try {
    const rows = db.prepare(
      `SELECT id, project_id, theme_id, outcome_label, outcome_description, importance,
              final_certainty, summary_of_findings, effect_size_text,
              num_studies, num_participants,
              risk_of_bias, inconsistency, indirectness, imprecision, publication_bias
         FROM grade_assessments
        WHERE project_id = ?
        ORDER BY display_order ASC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) outcomeGrades = rows
  } catch (e) {
    console.warn('[report/optimize-overlay] load grade_assessments failed:', e?.message)
  }

  let rawMatrixRows = null
  try {
    const rows = db.prepare(
      // 2026-05-25 P0-2:从 LIMIT 30 → LIMIT 250(用户要 "矩阵真全集")
      //   121-paper 项目原本只给 Opus 看前 30 行 → overlay/plan 的"量化亮点 / 命名约定"
      //   完全基于头 30 偏倚样本。250 兜底防极端项目(>200 论文)
      `SELECT record_id, fields FROM literature_matrix
        WHERE project_id = ?
        LIMIT 250`
    ).all(project.id) || []
    if (rows.length) {
      rawMatrixRows = rows.map((r) => ({
        record_id: r.record_id,
        fields: (() => { try { return JSON.parse(r.fields || '{}') } catch { return {} } })(),
      })).filter((r) => Object.keys(r.fields).length > 0)
      if (!rawMatrixRows.length) rawMatrixRows = null
    }
  } catch (e) {
    console.warn('[report/optimize-overlay] load literature_matrix failed:', e?.message)
  }

  let availableTables = null
  let availableFigures = null
  try {
    if (draftingHelpers?.buildFigTblManifest) {
      let tableDefsLocal = []
      let tablesDataLocal = {}
      let figureAssetsLocal = []
      let polishedByKeyLocal = {}                                          // N5: T3 LLM polish 注入 manifest
      try { tableDefsLocal = getAllTableDefs() || [] } catch {}
      try { tablesDataLocal = buildAllRegisteredTables(db, project.id) || {} } catch (e) {
        console.warn('[report/optimize-overlay] buildAllRegisteredTables failed:', e?.message)
      }
      try { figureAssetsLocal = listFigureAssets(db, project.id) || [] } catch {}
      try {
        const p = db.prepare('SELECT polished_tables_json FROM projects WHERE id = ?').get(project.id)
        if (p?.polished_tables_json) {
          const parsed = JSON.parse(p.polished_tables_json)
          if (parsed && typeof parsed === 'object') polishedByKeyLocal = parsed
        }
      } catch {}
      const manifest = draftingHelpers.buildFigTblManifest(
        tableDefsLocal, tablesDataLocal, figureAssetsLocal,
        { polishedByKey: polishedByKeyLocal }                              // N5: opt-in,helper 内部 fallback 无害
      )
      if (manifest) {
        availableTables = (manifest.availableTables && manifest.availableTables.length) ? manifest.availableTables : null
        availableFigures = (manifest.availableFigures && manifest.availableFigures.length) ? manifest.availableFigures : null
      }
    }
  } catch (e) {
    console.warn('[report/optimize-overlay] build figure/table manifest failed:', e?.message)
  }

  let searchStrategies = null
  try {
    const rows = db.prepare(
      `SELECT database_name AS database, query_text, is_locked, result_count
         FROM search_strategies
        WHERE project_id = ?
        ORDER BY is_locked DESC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) searchStrategies = rows
  } catch (e) {
    console.warn('[report/optimize-overlay] load search_strategies failed:', e?.message)
  }

  // 2026-05-25 P1-8:加载所有已写章节的最新 peer_summary
  //   overlay 知道哪些段已经写了 → "Naming conventions" / "Headline numbers" 段
  //   可以参考已写部分,不会跟已写章节用词冲突
  let priorSummariesOverlay = null
  try {
    const rows = db.prepare(
      `SELECT ds.section_name, ds.peer_summary
         FROM draft_sections ds
         JOIN (
           SELECT section_name, MAX(version) AS max_v
             FROM draft_sections
            WHERE project_id = ?
              AND peer_summary IS NOT NULL AND peer_summary != ''
            GROUP BY section_name
         ) m ON m.section_name = ds.section_name AND m.max_v = ds.version
        WHERE ds.project_id = ?`
    ).all(project.id, project.id) || []
    if (rows.length) {
      priorSummariesOverlay = {}
      for (const r of rows) priorSummariesOverlay[r.section_name] = r.peer_summary
    }
  } catch (e) {
    console.warn('[report/optimize-overlay] load peer_summaries failed:', e?.message)
  }

  const userPrompt = draftingPrompts.buildOptimizeDraftingOverlayUserPrompt({
    protocol,
    themes,
    themeCertainty,
    synthesisMeta,
    samplePapers,
    formatPaperProfile: synthHelpers.formatPaperProfile,
    journalTemplate,
    prismaCounts,
    // T1 P0 fix
    outcomeGrades,
    rawMatrixRows,
    availableTables,
    availableFigures,
    searchStrategies,
    // P1-8 新加
    priorSectionSummaries: priorSummariesOverlay,
    // 2026-05-25 M36: methodology capability
    methodologyCapabilities: (function(){ try { return loadCapabilities(db, project.id) } catch { return null } })(),
    buildCapabilitiesPromptBlockFn: buildCapabilitiesPromptBlock,
  })

  // 后台跑(Opus + ultrathink ~5-8 min)
  setImmediate(async () => {
    const projectId = project.id
    const userId = req.user.id
    const ovAudit = (eventType, payload) => {
      try {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType, userId, projectId, payload,
        })
      } catch {}
    }
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'drafting_optimize_overlay',
        projectId,
        system: draftingPrompts.OPTIMIZE_DRAFTING_OVERLAY_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        // 优化打磨包(M32-i 配套):safety belt — 旧 preset DB 行可能缺 drafting_optimize_overlay
        // step,resolveStepModel 会 fallback 到 'standard' (Sonnet);overlay 一次性任务,必须 Opus。
        model: 'heavy',
        maxTokens: 8000,
        timeoutMs: 480_000,    // 8 min
      })
    } catch (e) {
      console.error('[report/optimize-overlay] runLlm threw:', e)
      const errMsg = `LLM call threw: ${(e?.message || String(e)).slice(0, 800)}`
      try {
        db.prepare(
          `UPDATE projects SET
              drafting_master_prompt_optimize_started_at = NULL,
              drafting_master_prompt_optimize_error = ?,
              drafting_master_prompt_optimize_failed_at = datetime('now', '+8 hours')
            WHERE id = ?`
        ).run(errMsg, projectId)
        ovAudit('drafting_optimize_overlay_failed', { reason: 'runLlm_threw', error: errMsg.slice(0, 200) })
      } catch {}
      return
    }

    if (!result.ok) {
      const errMsg = `LLM status=${result.status}; ${(result.error || '').slice(0, 600)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        db.prepare(
          `UPDATE projects SET
              drafting_master_prompt_optimize_started_at = NULL,
              drafting_master_prompt_optimize_error = ?,
              drafting_master_prompt_optimize_failed_at = datetime('now', '+8 hours')
            WHERE id = ?`
        ).run(errMsg, projectId)
        ovAudit('drafting_optimize_overlay_failed', { status: result.status, error: (result.error || '').slice(0, 200), model: result.model, usage_log_id: result.usageLogId })
      } catch {}
      return
    }

    const parsed = draftingPrompts.parseDraftingOverlayOutput(result.data)
    if (!parsed.ok) {
      const errMsg = `parse_failed: ${(parsed.error || '').slice(0, 600)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        db.prepare(
          `UPDATE projects SET
              drafting_master_prompt_optimize_started_at = NULL,
              drafting_master_prompt_optimize_error = ?,
              drafting_master_prompt_optimize_failed_at = datetime('now', '+8 hours')
            WHERE id = ?`
        ).run(errMsg, projectId)
        ovAudit('drafting_optimize_overlay_failed', { reason: 'parse_failed', error: parsed.error, model: result.model, usage_log_id: result.usageLogId })
      } catch {}
      return
    }

    try {
      db.prepare(
        `UPDATE projects SET
            drafting_master_prompt_overlay = ?,
            drafting_master_prompt_at_version = ?,
            drafting_master_prompt_optimize_started_at = NULL,
            drafting_master_prompt_optimize_error = NULL,
            drafting_master_prompt_optimize_failed_at = NULL,
            updated_at = datetime('now', '+8 hours')
          WHERE id = ?`
      ).run(
        JSON.stringify({ overlay_text: parsed.overlay_text, system_version: currentSysVer }),
        protocol.version,
        projectId,
      )
      ovAudit('drafting_optimize_overlay_success', {
        overlay_chars: parsed.overlay_text.length, at_version: protocol.version,
        model: result.model, usage_log_id: result.usageLogId,
      })
    } catch (e) {
      console.error('[report/optimize-overlay] write failed:', e)
    }
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动 drafting overlay 生成(Opus 4.8 + ultrathink, 5-8 分钟)' })
  }
  req.session.flash = { type: 'success', message: '已启动 drafting overlay 生成(Opus 4.8 + ultrathink, 5-8 分钟),完成后页面会刷新显示' }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// GET /:id/report/optimize-overlay/status.json — Phase 8.B 轮询
// ============================================================
router.get('/:id/report/optimize-overlay/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.drafting_master_prompt_optimize_started_at
  const inFlight = !!(lockStarted && (Date.now() - new Date(lockStarted + ' UTC').getTime() < 15 * 60 * 1000))
  const hasFresh = !!(project.drafting_master_prompt_overlay && project.drafting_master_prompt_at_version)
  res.json({
    ok: true,
    in_flight: inFlight,
    has_fresh: hasFresh,
    at_version: project.drafting_master_prompt_at_version,
    started_at: lockStarted,
    system_version: draftingPrompts.DRAFTING_SYSTEM_VERSION || null,
  })
})

// ============================================================
// M32-f · POST /:id/report/generate-plan
//   Opus 一次性按本项目生成 manuscript-level plan(plan-then-write)
//   异步(setImmediate)+ 协议版本门 + atomic lock(10 min)
//   镜像 optimize-overlay 路径
// ============================================================
router.post('/:id/report/generate-plan', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const helpers = helpersOrReject(res)
  if (!helpers) return  // 503

  // Load full approved protocol(plan generator needs PICO + RQ)
  let synthHelpers
  try {
    synthHelpers = await import('../../services/synthesis-helpers.js')
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'synthesis_helpers_unavailable', message: e?.message })
  }
  const protocol = synthHelpers.loadApprovedProtocolFull(db, project.id)
  if (!protocol) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(400).json({ ok: false, error: 'no_approved_protocol' })
    }
    req.session.flash = { type: 'error', message: '协议还没批复 — 请先在 Step 1 提交协议' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Atomic lock(10 min)
  const lockAcquired = db.prepare(
    `UPDATE projects
        SET drafting_plan_started_at = datetime('now', '+8 hours'),
            drafting_plan_status = 'running',
            drafting_plan_error = NULL
      WHERE id = ?
        AND (drafting_plan_started_at IS NULL
             OR drafting_plan_started_at < datetime('now','-10 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    if (req.get('X-Requested-With') === 'fetch') return res.status(409).json({ ok: false, error_code: 'in_flight' })
    req.session.flash = { type: 'error', message: '已有大纲生成任务在跑(10 min 内),请稍后再试' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 准备 inputs
  let inputs = null
  try {
    inputs = helpers.buildDraftingInputs(db, project.id, { includePdfChunks: false })
  } catch (e) {
    console.warn('[report/generate-plan] buildDraftingInputs failed:', e?.message)
  }
  const themes = inputs?.themes || []
  const themeCertainty = inputs?.themeCertainty || new Map()
  const synthesisMeta = inputs?.synthesisMeta || null
  const journalTemplate = inputs?.journalTemplate || null
  const prismaCounts = inputs?.prismaCounts || null

  // Representative sample papers(6 篇)
  let samplePapers = []
  try {
    if (inputs && helpers.pickRepresentativeSamplePapers) {
      samplePapers = helpers.pickRepresentativeSamplePapers(inputs.papersByRid, themes, 6)
    }
  } catch (e) {
    console.warn('[report/generate-plan] sample picker failed:', e?.message)
  }

  // Citable records list
  let citableRecords = []
  try {
    if (helpers.buildCitableRecords) {
      const rows = helpers.buildCitableRecords(db, project.id) || []
      citableRecords = rows.map((r) => ({
        record_id: r.id,
        short_label: shortRecordLabel(r),
      }))
    }
  } catch (e) {
    console.warn('[report/generate-plan] buildCitableRecords failed:', e?.message)
  }

  // Custom sections
  const customSections = getCustomSections(db, project.id)

  // Overlay (drafting overlay, optional)
  let overlayText = ''
  try {
    if (helpers.loadDraftingOverlay) {
      const ov = helpers.loadDraftingOverlay(project)
      if (ov && typeof ov.overlay_text === 'string') overlayText = ov.overlay_text
    } else if (project.drafting_master_prompt_overlay) {
      overlayText = project.drafting_master_prompt_overlay
    }
  } catch {}

  // ──────────────────────────────────────────────────────────────────
  // T1 P0 fix: 5 extra data sources for plan generation
  //   (same as optimize-overlay — mirrors that loader for consistency)
  // ──────────────────────────────────────────────────────────────────
  let outcomeGradesPlan = null
  try {
    const rows = db.prepare(
      `SELECT id, project_id, theme_id, outcome_label, outcome_description, importance,
              final_certainty, summary_of_findings, effect_size_text,
              num_studies, num_participants,
              risk_of_bias, inconsistency, indirectness, imprecision, publication_bias
         FROM grade_assessments
        WHERE project_id = ?
        ORDER BY display_order ASC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) outcomeGradesPlan = rows
  } catch (e) {
    console.warn('[report/generate-plan] load grade_assessments failed:', e?.message)
  }

  let rawMatrixRowsPlan = null
  try {
    const rows = db.prepare(
      // 2026-05-25 P0-2:从 LIMIT 30 → LIMIT 250(用户要 "矩阵真全集")
      //   121-paper 项目原本只给 Opus 看前 30 行 → overlay/plan 的"量化亮点 / 命名约定"
      //   完全基于头 30 偏倚样本。250 兜底防极端项目(>200 论文)
      `SELECT record_id, fields FROM literature_matrix
        WHERE project_id = ?
        LIMIT 250`
    ).all(project.id) || []
    if (rows.length) {
      rawMatrixRowsPlan = rows.map((r) => ({
        record_id: r.record_id,
        fields: (() => { try { return JSON.parse(r.fields || '{}') } catch { return {} } })(),
      })).filter((r) => Object.keys(r.fields).length > 0)
      if (!rawMatrixRowsPlan.length) rawMatrixRowsPlan = null
    }
  } catch (e) {
    console.warn('[report/generate-plan] load literature_matrix failed:', e?.message)
  }

  let availableTablesPlan = null
  let availableFiguresPlan = null
  try {
    if (draftingHelpers?.buildFigTblManifest) {
      let tableDefsLocal = []
      let tablesDataLocal = {}
      let figureAssetsLocal = []
      let polishedByKeyLocal = {}                                          // N5: T3 polish 注入 plan manifest
      try { tableDefsLocal = getAllTableDefs() || [] } catch {}
      try { tablesDataLocal = buildAllRegisteredTables(db, project.id) || {} } catch (e) {
        console.warn('[report/generate-plan] buildAllRegisteredTables failed:', e?.message)
      }
      try { figureAssetsLocal = listFigureAssets(db, project.id) || [] } catch {}
      try {
        const p = db.prepare('SELECT polished_tables_json FROM projects WHERE id = ?').get(project.id)
        if (p?.polished_tables_json) {
          const parsed = JSON.parse(p.polished_tables_json)
          if (parsed && typeof parsed === 'object') polishedByKeyLocal = parsed
        }
      } catch {}
      const manifest = draftingHelpers.buildFigTblManifest(
        tableDefsLocal, tablesDataLocal, figureAssetsLocal,
        { polishedByKey: polishedByKeyLocal }
      )
      if (manifest) {
        availableTablesPlan = (manifest.availableTables && manifest.availableTables.length) ? manifest.availableTables : null
        availableFiguresPlan = (manifest.availableFigures && manifest.availableFigures.length) ? manifest.availableFigures : null
      }
    }
  } catch (e) {
    console.warn('[report/generate-plan] build figure/table manifest failed:', e?.message)
  }

  let searchStrategiesPlan = null
  try {
    const rows = db.prepare(
      `SELECT database_name AS database, query_text, is_locked, result_count
         FROM search_strategies
        WHERE project_id = ?
        ORDER BY is_locked DESC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) searchStrategiesPlan = rows
  } catch (e) {
    console.warn('[report/generate-plan] load search_strategies failed:', e?.message)
  }

  // P1-8:plan 也接 priorSectionSummaries(plan 写"as discussed in methods..." 类
  //   交接句更准,不会跟已写章节冲突)
  let priorSummariesPlan = null
  try {
    const rows = db.prepare(
      `SELECT ds.section_name, ds.peer_summary
         FROM draft_sections ds
         JOIN (
           SELECT section_name, MAX(version) AS max_v
             FROM draft_sections
            WHERE project_id = ?
              AND peer_summary IS NOT NULL AND peer_summary != ''
            GROUP BY section_name
         ) m ON m.section_name = ds.section_name AND m.max_v = ds.version
        WHERE ds.project_id = ?`
    ).all(project.id, project.id) || []
    if (rows.length) {
      priorSummariesPlan = {}
      for (const r of rows) priorSummariesPlan[r.section_name] = r.peer_summary
    }
  } catch (e) {
    console.warn('[report/generate-plan] load peer_summaries failed:', e?.message)
  }

  const userPrompt = draftingPrompts.buildDraftingPlanUserPrompt({
    project,
    protocol,
    themes,
    themeCertainty,
    synthesisMeta,
    samplePapers,
    formatPaperProfile: synthHelpers.formatPaperProfile,
    journalTemplate,
    prismaCounts,
    citableRecords,
    customSections,
    overlay: overlayText,
    // T1 P0 fix
    outcomeGrades: outcomeGradesPlan,
    rawMatrixRows: rawMatrixRowsPlan,
    availableTables: availableTablesPlan,
    availableFigures: availableFiguresPlan,
    // P1-8 新加
    priorSectionSummaries: priorSummariesPlan,
    searchStrategies: searchStrategiesPlan,
    // 2026-05-25 M36: methodology capability
    methodologyCapabilities: (function(){ try { return loadCapabilities(db, project.id) } catch { return null } })(),
    buildCapabilitiesPromptBlockFn: buildCapabilitiesPromptBlock,
  })

  const projectId = project.id
  const userId = req.user.id
  const planAudit = (eventType, payload) => {
    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType, userId, projectId, payload,
      })
    } catch {}
  }

  planAudit('drafting_plan_started', {
    at_protocol_version: protocol.version,
    themes_n: themes.length,
    citable_records_n: citableRecords.length,
    sections_n: customSections.length,
  })

  // Background Opus call(~3-5 min)
  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'drafting_plan',
        projectId,
        system: draftingPrompts.DRAFTING_PLAN_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        model: 'heavy',
        maxTokens: 16000,
        timeoutMs: 600_000,    // 10 min
      })
    } catch (e) {
      console.error('[report/generate-plan] runLlm threw:', e)
      try {
        db.prepare(
          `UPDATE projects
              SET drafting_plan_started_at = NULL,
                  drafting_plan_status = 'failed',
                  drafting_plan_error = ?
            WHERE id = ?`
        ).run(`runLlm threw: ${(e?.message || String(e)).slice(0, 280)}`, projectId)
      } catch {}
      planAudit('drafting_plan_failed', { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 200) })
      return
    }

    if (!result.ok) {
      try {
        db.prepare(
          `UPDATE projects
              SET drafting_plan_started_at = NULL,
                  drafting_plan_status = 'failed',
                  drafting_plan_error = ?
            WHERE id = ?`
        ).run(`${result.status}: ${(result.error || '').slice(0, 280)}`, projectId)
      } catch {}
      planAudit('drafting_plan_failed', {
        status: result.status, error: (result.error || '').slice(0, 200),
        model: result.model, usage_log_id: result.usageLogId,
      })
      return
    }

    const parsed = draftingPrompts.parseDraftingPlanOutput(result.data)
    if (!parsed.ok) {
      try {
        db.prepare(
          `UPDATE projects
              SET drafting_plan_started_at = NULL,
                  drafting_plan_status = 'failed',
                  drafting_plan_error = ?
            WHERE id = ?`
        ).run(`parse_failed: ${(parsed.error || '').slice(0, 280)}`, projectId)
      } catch {}
      planAudit('drafting_plan_failed', {
        reason: 'parse_failed', error: parsed.error,
        model: result.model, usage_log_id: result.usageLogId,
      })
      return
    }

    try {
      // 优化打磨包:把 "生成时看到的 overlay 状态" 记进 plan,后续可比对 staleness
      //   - with_overlay: 这次跑时 overlay 文本非空?
      //   - overlay_at_version: 当时 overlay 的协议版本(_at_version);若 overlay 还没生成则 null
      const planEnriched = {
        ...parsed.plan,
        with_overlay: !!(overlayText && overlayText.trim()),
        overlay_at_version: project.drafting_master_prompt_at_version || null,
      }
      const planJson = JSON.stringify(planEnriched)
      db.prepare(
        `UPDATE projects
            SET drafting_plan_json = ?,
                drafting_plan_generated_at = datetime('now', '+8 hours'),
                drafting_plan_at_protocol_version = ?,
                drafting_plan_started_at = NULL,
                drafting_plan_status = 'success',
                drafting_plan_error = NULL,
                updated_at = datetime('now', '+8 hours')
          WHERE id = ?`
      ).run(planJson, protocol.version, projectId)
      const paragraphCount = (parsed.plan.sections || []).reduce(
        (acc, s) => acc + ((s.paragraphs || []).length), 0
      )
      planAudit('drafting_plan_success', {
        at_protocol_version: protocol.version,
        sections_n: (parsed.plan.sections || []).length,
        paragraphs_n: paragraphCount,
        plan_chars: planJson.length,
        model: result.model, usage_log_id: result.usageLogId,
      })
    } catch (e) {
      console.error('[report/generate-plan] write failed:', e)
      try {
        db.prepare(
          `UPDATE projects
              SET drafting_plan_started_at = NULL,
                  drafting_plan_status = 'failed',
                  drafting_plan_error = ?
            WHERE id = ?`
        ).run(`write_failed: ${(e?.message || String(e)).slice(0, 280)}`, projectId)
      } catch {}
    }
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动全局大纲生成(Opus 4.8,3-5 min)', in_flight: true })
  }
  req.session.flash = { type: 'success', message: '已启动全局大纲生成(Opus 4.8,3-5 min),完成后页面会刷新显示' }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// M32-f · GET /:id/report/generate-plan/status.json — 轮询
// ============================================================
router.get('/:id/report/generate-plan/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })
  const lockStarted = project.drafting_plan_started_at
  let inFlight = false
  if (lockStarted) {
    try {
      const ms = Date.now() - new Date(lockStarted + ' UTC').getTime()
      inFlight = ms < 10 * 60 * 1000
    } catch {}
  }
  res.json({
    ok: true,
    in_flight: inFlight,
    has_plan: !!project.drafting_plan_json,
    generated_at: project.drafting_plan_generated_at || null,
    at_protocol_version: project.drafting_plan_at_protocol_version || null,
    status: project.drafting_plan_status || null,
    error: project.drafting_plan_error || null,
    started_at: lockStarted || null,
    system_version: draftingPrompts.DRAFTING_PLAN_SYSTEM_VERSION || null,
  })
})

// ============================================================
// POST /:id/report/optimize-figure-prompts — Opus 一键生成项目专属 3-5 张插图 prompt
//   mirrors matrix optimize-master-prompt:不需要 in-flight lock(一次性 + 同步等)
//   覆盖已有的 figure_prompts_ai_optimized
//
//   Phase 8.A 留作未来改造:目前还是同步 await,如果 Opus call > 8 min 就有
//   nginx 502 风险(单次 ~3-5 min 还能扛)。优先级低于 drafting 异步。
// ============================================================
router.post('/:id/report/optimize-figure-prompts', requireAdvancedExtraction, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  // Phase B: 用 loadApprovedProtocolFull(含 concept_groups 解析过的)+
  //          loadAllThemesWithMeta(含 Step 6 v2 字段:study_design_mix / rob_profile /
  //          methodological_note / grading_framework / maps_to_*),而不是浅层 listThemes。
  const protocol = loadApprovedProtocolFull(db, project.id) || getApprovedProtocol(db, project.id)
  let themes = []
  try { themes = loadAllThemesWithMeta(db, project.id) || [] } catch { themes = listThemes(db, project.id) }
  const prismaCounts = computePrismaFlow(db, project.id)

  if (themes.length === 0) {
    req.session.flash = { type: 'error', message: '请先在 Step 6 生成主题再来生成插图 prompt' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // ────────────────────────────────────────────────────────────────────────
  // N8 异步化:atomic lock(15 min)+ setImmediate 后台跑,handler 立刻返回
  //   镜像 tables/recommend / optimize-overlay 同款。锁过期(>15 min)视为
  //   抢锁失败前一次任务挂了。
  // ────────────────────────────────────────────────────────────────────────
  const projectId = project.id
  const userId = req.user.id
  const claimed = db.prepare(
    `UPDATE projects SET figure_prompts_optimize_started_at = datetime('now', '+8 hours'),
                          figure_prompts_optimize_status = 'running',
                          figure_prompts_optimize_error = NULL
       WHERE id = ?
         AND (figure_prompts_optimize_started_at IS NULL
              OR figure_prompts_optimize_started_at < datetime('now','-15 minutes'))`
  ).run(projectId)
  if (claimed.changes === 0) {
    // 锁被占
    if (req.get('X-Requested-With') === 'fetch') {
      return res.json({ ok: false, error: 'busy', message: '上次插图 prompt 任务还在跑(<15 min)' })
    }
    req.session.flash = { type: 'error', message: '上次插图 prompt 任务还在跑(<15 min),请等完成或刷新查看' }
    return res.redirect(`/projects/${projectId}/report`)
  }
  try {
    audit(db, req, {
      eventType: 'figure_prompts_optimize_started',
      userId, projectId,
      payload: { themes_n: themes.length, has_protocol: !!protocol },
    })
  } catch {}

  // N8 后台 worker(setImmediate)— handler 不等 LLM,立刻 redirect
  setImmediate(async () => {
    // 跑期内任何失败都要清锁 + 写 status=failed + 写 error,view 才能给出诊断
    function finishFailed(errMsg) {
      try {
        db.prepare(
          `UPDATE projects SET figure_prompts_optimize_started_at = NULL,
                                figure_prompts_optimize_status = 'failed',
                                figure_prompts_optimize_error = ?
              WHERE id = ?`
        ).run(String(errMsg).slice(0, 400), projectId)
      } catch {}
      try {
        audit(db, { user: { id: userId } }, {
          eventType: 'figure_prompts_optimize_failed',
          userId, projectId,
          payload: { error: String(errMsg).slice(0, 200) },
        })
      } catch {}
    }

    // Phase B: 10 数据源中的其余 6 个 — 全部 try/catch 兜底
    let themeCertainty = new Map()
    try {
      const rows = loadAllThemeCertainty(db, projectId) || []
      themeCertainty = indexLatestCertaintyByTheme(rows)
    } catch { themeCertainty = new Map() }
    let synthesisMeta = null
    try { synthesisMeta = loadSynthesisMetaForCertainty(db, projectId) } catch {}
    // 2026-05-25:outcomeGrades 不再只传 count — figure prompts 需要 27 个 outcome
    //   完整数据(effect_size_text / final_certainty / summary_of_findings / theme_name)
    //   才能写出真的 forest plot(列具体 outcome name + SMD + CI)/ harvest plot
    let outcomeGrades = null
    let outcomeGradesStats = { total: 0, quantitative: 0 }
    try {
      const gradeService = await import('../../services/grade.js').catch(() => null)
      if (gradeService?.listAssessmentsForProject) {
        const allG = gradeService.listAssessmentsForProject(db, projectId) || []
        if (allG.length) {
          outcomeGrades = allG
          const NARR = /^(\s*)(narrative\b|n\/?a\b|—|qual)/i
          let q = 0
          for (const r of allG) {
            const eff = (r?.effect_size_text || '').toString().trim()
            if (eff && !NARR.test(eff)) q += 1
          }
          outcomeGradesStats = { total: allG.length, quantitative: q }
        }
      }
    } catch (e) { console.warn('[figure_prompts] load outcomeGrades full failed:', e?.message) }
    let samplePapers = []
    try {
      let pool = db.prepare(
        `SELECT DISTINCT r.id, r.title, r.authors_text, r.year, r.journal
           FROM records r
           JOIN screening_decisions sd ON sd.record_id = r.id
          WHERE sd.project_id = ?
            AND sd.stage = 'full_text'
            AND sd.human_decision = 'include'
            AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
      ).all(projectId) || []
      if (pool.length === 0) {
        pool = db.prepare(
          `SELECT DISTINCT r.id, r.title, r.authors_text, r.year, r.journal
             FROM records r
             JOIN screening_decisions sd ON sd.record_id = r.id
            WHERE sd.project_id = ?
              AND sd.stage = 'title_abstract'
              AND sd.human_decision = 'include'
              AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')`
        ).all(projectId) || []
      }
      if (pool.length) {
        const shuffled = pool.slice().sort(() => Math.random() - 0.5)
        // 2026-05-25:升 4 → 8 sample papers(rawMatrixRows 已全集,可以多给 paper metadata)
        const picked = shuffled.slice(0, Math.min(8, shuffled.length))
        const ids = picked.map((p) => p.id)
        const matrixMap = new Map()
        if (ids.length) {
          const ph = ids.map(() => '?').join(',')
          try {
            const mRows = db.prepare(
              `SELECT record_id, fields FROM literature_matrix
                WHERE project_id = ? AND record_id IN (${ph})`
            ).all(projectId, ...ids) || []
            for (const m of mRows) {
              let f = {}
              try { f = JSON.parse(m.fields || '{}') } catch {}
              matrixMap.set(m.record_id, f)
            }
          } catch {}
        }
        samplePapers = picked.map((p) => ({
          id: p.id, title: p.title, authors_text: p.authors_text, year: p.year,
          fields: matrixMap.get(p.id) || {},
        }))
      }
    } catch {}
    let journalTemplate = null
    try { journalTemplate = getJournalTemplate(db, projectId) } catch {}
    let uploadedFigures = []
    try { uploadedFigures = listFigureAssets(db, projectId) || [] } catch {}

    // 2026-05-25:新加 5 个数据源给 figure prompts —
    //   1. RoB per-paper(给 quality heatmap 精确数据)
    //   2. dateRangeAlignment(给 timeline figure)
    //   3. searchStrategies summary(给 PRISMA flow)
    //   4. methodologyCapabilities(给 PRISMA flow dual reviewer 框)
    //   5. availableTables manifest(防图表重复)
    let robPerPaper = null
    try {
      const rows = db.prepare(
        `SELECT record_id, tool, overall_rating FROM rob_assessments
          WHERE project_id = ? LIMIT 200`
      ).all(projectId) || []
      if (rows.length) robPerPaper = rows
    } catch {}

    let dateRangeAlignmentForFig = null
    try {
      const dh = await import('../../services/drafting-helpers.js').catch(() => null)
      if (dh?.computeDateRangeAlignment) {
        dateRangeAlignmentForFig = dh.computeDateRangeAlignment(db, projectId)
      }
    } catch {}

    let searchStrategiesSummary = null
    try {
      const rows = db.prepare(
        `SELECT database_name, query_type, result_count, is_locked FROM search_strategies WHERE project_id = ?`
      ).all(projectId) || []
      if (rows.length) {
        const lockedN = rows.filter(r => r && r.is_locked).length
        const dbs = Array.from(new Set(rows.map(r => r.database_name).filter(Boolean)))
        const totalHits = rows.reduce((acc, r) => acc + (Number(r.result_count) || 0), 0)
        searchStrategiesSummary = { databases: dbs, n_queries: rows.length, n_locked: lockedN, total_raw_hits: totalHits }
      }
    } catch {}

    let methodologyCapsForFig = null
    try {
      const mc = await import('../../services/methodology-capabilities.js').catch(() => null)
      if (mc?.loadCapabilities) {
        methodologyCapsForFig = mc.loadCapabilities(db, projectId)
      }
    } catch {}

    let availableTablesForFig = null
    try {
      const tr = await import('../../services/table-registry.js').catch(() => null)
      const rv = await import('../../services/review-tables.js').catch(() => null)
      if (tr?.getAllTableDefs && rv?.buildAllRegisteredTables) {
        const defs = tr.getAllTableDefs() || []
        const allTables = rv.buildAllRegisteredTables(db, projectId) || {}
        availableTablesForFig = defs.map((d) => {
          const data = allTables[d.key] || null
          let row_count = 0
          if (data && Array.isArray(data.rows)) row_count = data.rows.length
          else if (data && data.subtables && Array.isArray(data.subtables)) {
            for (const st of data.subtables) row_count += Array.isArray(st.rows) ? st.rows.length : 0
          }
          return {
            key: d.key, label: d.label, intended_section: d.intended_section,
            row_count, has_data: row_count > 0,
          }
        }).filter(t => t.has_data)
      }
    } catch {}

    // 2026-05-25 用户要求"每步喂全集矩阵":figure prompts 也加载完整 250 行矩阵
    //   (不再 8 sample)。Opus 1M context 完全 hold,LLM 能 audit 所有 outcome 的
    //   effect-size 完整度后再决定 forest vs harvest plot。
    let rawMatrixRowsForFig = null
    try {
      const rows = db.prepare(
        `SELECT record_id, fields FROM literature_matrix
          WHERE project_id = ?
          ORDER BY record_id
          LIMIT 250`
      ).all(projectId) || []
      if (rows.length) {
        rawMatrixRowsForFig = rows.map((r) => ({
          record_id: r.record_id,
          fields: (() => { try { return JSON.parse(r.fields || '{}') } catch { return {} } })(),
        })).filter((r) => Object.keys(r.fields).length > 0)
        if (!rawMatrixRowsForFig.length) rawMatrixRowsForFig = null
      }
    } catch (e) { console.warn('[figure_prompts] load full matrix failed:', e?.message) }

    const userPrompt = buildOptimizeFigurePromptsUserPrompt({
      project, protocol, themes,
      themeCertainty, synthesisMeta, outcomeGrades,
      // 注:outcomeGrades 现在是完整 27 outcomes 数组(含 effect_size_text / final_certainty
      //     / summary_of_findings / theme_name);figures.js 会渲染 detailed list 给 LLM
      prismaCounts, samplePapers, journalTemplate, uploadedFigures,
      // 2026-05-25:全集 raw matrix(250) + 8 sample papers(从 4 升)
      rawMatrixRows: rawMatrixRowsForFig,
      // 2026-05-25 升级:5 个新数据源 — figure 信息量翻倍
      robPerPaper,
      dateRangeAlignment: dateRangeAlignmentForFig,
      searchStrategiesSummary,
      methodologyCapabilities: methodologyCapsForFig,
      availableTables: availableTablesForFig,
      // 同时把 outcomeGrades 的 stats 也传过去(builder 用 stats 决定 forest plot 推荐时仍方便)
      outcomeGradesStats,
    })

    let result
    try {
      result = await runLlm(db, {
        userId, actionType: 'figure_prompts_optimize', projectId,
        system: OPTIMIZE_FIGURE_PROMPTS_SYSTEM,
        prompt: userPrompt, expectJson: true,
        model: 'heavy',                  // safety belt — figure_prompts_optimize 没在 step-presets 时也用 Opus
        maxTokens: 12000, timeoutMs: 480_000,
      })
    } catch (e) {
      return finishFailed('runLlm threw: ' + (e?.message || String(e)))
    }

    if (!result.ok) {
      return finishFailed(`${result.status}: ${(result.error || '').slice(0, 280)}` +
                          (result.usageLogId ? ` (usage_log #${result.usageLogId})` : ''))
    }

    const parsed = parseFigurePromptsOutput(result.data)
    if (!parsed.ok) {
      return finishFailed(`parse_failed: ${(parsed.error || '').slice(0, 300)}` +
                          (result.usageLogId ? ` (usage_log #${result.usageLogId})` : ''))
    }

    try {
      db.prepare(
        `UPDATE projects SET
            figure_prompts_ai_optimized = ?,
            figure_prompts_optimized_at = datetime('now', '+8 hours'),
            figure_prompts_optimize_started_at = NULL,
            figure_prompts_optimize_status = 'success',
            figure_prompts_optimize_error = NULL,
            updated_at = datetime('now', '+8 hours')
           WHERE id = ?`
      ).run(JSON.stringify({
        figures: parsed.figures,
        style_baseline_used: parsed.style_baseline_used,
        system_version: FIGURE_SYSTEM_VERSION,
      }), projectId)
      audit(db, { user: { id: userId } }, {
        eventType: 'figure_prompts_optimize_success',
        userId, projectId,
        payload: {
          count: parsed.figures.length,
          model: result.model,
          usage_log_id: result.usageLogId,
          system_version: FIGURE_SYSTEM_VERSION,
        },
      })
    } catch (e) {
      finishFailed('write failed: ' + (e?.message || String(e)))
    }
  })

  // handler 立刻返回 — 不等 LLM
  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动插图 prompt 生成(Opus + ultrathink, 3-8 min)', in_flight: true })
  }
  req.session.flash = { type: 'success', message: '已启动插图 prompt 生成(Opus + ultrathink, 3-8 min),完成后页面会刷新显示' }
  res.redirect(`/projects/${projectId}/report`)
})

// ============================================================
// N8 · GET /:id/report/optimize-figure-prompts/status.json — 5s 轮询
// ============================================================
router.get('/:id/report/optimize-figure-prompts/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const lockStarted = project.figure_prompts_optimize_started_at
  let inFlight = false
  let elapsedS = 0
  if (lockStarted) {
    try {
      const ms = Date.now() - new Date(lockStarted + ' UTC').getTime()
      elapsedS = Math.max(0, Math.floor(ms / 1000))
      inFlight = ms < 15 * 60 * 1000
    } catch {}
  }

  let hasOptimized = false
  let optimizedCount = 0
  let optimizedSystemVer = null
  try {
    if (project.figure_prompts_ai_optimized) {
      const parsed = JSON.parse(project.figure_prompts_ai_optimized)
      if (parsed && Array.isArray(parsed.figures)) {
        hasOptimized = true
        optimizedCount = parsed.figures.length
        optimizedSystemVer = parsed.system_version || null
      }
    }
  } catch {}

  res.json({
    ok: true,
    in_flight: inFlight,
    elapsed_s: elapsedS,
    started_at: lockStarted || null,
    finished_at: project.figure_prompts_optimized_at || null,
    status: project.figure_prompts_optimize_status || null,
    error: project.figure_prompts_optimize_error || null,
    has_optimized: hasOptimized,
    optimized_count: optimizedCount,
    optimized_system_version: optimizedSystemVer,
    current_system_version: FIGURE_SYSTEM_VERSION,
  })
})

// ============================================================
// Phase A5 · POST /:id/report/tables/recommend
//   Opus 一次性看完项目数据 + 全部派生表 manifest,推荐"本论文该用哪几张表"。
//   异步(setImmediate)+ 协议/system 版本门 + atomic lock(10 min)
//   完全镜像 drafting optimize-overlay 模式。
// ============================================================
router.post('/:id/report/tables/recommend', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  // 加载完整 protocol(synthesis-helpers loadApprovedProtocolFull 已 parse JSON 数组)
  let synthHelpers
  try {
    synthHelpers = await import('../../services/synthesis-helpers.js')
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'synthesis_helpers_unavailable', message: e?.message })
  }
  const protocol = synthHelpers.loadApprovedProtocolFull(db, project.id)
  // 没协议也不硬阻断 — table-recommend 也能纯看 manifest 给建议(但会更弱)
  // 不过为了 stale 门有意义,如果有 protocol 就用 version 写入。

  // 双门:协议版本 + system_version 任意一个升级才允许重生成
  // force=1(query / body)绕过此 gate — 用户显式点击"强制重新生成"
  const forceRerun = req.query.force === '1' || req.body?.force === '1' || req.body?.force === 1 || req.body?.force === true
  const alreadyAtProto = project.recommended_tables_at_protocol_version
  const alreadyAtSys   = project.recommended_tables_at_system_version
  const currentSysVer  = TABLE_RECOMMEND_SYSTEM_VERSION
  const sameProtocol = !!(protocol && alreadyAtProto != null && Number(protocol.version) <= Number(alreadyAtProto))
  const sameSystem   = !!(alreadyAtSys === currentSysVer)
  if (!forceRerun && project.recommended_tables_json && sameProtocol && sameSystem) {
    const msg = `已基于协议 v${alreadyAtProto} + 通用 prompt ${currentSysVer} 生成过 — 协议或通用 prompt 升级后会自动允许重生成。如需强制重新跑,带 force=1 参数。`
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({
        ok: false,
        error_code: 'already_recommended',
        message: msg,
        protocol_version: protocol?.version || null,
        recommended_at_protocol_version: alreadyAtProto,
        system_version: currentSysVer,
        hint: 'POST with body { "force": "1" } or ?force=1 to bypass.',
      })
    }
    req.session.flash = { type: 'error', message: msg }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Atomic lock(10 min lease)
  const lockAcquired = db.prepare(
    `UPDATE projects SET recommend_tables_started_at = datetime('now', '+8 hours'),
                         recommend_tables_status = 'running',
                         recommend_tables_error = NULL
       WHERE id = ?
         AND (recommend_tables_started_at IS NULL
              OR recommend_tables_started_at < datetime('now','-10 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: 'in_flight' })
    }
    req.session.flash = { type: 'error', message: '已有表格推荐任务在跑(10 min 内),请稍后再试' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // ---- 构造 manifest:每张表实时 build 取 row_count ----
  let tablesManifest = []
  try {
    const defs = getAllTableDefs()
    const built = buildAllRegisteredTables(db, project.id)
    tablesManifest = defs.map((d) => {
      const data = built[d.key]
      let row_count = 0
      try {
        if (!data) {
          row_count = 0
        } else if (Array.isArray(data.subtables)) {
          row_count = data.subtables.reduce((acc, s) => acc + ((s.rows || []).length), 0)
        } else if (Array.isArray(data.rows)) {
          row_count = data.rows.length
        }
      } catch {}
      return {
        key:               d.key,
        label:             d.label,
        description:       d.description || '',
        intended_section:  d.intended_section || null,
        cochrane_required: !!d.cochrane_required,
        multi_subtable:    !!d.multi_subtable,
        row_count,
      }
    })
  } catch (e) {
    console.warn('[report/tables/recommend] build manifest failed:', e?.message)
  }

  // ---- 加载 themes + synthesisMeta + journalTemplate + themeCertainty (T1 P0 fix) ----
  let themes = []
  let synthesisMeta = null
  let journalTemplate = null
  let themeCertaintyRec = null
  try {
    // 复用 drafting-helpers.buildDraftingInputs(已聚合 themes / synthesisMeta / journalTemplate / themeCertainty)
    if (draftingHelpers?.buildDraftingInputs) {
      const inputs = draftingHelpers.buildDraftingInputs(db, project.id, { includePdfChunks: false })
      themes = inputs?.themes || []
      synthesisMeta = inputs?.synthesisMeta || null
      journalTemplate = inputs?.journalTemplate || null
      themeCertaintyRec = inputs?.themeCertainty || null    // Map<theme_id, row>
    } else {
      // Fallback: 手动 query
      themes = listThemes(db, project.id)
      try {
        synthesisMeta = db.prepare(
          `SELECT cross_cutting_observations, protocol_coverage FROM synthesis_meta WHERE project_id = ? LIMIT 1`
        ).get(project.id) || null
      } catch {}
      try { journalTemplate = getJournalTemplate(db, project.id) } catch {}
    }
  } catch (e) {
    console.warn('[report/tables/recommend] load themes/meta/template failed:', e?.message)
  }

  // ──────────────────────────────────────────────────────────────────
  // T1 P0 fix: 3 more data sources for table recommendation
  //   outcomeGrades / rawMatrixRows (5-8 sample) / searchStrategies
  // ──────────────────────────────────────────────────────────────────
  let outcomeGradesRec = null
  try {
    const rows = db.prepare(
      `SELECT id, project_id, theme_id, outcome_label, outcome_description, importance,
              final_certainty, summary_of_findings, effect_size_text,
              num_studies, num_participants,
              risk_of_bias, inconsistency, indirectness, imprecision, publication_bias
         FROM grade_assessments
        WHERE project_id = ?
        ORDER BY display_order ASC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) outcomeGradesRec = rows
  } catch (e) {
    console.warn('[report/tables/recommend] load grade_assessments failed:', e?.message)
  }

  let rawMatrixRowsRec = null
  try {
    // 5-8 sample 用于 caption 中引具体数字(LLM 已经能拿到完整 row_count via manifest)
    const rows = db.prepare(
      `SELECT record_id, fields FROM literature_matrix
        WHERE project_id = ?
        LIMIT 8`
    ).all(project.id) || []
    if (rows.length) {
      rawMatrixRowsRec = rows.map((r) => ({
        record_id: r.record_id,
        fields: (() => { try { return JSON.parse(r.fields || '{}') } catch { return {} } })(),
      })).filter((r) => Object.keys(r.fields).length > 0)
      if (!rawMatrixRowsRec.length) rawMatrixRowsRec = null
    }
  } catch (e) {
    console.warn('[report/tables/recommend] load literature_matrix failed:', e?.message)
  }

  let searchStrategiesRec = null
  try {
    const rows = db.prepare(
      `SELECT database_name AS database, query_text, is_locked, result_count
         FROM search_strategies
        WHERE project_id = ?
        ORDER BY is_locked DESC, created_at ASC`
    ).all(project.id) || []
    if (rows.length) searchStrategiesRec = rows
  } catch (e) {
    console.warn('[report/tables/recommend] load search_strategies failed:', e?.message)
  }

  const userPrompt = buildTableRecommendUserPrompt({
    protocol,
    themes,
    synthesisMeta,
    journalTemplate,
    tablesManifest,
    // T1 P0 fix
    themeCertainty: themeCertaintyRec,
    outcomeGrades: outcomeGradesRec,
    rawMatrixRows: rawMatrixRowsRec,
    searchStrategies: searchStrategiesRec,
  })

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id
  const knownKeysArr = (() => { try { return listTableKeys() } catch { return [] } })()
  const recAudit = (eventType, payload) => {
    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType, userId, projectId, payload,
      })
    } catch {}
  }

  recAudit('table_recommend_started', {
    tables_manifest_n: tablesManifest.length,
    themes_n: themes.length,
    has_protocol: !!protocol,
    has_journal_template: !!journalTemplate,
    system_version: currentSysVer,
  })

  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'table_recommend',
        projectId,
        system: TABLE_RECOMMEND_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        // safety belt:旧 preset DB 行可能缺 table_recommend step,
        // resolveStepModel 会 fallback 到默认 → 强制 heavy 保证 Opus
        model: 'heavy',
        maxTokens: 8000,
        timeoutMs: 480_000,    // 8 min
      })
    } catch (e) {
      console.error('[report/tables/recommend] runLlm threw:', e)
      const errMsg = `runLlm threw: ${(e?.message || String(e)).slice(0, 400)}`
      try {
        db.prepare(
          `UPDATE projects SET recommend_tables_started_at = NULL,
                               recommend_tables_status = 'failed',
                               recommend_tables_finished_at = datetime('now', '+8 hours'),
                               recommend_tables_error = ?
             WHERE id = ?`
        ).run(errMsg, projectId)
        recAudit('table_recommend_failed', { reason: 'runLlm_threw', error: errMsg.slice(0, 200) })
      } catch {}
      return
    }

    if (!result.ok) {
      const errMsg = `${result.status}: ${(result.error || '').slice(0, 280)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        db.prepare(
          `UPDATE projects SET recommend_tables_started_at = NULL,
                               recommend_tables_status = 'failed',
                               recommend_tables_finished_at = datetime('now', '+8 hours'),
                               recommend_tables_error = ?
             WHERE id = ?`
        ).run(errMsg, projectId)
        recAudit('table_recommend_failed', {
          status: result.status,
          error: (result.error || '').slice(0, 200),
          model: result.model,
          usage_log_id: result.usageLogId,
        })
      } catch {}
      return
    }

    const parsed = parseTableRecommendOutput(result.data, { knownKeys: knownKeysArr })
    if (!parsed.ok) {
      const errMsg = `parse_failed: ${(parsed.error || '').slice(0, 300)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        db.prepare(
          `UPDATE projects SET recommend_tables_started_at = NULL,
                               recommend_tables_status = 'failed',
                               recommend_tables_finished_at = datetime('now', '+8 hours'),
                               recommend_tables_error = ?
             WHERE id = ?`
        ).run(errMsg, projectId)
        recAudit('table_recommend_failed', {
          reason: 'parse_failed', error: parsed.error,
          model: result.model, usage_log_id: result.usageLogId,
        })
      } catch {}
      return
    }

    // Success — 写 recommendation + at_protocol_version + at_system_version + 清 lock
    try {
      const meta = {
        model: result.model || null,
        usage_log_id: result.usageLogId || null,
        recommended_n: parsed.recommendation.recommended_for_paper.length,
        proposed_n: parsed.recommendation.proposed_custom_tables.length,
        manifest_n: tablesManifest.length,
        warnings: parsed.warnings || [],
      }
      db.prepare(
        `UPDATE projects SET
            recommended_tables_json = ?,
            recommended_tables_at_protocol_version = ?,
            recommended_tables_at_system_version = ?,
            recommend_tables_started_at = NULL,
            recommend_tables_finished_at = datetime('now', '+8 hours'),
            recommend_tables_status = 'success',
            recommend_tables_error = NULL,
            recommend_tables_meta = ?,
            updated_at = datetime('now', '+8 hours')
          WHERE id = ?`
      ).run(
        JSON.stringify(parsed.recommendation),
        protocol?.version || null,
        currentSysVer,
        JSON.stringify(meta),
        projectId,
      )
      recAudit('table_recommend_success', {
        at_protocol_version: protocol?.version || null,
        recommended_n: meta.recommended_n,
        proposed_n: meta.proposed_n,
        manifest_n: meta.manifest_n,
        model: result.model,
        usage_log_id: result.usageLogId,
      })
    } catch (e) {
      console.error('[report/tables/recommend] write failed:', e)
      try {
        db.prepare(
          `UPDATE projects SET recommend_tables_started_at = NULL,
                               recommend_tables_status = 'failed',
                               recommend_tables_finished_at = datetime('now', '+8 hours'),
                               recommend_tables_error = ?
             WHERE id = ?`
        ).run(`write_failed: ${(e?.message || String(e)).slice(0, 280)}`, projectId)
      } catch {}
    }
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({ ok: true, message: '已启动表格推荐(Opus 4.8 + ultrathink, 3-6 分钟)', in_flight: true })
  }
  req.session.flash = { type: 'success', message: '已启动表格推荐(Opus 4.8 + ultrathink, 3-6 分钟),完成后页面会刷新显示' }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// Phase A5 · GET /:id/report/tables/recommend/status.json — 轮询
// ============================================================
router.get('/:id/report/tables/recommend/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const lockStarted = project.recommend_tables_started_at
  let inFlight = false
  let elapsedS = 0
  if (lockStarted) {
    try {
      const ms = Date.now() - new Date(lockStarted + ' UTC').getTime()
      elapsedS = Math.max(0, Math.floor(ms / 1000))
      inFlight = ms < 10 * 60 * 1000
    } catch {}
  }

  // stale 判定(跟 GET /report 同逻辑,但精简)
  let stale = false
  let staleReason = null
  let parsedRecommendation = null
  if (project.recommended_tables_json) {
    try { parsedRecommendation = JSON.parse(project.recommended_tables_json) } catch {}
    try {
      const atProto = project.recommended_tables_at_protocol_version
      if (atProto != null) {
        const r = db.prepare(
          `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
        ).get(project.id)
        if (r && r.version != null && Number(r.version) > Number(atProto)) {
          stale = true; staleReason = 'protocol_upgraded'
        }
      }
      if (!stale) {
        const atSys = project.recommended_tables_at_system_version
        if (!atSys) { stale = true; staleReason = 'old_no_version' }
        else if (atSys !== TABLE_RECOMMEND_SYSTEM_VERSION) { stale = true; staleReason = 'system_prompt_upgraded' }
      }
    } catch {}
  }

  let meta = null
  try { meta = project.recommend_tables_meta ? JSON.parse(project.recommend_tables_meta) : null } catch {}

  res.json({
    ok: true,
    in_flight: inFlight,
    has_recommendation: !!parsedRecommendation,
    parsed_recommendation: parsedRecommendation,
    stale,
    stale_reason: staleReason,
    status: project.recommend_tables_status || null,
    started_at: lockStarted || null,
    finished_at: project.recommend_tables_finished_at || null,
    elapsed_s: elapsedS,
    error: project.recommend_tables_error || null,
    at_protocol_version: project.recommended_tables_at_protocol_version || null,
    at_system_version: project.recommended_tables_at_system_version || null,
    system_version: TABLE_RECOMMEND_SYSTEM_VERSION,
    meta,
  })
})

// ============================================================
// T3 · POST /:id/report/tables/polish/:tableKey
//   单表 LLM 精修 — Opus 把派生表当"原料",产出 publication-ready 的
//   polished_caption / column_headers / paragraph_lead / footnotes /
//   optional row_reorder_keys。**反编造校验** 由 parseTablePolishOutput
//   5 条硬规则把守。
//
//   异步(setImmediate)+ per-table atomic lock(10 min lease,JSON 字段)
//   完全镜像 drafting overlay / table-recommend 模式,但 cache 是 per-table。
// ============================================================
//
// 辅助:给单张表抽出 { columnsList, rowsCount } 用于反编造校验(列数 / 行数)。
// 多子表(table1 / table3a / table3b)用第一个 subtable 的 columns 作 canonical。
function _extractTableShape(tableKey, tableData) {
  if (!tableData) return { columnsList: [], rowsCount: 0 }
  // multi-subtable: table1
  if (Array.isArray(tableData.subtables) && tableData.subtables.length) {
    const first = tableData.subtables[0] || {}
    const cols = Array.isArray(first.columns) ? first.columns : []
    const totalRows = tableData.subtables.reduce(
      (acc, s) => acc + ((Array.isArray(s.rows) ? s.rows.length : 0)), 0)
    return { columnsList: cols, rowsCount: totalRows }
  }
  if (Array.isArray(tableData.tools) && tableData.tools.length) {
    // table3a: tools[*].domains -> 列 = ['study', ...domains, 'overall_rating']
    // table3b: tools[*].domain_summary 行 -> 列固定 8 列
    const tg = tableData.tools[0] || {}
    if (tableKey === 'table3a') {
      const cols = [
        { key: 'study', label: 'Study' },
        ...((tg.domains || []).map((d) => ({ key: d.key, label: d.label }))),
        { key: 'overall_rating', label: 'Overall' },
      ]
      const totalRows = tableData.tools.reduce(
        (acc, t) => acc + ((Array.isArray(t.studies) ? t.studies.length : 0)), 0)
      return { columnsList: cols, rowsCount: totalRows }
    }
    if (tableKey === 'table3b') {
      const cols = [
        { key: 'domain_label', label: 'Domain' },
        { key: 'good',    label: 'Low' },
        { key: 'middle',  label: 'Some' },
        { key: 'bad',     label: 'High' },
        { key: 'unclear', label: 'Unclear' },
        { key: 'pct_good',   label: '% Low' },
        { key: 'pct_middle', label: '% Some' },
        { key: 'pct_bad',    label: '% High' },
      ]
      const totalRows = tableData.tools.reduce(
        (acc, t) => acc + ((Array.isArray(t.domain_summary) ? t.domain_summary.length : 0)), 0)
      return { columnsList: cols, rowsCount: totalRows }
    }
  }
  // generic single shape (table2 / table4 / table5..14)
  const cols = Array.isArray(tableData.columns) ? tableData.columns : []
  const rows = Array.isArray(tableData.rows) ? tableData.rows : []
  return { columnsList: cols, rowsCount: rows.length }
}

// Atomic per-table lock 操作:JSON 字段 read-modify-write,用 transaction 序列化。
function _claimPolishLock(db, projectId, tableKey) {
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT polish_tables_in_flight FROM projects WHERE id = ?`
    ).get(projectId)
    if (!row) return { acquired: false, reason: 'project_not_found' }
    let inFlight = {}
    try {
      inFlight = row.polish_tables_in_flight ? JSON.parse(row.polish_tables_in_flight) : {}
      if (!inFlight || typeof inFlight !== 'object' || Array.isArray(inFlight)) inFlight = {}
    } catch { inFlight = {} }
    const existing = inFlight[tableKey]
    if (existing && existing.started_at) {
      const ageMs = Date.now() - new Date(existing.started_at + ' UTC').getTime()
      if (ageMs < 10 * 60 * 1000) {
        return { acquired: false, reason: 'in_flight', started_at: existing.started_at }
      }
    }
    inFlight[tableKey] = {
      started_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
      model: 'heavy',
    }
    db.prepare(`UPDATE projects SET polish_tables_in_flight = ? WHERE id = ?`)
      .run(JSON.stringify(inFlight), projectId)
    return { acquired: true }
  })
  return tx()
}

function _releasePolishLock(db, projectId, tableKey) {
  try {
    const tx = db.transaction(() => {
      const row = db.prepare(
        `SELECT polish_tables_in_flight FROM projects WHERE id = ?`
      ).get(projectId)
      if (!row) return
      let inFlight = {}
      try {
        inFlight = row.polish_tables_in_flight ? JSON.parse(row.polish_tables_in_flight) : {}
        if (!inFlight || typeof inFlight !== 'object' || Array.isArray(inFlight)) inFlight = {}
      } catch { inFlight = {} }
      delete inFlight[tableKey]
      const next = Object.keys(inFlight).length ? JSON.stringify(inFlight) : null
      db.prepare(`UPDATE projects SET polish_tables_in_flight = ? WHERE id = ?`)
        .run(next, projectId)
    })
    tx()
  } catch (e) {
    console.warn('[report/tables/polish] release lock failed:', e?.message)
  }
}

// 写 polished_tables_json[tableKey] = entry(merge 不覆盖其他 key)
function _writePolishedEntry(db, projectId, tableKey, entry) {
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT polished_tables_json FROM projects WHERE id = ?`
    ).get(projectId)
    if (!row) return
    let cache = {}
    try {
      cache = row.polished_tables_json ? JSON.parse(row.polished_tables_json) : {}
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {}
    } catch { cache = {} }
    cache[tableKey] = entry
    db.prepare(
      `UPDATE projects SET polished_tables_json = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`
    ).run(JSON.stringify(cache), projectId)
  })
  tx()
}

router.post('/:id/report/tables/polish/:tableKey', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const tableKey = String(req.params.tableKey || '').trim()
  if (!tableKey) return res.status(400).json({ ok: false, error: 'missing_table_key' })

  // 1) 表必须在 registry 里
  const def = (() => { try { return getAllTableDefs().find((d) => d.key === tableKey) || null } catch { return null } })()
  if (!def) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(404).json({ ok: false, error: 'unknown_table_key', table_key: tableKey })
    }
    req.session.flash = { type: 'error', message: `未知 table_key: ${tableKey}` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 2) 派生表数据(也是反编造校验的"真相源")
  let allTables
  try {
    allTables = buildAllRegisteredTables(db, project.id)
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'derive_failed', message: e?.message })
  }
  const tableData = allTables[tableKey]
  if (!tableData) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(422).json({ ok: false, error: 'empty_table', table_key: tableKey,
        message: '该表派生失败或为空,无法精修' })
    }
    req.session.flash = { type: 'error', message: `表 ${tableKey} 派生失败/空,先到上游 step 补数据` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 3) 抽 shape(列 + 行数)用于反编造校验
  const { columnsList, rowsCount } = _extractTableShape(tableKey, tableData)
  if (!columnsList.length || !rowsCount) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(422).json({ ok: false, error: 'empty_shape', cols: columnsList.length, rows: rowsCount })
    }
    req.session.flash = { type: 'error', message: `表 ${tableKey} 没有数据(${columnsList.length} 列 × ${rowsCount} 行)` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 4) 渲染 derivedMarkdown(LLM 的 source of truth)
  let derivedMarkdown = ''
  try {
    derivedMarkdown = renderTableExport(allTables, tableKey, 'md') || ''
  } catch (e) {
    console.warn('[report/tables/polish] renderTableExport failed:', e?.message)
  }
  if (!derivedMarkdown) {
    return res.status(500).json({ ok: false, error: 'render_markdown_failed' })
  }

  // 5) Atomic per-table lock(10 min lease)
  const lock = _claimPolishLock(db, project.id, tableKey)
  if (!lock.acquired) {
    if (req.get('X-Requested-With') === 'fetch') {
      return res.status(409).json({ ok: false, error_code: lock.reason || 'in_flight',
        message: `精修任务进行中 (started_at=${lock.started_at || 'unknown'})` })
    }
    req.session.flash = { type: 'error', message: `已有 ${tableKey} 精修任务在跑(10 min 内),请稍后再试` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 6) 加载上下文:协议 / themes / journal / 之前的 table-recommend caption
  //   2026-05-25 Phase A:加载 themeCertainty + outcomeGrades 让 polish caption
  //   按证据强度调整语气(避免 high-RoB 主题对应表标题用 "demonstrated" 之类过度自信)
  let protocol = null
  try { protocol = loadApprovedProtocolFull(db, project.id) } catch {}
  let themes = []
  try { themes = listThemes(db, project.id) } catch {}
  let journalTemplate = null
  try { journalTemplate = getJournalTemplate(db, project.id) } catch {}
  let themeCertainty = null
  try {
    const map = loadAllThemeCertainty(db, project.id)
    if (map && map.size) themeCertainty = Array.from(map.values())
  } catch {}
  let outcomeGrades = null
  try {
    const gradeService = await import('../../services/grade.js').catch(() => null)
    if (gradeService?.listAssessmentsForProject) {
      const allG = gradeService.listAssessmentsForProject(db, project.id) || []
      if (allG.length) outcomeGrades = allG
    }
  } catch {}
  let recommendedCaption = ''
  let recommendedWhy = ''
  try {
    if (project.recommended_tables_json) {
      const parsed = JSON.parse(project.recommended_tables_json)
      const rec = Array.isArray(parsed?.recommended_for_paper)
        ? parsed.recommended_for_paper.find((r) => r && r.table_key === tableKey) : null
      if (rec) {
        recommendedCaption = rec.suggested_caption || ''
        recommendedWhy = rec.why_recommended || ''
      }
    }
  } catch {}
  // N3 — 记下当前 recommendation 时间戳,用于精修 stale 检测(recommendation 之后又
  // 重新跑了 → polish 标 stale)。
  const currentRecAt = project.recommend_tables_finished_at || null

  // 7) Build USER prompt
  const userPrompt = buildTablePolishUserPrompt({
    tableKey,
    tableLabel: def.label || '',
    derivedMarkdown,
    columns: columnsList,
    originalRowsCount: rowsCount,
    recommendedCaption,
    recommendedWhy,
    protocol,
    themes,
    journalTemplate,
    // 2026-05-25 Phase A:加 themeCertainty + outcomeGrades → caption 按证据强度调整语气
    themeCertainty,
    outcomeGrades,
  })

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id
  const polAudit = (eventType, payload) => {
    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType, userId, projectId, payload,
      })
    } catch {}
  }

  polAudit('table_polish_started', {
    table_key: tableKey,
    columns_count: columnsList.length,
    rows_count: rowsCount,
    derived_md_len: derivedMarkdown.length,
    has_recommendation: !!recommendedCaption,
    system_version: TABLE_POLISH_SYSTEM_VERSION,
  })

  setImmediate(async () => {
    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'table_polish',
        projectId,
        system: TABLE_POLISH_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        model: 'heavy',           // 强制 Opus(STEP_SPECS 兜底 / preset 都拉到 heavy)
        maxTokens: 4096,
        timeoutMs: 300_000,       // 5 min
      })
    } catch (e) {
      console.error('[report/tables/polish] runLlm threw:', e)
      const errMsg = `runLlm threw: ${(e?.message || String(e)).slice(0, 400)}`
      try {
        _writePolishedEntry(db, projectId, tableKey, {
          error: errMsg,
          generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
          system_version: TABLE_POLISH_SYSTEM_VERSION,
          at_protocol_version: protocol?.version || null,
        })
        polAudit('table_polish_failed', { table_key: tableKey, reason: 'runLlm_threw', error: errMsg.slice(0, 200) })
      } catch {}
      _releasePolishLock(db, projectId, tableKey)
      return
    }

    if (!result.ok) {
      const errMsg = `${result.status}: ${(result.error || '').slice(0, 280)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        _writePolishedEntry(db, projectId, tableKey, {
          error: errMsg,
          generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
          system_version: TABLE_POLISH_SYSTEM_VERSION,
          model: result.model || null,
          usage_log_id: result.usageLogId || null,
          at_protocol_version: protocol?.version || null,
        })
        polAudit('table_polish_failed', {
          table_key: tableKey, status: result.status,
          error: (result.error || '').slice(0, 200),
          model: result.model, usage_log_id: result.usageLogId,
        })
      } catch {}
      _releasePolishLock(db, projectId, tableKey)
      return
    }

    // 反编造硬校验
    const parsed = parseTablePolishOutput(result.data, {
      originalColumnsCount: columnsList.length,
      originalRowsCount:    rowsCount,
    })
    if (!parsed.ok) {
      const errMsg = `parse_failed: ${(parsed.error || '').slice(0, 300)}` +
                     (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
      try {
        _writePolishedEntry(db, projectId, tableKey, {
          error: errMsg,
          generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
          system_version: TABLE_POLISH_SYSTEM_VERSION,
          model: result.model || null,
          usage_log_id: result.usageLogId || null,
          at_protocol_version: protocol?.version || null,
        })
        polAudit('table_polish_failed', {
          table_key: tableKey, reason: 'parse_failed', error: parsed.error,
          model: result.model, usage_log_id: result.usageLogId,
        })
      } catch {}
      _releasePolishLock(db, projectId, tableKey)
      return
    }

    // Success — 写入 polished_tables_json[tableKey]
    try {
      _writePolishedEntry(db, projectId, tableKey, {
        polished_caption:        parsed.polished.polished_caption,
        polished_column_headers: parsed.polished.polished_column_headers,
        polished_paragraph_lead: parsed.polished.polished_paragraph_lead,
        polished_footnotes:      parsed.polished.polished_footnotes,
        row_reorder_keys:        parsed.polished.row_reorder_keys,
        model:                   result.model || null,
        generated_at:            new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
        system_version:          TABLE_POLISH_SYSTEM_VERSION,
        at_protocol_version:     protocol?.version || null,
        // N3 — 记下当时 recommendation 时间戳;recommendation 之后又重新生成 →
        // computeTablePolishStale 用它判 'recommendation_updated'。
        at_recommendation_at:    currentRecAt,
        usage_log_id:            result.usageLogId || null,
        original_columns_count:  columnsList.length,
        original_rows_count:     rowsCount,
      })
      polAudit('table_polish_success', {
        table_key: tableKey,
        model: result.model,
        usage_log_id: result.usageLogId,
        reordered: !!parsed.polished.row_reorder_keys,
        footnotes_n: parsed.polished.polished_footnotes.length,
        at_protocol_version: protocol?.version || null,
      })
    } catch (e) {
      console.error('[report/tables/polish] write success failed:', e)
      try {
        _writePolishedEntry(db, projectId, tableKey, {
          error: `write_failed: ${(e?.message || String(e)).slice(0, 280)}`,
          generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
          system_version: TABLE_POLISH_SYSTEM_VERSION,
          at_protocol_version: protocol?.version || null,
        })
      } catch {}
    }
    _releasePolishLock(db, projectId, tableKey)
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({
      ok: true, in_flight: true, table_key: tableKey,
      message: `已启动 ${tableKey} 精修(Opus 4.8, 1-3 分钟)`,
    })
  }
  req.session.flash = { type: 'success', message: `已启动 ${tableKey} 精修(Opus 4.8, 1-3 分钟),完成后页面刷新即可看到` }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// T3 · GET /:id/report/tables/polish/:tableKey/status.json — 轮询
// ============================================================
router.get('/:id/report/tables/polish/:tableKey/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const tableKey = String(req.params.tableKey || '').trim()
  if (!tableKey) return res.status(400).json({ ok: false, error: 'missing_table_key' })

  // in-flight lock
  let inFlight = false
  let startedAt = null
  let elapsedS = 0
  try {
    const flightMap = project.polish_tables_in_flight ? JSON.parse(project.polish_tables_in_flight) : {}
    const entry = flightMap && flightMap[tableKey]
    if (entry && entry.started_at) {
      startedAt = entry.started_at
      const ms = Date.now() - new Date(entry.started_at + ' UTC').getTime()
      elapsedS = Math.max(0, Math.floor(ms / 1000))
      inFlight = ms < 10 * 60 * 1000
    }
  } catch {}

  // polished cache for this key
  let polished = null
  let hasError = false
  let errorMsg = null
  try {
    const cache = project.polished_tables_json ? JSON.parse(project.polished_tables_json) : {}
    const entry = cache && cache[tableKey]
    if (entry) {
      if (entry.error) {
        hasError = true
        errorMsg = entry.error
      } else if (entry.polished_caption) {
        polished = entry
      }
    }
  } catch {}

  res.json({
    ok: true,
    table_key: tableKey,
    in_flight: inFlight,
    started_at: startedAt,
    elapsed_s: elapsedS,
    has_polished: !!polished,
    polished,
    has_error: hasError,
    error: errorMsg,
    system_version: TABLE_POLISH_SYSTEM_VERSION,
  })
})

// ============================================================
// N2 · POST /:id/report/tables/polish-batch — ✨ 一键精修多张表
// ============================================================
//
// 顺序跑多张表的 polish(默认 recommendedTableKeys,~13 张),复用单表
// pipeline 的 prompt + 校验 + 写入逻辑,但只用一个 atomic orchestrator
// lock(polish_batch_started_at)。每张表完成后即时 UPDATE polish_batch_meta,
// 前端 5 s 轮询 status.json 显示进度。
//
//   硬 timeout:60 min(单表 5 min × 13 + 余量)。orchestrator 自己看时钟,
//   超时把剩余表标 failed,batch_status='partial' / 'failed'。
//
function _claimBatchPolishLock(db, projectId) {
  // atomic:lock 空 OR 已超 60 min 才能拿;否则 in_flight
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT polish_batch_started_at FROM projects WHERE id = ?`
    ).get(projectId)
    if (!row) return { acquired: false, reason: 'project_not_found' }
    if (row.polish_batch_started_at) {
      try {
        const ms = Date.now() - new Date(row.polish_batch_started_at + ' UTC').getTime()
        if (ms < 60 * 60 * 1000) {
          return { acquired: false, reason: 'in_flight', started_at: row.polish_batch_started_at }
        }
      } catch {}
    }
    const now = new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, '')
    db.prepare(
      `UPDATE projects
          SET polish_batch_started_at = ?,
              polish_batch_finished_at = NULL,
              polish_batch_status = 'running',
              polish_batch_meta = ?
        WHERE id = ?`
    ).run(now, JSON.stringify({ total: 0, completed: [], failed: [], current_key: null }), projectId)
    return { acquired: true, started_at: now }
  })
  return tx()
}

function _writeBatchMeta(db, projectId, patch) {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT polish_batch_meta FROM projects WHERE id = ?`).get(projectId)
    if (!row) return
    let meta = {}
    try {
      meta = row.polish_batch_meta ? JSON.parse(row.polish_batch_meta) : {}
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {}
    } catch { meta = {} }
    const next = { ...meta, ...patch }
    db.prepare(`UPDATE projects SET polish_batch_meta = ? WHERE id = ?`)
      .run(JSON.stringify(next), projectId)
  })
  tx()
}

function _finalizeBatch(db, projectId, status, extraMetaPatch = {}) {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT polish_batch_meta FROM projects WHERE id = ?`).get(projectId)
    let meta = {}
    try { meta = row?.polish_batch_meta ? JSON.parse(row.polish_batch_meta) : {} } catch {}
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {}
    const nextMeta = { ...meta, ...extraMetaPatch, current_key: null }
    db.prepare(
      `UPDATE projects
          SET polish_batch_status = ?,
              polish_batch_finished_at = datetime('now', '+8 hours'),
              polish_batch_started_at = NULL,
              polish_batch_meta = ?
        WHERE id = ?`
    ).run(status, JSON.stringify(nextMeta), projectId)
  })
  tx()
}

// 单表精修核心(内部 helper):跑 LLM + parse + 写 polished_tables_json[key]。
// 复用 per-table 路由里的所有 helper(_extractTableShape / _claimPolishLock /
// _releasePolishLock / _writePolishedEntry / buildTablePolishUserPrompt / runLlm /
// parseTablePolishOutput)。返回 { ok, error?, polished? }.
async function _runOnePolishForBatch(db, ctx, tableKey) {
  const { projectId, userId, allTables, tableDefs, protocol, themes,
          journalTemplate, themeCertainty, outcomeGrades, recommendedMap, currentRecAt, polAuditFn } = ctx
  const def = tableDefs.find((d) => d.key === tableKey)
  if (!def) return { ok: false, error: 'unknown_table_key' }
  const tableData = allTables[tableKey]
  if (!tableData) return { ok: false, error: 'empty_table' }
  const { columnsList, rowsCount } = _extractTableShape(tableKey, tableData)
  if (!columnsList.length || !rowsCount) {
    return { ok: false, error: `empty_shape (cols=${columnsList.length}, rows=${rowsCount})` }
  }
  let derivedMarkdown = ''
  try { derivedMarkdown = renderTableExport(allTables, tableKey, 'md') || '' } catch {}
  if (!derivedMarkdown) return { ok: false, error: 'render_markdown_failed' }

  const rec = recommendedMap ? recommendedMap[tableKey] : null
  const recommendedCaption = rec?.suggested_caption || ''
  const recommendedWhy     = rec?.why_recommended  || ''

  // per-table lock(10 min)— 跟单表路由共享同一锁,避免跟用户手点撞车
  const lock = _claimPolishLock(db, projectId, tableKey)
  if (!lock.acquired) return { ok: false, error: `per_table_lock_${lock.reason}` }

  const userPrompt = buildTablePolishUserPrompt({
    tableKey,
    tableLabel: def.label || '',
    derivedMarkdown,
    columns: columnsList,
    originalRowsCount: rowsCount,
    recommendedCaption,
    recommendedWhy,
    protocol,
    themes,
    journalTemplate,
    // 2026-05-25 Phase A: certainty context for caption tone
    themeCertainty,
    outcomeGrades,
  })

  let result
  try {
    result = await runLlm(db, {
      userId,
      actionType: 'table_polish',
      projectId,
      system: TABLE_POLISH_SYSTEM,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 4096,
      timeoutMs: 300_000,
    })
  } catch (e) {
    _releasePolishLock(db, projectId, tableKey)
    const msg = `runLlm threw: ${(e?.message || String(e)).slice(0, 300)}`
    try {
      _writePolishedEntry(db, projectId, tableKey, {
        error: msg,
        generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
        system_version: TABLE_POLISH_SYSTEM_VERSION,
        at_protocol_version: protocol?.version || null,
        at_recommendation_at: currentRecAt,
      })
    } catch {}
    try { polAuditFn('table_polish_failed', { table_key: tableKey, reason: 'runLlm_threw', error: msg.slice(0, 200), via: 'batch' }) } catch {}
    return { ok: false, error: msg }
  }

  if (!result.ok) {
    _releasePolishLock(db, projectId, tableKey)
    const msg = `${result.status}: ${(result.error || '').slice(0, 280)}` +
                (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
    try {
      _writePolishedEntry(db, projectId, tableKey, {
        error: msg,
        generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
        system_version: TABLE_POLISH_SYSTEM_VERSION,
        model: result.model || null,
        usage_log_id: result.usageLogId || null,
        at_protocol_version: protocol?.version || null,
        at_recommendation_at: currentRecAt,
      })
      polAuditFn('table_polish_failed', {
        table_key: tableKey, status: result.status,
        error: (result.error || '').slice(0, 200),
        model: result.model, usage_log_id: result.usageLogId, via: 'batch',
      })
    } catch {}
    return { ok: false, error: msg }
  }

  const parsed = parseTablePolishOutput(result.data, {
    originalColumnsCount: columnsList.length,
    originalRowsCount:    rowsCount,
  })
  if (!parsed.ok) {
    _releasePolishLock(db, projectId, tableKey)
    const msg = `parse_failed: ${(parsed.error || '').slice(0, 300)}` +
                (result.usageLogId ? ` (usage_log #${result.usageLogId})` : '')
    try {
      _writePolishedEntry(db, projectId, tableKey, {
        error: msg,
        generated_at: new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
        system_version: TABLE_POLISH_SYSTEM_VERSION,
        model: result.model || null,
        usage_log_id: result.usageLogId || null,
        at_protocol_version: protocol?.version || null,
        at_recommendation_at: currentRecAt,
      })
      polAuditFn('table_polish_failed', {
        table_key: tableKey, reason: 'parse_failed', error: parsed.error,
        model: result.model, usage_log_id: result.usageLogId, via: 'batch',
      })
    } catch {}
    return { ok: false, error: msg }
  }

  try {
    _writePolishedEntry(db, projectId, tableKey, {
      polished_caption:        parsed.polished.polished_caption,
      polished_column_headers: parsed.polished.polished_column_headers,
      polished_paragraph_lead: parsed.polished.polished_paragraph_lead,
      polished_footnotes:      parsed.polished.polished_footnotes,
      row_reorder_keys:        parsed.polished.row_reorder_keys,
      model:                   result.model || null,
      generated_at:            new Date().toISOString().replace('T', ' ').replace(/\..*Z$/, ''),
      system_version:          TABLE_POLISH_SYSTEM_VERSION,
      at_protocol_version:     protocol?.version || null,
      at_recommendation_at:    currentRecAt,
      usage_log_id:            result.usageLogId || null,
      original_columns_count:  columnsList.length,
      original_rows_count:     rowsCount,
    })
    polAuditFn('table_polish_success', {
      table_key: tableKey, model: result.model, usage_log_id: result.usageLogId,
      reordered: !!parsed.polished.row_reorder_keys,
      footnotes_n: parsed.polished.polished_footnotes.length,
      at_protocol_version: protocol?.version || null, via: 'batch',
    })
  } catch (e) {
    _releasePolishLock(db, projectId, tableKey)
    return { ok: false, error: `write_failed: ${(e?.message || String(e)).slice(0, 280)}` }
  }
  _releasePolishLock(db, projectId, tableKey)
  return { ok: true }
}

router.post('/:id/report/tables/polish-batch', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  // 1) 拿候选 keys:body.tableKeys > recommended_for_paper > 全部 registry
  let candidateKeys = []
  if (Array.isArray(req.body?.tableKeys) && req.body.tableKeys.length) {
    candidateKeys = req.body.tableKeys.map((k) => String(k || '').trim()).filter(Boolean)
  } else if (project.recommended_tables_json) {
    try {
      const parsed = JSON.parse(project.recommended_tables_json)
      if (Array.isArray(parsed?.recommended_for_paper)) {
        candidateKeys = parsed.recommended_for_paper
          .map((r) => r && r.table_key).filter(Boolean)
      }
    } catch {}
  }
  // 过滤掉非 registry 表 + dedup
  let allDefs = []
  try { allDefs = getAllTableDefs() } catch {}
  const defKeySet = new Set(allDefs.map((d) => d.key))
  candidateKeys = Array.from(new Set(candidateKeys.filter((k) => defKeySet.has(k))))

  if (!candidateKeys.length) {
    const errPayload = { ok: false, error: 'no_candidate_tables',
      message: '没有可精修的表 — 先生成 AI 推荐(⚡ 生成推荐),或在 body.tableKeys 显式指定。' }
    if (req.get('X-Requested-With') === 'fetch') return res.status(400).json(errPayload)
    req.session.flash = { type: 'error', message: errPayload.message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 2) 派生所有表(一次性,worker 复用 — 避免 N 次 deriveAll)
  let allTables = null
  try { allTables = buildAllRegisteredTables(db, project.id) } catch (e) {
    const msg = `derive_failed: ${e?.message || e}`
    if (req.get('X-Requested-With') === 'fetch') return res.status(500).json({ ok: false, error: msg })
    req.session.flash = { type: 'error', message: msg }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 3) Atomic orchestrator lock(60 min lease)
  const lock = _claimBatchPolishLock(db, project.id)
  if (!lock.acquired) {
    const payload = { ok: false, error_code: lock.reason || 'in_flight',
      message: `已有批量精修任务在跑(60 min lease,started_at=${lock.started_at || 'unknown'})` }
    if (req.get('X-Requested-With') === 'fetch') return res.status(409).json(payload)
    req.session.flash = { type: 'error', message: payload.message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 4) Build shared context — protocol / themes / journal / recommendation map
  //   2026-05-25 Phase A:加 themeCertainty + outcomeGrades 给 polish caption tune
  let protocol = null
  try { protocol = loadApprovedProtocolFull(db, project.id) } catch {}
  let themes = []
  try { themes = listThemes(db, project.id) } catch {}
  let journalTemplate = null
  try { journalTemplate = getJournalTemplate(db, project.id) } catch {}
  let themeCertainty = null
  try {
    const map = loadAllThemeCertainty(db, project.id)
    if (map && map.size) themeCertainty = Array.from(map.values())
  } catch {}
  let outcomeGrades = null
  try {
    const gradeService = await import('../../services/grade.js').catch(() => null)
    if (gradeService?.listAssessmentsForProject) {
      const allG = gradeService.listAssessmentsForProject(db, project.id) || []
      if (allG.length) outcomeGrades = allG
    }
  } catch {}
  let recommendedMap = {}
  try {
    if (project.recommended_tables_json) {
      const parsed = JSON.parse(project.recommended_tables_json)
      if (Array.isArray(parsed?.recommended_for_paper)) {
        for (const r of parsed.recommended_for_paper) {
          if (r && r.table_key) recommendedMap[r.table_key] = r
        }
      }
    }
  } catch {}
  const currentRecAt = project.recommend_tables_finished_at || null

  // 闭包 capture
  const projectId = project.id
  const userId = req.user.id
  const polAuditFn = (eventType, payload) => {
    try { audit(db, { user: { id: userId }, ip: '', get: () => '' }, { eventType, userId, projectId, payload }) } catch {}
  }
  const ctx = {
    projectId, userId, allTables,
    tableDefs: allDefs,
    protocol, themes, journalTemplate, themeCertainty, outcomeGrades, recommendedMap, currentRecAt, polAuditFn,
  }

  // 5) 初始化 batch meta(total)+ audit start
  _writeBatchMeta(db, projectId, {
    total: candidateKeys.length, completed: [], failed: [], current_key: null,
    queue: candidateKeys.slice(),
  })
  polAuditFn('table_polish_batch_started', {
    total: candidateKeys.length, keys: candidateKeys,
    system_version: TABLE_POLISH_SYSTEM_VERSION,
  })

  // 6) 异步 worker — 顺序跑,60 min 硬 timeout
  setImmediate(async () => {
    const startedMs = Date.now()
    const TIMEOUT_MS = 60 * 60 * 1000
    const completed = []
    const failed = []
    try {
      for (let i = 0; i < candidateKeys.length; i++) {
        const k = candidateKeys[i]
        if (Date.now() - startedMs > TIMEOUT_MS) {
          // 剩余的标 failed
          for (let j = i; j < candidateKeys.length; j++) {
            failed.push({ key: candidateKeys[j], error: 'batch_timeout_60min' })
          }
          break
        }
        _writeBatchMeta(db, projectId, {
          total: candidateKeys.length, completed: completed.slice(),
          failed: failed.slice(), current_key: k,
        })
        let r
        try { r = await _runOnePolishForBatch(db, ctx, k) }
        catch (e) { r = { ok: false, error: `unexpected: ${e?.message || e}` } }
        if (r.ok) completed.push(k)
        else failed.push({ key: k, error: String(r.error || 'unknown').slice(0, 300) })
        _writeBatchMeta(db, projectId, {
          total: candidateKeys.length, completed: completed.slice(),
          failed: failed.slice(), current_key: null,
        })
      }
      const status = failed.length === 0 ? 'success'
                   : (completed.length > 0 ? 'partial' : 'failed')
      _finalizeBatch(db, projectId, status, {
        total: candidateKeys.length, completed, failed,
        elapsed_s: Math.floor((Date.now() - startedMs) / 1000),
      })
      polAuditFn('table_polish_batch_finished', {
        status, total: candidateKeys.length,
        completed_n: completed.length, failed_n: failed.length,
        elapsed_s: Math.floor((Date.now() - startedMs) / 1000),
      })
    } catch (e) {
      console.error('[report/tables/polish-batch] worker crashed:', e)
      try {
        _finalizeBatch(db, projectId, 'failed', {
          total: candidateKeys.length, completed, failed,
          crash_error: (e?.message || String(e)).slice(0, 300),
          elapsed_s: Math.floor((Date.now() - startedMs) / 1000),
        })
        polAuditFn('table_polish_batch_finished', {
          status: 'failed', crash: true,
          error: (e?.message || String(e)).slice(0, 200),
        })
      } catch {}
    }
  })

  if (req.get('X-Requested-With') === 'fetch') {
    return res.json({
      ok: true, in_flight: true, total: candidateKeys.length,
      started_at: lock.started_at, keys: candidateKeys,
      message: `已启动批量精修 ${candidateKeys.length} 张表(Opus + ultrathink,可关页面)`,
    })
  }
  req.session.flash = { type: 'success',
    message: `已启动批量精修 ${candidateKeys.length} 张表(Opus + ultrathink,~25-40 min,可关页面)` }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// N2 · GET /:id/report/tables/polish-batch/status.json
// ============================================================
router.get('/:id/report/tables/polish-batch/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const startedAt = project.polish_batch_started_at || null
  let inFlight = false
  let elapsedS = 0
  if (startedAt) {
    try {
      const ms = Date.now() - new Date(startedAt + ' UTC').getTime()
      elapsedS = Math.max(0, Math.floor(ms / 1000))
      inFlight = ms < 60 * 60 * 1000 && project.polish_batch_status === 'running'
    } catch {}
  }
  let meta = null
  try { meta = project.polish_batch_meta ? JSON.parse(project.polish_batch_meta) : null } catch {}

  const completedN = Array.isArray(meta?.completed) ? meta.completed.length : 0
  const failedN    = Array.isArray(meta?.failed)    ? meta.failed.length    : 0
  const totalN     = meta?.total || 0

  res.json({
    ok: true,
    in_flight: inFlight,
    status: project.polish_batch_status || null,
    started_at: startedAt,
    finished_at: project.polish_batch_finished_at || null,
    elapsed_s: elapsedS,
    total: totalN,
    completed_n: completedN,
    failed_n: failedN,
    completed: Array.isArray(meta?.completed) ? meta.completed : [],
    failed: Array.isArray(meta?.failed) ? meta.failed : [],
    current_key: meta?.current_key || null,
    system_version: TABLE_POLISH_SYSTEM_VERSION,
  })
})

// ============================================================
// Phase 8.C — 用户上传外部生成图(BioRender / draw.io / DALL-E)
// ============================================================

// Multer 错误兜底中间件:fileFilter / 大小超限 / 缺包都走这里
function figureUploadOrReject(req, res, next) {
  if (!figureUpload) {
    return res.status(503).json({
      ok: false,
      error: 'multer_unavailable',
      message: 'multer 未安装,无法处理上传。请联系管理员 npm install multer。',
      import_error: (figureUploadImportError?.message || String(figureUploadImportError) || 'unknown'),
    })
  }
  figureUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.message || String(err)
      if (req.get('X-Requested-With') === 'fetch') {
        return res.status(400).json({ ok: false, error: 'upload_failed', message: msg })
      }
      req.session.flash = { type: 'error', message: '上传失败:' + msg }
      return res.redirect(`/projects/${req.params.id}/report`)
    }
    next()
  })
}

// POST /:id/report/figures/upload — 上传一张外部生成的图
router.post('/:id/report/figures/upload', figureUploadOrReject, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  if (!req.file) {
    req.session.flash = { type: 'error', message: '没有收到文件' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const figureKey = String(req.body.figureKey || 'manual').slice(0, 100) || 'manual'
  // 2026-05-25 M34:title 加入表单接收;saveFigureAsset 内部会在 title/caption/altText
  //   为空且 figureKey 命中某 LLM 推荐 figure prompt 时自动从 prompt 复用。
  const title = String(req.body.title || '').slice(0, 200)
  const caption = String(req.body.caption || '').slice(0, 2000)
  const altText = String(req.body.altText || '').slice(0, 1000)
  const intendedSection = String(req.body.intendedSection || '').slice(0, 50)

  try {
    const row = await saveFigureAsset(db, {
      projectId: project.id,
      figureKey,
      file: req.file,
      userId: req.user.id,
      title,
      caption,
      altText,
      intendedSection,
    })
    audit(db, req, {
      eventType: 'figure_asset_uploaded',
      userId: req.user.id,
      projectId: project.id,
      payload: {
        asset_id: row?.id,
        figure_key: figureKey,
        size_bytes: req.file.size,
        mime: req.file.mimetype,
        original_filename: req.file.originalname,
      },
    })
    req.session.flash = { type: 'success', message: `✓ 已上传 ${req.file.originalname}(${figureKey})` }
  } catch (e) {
    console.error('[report] saveFigureAsset failed:', e?.message)
    req.session.flash = { type: 'error', message: '上传失败:' + (e?.message || String(e)).slice(0, 200) }
  }
  res.redirect(`/projects/${project.id}/report`)
})

// GET /:id/report/figures/:assetId/file — stream / sendFile
router.get('/:id/report/figures/:assetId/file', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const row = getFigureAsset(db, project.id, req.params.assetId)
  if (!row || !row.file_path) return res.status(404).type('text/plain').send('not found')

  try {
    const absPath = path.resolve(row.file_path)
    if (row.mime_type) res.setHeader('Content-Type', row.mime_type)
    if (row.original_filename) {
      // inline — 让浏览器在 <img> 里直接渲染
      const safeName = String(row.original_filename).replace(/[^\w.\-]/g, '_')
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
    }
    res.sendFile(absPath, (err) => {
      if (err && !res.headersSent) {
        console.warn('[report] sendFile failed for', absPath, ':', err?.message)
        res.status(404).type('text/plain').send('file missing')
      }
    })
  } catch (e) {
    console.warn('[report] figure file stream failed:', e?.message)
    if (!res.headersSent) res.status(500).type('text/plain').send('server error')
  }
})

// POST /:id/report/figures/:assetId/edit — 改 caption / altText / intendedSection
router.post('/:id/report/figures/:assetId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const result = updateFigureAsset(db, project.id, req.params.assetId, {
    title: req.body.title !== undefined ? String(req.body.title || '') : undefined,
    caption: req.body.caption !== undefined ? String(req.body.caption || '') : undefined,
    altText: req.body.altText !== undefined ? String(req.body.altText || '') : undefined,
    intendedSection: req.body.intendedSection !== undefined ? String(req.body.intendedSection || '') : undefined,
  })
  if (!result.ok) {
    req.session.flash = { type: 'error', message: '更新失败:' + (result.error || 'unknown') }
  } else {
    audit(db, req, {
      eventType: 'figure_asset_updated',
      userId: req.user.id,
      projectId: project.id,
      payload: { asset_id: req.params.assetId },
    })
    req.session.flash = { type: 'success', message: '✓ 已更新' }
  }
  res.redirect(`/projects/${project.id}/report`)
})

// POST /:id/report/figures/:assetId/delete — 删 DB + unlink
router.post('/:id/report/figures/:assetId/delete', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const result = await deleteFigureAsset(db, project.id, req.params.assetId)
  if (!result.ok) {
    req.session.flash = { type: 'error', message: '删除失败:' + (result.error || 'unknown') }
  } else {
    audit(db, req, {
      eventType: 'figure_asset_deleted',
      userId: req.user.id,
      projectId: project.id,
      payload: { asset_id: req.params.assetId, figure_key: result.deleted?.figure_key },
    })
    req.session.flash = { type: 'success', message: '✓ 已删除' }
  }
  res.redirect(`/projects/${project.id}/report`)
})

// 2026-05-26:POST /:id/report/figures/delete-all — 一键删该项目所有上传插图
//   DB + 文件全清。用户场景:重新跑了 AI 一键优化 6 张图 prompt 后,
//   想把上一轮自己外部生成 + 上传的图全删了换新批 — 之前要逐张点删除按钮,
//   100+ 张时无操作性。
router.post('/:id/report/figures/delete-all', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }
  const result = await deleteAllFigureAssets(db, project.id)
  audit(db, req, {
    eventType: 'figure_assets_bulk_deleted',
    userId: req.user.id,
    projectId: project.id,
    payload: {
      count: result.count,
      total: result.total,
      errors_n: (result.errors || []).length,
    },
  })
  if (result.total === 0) {
    req.session.flash = { type: 'success', message: '当前没有上传的插图,无需删除。' }
  } else if (result.errors.length === 0) {
    req.session.flash = { type: 'success', message: `✓ 已删除全部 ${result.count} 张上传插图` }
  } else {
    req.session.flash = {
      type: 'error',
      message: `部分失败:成功 ${result.count} / ${result.total},失败 ${result.errors.length} — 详情见审计日志`,
    }
  }
  res.redirect(`/projects/${project.id}/report#nav-figures`)
})

// ============================================================
// POST /:id/report/generate-section/:section  — Phase 8.A 异步重写
//   原来是 sync await runLlm 然后 redirect;现在改成:
//     1. atomic lock(placeholder version row with section_run_status='running')
//     2. setImmediate 后台跑 LLM + heartbeat
//     3. 立刻 redirect/JSON 给用户,前端轮询 status.json
//
//   Placeholder dedup:不预查 row 然后 INSERT,而是一次性 INSERT 占位
//   (section_name + version = max+1)且 status='running'。这样:
//     - 并发请求时,SQLite 的 UNIQUE(project_id, section_name, version)
//       会拒第二次 INSERT(or 第二个被同样的 max+1 算到 → 撞主键 / 撞 unique)。
//       生产里 INSERT 失败 = 已有运行中的 placeholder → 返 in_flight error。
//     - 成功完成时,UPDATE 同一行(写入 content + status='success'),不再
//       INSERT 新行,避免 placeholder 残留。
// ============================================================
router.post('/:id/report/generate-section/:section', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const helpers = helpersOrReject(res)
  if (!helpers) return  // helpersOrReject 已经 send 了 503

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) {
      return res.status(kind === 'error' ? 400 : 200)
        .json({ ok: kind !== 'error', message, ...(extra || {}) })
    }
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const section = String(req.params.section || '').trim()
  const customSections = getCustomSections(db, project.id)
  const sectionDef = customSections.find((s) => s.name === section)
  if (!sectionDef && section !== 'references') {
    return flashOrJson('error', `未知章节: ${section}`)
  }

  // References 章节走非 LLM 同步路径(老逻辑,Phase 8.A 不动)
  if (section === 'references') {
    const included = listIncludedRecords(db, project.id)
    const md = exportReferencesSection(included, { style: 'apa' })
    persistSectionSync(db, project.id, 'references', md, [], null, 'apa')
    audit(db, req, {
      eventType: 'report_section_generated',
      userId: req.user.id,
      projectId: project.id,
      payload: { section: 'references', record_count: included.length, source: 'reference-export' },
    })
    return flashOrJson('success', `References 章节已生成(${included.length} 篇,APA 风格)`)
  }

  // ── Per-section 原子 lock(placeholder version + status='running') ──
  // 先看最新行状态:如果还在 running 且不太老,拒绝重复
  const cur = getSectionRunState(db, project.id, section)
  if (cur.in_flight) {
    return flashOrJson('error', `该章节正在生成中(${cur.elapsed_s}s),请等待`, { error_code: 'in_flight' })
  }

  // 计算下一个 version,插入 placeholder row(content 空)
  const nextVersion = getMaxSectionVersion(db, project.id, section) + 1
  const placeholderId = randomId('ds')
  try {
    db.prepare(
      `INSERT INTO draft_sections
         (id, project_id, section_name, content_markdown, citation_map,
          model, prompt_version, user_edited, version,
          section_run_started_at, section_run_status)
       VALUES (?, ?, ?, '', '[]', NULL, NULL, 0, ?,
               datetime('now', '+8 hours'), 'running')`
    ).run(placeholderId, project.id, section, nextVersion)
  } catch (e) {
    return flashOrJson('error', `无法启动:${(e?.message || e).slice(0, 200)}`, { error_code: 'lock_failed' })
  }

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id

  // ── Heartbeat ──
  const hbStart = Date.now()
  const writeHb = () => {
    try {
      db.prepare(
        `UPDATE draft_sections
            SET section_run_meta = ?
          WHERE id = ? AND section_run_status = 'running'`
      ).run(JSON.stringify({
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - hbStart) / 1000),
        section_name: section,
      }), placeholderId)
    } catch {}
  }
  writeHb()
  const hbInterval = setInterval(writeHb, 30_000)

  const finishSection = (status, errorMessage, meta, contentMarkdown, citationMap, model, promptVersion) => {
    clearInterval(hbInterval)
    try {
      if (status === 'success' && contentMarkdown) {
        // P0.2 (2026-05-31):单章节直接生成也跑引文幻觉校验 + 占位 lint(与
        //   orchestrator 路径一致),把结果落 hallucinated_recs_json / lint_warnings_json,
        //   并把计数并进 section_run_meta,让 view / preview / export 都能 surface。
        const { hallucinatedRecs, lintWarnings } = computeCitationLintForSection(
          db, projectId, contentMarkdown, citationMap,
        )
        if (hallucinatedRecs.length > 0) {
          console.warn(`[report/generate-section] section=${section} 检测到 ${hallucinatedRecs.length} 个幻觉引文:`, hallucinatedRecs)
        }
        if (lintWarnings) {
          console.warn(`[report/generate-section] section=${section} 检测到未知占位:`, lintWarnings)
        }
        const metaWithLint = {
          ...(meta || {}),
          hallucinated_count: hallucinatedRecs.length,
          lint_unknown_tables: lintWarnings?.unknown_tables?.length || 0,
          lint_unknown_figures: lintWarnings?.unknown_figures?.length || 0,
        }
        // UPDATE 同一行(把 placeholder 填实)
        db.prepare(
          `UPDATE draft_sections
              SET content_markdown = ?,
                  citation_map = ?,
                  model = ?,
                  prompt_version = ?,
                  user_edited = 0,
                  updated_at = datetime('now', '+8 hours'),
                  section_run_status = 'success',
                  section_run_finished_at = datetime('now', '+8 hours'),
                  section_run_error = NULL,
                  section_run_meta = ?,
                  hallucinated_recs_json = ?,
                  lint_warnings_json = ?
            WHERE id = ?`
        ).run(
          contentMarkdown,
          JSON.stringify(citationMap || []),
          model || null,
          promptVersion || null,
          JSON.stringify(metaWithLint),
          hallucinatedRecs.length > 0 ? JSON.stringify(hallucinatedRecs) : null,
          lintWarnings ? JSON.stringify(lintWarnings) : null,
          placeholderId,
        )
      } else {
        // 失败 → placeholder 留着(content 空)但标失败,让 UI 能展示错误。
        // 下次重跑会算新 version + 1,placeholder 不会回收(保留诊断价值)。
        db.prepare(
          `UPDATE draft_sections
              SET section_run_status = ?,
                  section_run_finished_at = datetime('now', '+8 hours'),
                  section_run_error = ?,
                  section_run_meta = ?
            WHERE id = ?`
        ).run(
          status,
          errorMessage ? String(errorMessage).slice(0, 500) : null,
          meta ? JSON.stringify(meta) : null,
          placeholderId,
        )
      }
    } catch (e) {
      console.error('[report/generate-section] finish update failed:', e)
    }
  }

  setImmediate(async () => {
    try {
      const r = await generateSectionLlm(db, { project, userId, section })
      if (r.ok) {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType: 'report_section_generated',
          userId, projectId,
          payload: {
            section, model: r.model, duration_ms: r.durationMs,
            citation_count: r.citationMapCount,
            citation_issues: r.citationIssues.slice(0, 5),
            with_journal_template: r.withJournalTemplate || false,
            with_overlay: r.withOverlay || false,
          },
        })
        finishSection('success', null, {
          model: r.model,
          duration_ms: r.durationMs,
          citation_count: r.citationMapCount,
          citation_issues: r.citationIssues.slice(0, 5),
          used_overlay: r.withOverlay || false,
          drafting_system_version: r.systemVersion || null,
        }, r.contentMarkdown, r.citationMap, r.model, r.promptVersion)
        // M32-f: fire-and-forget peer-summary write so sibling sections can read it
        try {
          writePeerSummaryAsync(db, {
            projectId, userId, sectionId: placeholderId, sectionName: section,
            contentMarkdown: r.contentMarkdown,
          })
        } catch (e) {
          console.warn('[report/generate-section] peer_summary kick failed:', e?.message)
        }
      } else {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType: 'report_section_failed',
          userId, projectId,
          payload: { section, status: r.status, error: (r.error || '').slice(0, 300) },
        })
        finishSection('failed', `${r.status}: ${(r.error || '').slice(0, 200)}`, {
          usage_log_id: r.usageLogId || null,
        })
      }
    } catch (e) {
      console.error('[report/generate-section BG] threw:', e)
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType: 'report_section_failed',
        userId, projectId,
        payload: { section, error: (e?.message || String(e)).slice(0, 300), reason: 'bg_threw' },
      })
      finishSection('failed', `异常:${(e?.message || e).slice(0, 200)}`, null)
    }
  })

  // 立刻响应
  const label = sectionDef?.label || draftingPrompts.SECTION_LABELS?.[section] || section
  const msg = `已启动 ${label} 章节生成(后台 ~3-10 min,可关页面)`
  if (wantsJson) {
    return res.json({ ok: true, message: msg, in_flight: true, section, version: nextVersion })
  }
  req.session.flash = { type: 'success', message: msg }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// GET /:id/report/section/:section/status.json  — 单章节状态轮询
// ============================================================
router.get('/:id/report/section/:section/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const section = String(req.params.section || '').trim()
  const st = getSectionRunState(db, project.id, section)

  let heartbeatAgoS = null, heartbeatAt = null
  if (st.meta?.last_heartbeat_at) {
    heartbeatAt = st.meta.last_heartbeat_at
    const hbMs = Date.parse(st.meta.last_heartbeat_at)
    if (isFinite(hbMs)) heartbeatAgoS = Math.max(0, Math.floor((Date.now() - hbMs) / 1000))
  }
  res.json({
    ok: true,
    section,
    exists: st.exists,
    in_flight: st.in_flight,
    status: st.status,
    started_at: st.started_at,
    finished_at: st.finished_at,
    elapsed_s: st.elapsed_s,
    error: st.error,
    heartbeat_at: heartbeatAt,
    heartbeat_ago_s: heartbeatAgoS,
    meta: st.meta,
    version: st.version,
  })
})

// ============================================================
// POST /:id/report/generate-all — deps-aware orchestrator(Phase 8.A 重写)
//
//   关键决策:
//   - 用 customSections + topoSortSections → 拿到批次列表(数组的数组)。
//   - 8.A 不并行 LLM call(同 batch 内串行)— Step 2 计划里并行留给 8.B。
//     好处:1) 不撞 LLM rate-limit;2) 单 LLM call 失败不影响其他;
//          3) heartbeat 简洁(同时刻只一个 section 在跑)。
//   - References 章节走 reference-export 同步,不调 LLM。
//   - Abstract 特殊处理:跑前 read 所有同 deps 内的完整 content(introduction
//     / methods / results / discussion / conclusion),用 ABSTRACT_FROM_DRAFT_SYSTEM
//     + buildAbstractFromDraftUserPrompt 重新生成 user prompt。
//   - 每 section 用 placeholder + heartbeat,跟 generate-section 路由一致。
//   - 主进度独立 heartbeat(projects.drafting_run_meta 持续写 last_heartbeat_at
//     + current_section + sections_completed)。
// ============================================================
router.post('/:id/report/generate-all', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }
  const helpers = helpersOrReject(res)
  if (!helpers) return

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) {
      return res.status(kind === 'error' ? 400 : 200)
        .json({ ok: kind !== 'error', message, ...(extra || {}) })
    }
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 原子 lock(90 min stale,跟 inFlight 判定一致)
  const lockAcquired = db.prepare(
    `UPDATE projects
        SET drafting_run_started_at = datetime('now', '+8 hours'),
            drafting_run_finished_at = NULL,
            drafting_run_status = 'running',
            drafting_run_error = NULL,
            drafting_run_meta = NULL
      WHERE id = ?
        AND (drafting_run_status IS NULL
             OR drafting_run_status != 'running'
             OR drafting_run_started_at IS NULL
             OR drafting_run_started_at < datetime('now','-90 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    return flashOrJson('error',
      '已有正在进行的整文生成任务(90 min 内),请等待或刷新查看进度',
      { error_code: 'in_flight' })
  }

  const customSections = getCustomSections(db, project.id)
  let batches
  try {
    batches = topoSort(customSections)
  } catch (e) {
    // topo 失败 → 退回单批,顺序按 customSections
    console.error('[report/generate-all] topo failed, linear fallback:', e?.message)
    batches = [customSections.filter((s) => s.name !== 'abstract'),
               customSections.filter((s) => s.name === 'abstract')]
                 .filter((b) => b.length)
  }

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id
  const sectionsTotal = customSections.length

  // 主 heartbeat
  const hbStart = Date.now()
  const sectionsCompleted = []
  const sectionsFailed = []   // [{section, error}]
  let currentSection = null
  const writeMainHb = (extra = {}) => {
    try {
      db.prepare(
        `UPDATE projects
            SET drafting_run_meta = ?
          WHERE id = ? AND drafting_run_status = 'running'`
      ).run(JSON.stringify({
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - hbStart) / 1000),
        sections_total: sectionsTotal,
        sections_completed: sectionsCompleted,
        sections_failed: sectionsFailed,
        current_section: currentSection,
        ...extra,
      }), projectId)
    } catch {}
  }
  writeMainHb()
  const mainHbInterval = setInterval(writeMainHb, 30_000)

  const finishMain = (status, errorMessage, meta) => {
    clearInterval(mainHbInterval)
    try {
      db.prepare(
        `UPDATE projects
            SET drafting_run_status = ?,
                drafting_run_finished_at = datetime('now', '+8 hours'),
                drafting_run_error = ?,
                drafting_run_meta = ?
          WHERE id = ?`
      ).run(
        status,
        errorMessage ? String(errorMessage).slice(0, 500) : null,
        meta ? JSON.stringify(meta) : null,
        projectId,
      )
    } catch (e) { console.error('[report/generate-all] finishMain failed:', e) }
  }

  audit(db, req, {
    eventType: 'report_generate_all_started',
    userId, projectId,
    payload: { sections_total: sectionsTotal, batches_count: batches.length },
  })

  setImmediate(async () => {
    const runStart = Date.now()
    let usedOverlay = false  // 任一 section 用了 overlay 都标 true
    let systemVersion = null

    // ──────────────────────────────────────────────────────────────
    // 优化打磨包 / Session-continuity:
    //   生成新 UUID,试着把整次 generate-all 串成一个 Claude CLI session。
    //   - 用 crypto.randomUUID() 生成 sid
    //   - 探测 heavy 模型是否走 anthropic-cli:看用户的 drafting preset 是 anthropic
    //     型号 + 该用户有可用的 anthropic+oauth 凭证
    //   - 探测失败 / 任一 section 失败 → 退回 stateless 老路径(plan + peer_summary)
    //   - 首章成功后 → 持久化 sid 到 projects.drafting_session_id 用于 UI 显示 + diagnostics
    // ──────────────────────────────────────────────────────────────
    const sessionState = {
      sessionId: null,
      turnIndex: 0,             // 0 = 首章 full prompt;>0 = follow-up
      prevSection: null,
      isClaudeCli: false,
      disabled: false,          // 任一章失败 / cred 不支持 session → 禁用,后续 fallback stateless
    }
    try {
      const cfg = stepPresetsGetEffectiveConfigForUser(db, userId)
      const draftModelName = cfg?.step_model?.drafting
      const inferredProvider = draftModelName ? inferProviderFromModelName(draftModelName) : null
      // 用户有 anthropic+oauth 凭证可用?
      const userCreds = listUsableForUser(db, userId)
      const hasClaudeCli = userCreds.some((c) => c.provider === 'anthropic' && c.auth_type === 'oauth' && c.status !== 'error')
      // 启用条件:推断 provider 是 anthropic(或未指定 = 默认 anthropic)AND 有可用 claude oauth
      sessionState.isClaudeCli = !!hasClaudeCli && (inferredProvider == null || inferredProvider === 'anthropic')
      if (sessionState.isClaudeCli) {
        sessionState.sessionId = cryptoRandomUUID()
        try {
          // 顺手记一下当前 approved 协议版本(后续协议升级判 session stale 用)
          let curProtocolVer = null
          try {
            const protRow = db.prepare(
              `SELECT version FROM protocols WHERE project_id = ? AND approved_by_user = 1 ORDER BY version DESC LIMIT 1`
            ).get(projectId)
            curProtocolVer = protRow?.version || null
          } catch {}
          db.prepare(
            `UPDATE projects SET
                drafting_session_id = ?,
                drafting_session_started_at = datetime('now', '+8 hours'),
                drafting_session_provider = 'anthropic-cli',
                drafting_session_at_protocol_version = ?,
                drafting_session_first_section = NULL
               WHERE id = ?`
          ).run(sessionState.sessionId, curProtocolVer, projectId)
        } catch (e) { console.warn('[report/generate-all] persist session id failed:', e?.message) }
        console.log('[report/generate-all] session-continuity enabled, sid=' + sessionState.sessionId)
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType: 'report_generate_all_session_started',
          userId, projectId,
          payload: { session_id: sessionState.sessionId, provider: 'anthropic-cli' },
        })
      }
    } catch (e) {
      console.warn('[report/generate-all] session detection failed:', e?.message)
      sessionState.isClaudeCli = false
    }

    try {
      for (const batch of batches) {
        // 8.A:同 batch 内串行(不并行)— 简单 + 避免 LLM rate-limit
        for (const sectionDef of batch) {
          // 修 bug:topoSortSections 返回 string 数组(每项是 section name),但
          // linear fallback 返回 object 数组({name, deps, ...})。统一兼容:
          //   - string → 直接当 section name
          //   - object → 取 .name
          // 之前没兼容导致 9 个 section 全 INSERT NULL → NOT NULL constraint fail
          const section = typeof sectionDef === 'string' ? sectionDef : sectionDef?.name
          if (!section) {
            console.warn('[report/generate-all] skipping invalid sectionDef:', sectionDef)
            continue
          }
          currentSection = section
          writeMainHb()

          // References 走非 LLM
          if (section === 'references') {
            try {
              const included = listIncludedRecords(db, projectId)
              const md = exportReferencesSection(included, { style: 'apa' })
              persistSectionSync(db, projectId, 'references', md, [], null, 'apa')
              sectionsCompleted.push(section)
            } catch (e) {
              sectionsFailed.push({ section, error: (e?.message || String(e)).slice(0, 200) })
            }
            writeMainHb()
            continue
          }

          // 2026-05-25 P2-14:跳过 user_edited=1 的章节(保护手编内容)
          //   除非 query 有 force_overwrite_edits=1 — 用户显式覆盖
          //   注:此 force 通过 req 传不进来(setImmediate 闭包外),所以读 project.last_force_overwrite_edits
          //   也可以简化为永远跳过(本轮先这么做),后续如需 override 加 UI checkbox
          try {
            const editedRow = db.prepare(
              `SELECT user_edited FROM draft_sections
                 WHERE project_id = ? AND section_name = ?
                 ORDER BY version DESC LIMIT 1`
            ).get(projectId, section)
            if (editedRow && editedRow.user_edited === 1) {
              console.log(`[generate-all] section=${section} 用户手编过(user_edited=1),跳过覆盖`)
              sectionsCompleted.push(section)  // 当作完成处理 — 不算失败
              writeMainHb({ skipped_user_edited: (writeMainHb.skipCount = (writeMainHb.skipCount || 0) + 1) })
              continue
            }
          } catch (e) {
            console.warn('[generate-all] user_edited check failed for ' + section + ':', e?.message)
          }

          // 跑这个 section:per-section placeholder + heartbeat,跟 generate-section 一样
          // 但走内联函数(共享主 orchestrator 的状态),不另开后台
          // 优化打磨包 / Session-continuity:只在没失效时透传 sessionState
          const subResult = await runSectionInOrchestrator(db, {
            project, projectId, userId, section, sectionDef, customSections,
            sessionState: (sessionState.isClaudeCli && !sessionState.disabled) ? sessionState : null,
          })
          if (subResult.ok) {
            sectionsCompleted.push(section)
            if (subResult.withOverlay) usedOverlay = true
            if (subResult.systemVersion) systemVersion = subResult.systemVersion
            // 优化打磨包 / Session-continuity:前进 session turn
            if (subResult.usedSession) {
              if (sessionState.turnIndex === 0) {
                // 首章写完,记一下 first_section
                try {
                  db.prepare(`UPDATE projects SET drafting_session_first_section = ? WHERE id = ?`)
                    .run(section, projectId)
                } catch {}
              }
              sessionState.turnIndex += 1
              sessionState.prevSection = section
            }
          } else {
            sectionsFailed.push({ section, error: (subResult.error || '').slice(0, 200) })
            // 优化打磨包 / Session-continuity:本章失败 → 后续退回 stateless
            // (不 disable 的话 turnIndex 不对 + claude CLI session 状态可能损坏)
            if (sessionState.isClaudeCli && !sessionState.disabled) {
              sessionState.disabled = true
              console.warn('[report/generate-all] section failed, disabling session for remaining: ' + section)
              audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
                eventType: 'report_generate_all_session_aborted',
                userId, projectId,
                payload: { reason: 'section_failed', failed_section: section, completed_before_abort: sessionState.turnIndex },
              })
            }
          }
          writeMainHb()
        }
      }
    } catch (e) {
      console.error('[report/generate-all BG] orchestrator threw:', e)
      currentSection = null
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType: 'report_generate_all_failed',
        userId, projectId,
        payload: { reason: 'orchestrator_threw', error: (e?.message || String(e)).slice(0, 300),
                   completed: sectionsCompleted.length, failed: sectionsFailed.length },
      })
      finishMain('failed', `编排异常:${(e?.message || e).slice(0, 200)}`, {
        sections_completed: sectionsCompleted,
        sections_failed: sectionsFailed,
        sections_completed_count: sectionsCompleted.length,
        used_overlay: usedOverlay,
        overall_duration_ms: Date.now() - runStart,
      })
      return
    }

    currentSection = null
    const overallStatus = sectionsFailed.length === 0 ? 'success'
      : (sectionsCompleted.length === 0 ? 'failed' : 'success')  // 部分成功仍标 success(meta 有 fail 列表)
    audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
      eventType: 'report_generate_all_done',
      userId, projectId,
      payload: {
        completed: sectionsCompleted.length,
        failed: sectionsFailed.length,
        error_sections: sectionsFailed.map((e) => e.section),
        used_overlay: usedOverlay,
        duration_ms: Date.now() - runStart,
      },
    })
    finishMain(overallStatus, sectionsFailed.length ? `部分失败:${sectionsFailed.map((e) => e.section).join(',')}` : null, {
      sections_completed: sectionsCompleted,
      sections_failed: sectionsFailed,
      sections_completed_count: sectionsCompleted.length,
      sections_total: sectionsTotal,
      used_overlay: usedOverlay,
      drafting_system_version: systemVersion,
      overall_duration_ms: Date.now() - runStart,
    })
  })

  const startMsg = `已开始顺序生成全部章节(${sectionsTotal} 章,~${Math.ceil(sectionsTotal * 5)} min),可关闭页面后台继续。`
  if (wantsJson) {
    return res.json({ ok: true, message: startMsg, in_flight: true, sections_total: sectionsTotal })
  }
  req.session.flash = { type: 'success', message: startMsg }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// GET /:id/report/run/status.json  — 主 orchestrator 状态轮询
// ============================================================
router.get('/:id/report/run/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const orchestrator = getOrchestratorState(project)
  let heartbeatAgoS = null, heartbeatAt = null
  if (orchestrator.meta?.last_heartbeat_at) {
    heartbeatAt = orchestrator.meta.last_heartbeat_at
    const hbMs = Date.parse(orchestrator.meta.last_heartbeat_at)
    if (isFinite(hbMs)) heartbeatAgoS = Math.max(0, Math.floor((Date.now() - hbMs) / 1000))
  }

  // per-section summary
  const customSections = getCustomSections(db, project.id)
  const sectionsStatus = customSections.map((s) => {
    const st = getSectionRunState(db, project.id, s.name)
    return {
      section_name: s.name,
      label: s.label || draftingPrompts.SECTION_LABELS?.[s.name] || s.name,
      status: st.status,
      in_flight: st.in_flight,
      version: st.version,
      elapsed_s: st.elapsed_s,
      heartbeat_at: st.meta?.last_heartbeat_at || null,
    }
  })

  res.json({
    ok: true,
    in_flight: orchestrator.in_flight,
    status: orchestrator.status,
    started_at: orchestrator.started_at,
    finished_at: orchestrator.finished_at,
    elapsed_s: orchestrator.elapsed_s,
    error: orchestrator.error,
    heartbeat_at: heartbeatAt,
    heartbeat_ago_s: heartbeatAgoS,
    meta: orchestrator.meta,
    sections: sectionsStatus,
  })
})

// ============================================================
// POST /:id/report/section/:sectionId/edit  — 人工编辑(保留,Phase 8.A 不动)
// ============================================================
router.post('/:id/report/section/:sectionId/edit', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在' })
  }

  const row = db.prepare(
    `SELECT * FROM draft_sections WHERE id = ? AND project_id = ?`
  ).get(req.params.sectionId, project.id)
  if (!row) {
    req.session.flash = { type: 'error', message: '章节不存在' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const content = String(req.body.content_markdown || '').trim()
  if (!content) {
    req.session.flash = { type: 'error', message: '内容不能为空' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 新建一个 version,而不是原地改
  const version = getMaxSectionVersion(db, project.id, row.section_name) + 1
  const newId = randomId('ds')
  db.prepare(
    `INSERT INTO draft_sections
       (id, project_id, section_name, content_markdown, citation_map, model, prompt_version, user_edited, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    newId,
    project.id,
    row.section_name,
    content,
    row.citation_map || '[]',
    row.model,
    row.prompt_version,
    version,
  )
  audit(db, req, {
    eventType: 'report_section_edited',
    userId: req.user.id,
    projectId: project.id,
    payload: { section: row.section_name, from_version: row.version, to_version: version },
  })
  const label = draftingPrompts.SECTION_LABELS?.[row.section_name] || row.section_name
  req.session.flash = { type: 'success', message: `${label} 已保存(v${version})` }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// GET /:id/report/progress.json  — 老路由(DB 状态版本)
//   保留给老前端兼容,新前端用 /run/status.json 和 /section/:section/status.json
// ============================================================
router.get('/:id/report/progress.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ error: 'not_found' })

  const customSections = getCustomSections(db, project.id)
  const sections = listLatestSections(db, project.id)
  const status = {}
  for (const s of customSections) {
    const row = sections[s.name]
    status[s.name] = {
      has_content: !!(row && row.content_markdown),
      version: row?.version || 0,
      user_edited: !!row?.user_edited,
      updated_at: row?.updated_at || null,
    }
  }

  const orchestrator = getOrchestratorState(project)
  // 老 job 字段 shape:{startedAt, completed[], current, errors[], done}
  const job = orchestrator.status ? {
    startedAt: orchestrator.started_at,
    finishedAt: orchestrator.finished_at,
    current: orchestrator.meta?.current_section || null,
    completed: orchestrator.meta?.sections_completed || [],
    errors: (orchestrator.meta?.sections_failed || []).map((e) =>
      typeof e === 'string' ? { section: e } : { section: e.section, msg: e.error }
    ),
    done: !orchestrator.in_flight,
  } : null

  res.json({ job, sections: status })
})

// ============================================================
// GET /:id/report/tables/:tableKey.:format
//   表导出端点 — table1 / table2 / table3a / table3b / table4
//   format ∈ { md, csv, latex }
//   纯派生,毫秒级返回。
// ============================================================
router.get('/:id/report/tables/:tableKey.:format', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const { tableKey, format } = req.params
  const validKeys = listTableKeys()   // 注册中心动态枚举,加表无需改路由
  const validFormats = ['md', 'csv', 'latex']
  if (!validKeys.includes(tableKey) || !validFormats.includes(format)) {
    return res.status(400).type('text/plain').send('invalid table key or format')
  }

  let tables
  try {
    tables = buildAllRegisteredTables(db, project.id)
  } catch (e) {
    console.warn('[report/tables export] build failed:', e?.message)
    return res.status(500).type('text/plain').send('table build failed: ' + (e?.message || 'unknown'))
  }

  const body = renderTableExport(tables, tableKey, format)
  if (!body) return res.status(404).type('text/plain').send('table has no data')

  // 文件名 + content-type
  const ext = format === 'latex' ? 'tex' : format
  const mimeMap = { md: 'text/markdown', csv: 'text/csv', latex: 'text/x-tex' }
  const safeName = `${project.id}_${tableKey}.${ext}`
  res.setHeader('Content-Type', mimeMap[format] + '; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
  res.send(body)
})

// ============================================================
// Phase D — [tbl:<key>] / [fig:<id>] placeholder post-processor
// ------------------------------------------------------------
// 扫所有 section content 找占位,按首次出现顺序分配 Table N / Figure N,
// 替换占位 + 文末追加 Tables / Figures 附录段。
//
// 占位语法(与 Phase C drafting prompt 一致):
//   [tbl:<registry_key>]  — key 必须在 listTableKeys() 内,否则保留 + [unknown table key]
//   [fig:figasset_xxxx]   — 用户上传图(figure_assets.id)
//   [fig:prisma]          — PRISMA Flow Diagram(系统 figure)
//
// 编号策略:order of first appearance across the (title→conclusion) section sequence.
// 重复占位(同 key) → 共享同一编号。
//
// 测试场景(dev 注释,future 接 jest 时直接复用):
//   1) 空 draft / 无占位 → 不动正文,不追加 Tables/Figures。
//   2) 只有 [tbl] → 文末追加 "## Tables",无 "## Figures"。
//   3) 只有 [fig] → 文末追加 "## Figures"(uploaded 用 ![](path),
//      [fig:prisma] 嵌 Mermaid 块),无 "## Tables"。
//   4) 混合 → Tables + Figures 同时追加。
//   5) 不存在的 key → 占位保留 + 标 "[unknown table key]" / "[unknown figure id]",
//      Tables/Figures 段不收录(避免空 cell)。
//   6) 同 key 多次 → 只编号一次,正文所有出现都替成相同 Table N。
//
// 纯字符串处理,毫秒级返回。不破坏现有 [rec_xxx] 引文占位(re 严格匹配 [tbl:|fig:])。
// ============================================================
function postProcessFigTblPlaceholders({
  combinedBody,
  db,
  projectId,
  prismaMermaid,
  // 2026-05-25 P0-1:外部 base URL(给 export.md 用,让下载的 .md 在 Word /
  //   VS Code / GitHub 打开也能看到图)。preview 不传 → 相对 URL 即可。
  baseUrl = '',
}) {
  const empty = {
    tableOrder: [],
    figureOrder: [],
    tableNum: new Map(),
    figureNum: new Map(),
    tablesAppendix: '',
    figuresAppendix: '',
    unknownTables: [],
    unknownFigures: [],
  }
  if (typeof combinedBody !== 'string' || !combinedBody) return empty

  // 1) 加载 valid table keys + figure_assets(校验 + 渲染)
  let validTableKeys = new Set()
  try { validTableKeys = new Set(listTableKeys() || []) } catch {}

  let figureAssets = []
  try { figureAssets = listFigureAssets(db, projectId) || [] } catch {}
  const figureAssetById = new Map()
  for (const a of figureAssets) {
    if (a?.id) figureAssetById.set(a.id, a)
  }
  const hasPrisma = !!(prismaMermaid && String(prismaMermaid).trim())

  // 2) 扫首次出现顺序
  const re = /\[(tbl|fig):([A-Za-z0-9_-]+)\]/g
  const tableOrder = []
  const figureOrder = []
  const seenTables = new Set()
  const seenFigures = new Set()
  const unknownTables = new Set()
  const unknownFigures = new Set()
  let m
  while ((m = re.exec(combinedBody)) !== null) {
    const kind = m[1]; const id = m[2]
    if (kind === 'tbl') {
      if (!validTableKeys.has(id)) { unknownTables.add(id); continue }
      if (!seenTables.has(id)) { seenTables.add(id); tableOrder.push(id) }
    } else {
      // 2026-05-26:`[fig:prisma]` 已经从 availableFigures manifest 移除,LLM 不会再
      //   引用。但**老缓存的章节内容**里可能还残留 `[fig:prisma]` 占位 — 直接 silent
      //   skip,不当 unknown 报警,也不进 figureOrder(避免 PRISMA Figures appendix dup;
      //   replaceFigTblInSection 会把它替换成 "PRISMA Flow Diagram" 文本)
      if (id === 'prisma') continue
      const known = figureAssetById.has(id)
      if (!known) { unknownFigures.add(id); continue }
      if (!seenFigures.has(id)) { seenFigures.add(id); figureOrder.push(id) }
    }
  }
  // 2026-05-25 BUG FIX:用户反馈"我插入的图怎么只有一张在论文里" — 之前只把 LLM 显式
  //   [fig:figasset_xxx] 引用的图放进 figures appendix,LLM 漏引的就不出现。
  //   用户上传图说明他们想要这张图进论文 → ALL uploaded figures 必入 appendix,
  //   LLM 引用过的按引用顺序编号在前,未引用的按上传时间排在后(autonumber 接续)。
  const _llmCitedFigureIds = new Set(figureOrder)
  for (const a of figureAssets) {
    if (a?.id && !_llmCitedFigureIds.has(a.id)) {
      figureOrder.push(a.id)
    }
  }
  const tableNum = new Map(tableOrder.map((k, i) => [k, i + 1]))
  const figureNum = new Map(figureOrder.map((k, i) => [k, i + 1]))

  // 3) Tables appendix
  let tablesAppendix = ''
  if (tableOrder.length > 0) {
    const out = ['---', '', '## Tables', '']
    let allTables = {}
    try { allTables = buildAllRegisteredTables(db, projectId) || {} } catch (e) {
      console.warn('[report/export.md] buildAllRegisteredTables for Tables appendix failed:', e?.message)
    }
    const defsByKey = new Map()
    try {
      for (const def of (getAllTableDefs() || [])) {
        if (def?.key) defsByKey.set(def.key, def)
      }
    } catch {}
    for (const key of tableOrder) {
      const n = tableNum.get(key)
      const def = defsByKey.get(key)
      const label = def?.label || key
      out.push(`### Table ${n}. ${label}`)
      if (def?.description) {
        out.push('')
        out.push(`*${def.description}*`)
      }
      out.push('')
      try {
        // 2026-05-26 修双 heading bug:appendix 已经按动态首现顺序加了
        //   `### Table {n}. {def.label}` 包装,renderTableExport 内部不要再加
        //   "Table 2." / "Table 5." 等硬编码前缀 — 传 numberPrefix: false
        //   只输出描述性 title("Summary of Findings (N=18 outcomes)") + table body
        const body = renderTableExport(allTables, key, 'md', { numberPrefix: false })
        if (body && body.trim()) out.push(body.trim())
        else out.push('*(table has no rendered rows)*')
      } catch (e) {
        console.warn(`[report/export.md] renderTableExport(${key}) failed:`, e?.message)
        out.push('*(table render failed)*')
      }
      out.push('')
    }
    tablesAppendix = out.join('\n')
  }

  // 4) Figures appendix
  let figuresAppendix = ''
  if (figureOrder.length > 0) {
    const out = ['---', '', '## Figures', '']
    for (const id of figureOrder) {
      const n = figureNum.get(id)
      if (id === 'prisma') {
        out.push(`### Figure ${n}. PRISMA Flow Diagram`)
        out.push('')
        out.push('```mermaid')
        out.push(String(prismaMermaid).trim())
        out.push('```')
        out.push('')
        continue
      }
      const asset = figureAssetById.get(id)
      if (asset) {
        // 2026-05-25 M34:论文学术格式
        //   "### Figure N. <title>"  ← heading 用短 title(LLM 推荐 / 用户填)
        //   "*<caption>*"              ← 斜体长 caption 在 <img> 下方,publication-style
        //   "![<alt>](<url>)"          ← alt_text 给屏幕阅读器
        const title = asset.title || asset.caption || asset.alt_text || asset.original_filename || '(uploaded figure)'
        const caption = asset.caption || ''
        const alt = asset.alt_text || asset.caption || title || `Figure ${n}`
        // 2026-05-25 P0-1:用 HTTP 路由 URL 替代磁盘绝对路径 /var/lib/...
        //   export.md: baseUrl 传入 → 绝对 https://... URL,下载的 .md 在 Word 也能看到图
        //   preview: 不传 baseUrl → 相对 URL,同源浏览器加载
        const url = buildFigureUrl(projectId, asset.id, { baseUrl })
        out.push(`### Figure ${n}. ${title}`)
        out.push('')
        out.push(`![${alt}](${url})`)
        if (caption && caption !== title) {
          out.push('')
          out.push(`*${caption}*`)
        }
        out.push('')
      }
    }
    figuresAppendix = out.join('\n')
  }

  return {
    tableOrder, figureOrder, tableNum, figureNum,
    tablesAppendix, figuresAppendix,
    unknownTables: Array.from(unknownTables),
    unknownFigures: Array.from(unknownFigures),
  }
}

// 用一份共享的 tNum/fNum 映射做单 section 替换(unknown 仍保留 + 标注)
function replaceFigTblInSection(txt, tNum, fNum) {
  if (typeof txt !== 'string' || !txt) return txt
  return txt.replace(/\[(tbl|fig):([A-Za-z0-9_-]+)\]/g, (match, kind, id) => {
    if (kind === 'tbl') {
      if (tNum.has(id)) return `Table ${tNum.get(id)}`
      return `${match} [unknown table key]`
    }
    // 2026-05-26:`[fig:prisma]` 老缓存残留 — 替换成描述性文本(不编号成 Figure N),
    //   因为 PRISMA flow 已经作为 `### PRISMA Flow Diagram` 独立 mermaid 块自动渲染,
    //   不进 Figures appendix,所以不该有 Figure N 标号。
    if (id === 'prisma') return 'the PRISMA flow diagram'
    if (fNum.has(id)) return `Figure ${fNum.get(id)}`
    return `${match} [unknown figure id]`
  })
}

// ============================================================
// GET /:id/report/export.md  — 完整 Markdown 导出
// ------------------------------------------------------------
// Phase D 接入:正文段 post-process [tbl:]/[fig:] 占位 → Table N / Figure N,
// 并在 References 之前追加 Tables + Figures 附录。
// ============================================================
router.get('/:id/report/export.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const prismaCounts = computePrismaFlow(db, project.id)
  const sections = listLatestSections(db, project.id)
  const included = listIncludedRecords(db, project.id)
  const prismaMermaid = renderPrismaMermaid(prismaCounts).trim()

  // ── Phase D: 取每段正文 → 拼 combined 扫占位 → 拿编号映射 + 附录 ──
  // 2026-05-26 加 declarations(PRISMA 24-27)— 让 [tbl:xxx]/[fig:xxx] 占位扫描也覆盖该段
  const SECTION_ORDER_FOR_SCAN = [
    'title', 'abstract', 'introduction', 'methods',
    'results', 'discussion', 'limitations', 'conclusion', 'declarations',
  ]
  const sectionTexts = {}
  for (const k of SECTION_ORDER_FOR_SCAN) {
    sectionTexts[k] = (sections[k]?.content_markdown || '').toString()
  }
  const combinedForScan = SECTION_ORDER_FOR_SCAN.map((k) => sectionTexts[k]).join('\n\n')

  let postProc = {
    tableNum: new Map(),
    figureNum: new Map(),
    tablesAppendix: '',
    figuresAppendix: '',
    unknownTables: [],
    unknownFigures: [],
  }
  try {
    // 2026-05-25 P0-1:export.md 传外部 base URL,让下载 .md 在 Word / VS Code /
    //   GitHub 打开也能看到图(不再是 broken /var/lib/... 链接)
    const proto = req.protocol || 'https'
    const host = req.get('host') || ''
    const exportBaseUrl = host ? `${proto}://${host}` : ''
    postProc = postProcessFigTblPlaceholders({
      combinedBody: combinedForScan,
      db,
      projectId: project.id,
      prismaMermaid,
      baseUrl: exportBaseUrl,
    })
  } catch (e) {
    console.error('[report/export.md] postProcessFigTblPlaceholders failed:', e?.message)
  }
  const trSections = {}
  for (const k of SECTION_ORDER_FOR_SCAN) {
    trSections[k] = replaceFigTblInSection(sectionTexts[k], postProc.tableNum, postProc.figureNum)
  }

  const parts = []
  parts.push(`<!-- Generated by SLR Copilot — ${new Date().toISOString()} -->`)
  parts.push(`<!-- Project: ${project.title} (${project.id}) -->`)
  if ((postProc.unknownTables && postProc.unknownTables.length)
      || (postProc.unknownFigures && postProc.unknownFigures.length)) {
    parts.push(`<!-- Phase D postproc: unknown_tables=${JSON.stringify(postProc.unknownTables)}, unknown_figures=${JSON.stringify(postProc.unknownFigures)} -->`)
  }
  parts.push('')

  // Title
  if (trSections.title) {
    parts.push(trSections.title)
  } else {
    parts.push(`# ${project.title}`)
  }
  parts.push('')

  // Abstract
  if (trSections.abstract) {
    parts.push(trSections.abstract)
    parts.push('')
  }

  // Introduction
  if (trSections.introduction) {
    parts.push(trSections.introduction)
    parts.push('')
  }

  // Methods + PRISMA flow
  if (trSections.methods) {
    parts.push(trSections.methods)
    parts.push('')
  }
  // PRISMA flow:Mermaid 块 + 文字表
  parts.push('### PRISMA Flow Diagram')
  parts.push('')
  parts.push('```mermaid')
  parts.push(prismaMermaid)
  parts.push('```')
  parts.push('')
  parts.push(renderPrismaTextSummary(prismaCounts, { lang: 'en' }))
  parts.push('')

  // Results
  if (trSections.results) {
    parts.push(trSections.results)
    parts.push('')
  }

  // Summary of Findings — GRADE 详细评估表(Phase 6.5)
  try {
    const sofMd = renderSoFMarkdown(db, project.id)
    if (sofMd && sofMd.trim()) {
      parts.push(sofMd)
      parts.push('')
    }
  } catch (e) {
    console.error('[report/export.md] SoF render failed:', e.message)
  }

  // Discussion
  if (trSections.discussion) {
    parts.push(trSections.discussion)
    parts.push('')
  }

  // Limitations
  if (trSections.limitations) {
    parts.push(trSections.limitations)
    parts.push('')
  }

  // Conclusion
  if (trSections.conclusion) {
    parts.push(trSections.conclusion)
    parts.push('')
  }

  // ── Phase D: Tables + Figures appendices(置于 References 之前)──
  if (postProc.tablesAppendix) {
    parts.push(postProc.tablesAppendix)
    parts.push('')
  }
  if (postProc.figuresAppendix) {
    parts.push(postProc.figuresAppendix)
    parts.push('')
  }

  // References — 始终 by reference-export(忽略 draft_sections 里手编的版本)
  // 2026-05-25 P2-16:支持 ?style=apa|ieee|chicago|mla|gbt7714 切换;默认 APA。
  //   preview 用同一套切换逻辑;让用户在 preview 里看到的 References 跟下载
  //   的 .md 一致。
  const _allowedStylesExport = new Set(['apa', 'ieee', 'chicago', 'mla', 'gbt7714'])
  const _reqStyleExport = String(req.query.style || '').toLowerCase()
  const _exportStyle = _allowedStylesExport.has(_reqStyleExport) ? _reqStyleExport : 'apa'
  parts.push(exportReferencesSection(included, { style: _exportStyle }))
  parts.push('')

  // ─── Appendix: PRISMA 2020 27-item Checklist + AI 验证审计报告 ─────────
  // 2026-05-25:扩到含 ai_validation_status / ai_validation_evidence,
  //   让审稿人可以直接看每项是否被论文覆盖、对应证据 quote、AI 改进建议
  try {
    const checklist = db
      .prepare(
        `SELECT item_number, section, topic, recommendation,
                workflow_step, status, notes, evidence_url,
                ai_validation_status, ai_validation_evidence, ai_validated_at
         FROM prisma_checklist
         WHERE project_id = ?
         ORDER BY id ASC`
      )
      .all(project.id)
    if (checklist.length > 0) {
      // 汇总
      let _cv = 0, _pt = 0, _ms = 0, _ur = 0
      for (const it of checklist) {
        if (it.ai_validation_status === 'covered') _cv++
        else if (it.ai_validation_status === 'partial') _pt++
        else if (it.ai_validation_status === 'missing') _ms++
        else _ur++
      }
      const _hasAi = (_cv + _pt + _ms) > 0
      const _scorePct = _hasAi ? Math.round((_cv * 1 + _pt * 0.5) / checklist.length * 100) : 0

      parts.push('---')
      parts.push('')
      parts.push('## Appendix A. PRISMA 2020 Checklist')
      parts.push('')
      if (_hasAi) {
        parts.push(`> **AI compliance audit (Opus 4.8)** · ${checklist.length} items · ✓ covered ${_cv} · ⚠ partial ${_pt} · ✗ missing ${_ms}${_ur ? ` · · unrated ${_ur}` : ''} · **overall score ${_scorePct}/100**`)
      } else {
        parts.push(`> ${checklist.length} items · ⓘ AI compliance audit not yet run — manual statuses only.`)
      }
      parts.push('')
      // 主表 — 列含 AI status + manual status + 简短 notes
      parts.push('| # | Section | Item | AI status | Manual | Notes |')
      parts.push('|---|---|---|---|---|---|')
      const manualIcon = { done: '✓', in_progress: '◐', not_applicable: 'N/A', not_started: '○' }
      const aiIcon = { covered: '✓ covered', partial: '⚠ partial', missing: '✗ missing' }
      for (const it of checklist) {
        const aiStat = it.ai_validation_status ? (aiIcon[it.ai_validation_status] || it.ai_validation_status) : '—'
        const manualStat = manualIcon[it.status] || '○'
        const notes = (it.notes || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').slice(0, 200)
        parts.push(`| ${it.item_number} | ${it.section || ''} | ${(it.topic || '').replace(/\|/g, '\\|')} | ${aiStat} | ${manualStat} | ${notes} |`)
      }
      parts.push('')

      // AI 详细审计:每个 covered/partial/missing 项列 evidence + recommendation
      if (_hasAi) {
        parts.push('### AI Audit Details (covered · partial · missing)')
        parts.push('')
        parts.push('Each item below shows the AI-extracted verbatim evidence quote from the draft, its source section, and improvement recommendations from the audit. Use this to verify the audit is correct and to address any missing/partial items before submission.')
        parts.push('')
        for (const it of checklist) {
          if (!it.ai_validation_status) continue
          let ev = null
          try { ev = it.ai_validation_evidence ? JSON.parse(it.ai_validation_evidence) : null } catch { ev = null }
          const aiStat = aiIcon[it.ai_validation_status] || it.ai_validation_status
          parts.push(`#### Item ${it.item_number} · ${it.section || ''} · ${it.topic || ''}`)
          parts.push('')
          parts.push(`- **AI status:** ${aiStat}`)
          if (it.recommendation) parts.push(`- **PRISMA 2020 description:** ${String(it.recommendation).replace(/\r?\n/g, ' ').slice(0, 600)}`)
          if (ev && ev.section) parts.push(`- **Source section in draft:** \`${ev.section}\``)
          if (ev && ev.quote) {
            parts.push('')
            parts.push('  > ' + String(ev.quote).replace(/\r?\n/g, '\n  > ').slice(0, 1500))
          }
          if (ev && ev.recommendation) {
            parts.push('')
            parts.push(`- **AI recommendation:** ${String(ev.recommendation).replace(/\r?\n/g, ' ').slice(0, 800)}`)
          }
          if (it.ai_validated_at) parts.push(`- *Audited at ${it.ai_validated_at} UTC*`)
          parts.push('')
        }
      }
    }
  } catch (e) {
    console.error('[report/export.md] PRISMA checklist appendix failed:', e.message)
  }

  // ─── Appendix: search strategies ───────────────────────────────────
  try {
    const strategies = db
      .prepare(
        `SELECT database_name, query_type, query_text, result_count, search_date
         FROM search_strategies
         WHERE project_id = ?
         ORDER BY database_name, query_type`
      )
      .all(project.id)
    if (strategies.length > 0) {
      parts.push('---')
      parts.push('')
      parts.push('## Appendix B. Search Strategies (verbatim)')
      parts.push('')
      for (const s of strategies) {
        parts.push(`### ${s.database_name} · ${s.query_type}${s.search_date ? ' · ' + s.search_date : ''}${s.result_count != null ? ` · ${s.result_count} records` : ''}`)
        parts.push('')
        parts.push('```')
        parts.push(s.query_text || '')
        parts.push('```')
        parts.push('')
      }
    }
  } catch (e) {
    console.error('[report/export.md] search appendix failed:', e.message)
  }

  const md = parts.join('\n')

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="review-${project.id}.md"`)
  res.send(md)
})

// ============================================================
// GET /:id/report/preview  — 综述初稿 HTML 预览(排版可读版)
// ------------------------------------------------------------
// 2026-05-25 新加 — 用户硬性需求:
//   "论文分章节生成后我应该要能通过一个网页查看而不是 markdown,要排版好的,
//    包括 表格 / 插图 / 引文 等等"
//
// 实现路径:
//   - 服务端做和 export.md 完全一样的组装(包括 PRISMA Flow / SoF / Tables 附录 /
//     Figures 附录 / References / Appendix A/B),拿到完整 markdown
//   - 服务端额外构造 citationMap(record_id → "(Smith 2024) + anchor"),供前端
//     把 [rec_xxx] 占位换成可点击 badge,scroll 到 References 锚点
//   - 前端用 marked.js(GFM, CDN)markdown → HTML
//   - 前端用 mermaid.js 渲染 ```mermaid PRISMA flow
//   - CSS:Georgia serif + 学术期刊式 typography + print-friendly @page
//
// 跟 export.md 共用 buildAllRegisteredTables / postProcessFigTblPlaceholders /
// renderSoFMarkdown / exportReferencesSection,行为完全一致 — 用户在 preview
// 看到什么样,下载 .md 就是同样内容。
// ============================================================
router.get('/:id/report/preview', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })
  }

  const prismaCounts = computePrismaFlow(db, project.id)
  const sections = listLatestSections(db, project.id)
  const included = listIncludedRecords(db, project.id)
  const prismaMermaid = renderPrismaMermaid(prismaCounts).trim()

  // Phase D — post-process [tbl:]/[fig:] 占位
  // 2026-05-26 加 declarations(PRISMA 24-27)— 让 [tbl:xxx]/[fig:xxx] 占位扫描也覆盖该段
  const SECTION_ORDER_FOR_SCAN = [
    'title', 'abstract', 'introduction', 'methods',
    'results', 'discussion', 'limitations', 'conclusion', 'declarations',
  ]
  const sectionTexts = {}
  for (const k of SECTION_ORDER_FOR_SCAN) {
    sectionTexts[k] = (sections[k]?.content_markdown || '').toString()
  }
  const combinedForScan = SECTION_ORDER_FOR_SCAN.map((k) => sectionTexts[k]).join('\n\n')

  let postProc = {
    tableNum: new Map(),
    figureNum: new Map(),
    tablesAppendix: '',
    figuresAppendix: '',
    unknownTables: [],
    unknownFigures: [],
  }
  try {
    // 2026-05-25 P0-1:preview 用相对 URL(同源浏览器加载即可)
    postProc = postProcessFigTblPlaceholders({
      combinedBody: combinedForScan,
      db,
      projectId: project.id,
      prismaMermaid,
      baseUrl: '', // preview 同源,相对 URL 即可
    })
  } catch (e) {
    console.error('[report/preview] postProcessFigTblPlaceholders failed:', e?.message)
  }
  const trSections = {}
  for (const k of SECTION_ORDER_FOR_SCAN) {
    trSections[k] = replaceFigTblInSection(sectionTexts[k], postProc.tableNum, postProc.figureNum)
  }

  // 构造完整 markdown(跟 export.md 一致 — 不要发散)
  const parts = []
  if (trSections.title) parts.push(trSections.title)
  else parts.push(`# ${project.title}`)
  parts.push('')
  if (trSections.abstract) { parts.push(trSections.abstract); parts.push('') }
  if (trSections.introduction) { parts.push(trSections.introduction); parts.push('') }
  if (trSections.methods) { parts.push(trSections.methods); parts.push('') }
  parts.push('### PRISMA Flow Diagram')
  parts.push('')
  parts.push('```mermaid')
  parts.push(prismaMermaid)
  parts.push('```')
  parts.push('')
  parts.push(renderPrismaTextSummary(prismaCounts, { lang: 'en' }))
  parts.push('')
  if (trSections.results) { parts.push(trSections.results); parts.push('') }
  // SoF (outcome-level GRADE summary)
  try {
    const sofMd = renderSoFMarkdown(db, project.id)
    if (sofMd && sofMd.trim()) { parts.push(sofMd); parts.push('') }
  } catch (e) { console.warn('[report/preview] SoF render failed:', e?.message) }
  if (trSections.discussion) { parts.push(trSections.discussion); parts.push('') }
  if (trSections.limitations) { parts.push(trSections.limitations); parts.push('') }
  if (trSections.conclusion) { parts.push(trSections.conclusion); parts.push('') }
  if (postProc.tablesAppendix) { parts.push(postProc.tablesAppendix); parts.push('') }
  if (postProc.figuresAppendix) { parts.push(postProc.figuresAppendix); parts.push('') }
  // 2026-05-25 P2-16:支持 ?style=apa|ieee|chicago|mla|gbt7714 切换引文格式
  //   默认 APA;用户在 preview URL 加 ?style=ieee 可临时切换查看效果
  //   References 段 + inline badge 都跟随同一 style
  const allowedStyles = new Set(['apa', 'ieee', 'chicago', 'mla', 'gbt7714'])
  const reqStyle = String(req.query.style || '').toLowerCase()
  const citationStyle = allowedStyles.has(reqStyle) ? reqStyle : 'apa'
  parts.push(exportReferencesSection(included, { style: citationStyle }))
  parts.push('')

  const md = parts.join('\n')

  // 构造 citationMap(record_id → 短引文 + anchor)
  //   buildInlineCitationMap from services/reference-export.js(2026-05-25 新加)
  //   前端按这个 map 把 [rec_xxx] 替换成可点击 (Smith 2024) badge
  //   P2-16:把 citationStyle 传进去(inlineCitationShort 现在 hardcode APA author-year;
  //   IEEE 等数字 style 后续 v2 接入 — 当前 [1] 编号需要 sort + scan,先保 APA badge)
  let citationMap = {}
  try {
    citationMap = buildInlineCitationMap(included) || {}
  } catch (e) {
    console.warn('[report/preview] buildInlineCitationMap failed:', e?.message)
    citationMap = {}
  }

  res.render('projects/preview', {
    title: `预览 · ${project.title}`,
    project,
    currentStep: 'report',
    markdown: md,
    citationMap,
    includedCount: included.length,
    prismaCounts,
    unknownTables: postProc.unknownTables || [],
    unknownFigures: postProc.unknownFigures || [],
    citationStyle,
    availableStyles: Array.from(allowedStyles),
  })
})

// ============================================================
// 共用:跑一个章节的 LLM 调用,**返回**结果不直接入库
//   (入库由调用方做,因为入库 SQL 在 placeholder UPDATE 路径里)
// ============================================================
async function generateSectionLlm(db, { project, userId, section, abstractDraftInputs = null, sessionState = null }) {
  // 优化打磨包 / Session-continuity:
  //   sessionState = { sessionId, turnIndex, prevSection, isClaudeCli }
  //     - turnIndex === 0 → 首章,full user prompt + --session-id <uuid>
  //     - turnIndex > 0  → 跟进章,short follow-up prompt + --resume <uuid>
  //   sessionState=null OR isClaudeCli=false → 老路径(stateless,每次 full prompt + plan + peer_summary)
  //   Abstract-from-draft 永远走 stateless(自己的 ABSTRACT_FROM_DRAFT_SYSTEM)。
  const useSession = !!(sessionState && sessionState.sessionId && sessionState.isClaudeCli && !(section === 'abstract' && abstractDraftInputs))
  // ---- M32-f: load manuscript plan + prior section summaries for cohesion ----
  // 注:abstract-from-draft 路径用专门的 ABSTRACT_FROM_DRAFT_SYSTEM,不走 plan;其他章节都接 plan。
  let manuscriptPlanForPrompt = null
  let priorSummariesForPrompt = null
  if (section !== 'abstract' || !abstractDraftInputs) {
    try {
      const planRaw = project.drafting_plan_json
      if (planRaw) {
        const parsed = JSON.parse(planRaw)
        if (parsed && typeof parsed === 'object') manuscriptPlanForPrompt = parsed
      }
    } catch (e) {
      console.warn('[report] parse drafting_plan_json failed:', e?.message)
    }
    // Prior section summaries from siblings already drafted
    // (peer_summary populated after each section completes)
    try {
      const customSections = getCustomSections(db, project.id)
      const currentIdx = customSections.findIndex((s) => s.name === section)
      if (currentIdx > 0) {
        const earlierNames = customSections.slice(0, currentIdx).map((s) => s.name)
        if (earlierNames.length) {
          const placeholders = earlierNames.map(() => '?').join(',')
          const rows = db.prepare(
            `SELECT ds.section_name, ds.peer_summary, ds.version
               FROM draft_sections ds
               JOIN (
                 SELECT section_name, MAX(version) AS max_v
                   FROM draft_sections
                  WHERE project_id = ?
                    AND section_name IN (${placeholders})
                    AND peer_summary IS NOT NULL
                    AND peer_summary != ''
                  GROUP BY section_name
               ) m ON m.section_name = ds.section_name AND m.max_v = ds.version
              WHERE ds.project_id = ?`
          ).all(project.id, ...earlierNames, project.id)
          if (rows.length) {
            priorSummariesForPrompt = {}
            // Preserve customSections order in object key insertion
            const byName = {}
            for (const r of rows) byName[r.section_name] = r.peer_summary
            for (const n of earlierNames) {
              if (byName[n]) priorSummariesForPrompt[n] = byName[n]
            }
            if (Object.keys(priorSummariesForPrompt).length === 0) priorSummariesForPrompt = null
          }
        }
      }
    } catch (e) {
      console.warn('[report] prior section summaries query failed:', e?.message)
    }
  }

  const baseSystem = draftingPrompts.getSectionSystem(section)
  if (!baseSystem) {
    return { ok: false, status: 'config_error', error: `unknown section: ${section}` }
  }

  // Phase 9 Agent W:如果项目有期刊模板,把该 section 的风格基准拼到 system 末尾
  const journalTemplate = getJournalTemplate(db, project.id)
  const styleHint = buildSectionStyleHint(journalTemplate, section)
  let system = draftingPrompts.augmentSystemWithTemplate(baseSystem, styleHint)

  // Phase 8.A:overlay(若 Agent A 写了 drafting_master_prompt_overlay 列)
  // 注:overlayText 在下面"8.B 富数据接入"段统一构建并拼接(支持 JSON-wrap 形态)

  // 准备上下文
  const protocol = getApprovedProtocol(db, project.id)
  const themes = listThemes(db, project.id)
  const evidencePoints = listEvidencePoints(db, project.id)
  const searchStrategies = listSearchStrategies(db, project.id)
  const included = listIncludedRecords(db, project.id)
  const prismaCounts = computePrismaFlow(db, project.id)

  const citableRecords = included.map((r) => ({
    record_id: r.id,
    short_label: shortRecordLabel(r),
  }))
  const knownRecordIds = new Set(citableRecords.map((r) => r.record_id))

  // ────────────────────────────────────────────────────────────────────────
  // Phase 8.B:富数据接入 — overlay + 完整 paper profiles + citation cheat sheet
  // 这一段在 helpers 缺失时静默降级(包成 try),让单元测试 / 旧路径仍能跑。
  // ────────────────────────────────────────────────────────────────────────
  let overlayText = null
  let paperProfiles = null
  let formatPaperProfileFn = null
  let citationCheatSheet = ''
  try {
    // 1) overlay
    //   2026-05-25 P2-15:section 开跑前重新查 DB(不用 cached project 对象),
    //   防 cache miss:用户刷过 overlay 但 project 对象是旧的 → 跑出来 section
    //   用的还是老 overlay,产出跟覆盖率分析不一致。
    let _freshProjectRow = null
    try {
      _freshProjectRow = db.prepare(`SELECT drafting_master_prompt_overlay, drafting_master_prompt_at_version FROM projects WHERE id = ?`).get(project.id)
    } catch {}
    const _projectForOverlay = _freshProjectRow ? { ...project, ..._freshProjectRow } : project
    if (draftingHelpers?.loadDraftingOverlay) {
      const ov = draftingHelpers.loadDraftingOverlay(_projectForOverlay)
      overlayText = ov && typeof ov.overlay_text === 'string' ? ov.overlay_text : null
      // 落 audit 信息:section 看到的是哪个 overlay 版本
      if (ov && ov.at_protocol_version != null) {
        try {
          audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
            eventType: 'report_section_overlay_loaded',
            userId, projectId: project.id,
            payload: {
              section,
              overlay_at_protocol_version: ov.at_protocol_version,
              overlay_system_version: ov.system_version || null,
              overlay_text_length: overlayText ? overlayText.length : 0,
            },
          })
        } catch {}
      }
    } else {
      // 老 schema fallback:列里直接是字符串
      overlayText = _projectForOverlay.drafting_master_prompt_overlay || null
    }

    // 2) 完整 paper profiles(仅给"内容章节"喂,目录/标题/参考文献不需要)
    const contentSections = new Set(['introduction', 'methods', 'results', 'discussion',
                                     'limitations', 'conclusion', 'abstract'])
    if (contentSections.has(section) && draftingHelpers?.buildDraftingInputs) {
      // 高级用户允许喂 PDF chunks 给 matrix-sparse 论文
      const isAdvanced = !!(userId && project && (project.advanced_extraction_enabled || false))
      const inputs = draftingHelpers.buildDraftingInputs(db, project.id, {
        includePdfChunks: isAdvanced,
      })
      const synthHelpers = await import('../../services/synthesis-helpers.js').catch(() => null)
      formatPaperProfileFn = synthHelpers?.formatPaperProfile || null
      if (inputs?.papersByRid && formatPaperProfileFn) {
        // 决定 section 要喂哪些 papers:
        //   - results / discussion:所有 themes 的 supporting_record_ids 全集 + orphan(P1-9)
        //   - introduction:25 sample(P1-13 升:121 篇 only 12 样本 = 10% 偏倚太重)
        //   - methods / abstract:12-15 sample
        //   - limitations / conclusion:全集
        let targetRids = new Set()
        if (['results', 'discussion', 'limitations', 'conclusion'].includes(section)) {
          for (const t of inputs.themes || []) {
            for (const rid of (t.supporting_record_ids || [])) targetRids.add(rid)
          }
          // P1-9:Results 应该看到 orphan 论文(有 matrix 但未在任何主题)— 治"漏引"
          if (section === 'results') {
            for (const k of inputs.papersByRid.keys()) {
              if (!targetRids.has(k)) {
                const p = inputs.papersByRid.get(k)
                // 只 union 有 matrix 数据的 orphan(空 matrix 的论文喂了也没用)
                if (p?.matrixData?.fields && Object.keys(p.matrixData.fields).length > 0) {
                  targetRids.add(k)
                }
              }
            }
          }
          // 若 themes 空,fallback 用所有 papersByRid keys
          if (targetRids.size === 0) {
            for (const k of inputs.papersByRid.keys()) targetRids.add(k)
          }
        } else if (section === 'introduction') {
          // P1-13:intro 升 12→25(intro "prior work" 需要更广的覆盖面)
          if (draftingHelpers?.pickRepresentativeSamplePapers) {
            const sample = draftingHelpers.pickRepresentativeSamplePapers(
              inputs.papersByRid, inputs.themes || [], 25
            )
            for (const p of sample) if (p?.record?.id) targetRids.add(p.record.id)
          } else {
            for (const k of inputs.papersByRid.keys()) {
              if (targetRids.size >= 25) break
              targetRids.add(k)
            }
          }
        } else if (['methods', 'abstract'].includes(section)) {
          // methods/abstract 保持 12 sample(框架性章节,不需要广覆盖)
          if (draftingHelpers?.pickRepresentativeSamplePapers) {
            const sample = draftingHelpers.pickRepresentativeSamplePapers(
              inputs.papersByRid, inputs.themes || [], 12
            )
            for (const p of sample) if (p?.record?.id) targetRids.add(p.record.id)
          } else {
            for (const k of inputs.papersByRid.keys()) {
              if (targetRids.size >= 12) break
              targetRids.add(k)
            }
          }
        }
        paperProfiles = []
        for (const rid of targetRids) {
          const p = inputs.papersByRid.get(rid)
          if (p) paperProfiles.push(p)
        }
        // 2026-05-25 改:用户硬性要求"矩阵真全集"
        //   results/discussion/limitations/conclusion 不再限 80 篇,全部 supporting 论文都喂
        //   理由:121 篇 × ~1500 char/字段 × ~10 字段 ≈ 1.8MB ≈ 450K tokens,Opus 4.8 1M
        //   context 完全够用;之前 80 cap 把后 41 篇(~33%)悄悄丢了,Results 段引文密度
        //   和 Discussion 的"已有发现 vs 本综述"对比都被损害。
        //   仅在 paperProfiles 实在超出 Opus context 安全线(~200 篇)时才兜底截
        if (paperProfiles.length > 200) paperProfiles = paperProfiles.slice(0, 200)
        // intro/methods/abstract 路径上面已经做了 12-sample 选择,不会到这里
      }
    }

    // 3) Citation cheat sheet(全 citable records,默认 APA inline form)
    if (draftingHelpers?.buildCitableRecords) {
      const citable = draftingHelpers.buildCitableRecords(db, project.id)
      if (Array.isArray(citable) && citable.length) {
        try {
          citationCheatSheet = draftingPrompts.buildCitationCheatSheet(citable, 'apa') || ''
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[report] 8.B rich-context build failed (will fall back to v1 prompt):', e?.message)
  }

  // Step 5 RoB 统计 — 给 drafting 做"质量分层叙述"
  let robStats = null
  try {
    const robRows = db.prepare(
      `SELECT tool, overall_rating FROM rob_assessments WHERE project_id = ? AND rater_pass = 1`
    ).all(project.id)
    const byTool = {}
    let good = 0, middle = 0, bad = 0, unrated = 0
    for (const r of robRows) {
      byTool[r.tool] = (byTool[r.tool] || 0) + 1
      const rating = r.overall_rating
      const tool = r.tool
      let v = 'unrated'
      if (rating) {
        if (tool === 'mmat') {
          if (rating === 'screening_failed') v = 'bad'
          else {
            const m = String(rating).match(/^(\d+)\/(\d+)$/)
            if (m) {
              const ratio = parseInt(m[1], 10) / parseInt(m[2], 10)
              if (ratio >= 0.8) v = 'good'
              else if (ratio >= 0.4) v = 'middle'
              else v = 'bad'
            }
          }
        } else if (tool === 'nos') {
          v = rating === 'high_quality' ? 'good' : rating === 'moderate_quality' ? 'middle' : 'bad'
        } else if (tool === 'jbi_cs') {
          v = rating === 'high' ? 'good' : rating === 'moderate' ? 'middle' : 'bad'
        } else {
          if (rating === 'low') v = 'good'
          else if (rating === 'some_concerns' || rating === 'moderate') v = 'middle'
          else if (['high', 'serious', 'critical'].includes(rating)) v = 'bad'
        }
      }
      if (v === 'good') good++
      else if (v === 'middle') middle++
      else if (v === 'bad') bad++
      else unrated++
    }
    robStats = {
      assessed: robRows.length,
      totalInclude: included.length,
      byTool,
      good, middle, bad, unrated,
    }
  } catch {}

  // ── 构造 user prompt ──
  // Abstract 特殊路径:如果 abstractDraftInputs(由 orchestrator 传入,包含
  //   sectionsContent map),用 Agent A 的 buildAbstractFromDraftUserPrompt + ABSTRACT_FROM_DRAFT_SYSTEM
  //   覆盖默认 system / userPrompt。这样 abstract 是"基于已写完的草稿摘出
  //   200 words",而不是从零生成。
  let userPrompt
  let promptVersion = 'drafting_v1'
  let systemVersionTag = draftingPrompts.DRAFTING_SYSTEM_VERSION || null

  // ── 2026-05-25 NEW:date range alignment(protocol 窗 vs 实际入选论文年跨度)──
  //   一次算好,methods / limitations / discussion / abstract / introduction 都会注入
  let dateRangeAlignment = null
  try {
    if (draftingHelpers?.computeDateRangeAlignment) {
      dateRangeAlignment = draftingHelpers.computeDateRangeAlignment(protocol, included)
    }
  } catch (e) {
    console.warn('[report] computeDateRangeAlignment failed:', e?.message)
  }

  if (section === 'abstract'
      && abstractDraftInputs
      && draftingPrompts.ABSTRACT_FROM_DRAFT_SYSTEM
      && typeof draftingPrompts.buildAbstractFromDraftUserPrompt === 'function') {
    // 2026-05-26:abstract-from-draft 也走 augmentSystemWithTemplate,
    //   把 buildSectionStyleHint 的 "In-abstract citations: 0 (OVERRIDES)" 块拼到 system 末尾。
    //   之前这条路径直接 system = ABSTRACT_FROM_DRAFT_SYSTEM,跳过了模板 styleHint →
    //   LLM 看不到模板 override,默认按 "at most 6" 写了带引用的摘要,跟目标期刊不符。
    system = draftingPrompts.augmentSystemWithTemplate(
      draftingPrompts.ABSTRACT_FROM_DRAFT_SYSTEM,
      styleHint    // 来自 buildSectionStyleHint(journalTemplate, 'abstract') — 已在 fn 顶部算好
    )
    if (overlayText && overlayText.trim()) {
      system = system + '\n\n===== PROJECT OVERLAY =====\n' + overlayText.trim() + '\n'
    }
    // 8.B:abstract from full draft 也喂 citable records,让 abstract 里出现的引文匹配正文
    //   2026-05-25:加 journalTemplate(让 LLM 用 source paper 的 abstract shape,
    //   不再默认 PRISMA-for-Abstracts 强制 Background/Methods/...)+ dateRangeAlignment
    userPrompt = draftingPrompts.buildAbstractFromDraftUserPrompt({
      project,
      protocol,
      sectionsContent: abstractDraftInputs.sectionsContent || {},
      prismaCounts,
      themesCount: themes.length,
      overlay: overlayText,
      citableRecords,   // 已经是 {record_id, short_label} 形态
      journalTemplate: journalTemplate || null,
      dateRangeAlignment,
    })
    promptVersion = 'abstract_from_draft_v3'
  } else {
    // 8.B:把 overlay 拼到 system 末尾(不在 abstract-from-draft 路径里)
    if (overlayText && typeof overlayText === 'string' && overlayText.trim()) {
      system = system + '\n\n===== PROJECT OVERLAY =====\n' + overlayText.trim() + '\n'
    }
    // 优化打磨包:Step 7 GRADE/CERQual rollup + Step 6 synthesis_meta + 期刊模板
    //   从 buildDraftingInputs 已聚合数据拿(在 8.B 富数据 try-catch 之外再算一次,
    //   但只为这两个字段,代价小,不重新跑 buildSynthesisInputs)
    let themeCertaintyForPrompt = null
    let synthesisMetaForPrompt = null
    let journalTemplateForPrompt = journalTemplate || null
    try {
      // 单独拉 theme_certainty + synthesis_meta,避免 buildDraftingInputs 跑两次
      const synthHelpers = await import('../../services/synthesis-helpers.js').catch(() => null)
      if (synthHelpers?.loadAllThemeCertainty || draftingHelpers?.buildDraftingInputs) {
        // 直接拉 SQL(轻量)
        try {
          const tcRows = db.prepare(
            `SELECT theme_id, grading_framework, overall_certainty, body_of_evidence_summary,
                    implications_for_practice, implications_for_research
               FROM theme_certainty
              WHERE project_id = ?
              ORDER BY iteration_n DESC`
          ).all(project.id)
          if (tcRows.length) {
            const byTheme = new Map()
            for (const r of tcRows) {
              if (!byTheme.has(r.theme_id)) byTheme.set(r.theme_id, r)
            }
            themeCertaintyForPrompt = byTheme
          }
        } catch {}
        try {
          const smRow = db.prepare(
            `SELECT cross_cutting_observations, protocol_coverage FROM synthesis_meta WHERE project_id = ?`
          ).get(project.id)
          if (smRow) {
            synthesisMetaForPrompt = {
              cross_cutting_observations: (() => { try { return JSON.parse(smRow.cross_cutting_observations || '[]') } catch { return [] } })(),
              protocol_coverage: (() => { try { return JSON.parse(smRow.protocol_coverage || '{}') } catch { return {} } })(),
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[report] enrich Step 7 + Step 6 meta context failed:', e?.message)
    }

    // ──────────────────────────────────────────────────────────────────
    // 优化打磨包:Step 7 outcome-level GRADE + 矩阵原汁原味
    //   - outcomeGradesForPrompt:per-outcome GRADE 5+3 + SoF + effect_size_text
    //     (主题级 rollup 之外的 drill-down,results/discussion 写 quant claim 要)
    //   - rawMatrixRowsForPrompt:relevant 论文的 literature_matrix.fields 全量
    //     (不截断 — paperProfiles 路径里 500-char truncation 把 quant_results 切掉)
    // ──────────────────────────────────────────────────────────────────
    let outcomeGradesForPrompt = null
    let rawMatrixRowsForPrompt = null
    try {
      // 2026-05-25 用户硬性要求:**每一步都喂全集矩阵**(不只 results/discussion)
      //   每个 section 的 LLM 都拿到完整 121 篇矩阵 + outcomeGrades,真"全量"保险。
      //   skipMatrix 互补让 paperProfiles 在 rawMatrixRows 在场时跳 matrix 渲染,
      //   避免双倍。Opus 1M context 完全 hold;Sonnet 200K 也 OK(总 prompt ~50K tokens)。
      const wantsRich = ['title', 'abstract', 'introduction', 'methods', 'results',
                         'discussion', 'limitations', 'conclusion'].includes(section)
      if (wantsRich) {
        // 1) outcome-level GRADE — 给 results/discussion/abstract/conclusion 写 quantitative claim
        //    intro/methods/limitations/title 也加载(LLM 即使不直接引,看了能调整语气)
        try {
          const gradeService = await import('../../services/grade.js').catch(() => null)
          if (gradeService?.listAssessmentsForProject) {
            const allG = gradeService.listAssessmentsForProject(db, project.id) || []
            if (allG.length) outcomeGradesForPrompt = allG
          }
        } catch (e) { console.warn('[report] load outcome grades failed:', e?.message) }

        // 2) raw matrix rows — 每段都加载全集 121(用户要求 "每一步喂全集矩阵")
        if (true) {  // 旧 ['results', 'discussion'] gate 取消 — 全段加载
          try {
            const themeRids = new Set()
            for (const t of (themes || [])) {
              for (const rid of (t.supporting_record_ids || [])) themeRids.add(rid)
            }
            // 2026-05-25 用户硬性要求"矩阵真全集" — rawMatrixRows 不再限 top 40,
            //   恢复 200 上限。配套修复:formatPaperProfile 在 rawMatrixRows 在场时
            //   走"no-matrix"模式(只渲染 metadata + RoB + screening,跳过 matrix.fields)
            //   → 信息不丢、不双倍、prompt size 降一半。
            //   每行 ~1-2KB,121 篇 ~120-240KB ~ 30-60K tokens,Opus 4.8 1M context 完全 OK。
            const ridArr = Array.from(themeRids).slice(0, 200)
            if (ridArr.length) {
              const placeholders = ridArr.map(() => '?').join(',')
              const rows = db.prepare(
                `SELECT record_id, fields FROM literature_matrix
                  WHERE project_id = ? AND record_id IN (${placeholders})`
              ).all(project.id, ...ridArr)
              if (rows.length) {
                rawMatrixRowsForPrompt = rows.map((r) => ({
                  record_id: r.record_id,
                  fields: (() => { try { return JSON.parse(r.fields || '{}') } catch { return {} } })(),
                })).filter((r) => Object.keys(r.fields).length > 0)
                if (!rawMatrixRowsForPrompt.length) rawMatrixRowsForPrompt = null
              }
            }
          } catch (e) { console.warn('[report] load raw matrix rows failed:', e?.message) }
        }
      }
    } catch (e) {
      console.warn('[report] enrich outcome GRADE + raw matrix failed:', e?.message)
    }

    // ──────────────────────────────────────────────────────────────────
    // Phase C: figure / table manifest
    //   告知 LLM 当前项目已有哪些派生表 + 已上传 figure_assets + 系统 PRISMA 图,
    //   LLM 用 [tbl:<key>] / [fig:<id>] 占位引用,export 端 post-process 替换 +
    //   文末附完整表/图。
    //   全部 try/catch 兜底:任一子失败让本段为 null,buildSectionUserPrompt
    //   收到 null/空数组时自动省略 manifest 段(零回归)。
    // ──────────────────────────────────────────────────────────────────
    let availableTablesForPrompt = null
    let availableFiguresForPrompt = null
    try {
      if (draftingHelpers?.buildFigTblManifest) {
        let tableDefsLocal = []
        let tablesDataLocal = {}
        let figureAssetsLocal = []
        let polishedByKeyLocal = {}                                        // N5: section LLM 看到 polish lead
        try { tableDefsLocal = getAllTableDefs() || [] } catch {}
        try { tablesDataLocal = buildAllRegisteredTables(db, project.id) || {} } catch (e) {
          console.warn('[report] manifest: buildAllRegisteredTables failed:', e?.message)
        }
        try { figureAssetsLocal = listFigureAssets(db, project.id) || [] } catch {}
        try {
          const p = db.prepare('SELECT polished_tables_json FROM projects WHERE id = ?').get(project.id)
          if (p?.polished_tables_json) {
            const parsed = JSON.parse(p.polished_tables_json)
            if (parsed && typeof parsed === 'object') polishedByKeyLocal = parsed
          }
        } catch {}
        const manifest = draftingHelpers.buildFigTblManifest(
          tableDefsLocal, tablesDataLocal, figureAssetsLocal,
          { polishedByKey: polishedByKeyLocal }                            // N5: polished caption + paragraph_lead 入 section prompt
        )
        if (manifest) {
          availableTablesForPrompt = (manifest.availableTables || [])
          availableFiguresForPrompt = (manifest.availableFigures || [])
          if (availableTablesForPrompt.length === 0) availableTablesForPrompt = null
          if (availableFiguresForPrompt.length === 0) availableFiguresForPrompt = null
        }
      }
    } catch (e) {
      console.warn('[report] build figure/table manifest failed:', e?.message)
    }

    userPrompt = draftingPrompts.buildSectionUserPrompt({
      section,
      project,
      protocol,
      themes,
      evidencePoints,
      prismaCounts,
      citableRecords,
      searchStrategies,
      robStats,
      // 8.B 新增:overlay + 完整 paper profiles + citation cheat sheet
      overlay: overlayText || '',
      paperProfiles: paperProfiles || null,
      formatPaperProfile: formatPaperProfileFn || null,
      citationCheatSheet: citationCheatSheet || '',
      // 优化打磨包:Step 7 + Step 6 meta + 期刊模板
      themeCertainty: themeCertaintyForPrompt,
      synthesisMeta: synthesisMetaForPrompt,
      journalTemplate: journalTemplateForPrompt,
      // 优化打磨包:outcome 级 GRADE + 矩阵原汁原味
      outcomeGrades: outcomeGradesForPrompt,
      rawMatrixRows: rawMatrixRowsForPrompt,
      // M32-f: plan-then-write + cohesion
      manuscriptPlan: manuscriptPlanForPrompt,
      priorSectionSummaries: priorSummariesForPrompt,
      // Phase C: figure / table manifest
      availableTables: availableTablesForPrompt,
      availableFigures: availableFiguresForPrompt,
      // 2026-05-25 NEW: date range alignment(protocol 窗 vs 实际入选论文跨度,methods/limitations/discussion/abstract/introduction 注入)
      dateRangeAlignment,
      // 2026-05-25 M36: 方法学 capabilities(诚信门"允许端") — methods/abstract/limitations/introduction 注入
      methodologyCapabilities: (function() {
        try { return loadCapabilities(db, project.id) } catch { return null }
      })(),
      buildCapabilitiesPromptBlockFn: buildCapabilitiesPromptBlock,
    })
    if (overlayText || paperProfiles || citationCheatSheet || themeCertaintyForPrompt || synthesisMetaForPrompt) {
      promptVersion = 'drafting_v3'
    }
    if (manuscriptPlanForPrompt) {
      promptVersion = 'drafting_v4_plan'
    }
    if (outcomeGradesForPrompt || rawMatrixRowsForPrompt) {
      promptVersion = 'drafting_v6_outcome_grade_raw_matrix'
    }
    if (availableTablesForPrompt || availableFiguresForPrompt) {
      promptVersion = 'drafting_v7_figtbl_manifest'
    }

    // 优化打磨包 / Session-continuity:覆盖 user prompt
    //   turn 0 → 走 full prompt(上面已经构造好的 userPrompt)+ session-id 落地新 session
    //   turn 1+ → 改用 short follow-up,LLM 看见上一轮原文,只需要本节 plan + 必引论文
    if (useSession && sessionState.turnIndex > 0) {
      // 从 supportingRids 里挑出本 section paper profile 的 record_id(我们 above 已经
      // 把 targetRids 收到了 paperProfiles 数组里;reverse 取即可)
      const sectionRids = Array.isArray(paperProfiles)
        ? paperProfiles.map((p) => p?.record?.id).filter(Boolean)
        : []
      userPrompt = draftingPrompts.buildSectionFollowUpPrompt({
        section,
        manuscriptPlan: manuscriptPlanForPrompt,
        prevSection: sessionState.prevSection || null,
        sectionSupportingRids: sectionRids,
        shortSectionGuidance: '',    // 留空 — base SECTION_SYSTEMS 已经在 turn 0 喂过了
      })
      promptVersion = 'drafting_v5_session_followup'
    }
  }

  let result
  try {
    const llmCallArgs = {
      userId,
      actionType: 'drafting',
      projectId: project.id,
      system,
      prompt: userPrompt,
      expectJson: true,
      model: 'heavy',
      maxTokens: 8192,
      timeoutMs: 900_000,    // 15 min(per-section 异步 → 可以放宽,不卡 nginx)
    }
    // 优化打磨包 / Session-continuity:首章 --session-id <uuid>,后续章节 --resume <uuid>
    if (useSession) {
      llmCallArgs.sessionId = sessionState.sessionId
      llmCallArgs.resumeSession = sessionState.turnIndex > 0
    }
    result = await runLlm(db, llmCallArgs)
  } catch (e) {
    return { ok: false, status: 'error', error: e?.message || String(e) }
  }

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error, usageLogId: result.usageLogId }
  }

  const normalized = draftingPrompts.normalizeSectionOutput(result.data || null, { knownRecordIds })
  if (!normalized.content_markdown) {
    // 补 raw 原文到 usage_log,方便诊断 parse 失败
    if (result.data && result.usageLogId && result.text) {
      try {
        const blob = `meta:\n  reason=empty_content\n  section=${section}\n\nRAW_TEXT_BEGIN\n${result.text.slice(0, 8000)}\nRAW_TEXT_END`
        db.prepare(`UPDATE usage_logs SET status = 'parse_failed', error_message = ? WHERE id = ?`)
          .run(blob, result.usageLogId)
      } catch {}
    }
    return { ok: false, status: 'parse_failed', error: 'content_markdown empty', usageLogId: result.usageLogId }
  }

  return {
    ok: true,
    status: 'success',
    model: result.model,
    durationMs: result.durationMs,
    contentMarkdown: normalized.content_markdown,
    citationMap: normalized.citation_map,
    citationMapCount: normalized.citation_map.length,
    citationIssues: normalized.citation_issues,
    withJournalTemplate: !!journalTemplate,
    withOverlay: !!(overlayText && overlayText.trim()),
    promptVersion,
    systemVersion: systemVersionTag,
    usageLogId: result.usageLogId,
    // 优化打磨包 / Session-continuity:回传 sessionId 给 orchestrator 持久化
    sessionId: result.sessionId || (useSession ? sessionState.sessionId : null),
    usedSession: useSession,
    sessionTurnIndex: useSession ? sessionState.turnIndex : null,
  }
}

/**
 * Orchestrator 内联跑单 section:
 *   - 走 placeholder + heartbeat + finishSection(同 generate-section 路由)
 *   - 但不另开 setImmediate(已经在 orchestrator 的 BG 闭包里)
 *   - abstract section 自动从 DB 读已写完章节,传给 generateSectionLlm
 */
async function runSectionInOrchestrator(db, { project, projectId, userId, section, sectionDef, customSections, sessionState = null }) {
  // placeholder
  const nextVersion = getMaxSectionVersion(db, projectId, section) + 1
  const placeholderId = randomId('ds')
  try {
    db.prepare(
      `INSERT INTO draft_sections
         (id, project_id, section_name, content_markdown, citation_map,
          model, prompt_version, user_edited, version,
          section_run_started_at, section_run_status)
       VALUES (?, ?, ?, '', '[]', NULL, NULL, 0, ?, datetime('now', '+8 hours'), 'running')`
    ).run(placeholderId, projectId, section, nextVersion)
  } catch (e) {
    return { ok: false, status: 'lock_failed', error: (e?.message || String(e)) }
  }

  // 每 section 自己的 heartbeat(独立于 main orchestrator hb)
  const hbStart = Date.now()
  const writeHb = () => {
    try {
      db.prepare(
        `UPDATE draft_sections
            SET section_run_meta = ?
          WHERE id = ? AND section_run_status = 'running'`
      ).run(JSON.stringify({
        heartbeat: true,
        last_heartbeat_at: new Date().toISOString(),
        elapsed_seconds: Math.floor((Date.now() - hbStart) / 1000),
        section_name: section,
        from_orchestrator: true,
      }), placeholderId)
    } catch {}
  }
  writeHb()
  const hbInterval = setInterval(writeHb, 30_000)

  // Abstract:跑前 read 已写完章节
  let abstractDraftInputs = null
  if (section === 'abstract') {
    const wanted = ['introduction', 'methods', 'results', 'discussion', 'conclusion']
    const sectionsContent = {}
    for (const w of wanted) {
      const row = getLatestNonEmptySection(db, projectId, w)
      if (row?.content_markdown) sectionsContent[w] = row.content_markdown
    }
    abstractDraftInputs = { sectionsContent }
  }

  let r
  try {
    r = await generateSectionLlm(db, { project, userId, section, abstractDraftInputs, sessionState })
  } catch (e) {
    r = { ok: false, status: 'error', error: e?.message || String(e) }
  }

  clearInterval(hbInterval)

  try {
    if (r.ok) {
      // 2026-05-25 P0-6 → 2026-05-31 P0.2:LLM 返回后立刻校验引文幻觉 + [tbl:]/[fig:]
      //   占位 lint。两件事都抽到 computeCitationLintForSection 共享 helper,
      //   单章节直接生成路径走同一套(见 finishSection)。
      const { hallucinatedRecs, lintWarnings } = computeCitationLintForSection(
        db, projectId, r.contentMarkdown || '', r.citationMap,
      )
      if (hallucinatedRecs.length > 0) {
        console.warn(`[runSectionInOrchestrator] section=${section} 检测到 ${hallucinatedRecs.length} 个幻觉引文:`, hallucinatedRecs)
      }
      if (lintWarnings) {
        console.warn(`[runSectionInOrchestrator] section=${section} 检测到未知占位:`, lintWarnings)
      }

      db.prepare(
        `UPDATE draft_sections
            SET content_markdown = ?,
                citation_map = ?,
                model = ?,
                prompt_version = ?,
                user_edited = 0,
                updated_at = datetime('now', '+8 hours'),
                section_run_status = 'success',
                section_run_finished_at = datetime('now', '+8 hours'),
                section_run_error = NULL,
                section_run_meta = ?,
                hallucinated_recs_json = ?,
                lint_warnings_json = ?
          WHERE id = ?`
      ).run(
        r.contentMarkdown,
        JSON.stringify(r.citationMap || []),
        r.model || null,
        r.promptVersion || null,
        JSON.stringify({
          model: r.model,
          duration_ms: r.durationMs,
          citation_count: r.citationMapCount,
          citation_issues: r.citationIssues?.slice(0, 5) || [],
          used_overlay: r.withOverlay || false,
          from_orchestrator: true,
          drafting_system_version: r.systemVersion || null,
          hallucinated_count: hallucinatedRecs.length,
          lint_unknown_tables: lintWarnings?.unknown_tables?.length || 0,
          lint_unknown_figures: lintWarnings?.unknown_figures?.length || 0,
        }),
        hallucinatedRecs.length > 0 ? JSON.stringify(hallucinatedRecs) : null,
        lintWarnings ? JSON.stringify(lintWarnings) : null,
        placeholderId,
      )
      // M32-f: fire-and-forget peer-summary write so subsequent batches see it
      try {
        writePeerSummaryAsync(db, {
          projectId, userId, sectionId: placeholderId, sectionName: section,
          contentMarkdown: r.contentMarkdown,
        })
      } catch (e) {
        console.warn('[runSectionInOrchestrator] peer_summary kick failed:', e?.message)
      }
    } else {
      db.prepare(
        `UPDATE draft_sections
            SET section_run_status = 'failed',
                section_run_finished_at = datetime('now', '+8 hours'),
                section_run_error = ?,
                section_run_meta = ?
          WHERE id = ?`
      ).run(
        `${r.status}: ${(r.error || '').slice(0, 200)}`,
        JSON.stringify({ from_orchestrator: true, usage_log_id: r.usageLogId || null }),
        placeholderId,
      )
    }
  } catch (e) {
    console.error('[runSectionInOrchestrator] finish update failed:', e)
  }
  return r
}

/**
 * 老的 sync persistSection:仅 references / 老 view 兼容用。
 * 不动 section_run_* 列(reference 章节不走异步)。
 */
// ============================================================
// M32-f · writePeerSummaryAsync
//   Best-effort 150-word "what we just said" abstract for a section.
//   Called fire-and-forget after a section finishes — failure logs warn
//   but never blocks the main flow (catch all the way through).
//
//   Strategy:
//     - Use Opus 'light' model (cheap + fast). The peer-summary is just
//       a downstream input to sibling sections; doesn't need top-tier model.
//     - Parse strict JSON { "summary_150w": "..." } via lightweight regex.
//     - On any failure (LLM throw, parse fail, content too short), fall
//       back to first-300-chars of content_markdown so siblings still get
//       SOMETHING (better than blank).
// ============================================================
function writePeerSummaryAsync(db, { projectId, userId, sectionId, sectionName, contentMarkdown }) {
  if (!sectionId || !contentMarkdown) return
  setImmediate(async () => {
    const fallback = String(contentMarkdown || '').trim().slice(0, 300)
    const writeRow = (text) => {
      try {
        db.prepare(
          `UPDATE draft_sections SET peer_summary = ? WHERE id = ?`
        ).run(text, sectionId)
      } catch (e) {
        console.warn('[report/peer_summary] write failed:', e?.message)
      }
    }
    try {
      const sys = draftingPrompts.buildPeerSummarySystem
        ? draftingPrompts.buildPeerSummarySystem()
        : null
      if (!sys) {
        writeRow(fallback)
        return
      }
      const userMsg = `Summarise this section in <=150 words for downstream sections. Section name: ${sectionName}\n\n${String(contentMarkdown).slice(0, 12000)}`
      let result
      try {
        result = await runLlm(db, {
          userId,
          actionType: 'drafting_peer_summary',
          projectId,
          system: sys,
          prompt: userMsg,
          expectJson: true,
          model: 'light',
          maxTokens: 800,
          timeoutMs: 120_000,
        })
      } catch (e) {
        console.warn('[report/peer_summary] runLlm threw:', e?.message)
        writeRow(fallback)
        return
      }
      if (!result || !result.ok || !result.data) {
        writeRow(fallback)
        return
      }
      // tolerate wrappers
      let r = result.data
      for (let i = 0; i < 3; i++) {
        if (r && typeof r === 'object' && !r.summary_150w) {
          if (r.result && typeof r.result === 'object') { r = r.result; continue }
          if (r.data && typeof r.data === 'object') { r = r.data; continue }
          if (r.output && typeof r.output === 'object') { r = r.output; continue }
        }
        break
      }
      const summary = String(r?.summary_150w || r?.summary || '').trim()
      if (!summary) {
        writeRow(fallback)
        return
      }
      // Soft cap: ~200 words (some slack over the 150 ask) just to keep DB sane
      const words = summary.split(/\s+/)
      const clipped = words.length > 220 ? words.slice(0, 220).join(' ') + '…' : summary
      writeRow(clipped)
    } catch (e) {
      console.warn('[report/peer_summary] unexpected:', e?.message)
      try { writeRow(fallback) } catch {}
    }
  })
}

function persistSectionSync(db, projectId, section, contentMarkdown, citationMap, model, promptVersion) {
  const version = getMaxSectionVersion(db, projectId, section) + 1
  const id = randomId('ds')
  db.prepare(
    `INSERT INTO draft_sections
       (id, project_id, section_name, content_markdown, citation_map, model, prompt_version, user_edited, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    projectId,
    section,
    contentMarkdown,
    JSON.stringify(citationMap || []),
    model,
    promptVersion,
    version,
  )
  return { id, version }
}

// ============================================================
// 2026-05-25: GET /:id/report/prisma-checklist.md
// ------------------------------------------------------------
// 单独下载 PRISMA 27 项 AI 审计报告(独立于 export.md,方便贴到 cover letter
// / 给审稿人 / 供合规 checklist 留存)。
// 输出格式跟 export.md Appendix A 一致,但带正式报头 + AI score 摘要,
// missing 项前面有 ✗ 警告图标 + 给作者的下一步动作建议。
// ============================================================
router.get('/:id/report/prisma-checklist.md', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const checklist = db.prepare(
    `SELECT item_number, section, topic, recommendation,
            workflow_step, status, notes,
            ai_validation_status, ai_validation_evidence, ai_validated_at
       FROM prisma_checklist
      WHERE project_id = ?
      ORDER BY id ASC`
  ).all(project.id)

  let _cv = 0, _pt = 0, _ms = 0, _ur = 0
  for (const it of checklist) {
    if (it.ai_validation_status === 'covered') _cv++
    else if (it.ai_validation_status === 'partial') _pt++
    else if (it.ai_validation_status === 'missing') _ms++
    else _ur++
  }
  const _hasAi = (_cv + _pt + _ms) > 0
  const _scorePct = _hasAi ? Math.round((_cv * 1 + _pt * 0.5) / checklist.length * 100) : 0

  const parts = []
  parts.push(`# PRISMA 2020 Compliance Report — ${project.title}`)
  parts.push('')
  parts.push(`*Project ID: \`${project.id}\` · Generated ${new Date().toISOString()}*`)
  parts.push('')
  parts.push('PRISMA 2020 is the international reporting guideline for systematic reviews ([Page et al., BMJ 2021; 372:n71](https://doi.org/10.1136/bmj.n71)). This report shows, for each of the 27 checklist items, whether the manuscript covers the required content and what (if anything) is still missing.')
  parts.push('')
  if (!_hasAi) {
    parts.push('> **⚠ AI compliance audit not yet run.** Open `/projects/' + project.id + '/report` and click "⚡ AI 验证 PRISMA 27 项覆盖度" to generate the AI audit. Manual statuses are shown below until then.')
    parts.push('')
  } else {
    parts.push('## Summary')
    parts.push('')
    parts.push(`- **Total items:** ${checklist.length}`)
    parts.push(`- **✓ Covered:** ${_cv}`)
    parts.push(`- **⚠ Partial:** ${_pt} *(addressed but incomplete — see recommendations below)*`)
    parts.push(`- **✗ Missing:** ${_ms} *(not yet addressed — must fix before submission)*`)
    if (_ur) parts.push(`- **· Unrated:** ${_ur}`)
    parts.push(`- **Overall score:** ${_scorePct}/100  *(covered=1, partial=0.5, missing=0)*`)
    parts.push('')
    if (_ms > 0 || _pt > 0) {
      parts.push('### What to do next')
      parts.push('')
      const todo = checklist.filter(it => it.ai_validation_status === 'missing' || it.ai_validation_status === 'partial')
      for (const it of todo) {
        let ev = null
        try { ev = it.ai_validation_evidence ? JSON.parse(it.ai_validation_evidence) : null } catch { ev = null }
        const stat = it.ai_validation_status === 'missing' ? '✗ MISSING' : '⚠ partial'
        const where = ev && ev.section ? `**${ev.section}**` : `**${it.section || '?'}** section`
        const action = ev && ev.recommendation ? ev.recommendation : (it.recommendation || '')
        parts.push(`- **#${it.item_number}** (${stat}) — *${it.topic || ''}*: add to ${where}. ${action}`.replace(/\s+/g, ' ').slice(0, 500))
      }
      parts.push('')
    }
  }

  parts.push('## All 27 items')
  parts.push('')
  parts.push('| # | Section | Item | AI status | Manual | Notes |')
  parts.push('|---|---|---|---|---|---|')
  const manualIcon = { done: '✓', in_progress: '◐', not_applicable: 'N/A', not_started: '○' }
  const aiIcon = { covered: '✓ covered', partial: '⚠ partial', missing: '✗ missing' }
  for (const it of checklist) {
    const aiStat = it.ai_validation_status ? (aiIcon[it.ai_validation_status] || it.ai_validation_status) : '—'
    const manualStat = manualIcon[it.status] || '○'
    const notes = (it.notes || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').slice(0, 200)
    parts.push(`| ${it.item_number} | ${it.section || ''} | ${(it.topic || '').replace(/\|/g, '\\|')} | ${aiStat} | ${manualStat} | ${notes} |`)
  }
  parts.push('')

  if (_hasAi) {
    parts.push('## Detailed AI audit')
    parts.push('')
    parts.push('Each evaluated item below shows the verbatim evidence quote AI extracted from the draft, its source section, and the AI improvement recommendation.')
    parts.push('')
    for (const it of checklist) {
      if (!it.ai_validation_status) continue
      let ev = null
      try { ev = it.ai_validation_evidence ? JSON.parse(it.ai_validation_evidence) : null } catch { ev = null }
      const aiStat = aiIcon[it.ai_validation_status] || it.ai_validation_status
      parts.push(`### Item ${it.item_number} · ${it.section || ''} · ${it.topic || ''}`)
      parts.push('')
      parts.push(`- **AI status:** ${aiStat}`)
      if (it.recommendation) parts.push(`- **PRISMA 2020 description:** ${String(it.recommendation).replace(/\r?\n/g, ' ').slice(0, 600)}`)
      if (ev && ev.section) parts.push(`- **Source section in draft:** \`${ev.section}\``)
      if (ev && ev.quote) {
        parts.push('')
        parts.push('  > ' + String(ev.quote).replace(/\r?\n/g, '\n  > ').slice(0, 1500))
      }
      if (ev && ev.recommendation) {
        parts.push('')
        parts.push(`- **AI recommendation:** ${String(ev.recommendation).replace(/\r?\n/g, ' ').slice(0, 800)}`)
      }
      if (it.ai_validated_at) parts.push(`- *Audited at ${it.ai_validated_at} UTC*`)
      parts.push('')
    }
  }

  parts.push('---')
  parts.push('')
  parts.push('*Generated by SLR Copilot · PRISMA 2020 compliance audit · Audit model: Anthropic Claude (Opus) — verbatim quote extraction, no rewriting.*')

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="prisma-checklist-${project.id}.md"`)
  res.send(parts.join('\n'))
})

// ============================================================
// 2026-05-25 M36: POST /:id/report/methodology-capabilities
// ------------------------------------------------------------
// 用户在"方法学声明"卡片勾选完保存。落 projects.methodology_capabilities_json,
// 下次 generate-section / overlay / plan 会把这些 capability 注入 LLM user prompt,
// LLM 在 methods/abstract 段 VERBATIM 报告(P0-5 学术诚信门"允许端")。
// ============================================================
router.post('/:id/report/methodology-capabilities', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) {
    if ((req.headers.accept || '').includes('json')) {
      return res.status(404).json({ ok: false, error: 'not_found' })
    }
    req.session.flash = { type: 'error', message: '项目不存在或无权访问' }
    return res.redirect('/projects')
  }
  try {
    const caps = saveCapabilities(db, project.id, req.body || {})
    audit(db, req, {
      eventType: 'methodology_capabilities_saved',
      userId: req.user.id,
      projectId: project.id,
      payload: { caps_summary: summarizeCapabilities(caps) },
    })
    if ((req.headers.accept || '').includes('json')) {
      return res.json({ ok: true, capabilities: caps, summary: summarizeCapabilities(caps) })
    }
    req.session.flash = {
      type: 'success',
      message: `✓ 方法学声明已保存:${summarizeCapabilities(caps)}。下次生成 Methods / Abstract 段会反映这些 capability。`,
    }
    res.redirect(`/projects/${project.id}/report#nav-setup`)
  } catch (e) {
    console.error('[report] saveCapabilities failed:', e?.message)
    if ((req.headers.accept || '').includes('json')) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) })
    }
    req.session.flash = { type: 'error', message: '保存失败:' + (e?.message || '') }
    res.redirect(`/projects/${project.id}/report#nav-setup`)
  }
})

// ============================================================
// Phase 8.D · POST /:id/report/prisma-validate
//   一次性让 Opus 4.8 通读已生成的所有 draft_sections,对照 PRISMA 2020
//   27 项 checklist 全量打 covered / partial / missing 标签 + 证据 +
//   recommendation。结果写回 prisma_checklist 表(ai_validation_* 三列)。
//
//   异步(setImmediate)+ atomic lock(15 min)+ projects.prisma_validate_*
//   四列 run-status,镜像 drafting/certainty overlay 优化路由的 pattern。
// ============================================================
router.post('/:id/report/prisma-validate', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) {
      return res.status(kind === 'error' ? 400 : 200)
        .json({ ok: kind !== 'error', message, ...(extra || {}) })
    }
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Atomic lock(15 min)— 镜像 drafting/optimize-overlay
  const lockAcquired = db.prepare(
    `UPDATE projects
        SET prisma_validate_started_at = datetime('now', '+8 hours'),
            prisma_validate_finished_at = NULL,
            prisma_validate_status = 'running',
            prisma_validate_error = NULL
      WHERE id = ?
        AND (prisma_validate_status IS NULL
             OR prisma_validate_status != 'running'
             OR prisma_validate_started_at IS NULL
             OR prisma_validate_started_at < datetime('now','-15 minutes'))`
  ).run(project.id).changes > 0
  if (!lockAcquired) {
    return flashOrJson('error',
      '另一个 PRISMA 验证请求正在进行(15 min 内),请等待或刷新查看进度',
      { error_code: 'in_flight' })
  }

  // 准备 inputs(同步,失败要释放锁)
  let checklistItems
  let draftSections
  let prismaCounts
  let themesCount
  try {
    checklistItems = getChecklistItems()
    const sectionsMap = listLatestSections(db, project.id)
    // 只喂非 placeholder(有内容)的章节;空 placeholder 没意义
    draftSections = Object.values(sectionsMap)
      .filter((s) => s && typeof s.content_markdown === 'string' && s.content_markdown.trim())
      .map((s) => ({ section_name: s.section_name, content_markdown: s.content_markdown }))
    prismaCounts = computePrismaFlow(db, project.id)
    themesCount = listThemes(db, project.id).length
  } catch (e) {
    // 释放锁
    try {
      db.prepare(
        `UPDATE projects
            SET prisma_validate_status = 'failed',
                prisma_validate_finished_at = datetime('now', '+8 hours'),
                prisma_validate_started_at = NULL,
                prisma_validate_error = ?
          WHERE id = ?`
      ).run('inputs_build_failed: ' + (e?.message || String(e)).slice(0, 400), project.id)
    } catch {}
    return flashOrJson('error', `准备验证输入失败:${(e?.message || e).slice(0, 200)}`, { error_code: 'inputs_failed' })
  }

  // T4 · ground truth for items 5–8:approved protocol + locked search strategies
  let protocolForValidate = null
  try {
    const r = db.prepare(
      `SELECT version, research_questions, inclusion_criteria, exclusion_criteria, concept_groups
         FROM protocols
        WHERE project_id = ? AND approved_by_user = 1
        ORDER BY version DESC LIMIT 1`
    ).get(project.id)
    if (r) {
      protocolForValidate = {
        version: r.version,
        research_questions: parseJsonArrayField(r.research_questions),
        inclusion_criteria: parseJsonArrayField(r.inclusion_criteria),
        exclusion_criteria: parseJsonArrayField(r.exclusion_criteria),
        concept_groups: parseJsonArrayField(r.concept_groups),
      }
    }
  } catch (e) {
    console.warn('[prisma-validate] protocol load failed:', e?.message)
  }

  let searchForValidate = null
  try {
    searchForValidate = db.prepare(
      `SELECT database_name AS database, query_text, is_locked, result_count
         FROM search_strategies
        WHERE project_id = ? AND is_locked = 1`
    ).all(project.id)
  } catch (e) {
    console.warn('[prisma-validate] search load failed:', e?.message)
  }

  const userPrompt = buildPrismaValidatorUserPrompt({
    checklistItems,
    draftSections,
    prismaCounts,
    themes: themesCount,
    protocol: protocolForValidate,
    searchStrategies: searchForValidate,
  })

  audit(db, req, {
    eventType: 'prisma_validate_started',
    userId: req.user.id, projectId: project.id,
    payload: {
      checklist_total: checklistItems.length,
      draft_sections_count: draftSections.length,
      prompt_chars: userPrompt.length,
      system_version: PRISMA_VALIDATOR_SYSTEM_VERSION,
      protocol_version: protocolForValidate?.version ?? null,
      locked_search_count: Array.isArray(searchForValidate)
        ? searchForValidate.filter((s) => s && s.is_locked === 1).length
        : 0,
    },
  })

  // 闭包捕获
  const projectId = project.id
  const userId = req.user.id

  setImmediate(async () => {
    const ovAudit = (eventType, payload) => {
      try {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType, userId, projectId, payload,
        })
      } catch {}
    }
    const writeFinish = (status, error) => {
      try {
        db.prepare(
          `UPDATE projects
              SET prisma_validate_status = ?,
                  prisma_validate_finished_at = datetime('now', '+8 hours'),
                  prisma_validate_started_at = NULL,
                  prisma_validate_error = ?
            WHERE id = ?`
        ).run(status, error ? String(error).slice(0, 500) : null, projectId)
      } catch (e) {
        console.error('[prisma-validate] finish write failed:', e)
      }
    }

    let result
    try {
      result = await runLlm(db, {
        userId,
        actionType: 'prisma_validate',
        projectId,
        system: PRISMA_VALIDATOR_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        model: 'heavy',
        maxTokens: 16000,
        timeoutMs: 720_000,    // 12 min(27 items + 全文,Opus thinking 充足时间)
      })
    } catch (e) {
      console.error('[prisma-validate] runLlm threw:', e)
      ovAudit('prisma_validate_failed', { reason: 'runLlm_threw', error: (e?.message || String(e)).slice(0, 200) })
      writeFinish('failed', 'runLlm threw: ' + (e?.message || String(e)))
      return
    }

    if (!result.ok) {
      ovAudit('prisma_validate_failed', {
        status: result.status, error: (result.error || '').slice(0, 200),
        model: result.model, usage_log_id: result.usageLogId,
      })
      writeFinish('failed', `${result.status}: ${(result.error || '').slice(0, 200)}`)
      return
    }

    const parsed = parsePrismaValidatorOutput(result.data)
    if (!parsed.ok) {
      ovAudit('prisma_validate_failed', {
        reason: 'parse_failed', error: parsed.error,
        model: result.model, usage_log_id: result.usageLogId,
      })
      writeFinish('failed', 'parse_failed: ' + parsed.error)
      return
    }

    // 写回每一项到 prisma_checklist(UPDATE WHERE item_number = ?)
    const updateStmt = db.prepare(
      `UPDATE prisma_checklist
          SET ai_validated_at = datetime('now', '+8 hours'),
              ai_validation_status = ?,
              ai_validation_evidence = ?,
              updated_at = datetime('now', '+8 hours')
        WHERE project_id = ? AND item_number = ?`
    )
    let updatedRows = 0
    const unmatchedItems = []
    const writeTx = db.transaction(() => {
      for (const it of parsed.items) {
        const evidenceJson = JSON.stringify({
          quote: it.evidence_quote || '',
          section: it.section_found || '',
          recommendation: it.recommendation || '',
        })
        const r = updateStmt.run(it.status, evidenceJson, projectId, it.item_number)
        if (r.changes > 0) updatedRows += r.changes
        else unmatchedItems.push(it.item_number)
      }
    })
    try {
      writeTx()
    } catch (e) {
      console.error('[prisma-validate] DB write failed:', e)
      ovAudit('prisma_validate_failed', {
        reason: 'db_write_failed', error: (e?.message || String(e)).slice(0, 200),
        model: result.model, usage_log_id: result.usageLogId,
      })
      writeFinish('failed', 'db_write_failed: ' + (e?.message || String(e)))
      return
    }

    ovAudit('prisma_validate_success', {
      updated_rows: updatedRows,
      unmatched_items: unmatchedItems.slice(0, 10),
      overall_score: parsed.overall_score,
      covered: parsed.covered_count,
      partial: parsed.partial_count,
      missing: parsed.missing_count,
      model: result.model,
      duration_ms: result.durationMs,
      usage_log_id: result.usageLogId,
      system_version: PRISMA_VALIDATOR_SYSTEM_VERSION,
    })
    writeFinish('success', null)
  })

  const msg = `已启动 PRISMA 27 项 AI 验证(Opus 4.8,~3-10 分钟,可关页面)`
  if (wantsJson) {
    return res.json({ ok: true, message: msg, in_flight: true })
  }
  req.session.flash = { type: 'success', message: msg }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// Phase 8.D · GET /:id/report/prisma-validate/status.json
//   轮询用:in_flight + has_validated_count + last_validated_at + 三类计数
// ============================================================
router.get('/:id/report/prisma-validate/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const lockStarted = project.prisma_validate_started_at
  const inFlight = !!(lockStarted && (Date.now() - new Date(lockStarted + ' UTC').getTime() < 15 * 60 * 1000))

  let counts = { total: 0, validated: 0, covered: 0, partial: 0, missing: 0, unrated: 0 }
  let lastValidatedAt = null
  try {
    const row = db.prepare(
      `SELECT
          COUNT(*)                                                          AS total,
          SUM(CASE WHEN ai_validation_status IS NOT NULL THEN 1 ELSE 0 END) AS validated,
          SUM(CASE WHEN ai_validation_status = 'covered' THEN 1 ELSE 0 END) AS covered_n,
          SUM(CASE WHEN ai_validation_status = 'partial' THEN 1 ELSE 0 END) AS partial_n,
          SUM(CASE WHEN ai_validation_status = 'missing' THEN 1 ELSE 0 END) AS missing_n,
          MAX(ai_validated_at)                                              AS last_at
       FROM prisma_checklist WHERE project_id = ?`
    ).get(project.id)
    if (row) {
      counts.total = row.total || 0
      counts.validated = row.validated || 0
      counts.covered = row.covered_n || 0
      counts.partial = row.partial_n || 0
      counts.missing = row.missing_n || 0
      counts.unrated = counts.total - counts.validated
      lastValidatedAt = row.last_at || null
    }
  } catch (e) {
    console.warn('[prisma-validate/status] count query failed:', e?.message)
  }

  const overallScore = counts.total
    ? Math.round((100 * (counts.covered + 0.5 * counts.partial)) / counts.total)
    : 0

  res.json({
    ok: true,
    in_flight: inFlight,
    status: project.prisma_validate_status || null,
    started_at: lockStarted,
    finished_at: project.prisma_validate_finished_at || null,
    error: project.prisma_validate_error || null,
    has_validated_count: counts.validated,
    last_validated_at: lastValidatedAt,
    counts,
    overall_score: overallScore,
    system_version: PRISMA_VALIDATOR_SYSTEM_VERSION,
  })
})

// ============================================================
// Phase 8.E — LaTeX 模板上传 → LLM 填充 → pdflatex 渲染
// ============================================================

// multer wrapper for LaTeX template upload(同 figureUploadOrReject 模式)
function latexTemplateUploadOrReject(req, res, next) {
  if (!latexTemplateUpload) {
    return res.status(503).json({
      ok: false,
      error: 'multer_unavailable',
      message: 'multer 未安装,无法处理上传。请联系管理员 npm install multer。',
    })
  }
  latexTemplateUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.message || String(err)
      if (req.get('X-Requested-With') === 'fetch') {
        return res.status(400).json({ ok: false, error: 'upload_failed', message: msg })
      }
      req.session.flash = { type: 'error', message: 'LaTeX 模板上传失败:' + msg }
      return res.redirect(`/projects/${req.params.id}/report`)
    }
    next()
  })
}

// POST /:id/report/latex/upload — 模板 ZIP
router.post('/:id/report/latex/upload', latexTemplateUploadOrReject, async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  if (!req.file || !req.file.buffer) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'no_file' })
    req.session.flash = { type: 'error', message: '没有收到 .zip 文件' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const projectId = project.id
  const projectTemplateDir = path.join(LATEX_TEMPLATES_DIR, projectId)
  const zipPath = path.join(projectTemplateDir, 'template.zip')
  const extractDir = path.join(projectTemplateDir, 'extracted')

  try {
    // 清理上次的解压目录(避免老文件混入)+ 写入新 zip
    try { await fsp.rm(extractDir, { recursive: true, force: true }) } catch {}
    await ensureLatexDir(projectTemplateDir)
    await fsp.writeFile(zipPath, req.file.buffer)
    // 解压
    await extractZipToDir(req.file.buffer, extractDir)
  } catch (e) {
    console.error('[report/latex/upload] extract failed:', e)
    if (wantsJson) return res.status(400).json({ ok: false, error: 'extract_failed', message: (e?.message || String(e)).slice(0, 200) })
    req.session.flash = { type: 'error', message: 'ZIP 解压失败:' + (e?.message || e).slice(0, 200) }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const texFiles = listTexFilesInSync(extractDir)

  // 自动挑 main.tex:首选根目录的 main.tex;否则第一个 .tex
  let mainTex = project.latex_main_tex_filename || null
  if (!mainTex || !texFiles.includes(mainTex)) {
    if (texFiles.includes('main.tex')) mainTex = 'main.tex'
    else mainTex = texFiles[0] || null
  }

  try {
    db.prepare(
      `UPDATE projects
          SET latex_template_zip_path = ?,
              latex_template_extracted_at = datetime('now', '+8 hours'),
              latex_template_extract_dir = ?,
              latex_main_tex_filename = ?,
              updated_at = datetime('now', '+8 hours')
        WHERE id = ?`
    ).run(zipPath, extractDir, mainTex, projectId)
  } catch (e) {
    console.error('[report/latex/upload] DB update failed:', e)
  }

  audit(db, req, {
    eventType: 'latex_template_uploaded',
    userId: req.user.id, projectId,
    payload: {
      size_bytes: req.file.size,
      tex_files_count: texFiles.length,
      auto_main: mainTex,
      original_filename: req.file.originalname,
    },
  })

  if (wantsJson) {
    return res.json({ ok: true, tex_files: texFiles, main_tex: mainTex, message: `已上传并解压(${texFiles.length} 个 .tex)` })
  }
  req.session.flash = { type: 'success', message: `✓ LaTeX 模板已解压(${texFiles.length} 个 .tex,主文件 = ${mainTex || '?'})` }
  res.redirect(`/projects/${project.id}/report`)
})

// POST /:id/report/latex/main-entry — 指定主 .tex
router.post('/:id/report/latex/main-entry', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const mainTex = String(req.body?.main_tex || '').trim()
  if (!mainTex) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'missing_main_tex' })
    req.session.flash = { type: 'error', message: '未指定 main_tex' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  const extractDir = project.latex_template_extract_dir
  if (!extractDir) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'no_template' })
    req.session.flash = { type: 'error', message: '请先上传模板' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 校验:文件必须存在且不能逃逸
  const safeRoot = path.resolve(extractDir)
  const candidate = path.resolve(extractDir, mainTex)
  if (candidate !== safeRoot && !candidate.startsWith(safeRoot + path.sep)) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'unsafe_path' })
    req.session.flash = { type: 'error', message: '路径不安全' }
    return res.redirect(`/projects/${project.id}/report`)
  }
  if (!fs.existsSync(candidate)) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'not_found', message: `${mainTex} 不在解压目录中` })
    req.session.flash = { type: 'error', message: `${mainTex} 不存在` }
    return res.redirect(`/projects/${project.id}/report`)
  }

  try {
    db.prepare(`UPDATE projects SET latex_main_tex_filename = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`)
      .run(mainTex, project.id)
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: 'db_update_failed', message: e.message })
    req.session.flash = { type: 'error', message: '保存失败:' + e.message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  audit(db, req, {
    eventType: 'latex_main_entry_set', userId: req.user.id, projectId: project.id,
    payload: { main_tex: mainTex },
  })

  if (wantsJson) return res.json({ ok: true, main_tex: mainTex })
  req.session.flash = { type: 'success', message: `✓ 已指定主文件:${mainTex}` }
  res.redirect(`/projects/${project.id}/report`)
})

// POST /:id/report/latex/authors-form — 作者 / 单位 / 致谢
router.post('/:id/report/latex/authors-form', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'

  // 接受两种格式:① JSON body { authors:[...], affiliations:[...] }
  //                ② form-encoded:authors_json / affiliations_json 字符串
  let authors = []
  let affiliations = []
  try {
    if (req.body?.authors && Array.isArray(req.body.authors)) {
      authors = req.body.authors
    } else if (req.body?.authors_json) {
      const a = JSON.parse(req.body.authors_json)
      if (Array.isArray(a)) authors = a
    }
    if (req.body?.affiliations && Array.isArray(req.body.affiliations)) {
      affiliations = req.body.affiliations
    } else if (req.body?.affiliations_json) {
      const a = JSON.parse(req.body.affiliations_json)
      if (Array.isArray(a)) affiliations = a
    }
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: 'invalid_json', message: e.message })
    req.session.flash = { type: 'error', message: 'authors / affiliations JSON 无法解析:' + e.message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // 简化字段(防注入 + 字符上限)
  const cleanAuthors = authors.slice(0, 50).map((a) => ({
    first: String(a?.first || '').slice(0, 200),
    last: String(a?.last || '').slice(0, 200),
    email: String(a?.email || '').slice(0, 200),
    orcid: String(a?.orcid || '').slice(0, 100),
    affiliation_id: String(a?.affiliation_id || '').slice(0, 50),
  }))
  const cleanAffs = affiliations.slice(0, 50).map((a) => ({
    id: String(a?.id || '').slice(0, 50),
    name: String(a?.name || '').slice(0, 500),
    department: String(a?.department || '').slice(0, 300),
    address: String(a?.address || '').slice(0, 500),
  }))
  const correspondenceEmail = String(req.body?.correspondence_email || '').slice(0, 200)
  const fundingText = String(req.body?.funding_text || '').slice(0, 2000)
  const acknowledgementsText = String(req.body?.acknowledgements_text || '').slice(0, 2000)

  try {
    db.prepare(
      `UPDATE projects
          SET authors_json = ?,
              affiliations_json = ?,
              correspondence_email = ?,
              funding_text = ?,
              acknowledgements_text = ?,
              updated_at = datetime('now', '+8 hours')
        WHERE id = ?`
    ).run(
      JSON.stringify(cleanAuthors),
      JSON.stringify(cleanAffs),
      correspondenceEmail,
      fundingText,
      acknowledgementsText,
      project.id,
    )
  } catch (e) {
    if (wantsJson) return res.status(500).json({ ok: false, error: 'db_update_failed', message: e.message })
    req.session.flash = { type: 'error', message: '保存失败:' + e.message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  audit(db, req, {
    eventType: 'latex_authors_form_saved', userId: req.user.id, projectId: project.id,
    payload: { authors_n: cleanAuthors.length, affiliations_n: cleanAffs.length },
  })

  if (wantsJson) return res.json({ ok: true, authors: cleanAuthors, affiliations: cleanAffs })
  req.session.flash = { type: 'success', message: `✓ 已保存 ${cleanAuthors.length} 位作者 / ${cleanAffs.length} 个单位` }
  res.redirect(`/projects/${project.id}/report`)
})

// ============================================================
// 2026-05-26: POST /:id/report/latex/overlay-extract
// ------------------------------------------------------------
// Phase 1 of LaTeX rendering: Sonnet 看上传的 main.tex 模板源码 → 抽 JSON
// overlay(模板族 / section 命令 / author 宏 / 图表 caption 位置 / bib /
// quirks / format_fixes_to_apply 等)。
// 落 projects.latex_overlay_json + 元数据。下次 /latex/render 自动消费 overlay,
// system prompt v4 已被指令"严格按 overlay 执行"。
// 异步执行,1-3 min(Sonnet 比 Opus 快)。
// ============================================================
router.post('/:id/report/latex/overlay-extract', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

  // 2026-05-26 必须有上传的模板 — 改读 DB 字段而非硬编码路径:
  //   upload 路由解压到 <LATEX_TEMPLATES_DIR>/<projectId>/extracted/,主文件
  //   名落 project.latex_main_tex_filename。旧 stagedPath 硬编码查
  //   <root>/latex-templates/<projectId>/(无 extracted 子目录,且没用 DB 里的主文件名)
  //   → 即使用户传了 .zip 也找不到 → "请先上传" 误报。
  //   现在:① 优先用 DB 里的 latex_template_extract_dir + latex_main_tex_filename
  //         ② DB 缺时 fallback 到老式扫描(兼容老项目)
  let stagedPath = null
  try {
    const extractDir = project.latex_template_extract_dir
    const mainTex = project.latex_main_tex_filename
    if (extractDir && fs.existsSync(extractDir)) {
      // 优先用 DB 里的主文件名
      if (mainTex) {
        const p = path.resolve(extractDir, mainTex)
        if (fs.existsSync(p)) stagedPath = p
      }
      // DB 没主文件名 → 扫描 extractDir 找一个 .tex(递归 1 层)
      if (!stagedPath) {
        const entries = fs.readdirSync(extractDir)
        let pick = entries.find((f) => f === 'main.tex')
                || entries.find((f) => f.endsWith('.tex'))
        if (pick) {
          stagedPath = path.join(extractDir, pick)
        } else {
          // 再深一层(zip 经常含一个顶层 dir)
          for (const e of entries) {
            const sub = path.join(extractDir, e)
            try {
              if (fs.statSync(sub).isDirectory()) {
                const subEntries = fs.readdirSync(sub).filter((f) => f.endsWith('.tex'))
                if (subEntries.length) {
                  const pick2 = subEntries.includes('main.tex') ? 'main.tex' : subEntries[0]
                  stagedPath = path.join(sub, pick2)
                  break
                }
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    console.warn('[report/latex/overlay-extract] staged tex lookup failed:', e?.message)
  }
  if (!stagedPath) {
    req.session.flash = { type: 'error', message: '请先上传 LaTeX 模板 .zip(任意 .tex 文件即可 — 如 main.tex / frontiers.tex / elsarticle-template.tex 等;Sonnet 会自动识别主文件),再抽 overlay' }
    return res.redirect(`/projects/${project.id}/report#nav-validation`)
  }

  // atomic lock — 15 min 兜底
  const claim = db.prepare(
    `UPDATE projects
        SET latex_overlay_extract_started_at = datetime('now', '+8 hours'),
            latex_overlay_extract_status = 'running',
            latex_overlay_extract_error = NULL
      WHERE id = ?
        AND (latex_overlay_extract_started_at IS NULL
             OR latex_overlay_extract_started_at < datetime('now','-15 minutes'))`
  ).run(project.id)
  if (claim.changes === 0) {
    req.session.flash = { type: 'error', message: '上次 LaTeX overlay 抽取还在跑(<15 min),请等完成或刷新查看' }
    return res.redirect(`/projects/${project.id}/report#nav-validation`)
  }

  try {
    audit(db, req, {
      eventType: 'latex_overlay_extract_started',
      userId: req.user.id,
      projectId: project.id,
      payload: { template_path: path.basename(stagedPath) },
    })
  } catch {}

  // 异步跑 Sonnet
  const projectId = project.id
  const userId = req.user.id
  setImmediate(async () => {
    const finishFailed = (errMsg) => {
      try {
        db.prepare(
          `UPDATE projects
              SET latex_overlay_extract_started_at = NULL,
                  latex_overlay_extract_status = 'failed',
                  latex_overlay_extract_error = ?
            WHERE id = ?`
        ).run(String(errMsg).slice(0, 1000), projectId)
      } catch {}
      try {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType: 'latex_overlay_extract_failed',
          userId, projectId,
          payload: { error: String(errMsg).slice(0, 300) },
        })
      } catch {}
    }

    let templateTex
    try {
      templateTex = await import('node:fs/promises').then(m => m.readFile(stagedPath, 'utf-8'))
    } catch (e) {
      return finishFailed('template_read_failed: ' + (e?.message || String(e)))
    }
    if (!templateTex || templateTex.trim().length < 100) {
      return finishFailed('template too short / empty')
    }

    // 哈希(stale 检测用 — 模板换了 → overlay stale)
    const tmplHash = (await import('node:crypto')).createHash('sha256').update(templateTex).digest('hex').slice(0, 16)

    const userPrompt = buildLatexOverlayUserPrompt({
      templateTex,
      project,
      filename: path.basename(stagedPath),
    })

    let result
    try {
      result = await runLlm(db, {
        userId, actionType: 'latex_overlay_extract', projectId,
        system: LATEX_OVERLAY_SYSTEM,
        prompt: userPrompt,
        expectJson: true,
        model: 'light',           // Sonnet — 结构性抽取,不需要 Opus
        maxTokens: 4096,
        timeoutMs: 180_000,       // 3 min
      })
    } catch (e) {
      return finishFailed('runLlm threw: ' + (e?.message || String(e)))
    }

    if (!result.ok) {
      return finishFailed(`llm_error: ${result.status || 'unknown'} · ${(result.error || '').slice(0, 200)}`)
    }

    const parsed = parseLatexOverlayOutput(result.data)
    if (!parsed.ok) {
      return finishFailed('parse_failed: ' + parsed.error)
    }

    // 写回 DB
    try {
      db.prepare(
        `UPDATE projects
            SET latex_overlay_json = ?,
                latex_overlay_extracted_at = datetime('now', '+8 hours'),
                latex_overlay_at_template_hash = ?,
                latex_overlay_at_system_version = ?,
                latex_overlay_extract_started_at = NULL,
                latex_overlay_extract_status = 'success',
                latex_overlay_extract_error = NULL
          WHERE id = ?`
      ).run(
        JSON.stringify(parsed.overlay),
        tmplHash,
        LATEX_OVERLAY_SYSTEM_VERSION,
        projectId,
      )
    } catch (e) {
      return finishFailed('db_write_failed: ' + (e?.message || String(e)))
    }

    // 2026-05-26 用户要求:LLM 自动检测 main.tex(用户不用手选)。
    //   仅在用户还没选 main.tex 时填(选了的话尊重用户选择)+ 文件存在
    try {
      const detectedMain = parsed.overlay.detected_main_tex_filename
      if (detectedMain && !project.latex_main_tex_filename) {
        const root = path.resolve(process.env.DATA_DIR || '/var/lib/slr')
        const tplDir = path.join(root, 'latex-templates', projectId)
        const candidate = path.join(tplDir, detectedMain)
        if (fs.existsSync(candidate)) {
          db.prepare(`UPDATE projects SET latex_main_tex_filename = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`)
            .run(detectedMain, projectId)
          try {
            audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
              eventType: 'latex_main_tex_auto_detected',
              userId, projectId,
              payload: { detected: detectedMain, source: 'overlay_extract' },
            })
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[latex/overlay-extract] auto-pick main.tex failed:', e?.message)
    }

    try {
      audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
        eventType: 'latex_overlay_extract_success',
        userId, projectId,
        payload: {
          template_family: parsed.overlay.template_family,
          fixes_count: parsed.overlay.format_fixes_to_apply.length,
          quirks_count: parsed.overlay.template_quirks.length,
          system_version: LATEX_OVERLAY_SYSTEM_VERSION,
          template_hash: tmplHash,
        },
      })
    } catch {}
  })

  req.session.flash = {
    type: 'success',
    message: '✓ 已启动 LaTeX overlay 抽取(Sonnet, 1-3 min)。完成后下次渲染 PDF 会按模板专用规则填 + 修格式',
  }
  res.redirect(`/projects/${project.id}/report#nav-validation`)
})

// POST /:id/report/latex/render — 异步:LLM 填模板 → pdflatex
router.post('/:id/report/latex/render', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const flashOrJson = (kind, message, extra) => {
    if (wantsJson) {
      return res.status(kind === 'error' ? 400 : 200)
        .json({ ok: kind !== 'error', message, ...(extra || {}) })
    }
    req.session.flash = { type: kind, message }
    return res.redirect(`/projects/${project.id}/report`)
  }

  if (!project.latex_template_extract_dir) {
    return flashOrJson('error', '请先上传 LaTeX 模板(支持任意 .tex 文件名,如 main.tex / frontiers.tex / elsarticle-template.tex 等)')
  }
  const mainTex = project.latex_main_tex_filename
  if (!mainTex) {
    return flashOrJson('error', '请先指定主 .tex 文件')
  }
  const mainTexAbs = path.resolve(project.latex_template_extract_dir, mainTex)
  if (!fs.existsSync(mainTexAbs)) {
    return flashOrJson('error', `主文件 ${mainTex} 不存在`)
  }

  // 看是否已有 running 的 render(30 min 内)
  try {
    const recent = db.prepare(
      `SELECT id, status, started_at FROM latex_renders
        WHERE project_id = ? AND status = 'running'
          AND started_at > datetime('now','-30 minutes')
        ORDER BY started_at DESC LIMIT 1`
    ).get(project.id)
    if (recent) {
      return flashOrJson('error', '已有正在进行的渲染任务(30 min 内),请等待或刷新查看进度', { error_code: 'in_flight', render_id: recent.id })
    }
  } catch {}

  // 创建 render row + workdir
  const renderId = randomId('lr')
  const workDir = path.join(LATEX_RENDERS_DIR, project.id, renderId)
  try {
    db.prepare(
      `INSERT INTO latex_renders (id, project_id, status, started_at)
       VALUES (?, ?, 'running', datetime('now', '+8 hours'))`
    ).run(renderId, project.id)
  } catch (e) {
    return flashOrJson('error', '无法创建 render 记录:' + e.message)
  }

  audit(db, req, {
    eventType: 'latex_render_started',
    userId: req.user.id, projectId: project.id,
    payload: { render_id: renderId, main_tex: mainTex },
  })

  // 闭包捕获 — req 在 setImmediate 后不可用
  const projectId = project.id
  const userId = req.user.id

  setImmediate(async () => {
    const finishRender = (status, error, fields = {}) => {
      try {
        db.prepare(
          `UPDATE latex_renders
              SET status = ?,
                  finished_at = datetime('now', '+8 hours'),
                  error = ?,
                  pdf_path = COALESCE(?, pdf_path),
                  log_path = COALESCE(?, log_path),
                  tex_path = COALESCE(?, tex_path),
                  llm_usage_log_id = COALESCE(?, llm_usage_log_id)
            WHERE id = ?`
        ).run(
          status,
          error ? String(error).slice(0, 4000) : null,
          fields.pdf_path || null,
          fields.log_path || null,
          fields.tex_path || null,
          fields.llm_usage_log_id || null,
          renderId,
        )
      } catch (e) {
        console.error('[latex/render BG] finish update failed:', e)
      }
    }
    const auditBg = (eventType, payload) => {
      try {
        audit(db, { user: { id: userId }, ip: '', get: () => '' }, {
          eventType, userId, projectId, payload,
        })
      } catch {}
    }

    try {
      await ensureLatexDir(workDir)

      // ── 1. Load template tex ──
      let templateTex
      try {
        templateTex = await fsp.readFile(mainTexAbs, 'utf8')
      } catch (e) {
        finishRender('failed', 'template_read_failed: ' + (e?.message || String(e)))
        auditBg('latex_render_failed', { render_id: renderId, reason: 'template_read_failed' })
        return
      }

      // ── 2. Gather context ──
      const protocol = getApprovedProtocol(db, projectId)
      const sectionsMap = listLatestSections(db, projectId)
      const draftSections = Object.values(sectionsMap)
        .filter((s) => s && typeof s.content_markdown === 'string' && s.content_markdown.trim())
        .map((s) => ({ section_name: s.section_name, content_markdown: s.content_markdown }))

      // Authors + affiliations
      let authors = [], affiliations = []
      try { if (project.authors_json) authors = JSON.parse(project.authors_json) || [] } catch {}
      try { if (project.affiliations_json) affiliations = JSON.parse(project.affiliations_json) || [] } catch {}

      // Figures(已上传到 figure_assets 的图)
      const figureAssetsLocal = listFigureAssets(db, projectId)
      const figuresMeta = figureAssetsLocal.map((fa) => ({
        fig_key: fa.figure_key || fa.id,
        filename: fa.original_filename || (fa.id + path.extname(fa.file_path || '')),
        caption: fa.caption || '',
        intended_section: fa.intended_section || '',
        source_path: fa.file_path,
      }))

      // N7 — 系统 figure [fig:prisma] 注入 ground truth(LLM 看到草稿 [fig:prisma] 占位时
      //   能 \ref{fig:prisma} + \begin{figure}\label{fig:prisma}... 嵌入)。
      //   filename:用 'prisma.pdf' 占位文件名(用户需在 LaTeX 模板的 figures/ 目录提供
      //   实际 PDF;若没有,latex-fill v3 会降级为 \textit{[unresolved figure: prisma]}
      //   + warnings,LaTeX 仍可编译,只是 figure 区显示 placeholder 文本)。
      //   caption:用一句固定描述,LLM 不会改(它把它转 \caption{...} 即可)。
      figuresMeta.push({
        fig_key: 'prisma',
        filename: 'prisma.pdf',
        caption: 'PRISMA 2020 flow diagram showing study identification, screening, eligibility, and inclusion.',
        intended_section: 'methods',
        source_path: null,                                    // 表示无源文件;由模板/用户提供
      })

      // Citable records(BibTeX 用)
      let citableRecords = []
      try {
        if (draftingHelpers?.buildCitableRecords) {
          citableRecords = draftingHelpers.buildCitableRecords(db, projectId) || []
        } else {
          // Fallback:直接查 include records
          citableRecords = listIncludedRecords(db, projectId).map((r) => ({
            id: r.id, title: r.title, year: r.year,
            authors_text: r.authors_text, authors_json: r.authors_json,
            doi: r.doi, journal: r.journal,
          }))
        }
      } catch (e) {
        console.warn('[latex/render] buildCitableRecords failed:', e?.message)
      }

      // ── 3. Build LLM user prompt ──
      //   优化打磨包 / Prompt audit fix:把 drafting overlay 透传给 LaTeX 填充器
      //   让 voice / banned terms / canonical naming 在最终 .tex 里保持一致
      let latexOverlay = ''
      try {
        if (draftingHelpers?.loadDraftingOverlay) {
          const ov = draftingHelpers.loadDraftingOverlay(project)
          if (ov && typeof ov.overlay_text === 'string') latexOverlay = ov.overlay_text
        } else if (project.drafting_master_prompt_overlay) {
          // fallback:旧 schema 可能是裸字符串
          try {
            const parsed = JSON.parse(project.drafting_master_prompt_overlay)
            latexOverlay = parsed?.overlay_text || ''
          } catch {
            latexOverlay = String(project.drafting_master_prompt_overlay)
          }
        }
      } catch (e) {
        console.warn('[latex/render] load drafting overlay failed:', e?.message)
      }

      // Phase D:Available tables(让 LaTeX LLM 把 [tbl:<key>] 转 \ref{tab:<key>}
      // 并在文末嵌完整 table 环境)。预渲染 markdown 喂给 LLM 转 \begin{tabular}。
      let tablesForLatex = null
      try {
        const allTables = buildAllRegisteredTables(db, projectId) || {}
        const defs = getAllTableDefs() || []
        tablesForLatex = []
        for (const def of defs) {
          if (!def?.key) continue
          const data = allTables[def.key]
          if (!data) continue
          // 跳过空表(防止 LLM 引用一个空 tabular)
          let rowsN = 0
          if (Array.isArray(data.subtables)) {
            for (const s of data.subtables) rowsN += Array.isArray(s?.rows) ? s.rows.length : 0
          } else if (Array.isArray(data.rows)) {
            rowsN = data.rows.length
          }
          if (rowsN === 0) continue
          let md = ''
          try { md = renderTableExport(allTables, def.key, 'md') || '' } catch {}
          tablesForLatex.push({
            key: def.key,
            label: def.label || def.key,
            description: def.description || '',
            intended_section: def.intended_section || '',
            markdown: md,
          })
        }
        if (tablesForLatex.length === 0) tablesForLatex = null
      } catch (e) {
        console.warn('[latex/render] build tables manifest for latex prompt failed:', e?.message)
        tablesForLatex = null
      }

      // 2026-05-26 v4:加载 LaTeX overlay(Phase 1 Sonnet 抽出来的项目专用 LaTeX
      //   填充指引);有就喂给 fill builder,无就走通用 system prompt(向后兼容)
      let latexTemplateOverlayObj = null
      try {
        if (project.latex_overlay_json) {
          latexTemplateOverlayObj = JSON.parse(project.latex_overlay_json)
        }
      } catch (e) { console.warn('[latex/render] parse latex_overlay_json failed:', e?.message) }

      // ────────────────────────────────────────────────────────────────────
      // 2026-05-26 v6:FILE-OPS fill pipeline(默认路径,替代 v4 one-shot + v5 per-section)
      //   - Claude CLI 在 sandbox workdir/fill/ 里用 Read/Write/Edit/Glob 工具操作
      //   - 论文已锁(sections/*.md 是最终成稿),任务本质是文件转换:
      //       sections/*.md + template/<main>.tex → out/main.tex
      //   - Claude 可以分多次小 Edit 写 out/main.tex,避开 v4/v5 "单次 stream 50K LaTeX"
      //     引发的 timeout / Anthropic Overloaded
      //   - 失败 mode:Claude 没写 out/main.tex 或 < 1000 chars 即视为失败,整体 render fail
      //     (符合"出问题明确报"约定,不自动 fall back)
      //   - 旧 v5 per-section / v4 one-shot 代码保留(已 import LATEX_FILL_SECTION_SYSTEM
      //     等,可手动切回),但默认 routes 走这条
      // ────────────────────────────────────────────────────────────────────
      const SECTION_FILL_ORDER = [
        'title', 'abstract', 'introduction', 'methods', 'results',
        'discussion', 'limitations', 'conclusion', 'declarations',
      ]
      // 2026-05-26 v6.1 — section_name 归一(同 services/prompts/drafting.js 的别名约定)。
      //   draft_sections 里可能存在 method(单数) / literature_review / funding /
      //   author_contributions / conflict_of_interest / publishers_note /
      //   supplementary_material 等"非标准名",需要先归一到 SECTION_FILL_ORDER 的 9 个标准桶。
      //   多个 source rows 落同一桶 → concat,带 "## <source name>" 标题分割,
      //   让 Claude 知道这是同一桶的多个 sub-block。
      const SECTION_ALIAS_MAP = {
        // methods 桶
        'method':                     'methods',
        'methods':                    'methods',
        'methodology':                'methods',
        'methodologies':              'methods',
        'materials and methods':      'methods',
        // introduction 桶(literature_review / background 都归这里)
        'introduction':               'introduction',
        'background':                 'introduction',
        'literature review':          'introduction',
        'literature_review':          'introduction',
        'related work':               'introduction',
        'related_work':               'introduction',
        // results 桶
        'results':                    'results',
        'result':                     'results',
        'findings':                   'results',
        // discussion 桶
        'discussion':                 'discussion',
        'discussions':                'discussion',
        // limitations 桶(独立段或被 discussion 子节吸收 — Claude 看 INSTRUCTIONS 决定)
        'limitations':                'limitations',
        'limitation':                 'limitations',
        // conclusion 桶
        'conclusion':                 'conclusion',
        'conclusions':                'conclusion',
        // declarations 桶(PRISMA 24-27 一堆子段并到这里)
        'declarations':               'declarations',
        'declaration':                'declarations',
        'funding':                    'declarations',
        'funding and acknowledgements':'declarations',
        'acknowledgements':           'declarations',
        'acknowledgments':            'declarations',
        'author_contributions':       'declarations',
        'author contributions':       'declarations',
        'conflict_of_interest':       'declarations',
        'conflict of interest':       'declarations',
        'conflicts of interest':      'declarations',
        'competing interests':        'declarations',
        'disclosures':                'declarations',
        'data availability':          'declarations',
        'data_availability':          'declarations',
        'publishers_note':            'declarations',
        'publisher\'s note':          'declarations',
        'publishers note':            'declarations',
        'supplementary_material':     'declarations',
        'supplementary material':     'declarations',
        'supplementary materials':    'declarations',
        // 直传
        'title':                      'title',
        'abstract':                   'abstract',
      }
      function normalizeSectionKey(s) {
        return String(s || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ')
      }
      function resolveBucket(rawName) {
        if (!rawName) return null
        // 1) raw 直接命中
        if (SECTION_ALIAS_MAP[rawName]) return SECTION_ALIAS_MAP[rawName]
        // 2) lowercase 命中
        const lc = String(rawName).toLowerCase()
        if (SECTION_ALIAS_MAP[lc]) return SECTION_ALIAS_MAP[lc]
        // 3) 归一后命中(空格 / 连字符 / 下划线全转空格)
        const norm = normalizeSectionKey(rawName)
        if (SECTION_ALIAS_MAP[norm]) return SECTION_ALIAS_MAP[norm]
        // 4) 兜底:如果是 SECTION_FILL_ORDER 里的标准名,直传
        if (SECTION_FILL_ORDER.includes(norm)) return norm
        return null   // 完全识别不出 → 丢弃(避免污染)
      }

      // 把 draftSections array 按 bucket 聚合
      const draftSectionsByBucket = {}   // { bucket: [{source_name, content}, ...] }
      for (const ds of draftSections) {
        if (!ds || !ds.section_name) continue
        const content = String(ds.content_markdown || '').trim()
        if (!content) continue
        const bucket = resolveBucket(ds.section_name)
        if (!bucket) {
          console.log(`[latex/render BG] drop unrecognized section: ${ds.section_name}`)
          continue
        }
        if (!draftSectionsByBucket[bucket]) draftSectionsByBucket[bucket] = []
        draftSectionsByBucket[bucket].push({ source_name: ds.section_name, content })
      }

      // ── A. Stage workdir/fill 沙盒 ──
      //   layout:fill/template/  fill/sections/  fill/figures/  fill/out/
      //          fill/references.bib  fill/overlay.json  fill/citation-map.json
      //          fill/INSTRUCTIONS.md
      const fillDir = path.join(workDir, 'fill')
      const fillTemplateDir = path.join(fillDir, 'template')
      const fillSectionsDir = path.join(fillDir, 'sections')
      const fillFiguresDir  = path.join(fillDir, 'figures')
      const fillOutDir      = path.join(fillDir, 'out')
      try {
        await ensureLatexDir(fillTemplateDir)
        await ensureLatexDir(fillSectionsDir)
        await ensureLatexDir(fillFiguresDir)
        await ensureLatexDir(fillOutDir)
      } catch (e) {
        finishRender('failed', 'mkdir fill sandbox failed: ' + (e?.message || String(e)))
        return
      }

      // A1. copy template tree 到 fill/template/
      //    (Claude 只读;preamble + .cls/.sty/.bst/logo 等都给它看)
      async function copyTreeRec(src, dst) {
        try { await ensureLatexDir(dst) } catch {}
        let entries = []
        try { entries = await fsp.readdir(src, { withFileTypes: true }) } catch { return }
        for (const ent of entries) {
          const sp = path.join(src, ent.name)
          const dp = path.join(dst, ent.name)
          if (ent.isDirectory()) {
            await copyTreeRec(sp, dp)
          } else if (ent.isFile()) {
            try { await fsp.copyFile(sp, dp) } catch (e) {
              console.warn('[latex/render BG] copy template asset failed:', sp, '→', dp, e?.message)
            }
          }
        }
      }
      try {
        await copyTreeRec(project.latex_template_extract_dir, fillTemplateDir)
      } catch (e) {
        finishRender('failed', 'copy template tree failed: ' + (e?.message || String(e)))
        return
      }

      // A2. write sections/<bucket>.md(每桶一个文件,多源 concat with sub-header)
      const stagedSectionFilenames = []   // 给 INSTRUCTIONS.md 的 sectionFilenames
      const stagedBuckets = []            // 给 INSTRUCTIONS.md 的处理顺序(保留 SECTION_FILL_ORDER 顺序)
      for (const bucket of SECTION_FILL_ORDER) {
        const entries = draftSectionsByBucket[bucket]
        if (!entries || entries.length === 0) {
          console.log(`[latex/render BG] skip empty bucket: ${bucket}`)
          continue
        }
        // 单源 → 直接 dump;多源 → concat,带 "## <pretty source name>" 子标题
        let merged
        if (entries.length === 1) {
          merged = entries[0].content
        } else {
          const parts = []
          for (const ent of entries) {
            const prettyName = ent.source_name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            parts.push(`## ${prettyName}\n\n${ent.content}`)
          }
          merged = parts.join('\n\n')
        }
        try {
          await fsp.writeFile(path.join(fillSectionsDir, `${bucket}.md`), merged, 'utf8')
          stagedSectionFilenames.push(`${bucket}.md`)
          stagedBuckets.push(bucket)
          const sourceList = entries.map(e => e.source_name).join('+')
          console.log(`[latex/render BG] staged sections/${bucket}.md (${merged.length} chars from: ${sourceList})`)
        } catch (e) {
          console.warn(`[latex/render BG] write sections/${bucket}.md failed:`, e?.message)
        }
      }
      if (stagedSectionFilenames.length === 0) {
        finishRender('failed', '没有可填入的章节(所有 draft_sections 内容都为空 / 归一后无可识别桶)')
        return
      }

      // A2.5. stage tables/<key>.md — 让 Claude 看到真实表格数据,不再编造 2 行占位
      //   tablesForLatex 是上游 review-tables 准备好的 [{key, label, description, intended_section, markdown}]
      //   每张表写一个 .md 文件;INSTRUCTIONS.md 教 Claude 遇到 [tbl:key] 时 Read tables/<key>.md
      //   并把内容转 \begin{tabular} 落进 main.tex
      const fillTablesDir = path.join(fillDir, 'tables')
      const tableManifest = []   // 给 INSTRUCTIONS.md 列出有哪些表
      if (Array.isArray(tablesForLatex) && tablesForLatex.length > 0) {
        try { await ensureLatexDir(fillTablesDir) } catch {}
        for (const t of tablesForLatex) {
          if (!t || !t.key) continue
          const md = String(t.markdown || '').trim()
          if (!md) continue
          // 在表文件头部加一行 metadata,Claude Read 时立刻知道这是哪张表
          const header = `<!-- table key: ${t.key} | label: ${t.label || t.key} | intended_section: ${t.intended_section || ''} -->\n# ${t.label || t.key}\n\n${t.description || ''}\n\n`
          try {
            await fsp.writeFile(path.join(fillTablesDir, `${t.key}.md`), header + md, 'utf8')
            tableManifest.push({
              key: t.key,
              label: t.label || t.key,
              description: t.description || '',
              intended_section: t.intended_section || '',
            })
          } catch (e) {
            console.warn(`[latex/render BG] write tables/${t.key}.md failed:`, e?.message)
          }
        }
        console.log(`[latex/render BG] staged ${tableManifest.length} tables/*.md`)
      }

      // A3. copy figures(figureAssets 已上传的图;[fig:prisma] 占位无源文件,跳过)
      for (const f of figuresMeta) {
        if (!f.source_path) continue
        try {
          const safeFigName = String(f.filename || '').replace(/[^\w.\-]/g, '_') || `${f.fig_key}.bin`
          await fsp.copyFile(f.source_path, path.join(fillFiguresDir, safeFigName))
        } catch (e) {
          console.warn(`[latex/render BG] copy figure ${f.fig_key} failed:`, e?.message)
        }
      }

      // A4. overlay.json + citation-map.json + references.bib
      const hasOverlay = !!(latexTemplateOverlayObj && Object.keys(latexTemplateOverlayObj).length > 0)
      try {
        if (hasOverlay) {
          await fsp.writeFile(
            path.join(fillDir, 'overlay.json'),
            JSON.stringify(latexTemplateOverlayObj, null, 2),
            'utf8',
          )
        }
      } catch (e) { console.warn('[latex/render BG] write overlay.json failed:', e?.message) }

      // citation-map.json:rec_id → "Author, Year"(LLM 写 \citet{} 时不用瞎猜)
      const citationMap = {}
      for (const r of citableRecords) {
        if (!r || !r.id) continue
        let authorLast = ''
        try {
          if (r.authors_json) {
            const arr = JSON.parse(r.authors_json)
            if (Array.isArray(arr) && arr.length > 0) {
              const first = arr[0]
              if (typeof first === 'string') authorLast = first.split(',')[0].trim()
              else if (first && typeof first === 'object') authorLast = String(first.family || first.last || first.name || '').split(',')[0].trim()
            }
          }
          if (!authorLast && r.authors_text) authorLast = String(r.authors_text).split(/[,;&]/)[0].trim()
        } catch {}
        const yr = r.year ? String(r.year) : 'n.d.'
        citationMap[r.id] = `${authorLast || 'Anonymous'}, ${yr}`
      }
      const hasCitationMap = Object.keys(citationMap).length > 0
      try {
        if (hasCitationMap) {
          await fsp.writeFile(
            path.join(fillDir, 'citation-map.json'),
            JSON.stringify(citationMap, null, 2),
            'utf8',
          )
        }
      } catch (e) { console.warn('[latex/render BG] write citation-map.json failed:', e?.message) }

      // references.bib(BibTeX 给 Claude 读 + 后续 latexmk 也要用一份在 workDir,
      // 那份在 ── 5 ── 阶段写,这里在 fill/ 里也放一份让 Claude 可 \bibliography{references} 引用)
      let referencesBibText = ''
      try {
        referencesBibText = generateBibtex(citableRecords) || ''
        if (referencesBibText) {
          await fsp.writeFile(path.join(fillDir, 'references.bib'), referencesBibText, 'utf8')
        }
      } catch (e) { console.warn('[latex/render BG] write fill/references.bib failed:', e?.message) }

      // A5. INSTRUCTIONS.md(教 Claude 怎么干)
      //   bib_style 优先级:overlay top-level bib_style_hint.style_name(Phase 1 Sonnet 实测可靠)
      //   → deep bibliography_handling 路径 → plainnat fallback
      const bibStyleHint =
            (latexTemplateOverlayObj?.bib_style_hint?.style_name)
         || (typeof latexTemplateOverlayObj?.bibliography_handling?.csl_or_natbib_options === 'object'
              ? latexTemplateOverlayObj.bibliography_handling.csl_or_natbib_options.bib_style
              : null)
         || 'plainnat'
      const citationStyleHint = project.citation_style || 'apa'
      const instructionsMd = buildLatexFillopsInstructions({
        templateMainTexFilename: mainTex,
        sectionFilenames: stagedSectionFilenames,
        sectionBuckets: stagedBuckets,             // 只列实际有内容的桶,按 SECTION_FILL_ORDER 顺序
        tableManifest,                              // [{key,label,description,intended_section}]
        figureManifest: figuresMeta.filter(f => f.source_path || f.fig_key === 'prisma').map(f => ({
          fig_key: f.fig_key, filename: f.filename, caption: f.caption, intended_section: f.intended_section,
        })),
        citationStyle: citationStyleHint,
        bibStyle: bibStyleHint,
        hasOverlay,
        hasCitationMap,
        figuresCount: figuresMeta.filter(f => f.source_path).length,
        citablePapersCount: citableRecords.length,
      })
      try {
        await fsp.writeFile(path.join(fillDir, 'INSTRUCTIONS.md'), instructionsMd, 'utf8')
      } catch (e) {
        finishRender('failed', 'write INSTRUCTIONS.md failed: ' + (e?.message || String(e)))
        return
      }

      // ── B. Run Claude CLI(file-ops 模式)──
      //   45 min 上限:Claude 自纠/重读/分块 Edit 都算时间,给充分预算
      //   actionType=latex_fill_fileops → step-presets.js 路由到 claude-opus-4-8 + reasoning off
      //   fallbackModel=claude-sonnet-4-6:Opus overloaded 时 Anthropic 自动降级
      const startedFillMs = Date.now()
      console.log(`[latex/render BG] launching Claude CLI fileops at ${fillDir} (sections=${stagedSectionFilenames.length}, citable=${citableRecords.length}, figures=${figuresMeta.filter(f => f.source_path).length})`)
      let llmRes
      try {
        llmRes = await runFileOpsLlm(db, {
          userId,
          actionType: 'latex_fill_fileops',
          projectId,
          model: 'heavy',                         // step-presets → claude-opus-4-8
          fallbackModel: 'claude-sonnet-4-6',     // Opus overloaded → 自动降级
          cwd: fillDir,
          prompt: 'Read INSTRUCTIONS.md and follow it step-by-step. Use Read, Write, Edit, Glob tools to produce out/main.tex.',
          allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
          timeoutMs: 45 * 60 * 1000,              // 45 min cap
        })
      } catch (e) {
        finishRender('failed', 'runFileOpsLlm threw: ' + (e?.message || String(e)))
        auditBg('latex_render_failed', { render_id: renderId, reason: 'fileops_threw', error: (e?.message || String(e)).slice(0, 200) })
        return
      }

      // 为兼容下游 finishRender / audit 引用 — 用相同变量名
      const lastLlmRes = llmRes
      const sectionUsageLogs = llmRes?.usageLogId
        ? [{ section: 'fileops_run', attempt: 1, log_id: llmRes.usageLogId, duration_ms: llmRes.durationMs }]
        : []

      console.log(`[latex/render BG] Claude CLI fileops finished in ${Date.now() - startedFillMs}ms (ok=${llmRes.ok}, status=${llmRes.status}, exit=${llmRes.exitCode}, timedOut=${llmRes.timedOut})`)
      if (llmRes.stdout) {
        console.log('[latex/render BG] fileops stdout (last 2000):\n' + llmRes.stdout.slice(-2000))
      }
      if (llmRes.stderr) {
        console.warn('[latex/render BG] fileops stderr (last 1000):\n' + llmRes.stderr.slice(-1000))
      }

      // ── C. Validate output ──
      const fillOutMainTex = path.join(fillOutDir, 'main.tex')
      let filledTex = ''
      try {
        filledTex = await fsp.readFile(fillOutMainTex, 'utf8')
      } catch (e) {
        const reason = llmRes.timedOut ? 'timeout (45min cap)'
                     : !llmRes.ok ? `Claude CLI fileops failed (${llmRes.status}, exit=${llmRes.exitCode})`
                     : 'out/main.tex not written'
        const stdoutTail = (llmRes.stdout || '').slice(-2000)
        const stderrTail = (llmRes.stderr || '').slice(-1000)
        finishRender(
          'failed',
          `${reason}\n--- stdout (tail) ---\n${stdoutTail}\n--- stderr (tail) ---\n${stderrTail}`,
          { llm_usage_log_id: llmRes?.usageLogId, section_usage_logs: sectionUsageLogs },
        )
        auditBg('latex_render_failed', {
          render_id: renderId,
          reason: llmRes.timedOut ? 'fileops_timeout' : 'fileops_no_output',
          exit_code: llmRes.exitCode,
          timed_out: !!llmRes.timedOut,
          duration_ms: llmRes.durationMs,
          usage_log_id: llmRes?.usageLogId,
        })
        return
      }
      if (filledTex.length < 1000) {
        finishRender(
          'failed',
          `out/main.tex too small (${filledTex.length} chars) — Claude likely failed mid-way. stdout (tail):\n${(llmRes.stdout || '').slice(-2000)}`,
          { llm_usage_log_id: llmRes?.usageLogId, section_usage_logs: sectionUsageLogs },
        )
        auditBg('latex_render_failed', {
          render_id: renderId, reason: 'fileops_output_too_small',
          out_chars: filledTex.length, usage_log_id: llmRes?.usageLogId,
        })
        return
      }
      if (!/\\end\{document\}/.test(filledTex)) {
        // 缺 \end{document} 一定崩 latexmk → 早 fail
        finishRender(
          'failed',
          `out/main.tex missing \\end{document} (${filledTex.length} chars). Claude may have been cut off. stdout (tail):\n${(llmRes.stdout || '').slice(-2000)}`,
          { llm_usage_log_id: llmRes?.usageLogId, section_usage_logs: sectionUsageLogs },
        )
        auditBg('latex_render_failed', {
          render_id: renderId, reason: 'fileops_output_truncated',
          out_chars: filledTex.length, usage_log_id: llmRes?.usageLogId,
        })
        return
      }
      console.log(`[latex/render BG] ✓ out/main.tex looks good (${filledTex.length} chars)`)

      // 兼容下游代码:伪造 v4 parser 输出形态
      //   warnings / conversion_notes 在 fileops 模式没有结构化输出,从 stdout 提一些信息
      const stdoutWarnings = []
      try {
        // Claude tool-summary 中可能含 "PARTIAL — ..." / 各种 warning;取 stdout 最后 5 行
        const lines = (llmRes.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
        if (lines.length > 0) stdoutWarnings.push(`fileops_tail: ${lines.slice(-3).join(' | ').slice(0, 400)}`)
      } catch {}
      const parsed = {
        ok: true,
        filled_tex: filledTex,
        conversion_notes: [],
        warnings: stdoutWarnings,
      }

      // ── 5. Write main.tex + references.bib + copy figures ──
      const renderMainTex = path.join(workDir, 'main.tex')

      // N6 — sanitize safety net:LLM 漏处理 [tbl:]/[fig:] 时兜底转 \ref{...}
      // 用 services/latex-render.js 的 sanitizeLatexPlaceholders(N4 实现 + dev-comment 测试)。
      // substitutions 数组写 audit,失败也不阻断渲染(只是占位会以裸方括号进 LaTeX,latex 编译会崩)。
      let texToWrite = parsed.filled_tex
      let placeholderLeaks = []
      try {
        const sanitised = sanitizeLatexPlaceholders(parsed.filled_tex)
        texToWrite = sanitised.text
        placeholderLeaks = sanitised.substitutions || []
        if (placeholderLeaks.length > 0) {
          auditBg('latex_render_placeholder_leak', {
            render_id: renderId,
            leaks_n: placeholderLeaks.length,
            samples: placeholderLeaks.slice(0, 10),
          })
        }
      } catch (e) {
        console.warn('[latex/render] sanitizeLatexPlaceholders threw:', e?.message)
        // 失败:用原始 filled_tex,继续写盘
      }

      // 2026-05-27 v6.1 — defensive path rewrite:Claude 在 fillDir/out/main.tex 视角下
      //   倾向写 ../figures/foo.png(相对它的 out/ 子目录),但 main.tex 实际被 relocate 到
      //   workDir/main.tex 顶层,figures/ 是同级目录 — ../figures/ 失效 → pdflatex fatal。
      //   把任意 (../)+(figures|tables|template)/ 前缀打平回 figures/ / tables/ / template/。
      //   也防 absolute /tmp/... / /var/lib/... 之类绝对路径(虽然 Claude 没倾向写绝对,但兜个底)。
      try {
        const beforeLen = texToWrite.length
        let pathRewriteCount = 0
        // (../) 前缀 → 删:支持多层 ../../figures/
        texToWrite = texToWrite.replace(
          /(\\includegraphics(?:\[[^\]]*\])?\{)((?:\.\.\/)+)(figures|tables|template)\//g,
          (_match, head, _dots, dir) => { pathRewriteCount++; return `${head}${dir}/` }
        )
        // 也处理 \input{../...} / \include{../...} 风格(模板内置 includes,Claude 不太可能写,兜底)
        texToWrite = texToWrite.replace(
          /(\\(?:input|include)\{)((?:\.\.\/)+)(figures|tables|template)\//g,
          (_match, head, _dots, dir) => { pathRewriteCount++; return `${head}${dir}/` }
        )
        if (pathRewriteCount > 0) {
          console.warn(`[latex/render BG] defensive path rewrite: stripped ${pathRewriteCount} occurrences of ../figures|tables|template/ prefix`)
          auditBg('latex_render_path_rewrite', {
            render_id: renderId,
            rewrites_n: pathRewriteCount,
            tex_size_before: beforeLen,
            tex_size_after: texToWrite.length,
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] defensive path rewrite threw:', e?.message)
      }

      // 2026-05-27 v6.1 — defensive image-options auto-inject:
      //   Claude 偶尔会漏 keepaspectratio / height cap → 高图(纵向插画 / PRISMA flow)
      //   会从页底溢出,latexmk 不一定 fatal 但 PDF 难看(图被截断)。
      //   策略:扫所有 \includegraphics,如果 options 不含 keepaspectratio,
      //   把它合并进去 + 补 height=0.85\textheight 上限。已有 width=... 的不动。
      //   完全没 options 的(\includegraphics{...})补全套。
      try {
        let imgOptsRewrites = 0
        const SAFE_OPTS = 'width=\\linewidth,height=0.85\\textheight,keepaspectratio'
        // 1) 无 options:\includegraphics{foo} → \includegraphics[SAFE_OPTS]{foo}
        texToWrite = texToWrite.replace(
          /\\includegraphics\{([^}]+)\}/g,
          (_m, fn) => { imgOptsRewrites++; return `\\includegraphics[${SAFE_OPTS}]{${fn}}` }
        )
        // 2) 有 options 但缺 keepaspectratio:补 keepaspectratio 和 height cap(不动已有 width 设置)
        texToWrite = texToWrite.replace(
          /\\includegraphics\[([^\]]*)\]\{([^}]+)\}/g,
          (_m, opts, fn) => {
            const lower = opts.toLowerCase()
            const additions = []
            if (!/keepaspectratio/i.test(lower)) additions.push('keepaspectratio')
            if (!/\bheight\s*=/i.test(lower)) additions.push('height=0.85\\textheight')
            // 不强制加 width — 用户可能用 scale=0.5 等不同 sizing,只在没 width 也没 scale 时补
            if (!/\bwidth\s*=/i.test(lower) && !/\bscale\s*=/i.test(lower)) {
              additions.push('width=\\linewidth')
            }
            if (additions.length === 0) return _m   // 已齐全,不动
            imgOptsRewrites++
            const merged = opts.trim().replace(/,\s*$/, '')   // 去尾逗号
            return `\\includegraphics[${merged}${merged ? ',' : ''}${additions.join(',')}]{${fn}}`
          }
        )
        if (imgOptsRewrites > 0) {
          console.log(`[latex/render BG] defensive image opts injection: ${imgOptsRewrites} \\includegraphics commands patched`)
          auditBg('latex_render_image_opts_injection', {
            render_id: renderId,
            patches_n: imgOptsRewrites,
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] defensive image opts injection threw:', e?.message)
      }

      // 2026-05-27 v6.1 — defensive: strip "Table 1a. / Table 1b. ..." prefix from
      //   longtable in-table sub-section dividers. 数据源 tables/table1.md 用
      //   "### Table 1a / 1b / ..." 给 sub-themes 命名,Claude 容易 verbatim 写进
      //   \multicolumn{N}{l}{\textbf{Table 1a. ...}} 当 divider — 但整个 longtable 已经
      //   有 LaTeX 自动编号(如 Table 4),divider 再写 "Table 1a" → PDF 同时显示两个编号,
      //   读者懵。剥前缀,只保留描述。
      try {
        let dividerStrips = 0
        texToWrite = texToWrite.replace(
          /(\\multicolumn\{\d+\}\{[a-zA-Z|]+\}\{\\textbf\{)Table\s+\d+[a-z]?\.\s+/g,
          (_m, head) => { dividerStrips++; return head }
        )
        // 也兜 \textit / 无 textbf 的形态
        texToWrite = texToWrite.replace(
          /(\\multicolumn\{\d+\}\{[a-zA-Z|]+\}\{\\textit\{)Table\s+\d+[a-z]?\.\s+/g,
          (_m, head) => { dividerStrips++; return head }
        )
        texToWrite = texToWrite.replace(
          /(\\multicolumn\{\d+\}\{[a-zA-Z|]+\}\{)Table\s+\d+[a-z]?\.\s+/g,
          (_m, head) => { dividerStrips++; return head }
        )
        if (dividerStrips > 0) {
          console.log(`[latex/render BG] defensive divider strip: removed ${dividerStrips} "Table Nx." prefixes from in-table multicolumn dividers`)
          auditBg('latex_render_divider_strip', {
            render_id: renderId,
            strips_n: dividerStrips,
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] divider strip threw:', e?.message)
      }

      // 2026-05-27 v6.1 — bare-float audit:
      //   每个 \includegraphics 必须在 \begin{figure}..\end{figure} 里;
      //   每个 \begin{tabular} 必须在 \begin{table}/\begin{table*}/\begin{longtable} 里。
      //   裸 includegraphics / 裸 tabular = 无 caption / 无 label / 无法 \ref{} = 学术规范违规。
      //   策略:line-by-line 扫描 + 栈跟踪当前在哪个 env 内。检出报警 + audit log,不阻断
      //   渲染(模板里可能有合法的特殊用法,不能误杀)。
      try {
        const lines = texToWrite.split('\n')
        const envStack = []   // 栈:当前嵌套的 env 名
        const ENV_OPEN_RE  = /\\begin\{(figure\*?|table\*?|longtable|tabularx|sidewaystable|sidewaysfigure|wrapfigure|wraptable|minipage)\}/g
        const ENV_CLOSE_RE = /\\end\{(figure\*?|table\*?|longtable|tabularx|sidewaystable|sidewaysfigure|wrapfigure|wraptable|minipage)\}/g
        const FIG_FLOATS   = new Set(['figure', 'figure*', 'sidewaysfigure', 'wrapfigure', 'minipage'])
        const TAB_FLOATS   = new Set(['table', 'table*', 'longtable', 'tabularx', 'sidewaystable', 'wraptable', 'minipage'])
        const bareIncludegraphics = []
        const bareTabular = []
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
          const line = lines[lineNo]
          // 先处理 open / close(注意一行内可能 open + close 同时出现 — 顺序扫)
          let m
          ENV_OPEN_RE.lastIndex = 0
          while ((m = ENV_OPEN_RE.exec(line)) !== null) envStack.push(m[1])
          ENV_CLOSE_RE.lastIndex = 0
          while ((m = ENV_CLOSE_RE.exec(line)) !== null) {
            const closing = m[1]
            // 弹出匹配的开,容错乱嵌套
            const idx = envStack.lastIndexOf(closing)
            if (idx >= 0) envStack.splice(idx, 1)
          }
          // 检测裸 includegraphics(在当前 stack 没有 fig 类 float 时报警)
          if (/\\includegraphics\b/.test(line)) {
            const inFig = envStack.some(e => FIG_FLOATS.has(e))
            if (!inFig) bareIncludegraphics.push({ line: lineNo + 1, snippet: line.trim().slice(0, 120) })
          }
          // 检测裸 \begin{tabular}(在当前 stack 没有 table 类 float 时报警)
          //   注意:此时 \begin{tabular} 本身 没被 push 到 envStack(我们不追 tabular,
          //   因为它的 *内层* 不算 float — 但 tabular 必须 *外层* 有 table)
          if (/\\begin\{tabular\}/.test(line)) {
            const inTab = envStack.some(e => TAB_FLOATS.has(e))
            if (!inTab) bareTabular.push({ line: lineNo + 1, snippet: line.trim().slice(0, 120) })
          }
        }
        if (bareIncludegraphics.length > 0 || bareTabular.length > 0) {
          console.warn(`[latex/render BG] bare floats detected: ${bareIncludegraphics.length} includegraphics + ${bareTabular.length} tabular(s) NOT in float env`)
          auditBg('latex_render_bare_float_warning', {
            render_id: renderId,
            bare_includegraphics_n: bareIncludegraphics.length,
            bare_tabular_n: bareTabular.length,
            samples_fig: bareIncludegraphics.slice(0, 5),
            samples_tab: bareTabular.slice(0, 5),
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] bare-float audit threw:', e?.message)
      }

      // 2026-05-27 v6.1.2 — longtable column-width auto-rescale:
      //   \resizebox 不能包 longtable(longtable 跨页,resizebox 是单 box)。Claude 写
      //   longtable 时常给固定 p{Xcm} 列宽,加和 + \tabcolsep × 列数 容易 > \textwidth,
      //   pdflatex 产生 "Overfull \hbox in alignment" → PDF 边距溢出。
      //   实测案例:p{2.3cm}p{2cm}p{2.2cm}p{1.4cm}p{2.4cm}p{1.8cm}p{2.3cm} =
      //     14.4 cm cols + ~2.95 cm tabcolsep = 17.35 cm,超 Frontiers \textwidth 约 3 cm。
      //   策略:解析 longtable colspec,只看 p{X.Ycm} / p{X.Ymm} 列;
      //     - estimate = sum_of_p_widths + 0.42 cm × column_count(tabcolsep budget)
      //     - 保守 textwidth = 15.5 cm(典型 A4 + 2.5cm 边距,留 safety)
      //     - 超过 → scale = 15.5 / estimate,缩所有 p{} 列宽(其他列 l/c/r 不动,它们窄)
      try {
        const SAFE_TEXTWIDTH_CM = 15.5
        const TABCOLSEP_BUDGET_CM = 0.42   // 默认 6pt × 2 ≈ 0.42 cm per column gap
        let longtableRescaleCount = 0
        let longtableTotalScaled = 0
        // ⚠️ colspec 含 p{Xcm} 嵌套 {} — 简单 [^}]+ 会在第一个 } 截断,只捕获 "p{2.3cm"。
        //    用 1-level 嵌套支持:[^{}]*(?:\{[^}]*\}[^{}]*)*
        texToWrite = texToWrite.replace(
          /\\begin\{longtable\}\{([^{}]*(?:\{[^}]*\}[^{}]*)*)\}/g,
          (match, colspec) => {
            // 解析 p{X.Ycm} / p{Xcm} / p{Xmm} 列
            const pCols = []
            const pRe = /p\{(\d+(?:\.\d+)?)(cm|mm)\}/g
            let m
            while ((m = pRe.exec(colspec)) !== null) {
              const val = parseFloat(m[1])
              const cm = m[2] === 'mm' ? val / 10 : val
              pCols.push({ raw: m[0], cm })
            }
            // 数列总数 — 必须 SKIP {Xcm} 单位里的 c/m,否则 over-count
            //    用 state machine:深度跟踪 {},只在 depth=0 时数 l/c/r/X/p/m/b
            let totalCols = 0
            let depth = 0
            for (const ch of colspec) {
              if (ch === '{') depth++
              else if (ch === '}') depth--
              else if (depth === 0) {
                if (ch === 'l' || ch === 'c' || ch === 'r' || ch === 'X' || ch === 'p' || ch === 'm' || ch === 'b') totalCols++
              }
            }
            const sumP = pCols.reduce((s, c) => s + c.cm, 0)
            const estimate = sumP + TABCOLSEP_BUDGET_CM * totalCols
            if (estimate <= SAFE_TEXTWIDTH_CM || pCols.length === 0) return match
            const scale = SAFE_TEXTWIDTH_CM / estimate
            let newColspec = colspec
            for (const c of pCols) {
              const newCm = (c.cm * scale).toFixed(2)
              // 替换第一次匹配(每个 c.raw 独立替换不会撞,因为后面再 match 时 pRe 已走过)
              newColspec = newColspec.replace(c.raw, `p{${newCm}cm}`)
            }
            longtableRescaleCount++
            longtableTotalScaled += pCols.length
            console.log(`[latex/render BG] longtable rescale: ${pCols.length} p{} cols, estimate ${estimate.toFixed(2)}cm → scale ${scale.toFixed(3)} (target ≤ ${SAFE_TEXTWIDTH_CM}cm)`)
            return `\\begin{longtable}{${newColspec}}`
          }
        )
        if (longtableRescaleCount > 0) {
          auditBg('latex_render_longtable_rescale', {
            render_id: renderId,
            tables_rescaled: longtableRescaleCount,
            p_cols_scaled: longtableTotalScaled,
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] longtable rescale threw:', e?.message)
      }

      // 2026-05-27 v6.1 — defensive tabular overflow wrapping:
      //   tabular 列数 >= 5 且未被 \resizebox / longtable / tabularx 包裹 → 强行套 \resizebox
      //   保 PDF 不溢出右边距(用户:"表也可能过大会出界")。
      //   实现:扫每个 \begin{tabular}{<cols>}...\end{tabular},
      //     - 数 cols 字符串里的列说明符(l/c/r/p{...})
      //     - 如果 >= 5 且周围 1KB 范围内没有 \resizebox 或 \begin{longtable} 或 \begin{tabularx}
      //     - 把整个 \begin{tabular}...\end{tabular} 包成 \resizebox{\textwidth}{!}{...}
      try {
        let tabularWrapCount = 0
        // 解析 column spec 列数(l/c/r/p{...}/m{...}/b{...}/X 等)
        function countCols(spec) {
          let n = 0
          let i = 0
          while (i < spec.length) {
            const ch = spec[i]
            if (ch === 'l' || ch === 'c' || ch === 'r' || ch === 'X' || ch === '|') {
              if (ch !== '|') n++
              i++
            } else if (ch === 'p' || ch === 'm' || ch === 'b') {
              n++
              // skip until matching closing }
              i++
              if (spec[i] === '{') {
                let depth = 1; i++
                while (i < spec.length && depth > 0) {
                  if (spec[i] === '{') depth++
                  else if (spec[i] === '}') depth--
                  i++
                }
              }
            } else if (ch === '*') {
              // *{n}{cols} — 不展开,粗略当 5+ 列估
              n += 5
              i++
              // skip *{n}{spec}
              if (spec[i] === '{') { let d = 1; i++; while (i<spec.length&&d>0) { if (spec[i]==='{') d++; else if (spec[i]==='}') d--; i++ } }
              if (spec[i] === '{') { let d = 1; i++; while (i<spec.length&&d>0) { if (spec[i]==='{') d++; else if (spec[i]==='}') d--; i++ } }
            } else {
              i++
            }
          }
          return n
        }
        // 用 lastIndex 状态跟踪,逐个替换 tabular 块
        // ⚠️ column spec 可能含 p{3cm} m{2cm} 等嵌套 {} → 简单 [^}]* 会在第一个 } 截断
        //    所以用 1-level 嵌套支持:[^{}]* (?: \{[^}]*\} [^{}]* )*
        const tabRe = /\\begin\{tabular\}\{([^{}]*(?:\{[^}]*\}[^{}]*)*)\}([\s\S]*?)\\end\{tabular\}/g
        texToWrite = texToWrite.replace(tabRe, (match, colSpec, body, offset) => {
          const cols = countCols(colSpec)
          if (cols < 5) return match   // 窄表,不动
          // 检查前 800 字节是否已有 \resizebox / longtable / tabularx 包裹(已包过的不重复)
          const context = texToWrite.slice(Math.max(0, offset - 800), offset)
          if (/\\resizebox\b|\\begin\{longtable\}|\\begin\{tabularx\}/.test(context)) {
            return match   // 已被外层 wrap,跳过
          }
          tabularWrapCount++
          return `\\resizebox{\\textwidth}{!}{%\n${match}%\n}`
        })
        if (tabularWrapCount > 0) {
          console.log(`[latex/render BG] defensive tabular wrap: ${tabularWrapCount} wide tabulars wrapped in \\resizebox{\\textwidth}{!}{...}`)
          auditBg('latex_render_tabular_wrap', {
            render_id: renderId,
            wrap_n: tabularWrapCount,
          })
        }
      } catch (e) {
        console.warn('[latex/render BG] defensive tabular wrap threw:', e?.message)
      }

      try {
        await fsp.writeFile(renderMainTex, texToWrite, 'utf8')
      } catch (e) {
        finishRender('failed', 'write main.tex failed: ' + (e?.message || String(e)), { llm_usage_log_id: lastLlmRes?.usageLogId, section_usage_logs: sectionUsageLogs })
        return
      }

      // references.bib
      const bib = generateBibtex(citableRecords)
      if (bib) {
        try { await fsp.writeFile(path.join(workDir, 'references.bib'), bib, 'utf8') } catch (e) {
          console.warn('[latex/render] write references.bib failed:', e?.message)
        }
      }

      // 拷贝图到 figures/ 子目录
      const figuresDir = path.join(workDir, 'figures')
      try { await ensureLatexDir(figuresDir) } catch {}
      for (const f of figuresMeta) {
        if (!f.source_path) continue
        try {
          const safeName = String(f.filename || '').replace(/[^\w.\-]/g, '_') || (f.fig_key + '.bin')
          await fsp.copyFile(f.source_path, path.join(figuresDir, safeName))
        } catch (e) {
          console.warn('[latex/render] copy figure failed:', f.source_path, e?.message)
        }
      }

      // ── 6. Copy template static assets next to main.tex ──
      //   2026-05-26 扩白名单:除了 LaTeX class/style/bib 类(.cls/.sty/.bst/.bib/.def/.clo)
      //   还要拷贝模板自带的 logo / 装饰图(.eps/.pdf/.png/.jpg/.jpeg)— 很多期刊模板
      //   \includegraphics{logo1.eps} 类引用图片放在 main.tex 同级,缺了 pdflatex 直接
      //   Fatal "File `./logo1.eps' not found" 整个 PDF 渲染失败。
      //   还要递归扫子目录(zip 经常含 `style/` `images/` `figures/` 顶层子目录),
      //   保留相对路径结构。
      const ALLOWED_TPL_EXTS = ['.cls', '.sty', '.bst', '.bib', '.def', '.clo',
                                '.eps', '.pdf', '.png', '.jpg', '.jpeg', '.tex',
                                '.fd', '.cfg', '.ldf', '.dfu']
      const RESERVED_NAMES = new Set(['main.tex', 'references.bib'])    // 不覆盖
      async function copyTemplateTree(srcDir, dstDir, relPrefix = '') {
        let entries = []
        try { entries = fs.readdirSync(srcDir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const srcPath = path.join(srcDir, entry.name)
          const relName = path.join(relPrefix, entry.name)
          if (entry.isDirectory()) {
            // 跳过明显无关的目录
            if (['__MACOSX', '.git', 'node_modules'].includes(entry.name)) continue
            const subDst = path.join(dstDir, entry.name)
            try { await ensureLatexDir(subDst) } catch {}
            await copyTemplateTree(srcPath, subDst, relName)
            continue
          }
          if (!entry.isFile()) continue
          const ext = path.extname(entry.name).toLowerCase()
          if (!ALLOWED_TPL_EXTS.includes(ext)) continue
          if (RESERVED_NAMES.has(entry.name)) continue
          try {
            await fsp.copyFile(srcPath, path.join(dstDir, entry.name))
          } catch (e) {
            console.warn(`[latex/render] copy template asset failed: ${relName}`, e?.message)
          }
        }
      }
      try {
        const srcRoot = project.latex_template_extract_dir
        if (srcRoot && fs.existsSync(srcRoot)) {
          await copyTemplateTree(srcRoot, workDir)
        }
      } catch (e) {
        console.warn('[latex/render] copy template static assets failed:', e?.message)
      }

      // ── 7. Run pdflatex ──
      const pdfRes = await runPdflatex({
        workDir,
        mainTex: 'main.tex',
        timeoutMs: 120_000,
      })

      if (!pdfRes.ok) {
        const errPrefix = pdfRes.missing_toolchain
          ? 'pdflatex / latexmk 未安装(prod 需要 TeX Live 2023)\n'
          : (pdfRes.killed ? 'pdflatex 超时(>120s)被强杀\n' : `pdflatex 失败 exit=${pdfRes.exitCode}\n`)
        finishRender('failed', errPrefix + (pdfRes.stderr_tail || ''), {
          tex_path: renderMainTex,
          log_path: pdfRes.logPath || null,
          llm_usage_log_id: lastLlmRes?.usageLogId,
          section_usage_logs: sectionUsageLogs,
        })
        auditBg('latex_render_failed', {
          render_id: renderId, reason: pdfRes.missing_toolchain ? 'missing_toolchain'
            : (pdfRes.killed ? 'timeout' : 'pdflatex_exit_nonzero'),
          exit_code: pdfRes.exitCode, duration_ms: pdfRes.duration_ms,
          usage_log_id: lastLlmRes?.usageLogId,
          section_usage_logs: sectionUsageLogs,
        })
        return
      }

      // 成功 — 落最终状态
      finishRender('success', null, {
        pdf_path: pdfRes.pdfPath,
        log_path: pdfRes.logPath,
        tex_path: renderMainTex,
        llm_usage_log_id: lastLlmRes?.usageLogId,
        section_usage_logs: sectionUsageLogs,
      })
      auditBg('latex_render_success', {
        render_id: renderId,
        duration_ms: pdfRes.duration_ms,
        model: lastLlmRes?.model || 'claude-opus-4-8',
        usage_log_id: lastLlmRes?.usageLogId,
        section_usage_logs: sectionUsageLogs,
        warnings: (parsed.warnings || []).slice(0, 5),
        conversion_notes_n: (parsed.conversion_notes || []).length,
        figures_n: figuresMeta.length,
        citable_records_n: citableRecords.length,
      })

      // 2026-05-31 磁盘优化:渲染成功后删 latexmk 中间产物(100% 可再生,从不被读/serve)。
      //   保留 main.pdf / main.tex / figures / 模板 assets(.cls/.sty/.bst/.eps)+ fill/ 沙盒。
      try {
        const intermediates = ['main.aux', 'main.fls', 'main.fdb_latexmk', 'main.bbl', 'main.blg', 'main.out', 'main.toc', 'main.lof', 'main.lot']
        let cleaned = 0
        for (const f of intermediates) {
          const p = path.join(workDir, f)
          try { if (fs.existsSync(p)) { await fsp.unlink(p); cleaned++ } } catch {}
        }
        if (cleaned > 0) console.log(`[latex/render BG] cleaned ${cleaned} latexmk intermediates in ${renderId}`)
      } catch (e) { console.warn('[latex/render BG] intermediate cleanup failed:', e?.message) }
    } catch (e) {
      console.error('[latex/render BG] threw:', e)
      finishRender('failed', 'unexpected: ' + (e?.message || String(e)))
      auditBg('latex_render_failed', { render_id: renderId, reason: 'bg_threw', error: (e?.message || String(e)).slice(0, 200) })
    }
  })

  if (wantsJson) {
    return res.json({ ok: true, render_id: renderId, message: '已启动 LaTeX 渲染(LLM 填充 + pdflatex,~3-8 min)' })
  }
  req.session.flash = { type: 'success', message: '已启动 LaTeX 渲染(LLM 填充 + pdflatex,~3-8 min,可关页面)' }
  res.redirect(`/projects/${project.id}/report`)
})

// GET /:id/report/latex/render/:renderId/status.json — 轮询
router.get('/:id/report/latex/render/:renderId/status.json', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).json({ ok: false, error: 'not_found' })

  let row
  try {
    row = db.prepare(
      `SELECT id, project_id, started_at, finished_at, status,
              pdf_path, log_path, tex_path, error, llm_usage_log_id
         FROM latex_renders
        WHERE id = ? AND project_id = ?`
    ).get(req.params.renderId, project.id)
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'db_query_failed', message: e.message })
  }
  if (!row) return res.status(404).json({ ok: false, error: 'render_not_found' })

  const inFlight = !!(row.status === 'running' && row.started_at &&
    (Date.now() - new Date(row.started_at + ' UTC').getTime() < 30 * 60 * 1000))
  const elapsedS = row.started_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.started_at + ' UTC').getTime()) / 1000))
    : 0

  res.json({
    ok: true,
    render: {
      id: row.id,
      project_id: row.project_id,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      in_flight: inFlight,
      elapsed_s: elapsedS,
      has_pdf: !!(row.pdf_path && fs.existsSync(row.pdf_path)),
      error: row.error,
      llm_usage_log_id: row.llm_usage_log_id,
    },
  })
})

// GET /:id/report/latex/render/:renderId/pdf — stream
router.get('/:id/report/latex/render/:renderId/pdf', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  let row
  try {
    row = db.prepare(
      `SELECT id, status, pdf_path FROM latex_renders WHERE id = ? AND project_id = ?`
    ).get(req.params.renderId, project.id)
  } catch (e) {
    return res.status(500).type('text/plain').send('db error')
  }
  if (!row) return res.status(404).type('text/plain').send('render not found')
  if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
    return res.status(404).type('text/plain').send('pdf not available (render status: ' + row.status + ')')
  }

  try {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="review-${project.id}-${row.id}.pdf"`)
    res.sendFile(path.resolve(row.pdf_path), (err) => {
      if (err && !res.headersSent) {
        console.warn('[latex/render/pdf] sendFile failed:', err?.message)
        res.status(404).type('text/plain').send('file missing')
      }
    })
  } catch (e) {
    if (!res.headersSent) res.status(500).type('text/plain').send('stream error')
  }
})

// GET /:id/report/latex/render/:renderId/source.zip — package + stream
router.get('/:id/report/latex/render/:renderId/source.zip', async (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  let row
  try {
    row = db.prepare(
      `SELECT id, status, tex_path FROM latex_renders WHERE id = ? AND project_id = ?`
    ).get(req.params.renderId, project.id)
  } catch (e) {
    return res.status(500).type('text/plain').send('db error')
  }
  if (!row) return res.status(404).type('text/plain').send('render not found')

  // workDir = dirname(tex_path) (默认 .../<render_id>/main.tex)
  const workDir = row.tex_path
    ? path.dirname(row.tex_path)
    : path.join(LATEX_RENDERS_DIR, project.id, row.id)
  if (!fs.existsSync(workDir)) {
    return res.status(404).type('text/plain').send('workdir missing')
  }

  const zipPath = path.join(workDir, 'source.zip')
  try {
    await packageRenderSource(workDir, zipPath)
  } catch (e) {
    console.error('[latex/render/source.zip] package failed:', e)
    return res.status(500).type('text/plain').send('package failed: ' + (e?.message || ''))
  }

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="latex-source-${project.id}-${row.id}.zip"`)
  res.sendFile(path.resolve(zipPath), (err) => {
    if (err && !res.headersSent) {
      console.warn('[latex/render/source.zip] sendFile failed:', err?.message)
      res.status(404).type('text/plain').send('zip missing')
    }
  })
})

// ============================================================
// Phase 8.F · 一键投稿包(finalize)
// ============================================================

/**
 * 把所有 finalize 资产打成 zip,写到 FINALIZED_DIR,返回 { zipPath, timestamp }。
 * 同步执行(adm-zip writeZip + fs;不调 LLM)。
 */
function buildFinalizedZip(db, project, {
  customSections,
  finalizationReady,
  latexLastRender,
  skipLatex,
}) {
  const projectId = project.id
  const timestamp = Date.now()

  // 章节内容(topological order)
  // topoSort 在不同分支返回不同形态:
  //   - helpers 路径返回 [['name1','name2'], ...](strings)
  //   - fallback 路径返回 [[{name,...}, ...], ...](objects)
  // 这里两种都吃。
  const sectionsMap = listLatestSections(db, projectId)
  const batches = topoSort(customSections || [])
  const orderedSectionNames = []
  for (const batch of (batches || [])) {
    for (const s of (batch || [])) {
      const n = (s && typeof s === 'object') ? s.name : (typeof s === 'string' ? s : null)
      if (n && !orderedSectionNames.includes(n)) orderedSectionNames.push(n)
    }
  }
  // Fallback: 若 topoSort 没覆盖到所有 section(理论上不会),补尾
  for (const s of (customSections || [])) {
    if (!orderedSectionNames.includes(s.name)) orderedSectionNames.push(s.name)
  }

  const manuscriptParts = []
  manuscriptParts.push(`<!-- SLR Copilot finalized package — ${new Date().toISOString()} -->`)
  manuscriptParts.push(`<!-- Project: ${project.title} (${projectId}) -->`)
  manuscriptParts.push('')
  for (const name of orderedSectionNames) {
    const row = sectionsMap[name]
    if (!row || !row.content_markdown || !row.content_markdown.trim()) continue
    const def = (customSections || []).find((s) => s.name === name)
    const label = (def && def.label) || (draftingPrompts.SECTION_LABELS && draftingPrompts.SECTION_LABELS[name]) || name
    manuscriptParts.push(`# ${label}`)
    manuscriptParts.push('')
    manuscriptParts.push(row.content_markdown.trim())
    manuscriptParts.push('')
  }
  const manuscriptMd = manuscriptParts.join('\n')

  // BibTeX
  let bib = ''
  try {
    let citable = []
    if (draftingHelpers?.buildCitableRecords) {
      citable = draftingHelpers.buildCitableRecords(db, projectId) || []
    } else {
      citable = listIncludedRecords(db, projectId).map((r) => ({
        id: r.id, title: r.title, year: r.year,
        authors_text: r.authors_text, authors_json: r.authors_json,
        doi: r.doi, journal: r.journal,
      }))
    }
    bib = generateBibtex(citable) || ''
  } catch (e) {
    console.warn('[finalize] generateBibtex failed:', e?.message)
  }

  // PRISMA checklist CSV
  let prismaCsv = 'item_number,item,ai_validation_status,evidence_quote,section_found,recommendation\n'
  try {
    const rows = db.prepare(
      `SELECT item_number, topic, recommendation, ai_validation_status, ai_validation_evidence
         FROM prisma_checklist
        WHERE project_id = ?
        ORDER BY id ASC`
    ).all(projectId)
    const csvEscape = (v) => {
      const s = (v == null ? '' : String(v)).replace(/\r?\n/g, ' ')
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    for (const r of rows) {
      let ev = null
      try { ev = r.ai_validation_evidence ? JSON.parse(r.ai_validation_evidence) : null } catch {}
      const quote = (ev && ev.quote) || ''
      const sectionFound = (ev && ev.section) || ''
      const reco = (ev && ev.recommendation) || r.recommendation || ''
      prismaCsv += [
        csvEscape(r.item_number),
        csvEscape(r.topic || ''),
        csvEscape(r.ai_validation_status || 'unrated'),
        csvEscape(quote),
        csvEscape(sectionFound),
        csvEscape(reco),
      ].join(',') + '\n'
    }
  } catch (e) {
    console.warn('[finalize] prisma checklist CSV build failed:', e?.message)
  }

  // synthesis_summary.md — themes + body_of_evidence(best-effort)
  let synthesisMd = '# Synthesis Summary\n\n'
  try {
    const themes = listThemes(db, projectId)
    let tcByTheme = new Map()
    try {
      const tcRows = db.prepare(
        `SELECT theme_id, overall_certainty, body_of_evidence_summary,
                implications_for_practice, implications_for_research, iteration_n
           FROM theme_certainty WHERE project_id = ?
          ORDER BY iteration_n DESC`
      ).all(projectId)
      for (const tc of tcRows) {
        if (!tcByTheme.has(tc.theme_id)) tcByTheme.set(tc.theme_id, tc)
      }
    } catch {}
    if (themes.length === 0) {
      synthesisMd += '_(No themes captured yet.)_\n'
    } else {
      for (const t of themes) {
        synthesisMd += `## ${t.name || t.theme_name || '(untitled theme)'}\n\n`
        if (t.description) synthesisMd += `${t.description}\n\n`
        const tc = tcByTheme.get(t.id)
        if (tc) {
          if (tc.overall_certainty) synthesisMd += `**Overall certainty**: ${tc.overall_certainty}\n\n`
          if (tc.body_of_evidence_summary) synthesisMd += `${tc.body_of_evidence_summary}\n\n`
          if (tc.implications_for_practice) synthesisMd += `**Implications for practice**: ${tc.implications_for_practice}\n\n`
          if (tc.implications_for_research) synthesisMd += `**Implications for research**: ${tc.implications_for_research}\n\n`
        }
      }
    }
  } catch (e) {
    console.warn('[finalize] synthesis summary build failed:', e?.message)
    synthesisMd += '_(synthesis summary generation failed)_\n'
  }

  // Figures
  const figureAssetsLocal = (() => { try { return listFigureAssets(db, projectId) } catch { return [] } })()

  // README
  const readmeLines = []
  readmeLines.push(`# Submission Package — ${project.title}`)
  readmeLines.push('')
  readmeLines.push(`- Project ID: \`${projectId}\``)
  readmeLines.push(`- Generated: ${new Date().toISOString()}`)
  readmeLines.push(`- Generator: SLR Copilot`)
  readmeLines.push('')
  readmeLines.push('## Contents')
  readmeLines.push('')
  readmeLines.push('- `manuscript.md` — full manuscript markdown (sections concatenated in topological order)')
  if (!skipLatex && latexLastRender && latexLastRender.pdf_path) readmeLines.push('- `manuscript.pdf` — typeset PDF (from LaTeX render)')
  if (!skipLatex && latexLastRender && latexLastRender.tex_path) readmeLines.push('- `manuscript.tex` — filled LaTeX source')
  readmeLines.push('- `references.bib` — BibTeX bibliography of included records')
  if (figureAssetsLocal.length) readmeLines.push(`- \`figures/\` — ${figureAssetsLocal.length} figure asset(s)`)
  readmeLines.push('- `prisma_checklist.csv` — PRISMA 2020 27-item checklist with AI validation status')
  readmeLines.push('- `synthesis_summary.md` — themes + body-of-evidence summary')
  readmeLines.push('')
  readmeLines.push('## Finalization status snapshot')
  readmeLines.push('')
  if (finalizationReady) {
    readmeLines.push(`- Sections done: ${finalizationReady.sections_done}/${finalizationReady.sections_total_required}`)
    const pv = finalizationReady.prisma_validated
    readmeLines.push(`- PRISMA: ${pv.covered}/${pv.total} covered (partial ${pv.partial}, missing ${pv.missing}, unrated ${pv.unrated})`)
    readmeLines.push(`- Figures uploaded: ${finalizationReady.figures_uploaded}`)
    readmeLines.push(`- Authors filled: ${finalizationReady.authors_filled}`)
    const lr = finalizationReady.latex_rendered
    readmeLines.push(`- LaTeX render: ${lr.last_status || 'none'}${lr.has_pdf ? ' (pdf available)' : ''}${lr.last_at ? ' at ' + lr.last_at : ''}`)
    readmeLines.push(`- Overall ready: **${finalizationReady.overall_ready ? 'YES' : 'NO (forced or skipped checks)'}**`)
  }
  if (skipLatex) {
    readmeLines.push('')
    readmeLines.push('> ⚠ This package was built with `skip_latex=1` — no PDF/tex included.')
  }
  const readmeMd = readmeLines.join('\n') + '\n'

  // Build zip
  const zip = new AdmZip()
  zip.addFile('manuscript.md', Buffer.from(manuscriptMd, 'utf8'))
  if (bib) zip.addFile('references.bib', Buffer.from(bib, 'utf8'))
  zip.addFile('prisma_checklist.csv', Buffer.from(prismaCsv, 'utf8'))
  zip.addFile('synthesis_summary.md', Buffer.from(synthesisMd, 'utf8'))
  zip.addFile('README.md', Buffer.from(readmeMd, 'utf8'))

  // PDF / TEX
  if (!skipLatex && latexLastRender) {
    if (latexLastRender.pdf_path && fs.existsSync(latexLastRender.pdf_path)) {
      try { zip.addLocalFile(latexLastRender.pdf_path, '', 'manuscript.pdf') } catch (e) {
        console.warn('[finalize] add pdf failed:', e?.message)
      }
    }
    if (latexLastRender.tex_path && fs.existsSync(latexLastRender.tex_path)) {
      try { zip.addLocalFile(latexLastRender.tex_path, '', 'manuscript.tex') } catch (e) {
        console.warn('[finalize] add tex failed:', e?.message)
      }
    }
  }

  // Figures
  for (const fa of figureAssetsLocal) {
    if (!fa.file_path || !fs.existsSync(fa.file_path)) continue
    const safeName = String(fa.original_filename || (fa.id + path.extname(fa.file_path || '')))
      .replace(/[^\w.\-]/g, '_') || (fa.id + '.bin')
    try { zip.addLocalFile(fa.file_path, 'figures', safeName) } catch (e) {
      console.warn('[finalize] add figure failed:', fa.file_path, e?.message)
    }
  }

  // Write
  try { fs.mkdirSync(FINALIZED_DIR, { recursive: true }) } catch {}
  const zipPath = path.join(FINALIZED_DIR, `${projectId}_${timestamp}.zip`)
  zip.writeZip(zipPath)
  return { zipPath, timestamp }
}

// POST /:id/report/finalize
router.post('/:id/report/finalize', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).render('error', { title: 'Not Found', message: '项目不存在或无权访问' })

  const wantsJson = req.get('X-Requested-With') === 'fetch'
  const force = String(req.query.force || req.body?.force || '') === '1'
  const skipLatex = String(req.query.skip_latex || req.body?.skip_latex || '') === '1'

  const customSections = getCustomSections(db, project.id)

  // Latex last render(给就绪度 + zip 用)
  let latexLastRender = null
  try {
    latexLastRender = db.prepare(
      `SELECT id, status, pdf_path, tex_path, started_at, finished_at
         FROM latex_renders
        WHERE project_id = ?
        ORDER BY started_at DESC
        LIMIT 1`
    ).get(project.id) || null
  } catch (e) { console.warn('[finalize] latex_renders load failed:', e?.message) }

  const ready = computeFinalizationReady(db, project, { customSections, latexLastRender })

  audit(db, req, {
    eventType: 'report_finalize_started',
    userId: req.user.id, projectId: project.id,
    payload: { force, skip_latex: skipLatex, ready_snapshot: ready },
  })

  // Gate 1:必填章节
  if (!ready.sections_ready && !force) {
    const msg = `必填章节未全部完成(${ready.sections_done}/${ready.sections_total_required}),缺:${ready.missing_required.join(', ')}`
    audit(db, req, {
      eventType: 'report_finalize_failed',
      userId: req.user.id, projectId: project.id,
      payload: { reason: 'sections_incomplete', missing: ready.missing_required },
    })
    if (wantsJson) return res.status(400).json({ ok: false, error: 'sections_incomplete', message: msg, ready })
    req.session.flash = { type: 'error', message: msg + '(加 ?force=1 强制)' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Gate 2a:PRISMA validator 必须跑过(P1-16 — 不允许"没跑就 force")
  //   validated === 0 表示用户从未点 "⚡ PRISMA AI 验证" 按钮 → 投稿包不合规
  //   force=1 也不能绕过此 gate(诚实性要求),用户必须显式跑过 validator
  if (ready.prisma_validated.validated === 0) {
    const msg = 'PRISMA 27 项 AI 验证从未运行 — 投稿前必须先跑一次验证(/report 页 ⚡ PRISMA AI 验证 按钮),完成后再 finalize。即使加 force=1 也不允许跳过此 gate。'
    audit(db, req, {
      eventType: 'report_finalize_failed',
      userId: req.user.id, projectId: project.id,
      payload: { reason: 'prisma_validator_never_run' },
    })
    if (wantsJson) return res.status(400).json({ ok: false, error: 'prisma_validator_never_run', message: msg, ready })
    req.session.flash = { type: 'error', message: msg }
    return res.redirect(`/projects/${project.id}/report`)
  }
  // Gate 2:PRISMA(>= 24/27 covered)
  if (!ready.prisma_validated.ready && !force) {
    const pv = ready.prisma_validated
    const msg = `PRISMA AI 验证未达标(covered ${pv.covered}/${pv.total},需 ≥ 24/27)`
    audit(db, req, {
      eventType: 'report_finalize_failed',
      userId: req.user.id, projectId: project.id,
      payload: { reason: 'prisma_not_ready', counts: pv },
    })
    if (wantsJson) return res.status(400).json({ ok: false, error: 'prisma_not_ready', message: msg, ready })
    req.session.flash = { type: 'error', message: msg + '(请先跑 PRISMA 验证;或加 ?force=1 强制)' }
    return res.redirect(`/projects/${project.id}/report`)
  }

  // Gate 3:LaTeX(skip_latex 可绕过)
  if (!skipLatex) {
    const lr = ready.latex_rendered
    if (!lr.ready && !force) {
      const msg = `LaTeX 渲染未成功(last_status=${lr.last_status || 'none'},pdf=${lr.has_pdf})`
      audit(db, req, {
        eventType: 'report_finalize_failed',
        userId: req.user.id, projectId: project.id,
        payload: { reason: 'latex_not_ready', latex: lr },
      })
      if (wantsJson) return res.status(400).json({ ok: false, error: 'latex_not_ready', message: msg, ready })
      req.session.flash = { type: 'error', message: msg + '(请先成功跑 LaTeX 渲染;或加 ?skip_latex=1 / ?force=1)' }
      return res.redirect(`/projects/${project.id}/report`)
    }
  }

  // ── Build zip ──
  let zipResult
  try {
    zipResult = buildFinalizedZip(db, project, {
      customSections,
      finalizationReady: ready,
      latexLastRender,
      skipLatex,
    })
  } catch (e) {
    console.error('[finalize] buildFinalizedZip failed:', e)
    audit(db, req, {
      eventType: 'report_finalize_failed',
      userId: req.user.id, projectId: project.id,
      payload: { reason: 'zip_build_failed', error: (e?.message || String(e)).slice(0, 400) },
    })
    if (wantsJson) return res.status(500).json({ ok: false, error: 'zip_build_failed', message: (e?.message || String(e)).slice(0, 200) })
    req.session.flash = { type: 'error', message: '打包失败:' + (e?.message || String(e)).slice(0, 200) }
    return res.redirect(`/projects/${project.id}/report`)
  }

  let zipSize = 0
  try { zipSize = fs.statSync(zipResult.zipPath).size } catch {}
  audit(db, req, {
    eventType: 'report_finalize_success',
    userId: req.user.id, projectId: project.id,
    payload: {
      zip_path: zipResult.zipPath,
      timestamp: zipResult.timestamp,
      size_bytes: zipSize,
      force, skip_latex: skipLatex,
      sections_done: ready.sections_done,
      figures_n: ready.figures_uploaded,
      authors_n: ready.authors_filled,
      prisma_covered: ready.prisma_validated.covered,
    },
  })

  const downloadUrl = `/projects/${project.id}/report/finalize/download?ts=${zipResult.timestamp}`
  if (wantsJson) {
    return res.json({
      ok: true,
      zip_path: zipResult.zipPath,
      timestamp: zipResult.timestamp,
      size_bytes: zipSize,
      download_url: downloadUrl,
      message: `投稿包已打包(${(zipSize / 1024).toFixed(0)} KB)`,
    })
  }
  return res.redirect(downloadUrl)
})

// GET /:id/report/finalize/download
router.get('/:id/report/finalize/download', (req, res) => {
  const db = req.app.locals.db
  const project = ownProjectOr404(db, req.params.id, req.user.id)
  if (!project) return res.status(404).type('text/plain').send('not found')

  const ts = String(req.query.ts || '').trim()
  const wantLatest = String(req.query.latest || '') === '1' || !ts

  let zipPath = null
  if (ts && /^\d+$/.test(ts)) {
    const candidate = path.join(FINALIZED_DIR, `${project.id}_${ts}.zip`)
    if (fs.existsSync(candidate)) zipPath = candidate
  }
  if (!zipPath && wantLatest && fs.existsSync(FINALIZED_DIR)) {
    try {
      const prefix = project.id + '_'
      const files = fs.readdirSync(FINALIZED_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.zip'))
        .map((f) => ({ f, full: path.join(FINALIZED_DIR, f), mtime: fs.statSync(path.join(FINALIZED_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (files.length) zipPath = files[0].full
    } catch (e) { console.warn('[finalize/download] latest lookup failed:', e?.message) }
  }

  if (!zipPath) {
    return res.status(404).type('text/plain').send('finalized package not found — POST /finalize first')
  }

  const downloadName = `submission-${project.id}-${ts || 'latest'}.zip`
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
  res.sendFile(path.resolve(zipPath), (err) => {
    if (err && !res.headersSent) {
      console.warn('[finalize/download] sendFile failed:', err?.message)
      res.status(404).type('text/plain').send('zip file missing')
    }
  })
})

export default router
