// services/table-registry.js
// ────────────────────────────────────────────────────────────────────────
// 表 Registry — 所有派生表的注册中心
// ────────────────────────────────────────────────────────────────────────
//
// 设计目标(对照用户拍板):
//   1. 任何"值得系统化讨论"的维度都可以注册成表(从硬编码 4 表升级)
//   2. 每张表 = 一个 TableDef,view 自动枚举渲染,导出自动列出
//   3. 未来可让 LLM 推荐"对本项目应该出哪几张表",或用户自定义
//
// TableDef 结构:
//   {
//     key:               'table1' | 'table5' | 'tableX',
//     label:             '表头中文 / 英文 显示名',
//     description:       '一句话作用描述(给 UI 显示)',
//     intended_section:  'methods' | 'results' | 'discussion' | 'limitations' | 'future_research' | 'multi'
//     multi_subtable:    boolean  — 是否产出多个子表(如 Table 1 按主题分子表)
//     cochrane_required: boolean  — Cochrane / JBI 标准必出(true) 还是可选派生(false)
//     deriveFn:          (db, projectId) => tableData
//     // 输出 tableData 形态:
//     //   multi_subtable=false: { columns: [{key,label}], rows: [{...}] , (optional meta)}
//     //   multi_subtable=true:  { subtables: [{theme_id, theme_label, theme_name, theme_count, columns, rows}, ...] }
//   }

const TABLE_DEFS = []
const TABLE_BY_KEY = new Map()

export function registerTable(def) {
  if (!def || !def.key || !def.deriveFn) {
    throw new Error('registerTable: missing key or deriveFn')
  }
  if (TABLE_BY_KEY.has(def.key)) {
    throw new Error(`registerTable: duplicate key '${def.key}'`)
  }
  // 默认值
  const full = {
    multi_subtable:    false,
    cochrane_required: false,
    intended_section:  'multi',
    description:       '',
    ...def,
  }
  TABLE_DEFS.push(full)
  TABLE_BY_KEY.set(full.key, full)
  return full
}

export function getAllTableDefs() {
  return TABLE_DEFS.slice()
}

export function getTableDef(key) {
  return TABLE_BY_KEY.get(key) || null
}

export function listTableKeys() {
  return TABLE_DEFS.map((d) => d.key)
}

// ────────────────────────────────────────────────────────────────────────
// 一次性 build 所有注册表(供 GET /:id/report 视图)
//   返回 { [key]: tableData | null }(失败的表是 null,view 处理)
// ────────────────────────────────────────────────────────────────────────
export function buildAllRegisteredTables(db, projectId) {
  const out = {}
  for (const def of TABLE_DEFS) {
    try {
      out[def.key] = def.deriveFn(db, projectId)
    } catch (e) {
      console.warn(`[table-registry] derive failed for ${def.key}:`, e?.message)
      out[def.key] = null
    }
  }
  return out
}

// 单表 build(供导出端点)
export function buildSingleTable(db, projectId, key) {
  const def = getTableDef(key)
  if (!def) return null
  try {
    return { def, data: def.deriveFn(db, projectId) }
  } catch (e) {
    console.warn(`[table-registry] derive failed for ${key}:`, e?.message)
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────
// 注册现有 4 张 Cochrane 标准表(从 review-tables.js)+ Table 5-14 派生表
// ────────────────────────────────────────────────────────────────────────
import * as RT from './review-tables.js'

// 标准 4 表
registerTable({
  key: 'table1',
  label: 'Characteristics of Core Included Studies (by theme)',
  description: '正文用:每个主题只列 RoB 最强的核心研究(每主题封顶 N 篇,5 列精简),与正文 themes 一一呼应。完整全表见 Table S1(table1_full)。',
  intended_section: 'methods+results',
  multi_subtable: true,
  cochrane_required: true,
  deriveFn: RT.buildCharacteristicsTablesByTheme,
})

// #250:附录全表 —— 满足 PRISMA/Cochrane "列出全部纳入研究" 惯例。
//   正文 Table 1 是核心子集(瘦身省页),全部研究在此单张扁平表。
registerTable({
  key: 'table1_full',
  label: 'Table S1 — Characteristics of All Included Studies (Supplementary)',
  description: '附录/补充材料:单张扁平表列出全部纳入研究(含 Theme + RoB/Quality 列),不筛选不封顶。配合正文精简版 Table 1。',
  intended_section: 'supplementary',
  multi_subtable: false,
  cochrane_required: true,
  deriveFn: RT.buildFullCharacteristicsAppendix,
})

registerTable({
  key: 'table2',
  label: 'Summary of Findings (SoF)',
  description: 'Cochrane 标准 SoF 表 — outcome 级 GRADE certainty + effect size。',
  intended_section: 'results',
  cochrane_required: true,
  deriveFn: RT.buildSoFTable,
})

registerTable({
  key: 'table3a',
  label: 'Risk of Bias — Traffic Light (per study)',
  description: '逐研究 × 各 RoB domain 的红绿灯单元格,按 RoB 工具分子表。',
  intended_section: 'methods+results',
  cochrane_required: true,
  deriveFn: RT.buildRobTrafficLight,
})

registerTable({
  key: 'table3b',
  label: 'Risk of Bias — Domain Summary',
  description: 'GRADEpro 风格 stacked bar — 每 domain 跨研究汇总。',
  intended_section: 'methods+results',
  cochrane_required: true,
  deriveFn: RT.buildRobDomainSummary,
})

registerTable({
  key: 'table4',
  label: 'Evidence Profile (GRADE / CERQual)',
  description: '主题级 12 维评级 + 总体置信度。',
  intended_section: 'discussion',
  cochrane_required: true,
  deriveFn: RT.buildEvidenceProfileTable,
})

// 派生表 5-14(扩展分析,Cochrane 不要求但提升论文深度)
registerTable({
  key: 'table5',
  label: 'Geographic Distribution',
  description: '研究地域分布 × 主题 — 暴露地域偏倚,喂 Limitations 段。',
  intended_section: 'results+limitations',
  deriveFn: RT.buildGeographicDistribution,
})

registerTable({
  key: 'table6',
  label: 'Timeline / Year Trend',
  description: '论文时间分布 × 主题 — 主题成熟度演化,喂 Introduction / Results。',
  intended_section: 'introduction+results',
  deriveFn: RT.buildTimelineTrend,
})

registerTable({
  key: 'table7',
  label: 'Theoretical Framework Usage',
  description: '各论文采用的理论框架分布 — 暴露理论真空,喂 Discussion。',
  intended_section: 'introduction+discussion',
  deriveFn: RT.buildTheoreticalFrameworkUsage,
})

registerTable({
  key: 'table8',
  label: 'Measurement Instruments',
  description: '测量工具碎片化分析 — 喂 Methods / Limitations / Future Research。',
  intended_section: 'methods+limitations',
  deriveFn: RT.buildMeasurementInstruments,
})

registerTable({
  key: 'table9',
  label: 'Methodology Distribution',
  description: 'study_design × theme 分布矩阵 — 方法学多样性按主题。',
  intended_section: 'methods+results',
  deriveFn: RT.buildMethodologyDistribution,
})

registerTable({
  key: 'table10',
  label: 'Sample Size Descriptives',
  description: '样本量分布(min/median/max/IQR + 按主题对比)。',
  intended_section: 'methods+results',
  deriveFn: RT.buildSampleSizeDescriptives,
})

registerTable({
  key: 'table11',
  label: 'Effect Direction Summary',
  description: '效应方向汇总(正向 / 负向 / 混合 / 无显著)× 主题。',
  intended_section: 'results',
  deriveFn: RT.buildEffectDirectionSummary,
})

registerTable({
  key: 'table12',
  label: 'Cross-Theme Overlap Matrix',
  description: '主题间论文重叠度 — 暴露主题边界清晰度,提示合并 / 拆分。',
  intended_section: 'discussion',
  deriveFn: RT.buildCrossThemeOverlap,
})

registerTable({
  key: 'table13',
  label: 'PICO ↔ Theme Coverage Matrix',
  description: 'RQ × 主题覆盖反查 — 哪些 RQ 没被任何主题覆盖,这是 evidence gap 主据点。',
  intended_section: 'discussion+conclusion',
  deriveFn: RT.buildPicoThemeCoverage,
})

registerTable({
  key: 'table14',
  label: 'Evidence Gaps Registry',
  description: '系统化整理所有 evidence_gaps(主题 + 跨主题观察)— 直接进 Future Research 段。',
  intended_section: 'future_research',
  deriveFn: RT.buildEvidenceGapsRegistry,
})
