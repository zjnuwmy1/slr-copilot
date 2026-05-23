/**
 * Literature Matrix — Agent V (Phase 9)
 *
 * 思路:替代 / 补充 Agent N 的 LLM JSON extraction。
 *   - 每篇纳入文献一行,每列一个维度(扁平 fields JSON)
 *   - 用户主导填写;每列配可复制 prompt,让用户拿去自己的 AI 整理目标论文
 *   - 支持下载 XLSX 模板填完再上传;也支持在线 inline 编辑
 *
 * 表:literature_matrix(id, project_id, record_id, fields JSON, filled_by, completeness, notes)
 *     matrix_columns(id, project_id, key, label, description, ai_prompt_template,
 *                    is_quantitative, is_default, display_order)
 *
 * 不变量:
 *   - DEFAULT_MATRIX_COLUMNS 用 INSERT OR IGNORE 幂等 seed,删了不会复活
 *   - fields 值 toString().slice(0, 2000) 防超大
 *   - completeness = 非空字段数 / 当前可见列数
 */

import { randomId } from './crypto.js'

// ============================================================
// 13 个默认列(seed 进每个项目的 matrix_columns)
// ai_prompt_template:100-200 字中文,带 {{title}} / {{abstract}} / {{doi}} 占位符
// 语言风格沿用 services/prompts/protocol.js — 日常学术中文,不堆"赋能/范式"
// ============================================================
export const DEFAULT_MATRIX_COLUMNS = [
  {
    key: 'study_design',
    label: '研究设计',
    description: 'RCT / 观察性 / 案例 / 混合方法 / 综述 / 质性',
    is_quantitative: 0,
    display_order: 10,
    ai_prompt_template:
`请帮我判断下面这篇论文是什么研究设计,只输出一个短语,不要解释。
可选项:RCT、准实验、队列、横断面、病例对照、案例研究、质性研究、混合方法、系统综述、其它(注明)。
如果全文不足以判断,回答"无法判断(全文未明示)"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'population',
    label: '研究对象',
    description: '受试者人群/年龄/学段/职业等',
    is_quantitative: 0,
    display_order: 20,
    ai_prompt_template:
`从下面这篇论文里提取研究对象的描述:人群类型、年龄段、学段或职业、健康/学习状态。
一句话写完,30 字以内,不要列要点。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'country_region',
    label: '国家/地区',
    description: '研究开展的国家或地区',
    is_quantitative: 0,
    display_order: 30,
    ai_prompt_template:
`这篇论文的数据来自哪个国家或地区?只输出国家/地区名(可多个,用逗号分隔)。
如果全文没说,回答"未说明"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'sample_size_total',
    label: '样本量(总数)',
    description: '总参与者数,纯数字',
    is_quantitative: 1,
    display_order: 40,
    ai_prompt_template:
`这篇论文的总样本量是多少?只输出一个数字,不带"人""名""位",也不要带括号。
如果是综述/不适用,输出 0。如果全文没给,输出 -1。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'sample_size_per_group',
    label: '各组样本量',
    description: '如:实验组 30 / 对照组 28',
    is_quantitative: 0,
    display_order: 50,
    ai_prompt_template:
`如果这篇论文有分组,列出各组人数,格式如"实验组 30 / 对照组 28"。
没有分组就写"单组"或"不适用"。一行写完,不要解释。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'recruitment',
    label: '招募方式',
    description: '便利抽样 / 随机抽样 / 在线召募 等',
    is_quantitative: 0,
    display_order: 60,
    ai_prompt_template:
`这篇论文的受试者是怎么招到的?常见类别:便利抽样、随机抽样、分层抽样、滚雪球、线上招募、课堂整班、社区/医院。
一句话讲清,20 字内。全文没说就写"未说明"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'intervention',
    label: '干预/技术',
    description: '具体技术、工具、教学法、干预内容',
    is_quantitative: 0,
    display_order: 70,
    ai_prompt_template:
`这篇论文里的核心干预或技术是什么?用一句话讲清:做了什么、用了什么工具、持续多久(若有)。
40 字以内,不要写"旨在""探究"这类八股。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'comparator',
    label: '对照',
    description: '对照组接受了什么(传统教学 / 安慰剂 / 无 等)',
    is_quantitative: 0,
    display_order: 80,
    ai_prompt_template:
`这篇论文的对照组是什么?常见:传统教学、常规护理、空白对照、等待名单、安慰剂、无对照。
一句话写完。如果全文没讲对照,写"未说明"或"无对照"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'outcomes',
    label: '测量结局',
    description: '测了哪些变量(成绩/动机/焦虑 等)',
    is_quantitative: 0,
    display_order: 90,
    ai_prompt_template:
`这篇论文测了哪些结局变量?列出 2-5 个,用顿号分隔。
例如"学业成绩、学习动机、焦虑水平"。不要写测量工具(那是另一列)。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'measurement_tools',
    label: '测量工具/量表',
    description: '用了什么量表/题库/客观指标',
    is_quantitative: 0,
    display_order: 100,
    ai_prompt_template:
`这篇论文用了哪些量表、问卷或客观指标来测结局?
列出名字(英文缩写也可),用顿号分隔,如"MSLQ、PISA 阅读题、心率"。
全文没给就写"未说明"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'key_findings',
    label: '关键发现',
    description: '一两句话讲作者主张的核心结果',
    is_quantitative: 0,
    display_order: 110,
    ai_prompt_template:
`用一两句中文讲清这篇论文的核心发现 —— 谁比谁怎么样、显著与否、效应方向。
60 字以内,直接说结论,不要"本研究表明""旨在探究"这种开头。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'quantitative_results',
    label: '量化结果(p / 效应量 / CI)',
    description: '提取显著性检验数值',
    is_quantitative: 1,
    display_order: 120,
    ai_prompt_template:
`从这篇论文里提取所有显著性检验和效应量的数值。
格式:每个发现一行,如"实验组 vs 对照组:t(58)=2.31, p=.024, d=0.61"。
没有量化结果(质性/综述)写"不适用"。全文有但找不到具体数值,写"未明确报告"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'limitations',
    label: '作者报告的局限',
    description: '作者自己承认的不足',
    is_quantitative: 0,
    display_order: 130,
    ai_prompt_template:
`这篇论文作者自己承认了哪些局限?列 1-3 条,用顿号分隔。
只写作者自己说的,不要你额外评判。
全文末尾或讨论部分通常会写,如果完全没有就回答"作者未讨论局限"。
论文(完整全文):
{{paper}}`,
  },

  // ─── 跨学科通用补充字段(工 / 文 / 医 都用得到)─────────
  {
    key: 'research_question',
    label: '研究问题/假设',
    description: '作者明确陈述的 RQ 或 H(不是发现,是问题本身)',
    is_quantitative: 0,
    display_order: 15,   // 早于 population,因为这是研究的起点
    ai_prompt_template:
`这篇论文要回答的核心研究问题(RQ)或假设(H)是什么?
摘录或概括作者明确陈述的问题/假设,1-2 句,80 字内。
不要把"发现"或"结论"塞进来 — 那是答案,不是问题。
如果作者没明说,从引言末尾或方法首段推一个。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'theoretical_framework',
    label: '理论框架',
    description: '依据什么理论 / 学派 / 模型(文科 & 社科常见,工医偶尔)',
    is_quantitative: 0,
    display_order: 25,
    ai_prompt_template:
`这篇论文用了什么理论框架、模型或学派立场?
例如:"建构主义""自我决定论""TAM 技术接受模型""社会认知理论""扎根理论""话语分析"等。
没有显式理论的实证 / 工程论文写"无明确理论框架(实证/工程)"。
列 1-2 个,15 字内,顿号分隔。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'data_source',
    label: '数据来源/类型',
    description: '问卷 / 访谈 / 实验测量 / 公开数据集 / 档案 等',
    is_quantitative: 0,
    display_order: 75,   // 紧跟 intervention 之后
    ai_prompt_template:
`这篇论文的数据是怎么来的?用 1-3 个标签描述。
常见类别:
  - 实证:问卷调查 / 半结构访谈 / 焦点小组 / 实验测量 / 田野观察 / 课堂录像
  - 二手:公开数据集 / 档案文献 / 政策文本 / 媒体语料 / 已发表论文(系统综述/元分析)
  - 工程:仿真数据 / 真实采集 / benchmark 数据集 / 传感器记录
顿号分隔,30 字内。全文未说就写"未说明"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'analysis_method',
    label: '数据分析方法',
    description: '统计 / 编码 / 主题分析 / 内容分析 / 仿真 / 机器学习 等',
    is_quantitative: 0,
    display_order: 95,   // outcomes 之后,measurement_tools 之前
    ai_prompt_template:
`这篇论文用了哪些数据分析方法?列出关键方法名,顿号分隔,40 字内。
例如:
  - 量化:t 检验 / ANOVA / 回归 / SEM 结构方程 / 多层模型 / 元分析
  - 质性:主题分析 / 扎根理论编码 / 话语分析 / 内容分析 / 案例对比
  - 工程:数值仿真 / 蒙特卡洛 / 机器学习 / 深度学习模型 / 系统识别
  - 综合:混合方法 / 三角验证
如果作者只写得很粗(如"统计分析"),原样写;完全没说就写"未说明"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'key_concepts_defined',
    label: '核心概念定义',
    description: '本文给出的关键术语操作性定义(文/社科尤其重要)',
    is_quantitative: 0,
    display_order: 115,   // key_findings 之前一点
    ai_prompt_template:
`这篇论文在哪些核心术语上给出了自己的定义?列 1-3 个,格式:"术语:简短定义"。
例如:"工作记忆:在认知任务中临时保持并操控信息的系统"。
只列论文里**显式定义**的术语,不要列你常识里的。如果全文中没有显式定义,回答"未给出显式定义"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'ethics_funding',
    label: '伦理审查 + 资助 + COI',
    description: 'IRB/伦理委员会编号、资助来源、利益冲突声明(医学/社科必查)',
    is_quantitative: 0,
    display_order: 135,
    ai_prompt_template:
`这篇论文是否报告了 (1) 伦理审查 / IRB 批准编号、(2) 资助来源、(3) 利益冲突声明?
按以下格式输出(只写论文中明确提到的):
  伦理:[编号或机构 / 或"未报告"]
  资助:[资助方 / 或"未报告"]
  COI:[有/无 / 或"未报告"]
如果全文中也没有,写"未报告"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'reproducibility',
    label: '可重复性(数据/代码)',
    description: '数据是否公开 / 代码 / 仪器 / 协议是否可获取',
    is_quantitative: 0,
    display_order: 140,
    ai_prompt_template:
`这篇论文的可重复性如何?检查以下几点:
  - 数据公开:是 / 否 / 未说明(若是,提供链接如 OSF / GitHub / Zenodo)
  - 代码公开:是 / 否 / 未说明
  - 协议预注册:是(PROSPERO/OSF 编号) / 否 / 未说明
  - 详细方法:正文有完整章节 / 仅有概述
一行写完,30 字内。如果完全没有,写"未报告"。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'practical_implication',
    label: '应用启示',
    description: '作者建议的实践应用 / 政策含义 / 工程改进点',
    is_quantitative: 0,
    display_order: 145,
    ai_prompt_template:
`作者提出了什么具体的实践应用建议?可以是:
  - 教育:课堂改革 / 课程设计建议
  - 医学:临床指南更新 / 患者管理建议
  - 工程:设计准则 / 系统优化建议
  - 政策:管理决策含义
1-2 句,60 字内。如果作者只讲了"未来研究方向"没讲应用,写"作者仅提未来研究,未给具体应用"。
论文(完整全文):
{{paper}}`,
  },
]

// ============================================================
// Seed:新建项目时(或第一次访问 matrix 页时)调,幂等
// ============================================================
export function seedColumnsForProject(db, projectId) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO matrix_columns
       (id, project_id, key, label, description, ai_prompt_template,
        is_quantitative, is_default, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
  const tx = db.transaction(() => {
    for (const c of DEFAULT_MATRIX_COLUMNS) {
      stmt.run(
        randomId('mcol'),
        projectId,
        c.key,
        c.label,
        c.description || null,
        c.ai_prompt_template || null,
        c.is_quantitative ? 1 : 0,
        c.display_order || 100,
      )
    }
  })
  tx()
}

// ============================================================
// 列出当前项目的所有列(默认 + 自定义,按 display_order)
// ============================================================
export function listColumns(db, projectId) {
  return db.prepare(
    `SELECT id, key, label, description, ai_prompt_template,
            is_quantitative, is_default, display_order
       FROM matrix_columns
      WHERE project_id = ?
      ORDER BY display_order ASC, created_at ASC`
  ).all(projectId)
}

// ============================================================
// 取某条 record 的 matrix 行(可能不存在,返回 null 或空 fields)
// ============================================================
export function getMatrixForRecord(db, projectId, recordId) {
  const row = db.prepare(
    `SELECT id, fields, filled_by, completeness, notes, updated_at
       FROM literature_matrix
      WHERE project_id = ? AND record_id = ?`
  ).get(projectId, recordId)
  if (!row) return null
  let fields = {}
  try {
    const parsed = JSON.parse(row.fields || '{}')
    if (parsed && typeof parsed === 'object') fields = parsed
  } catch {}
  return { ...row, fields }
}

// ============================================================
// upsert 一行(单条 save / xlsx 批量都走这个)
//   - fields 浅合并:不传的 key 不变;空串显式覆盖
//   - 每个值 toString().slice(0, 2000) 防超大
//   - filledBy: 'user' | 'ai' | 'ai_edited'
//   - 同时重算 completeness(传入 columns 避免重复查)
// ============================================================
export function upsertMatrixRow(db, { projectId, recordId, fields, filledBy = 'user', notes }) {
  if (!projectId || !recordId) throw new Error('projectId / recordId required')
  if (!fields || typeof fields !== 'object') fields = {}

  // 清洗字段值
  const cleaned = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue
    const s = String(v).slice(0, 2000)
    cleaned[k] = s
  }

  const existing = db.prepare(
    `SELECT id, fields FROM literature_matrix WHERE project_id = ? AND record_id = ?`
  ).get(projectId, recordId)

  let prev = {}
  if (existing) {
    try {
      const p = JSON.parse(existing.fields || '{}')
      if (p && typeof p === 'object') prev = p
    } catch {}
  }
  const merged = { ...prev, ...cleaned }

  // 重算 completeness
  const columns = listColumns(db, projectId)
  const completeness = computeCompleteness(merged, columns)

  if (existing) {
    db.prepare(
      `UPDATE literature_matrix
          SET fields = ?, filled_by = ?, completeness = ?,
              notes = COALESCE(?, notes),
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(JSON.stringify(merged), filledBy, completeness, notes ?? null, existing.id)
    return { id: existing.id, fields: merged, completeness }
  }

  const id = randomId('mtx')
  db.prepare(
    `INSERT INTO literature_matrix
       (id, project_id, record_id, fields, filled_by, completeness, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, recordId, JSON.stringify(merged), filledBy, completeness, notes || null)
  return { id, fields: merged, completeness }
}

// ============================================================
// 完成度 = 非空字段数 / 当前可见列数
// 仅统计 columns 里有的 key(用户删过的列不算)
// ============================================================
export function computeCompleteness(fields, columns) {
  if (!columns || columns.length === 0) return 0
  let filled = 0
  for (const col of columns) {
    const v = fields?.[col.key]
    if (v !== null && v !== undefined && String(v).trim() !== '') filled++
  }
  return Math.round((filled / columns.length) * 1000) / 1000
}

// ============================================================
// 列出本项目所有"纳入"的 records(screening human_decision='include')
// 返回 { id, title, authors_text, year, journal, doi }
// ============================================================
export function listIncludedRecords(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.title, r.authors_text, r.year, r.journal, r.doi
       FROM records r
      INNER JOIN screening_decisions sd
         ON sd.record_id = r.id
        AND sd.project_id = r.project_id
        AND sd.human_decision = 'include'
      WHERE r.project_id = ?
        AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
      GROUP BY r.id
      ORDER BY r.year DESC, r.title ASC`
  ).all(projectId)
}

// ============================================================
// 生成 XLSX 模板:首行 header,每行一篇纳入论文(metadata 已填)
// 返回 Node Buffer
// ============================================================
export async function buildXlsxTemplate(db, projectId) {
  // 动态 import 避免在测试无依赖时卡住
  const XLSX = (await import('xlsx')).default || (await import('xlsx'))

  const columns = listColumns(db, projectId)
  const records = listIncludedRecords(db, projectId)

  // metadata 列(固定前 5 列,导入时按 record_id 回填)
  const meta = ['record_id', 'title', 'authors', 'year', 'doi']
  const colKeys = columns.map((c) => c.key)
  const header = [...meta, ...colKeys]
  const labelRow = ['(勿改)', '(只读)', '(只读)', '(只读)', '(只读)', ...columns.map((c) => c.label)]

  const dataRows = []
  for (const r of records) {
    // 读现有 matrix(让用户下载时已经能看到之前填的)
    const m = getMatrixForRecord(db, projectId, r.id)
    const filled = m?.fields || {}
    const row = [
      r.id,
      r.title || '',
      r.authors_text || '',
      r.year || '',
      r.doi || '',
      ...colKeys.map((k) => filled[k] ?? ''),
    ]
    dataRows.push(row)
  }

  const aoa = [header, labelRow, ...dataRows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // 列宽:metadata 紧凑,数据列宽一点
  ws['!cols'] = [
    { wch: 20 }, { wch: 40 }, { wch: 28 }, { wch: 6 }, { wch: 20 },
    ...colKeys.map(() => ({ wch: 22 })),
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '文献矩阵')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
  return buf
}

// ============================================================
// 解析上传的 XLSX,逐行 upsert
//   - 第一行 = header(read record_id + 各 column key)
//   - 第二行 = label/勿改提示行,跳过
//   - 之后每行一篇 record
// 返回 { processed, skipped, errors[] }
// ============================================================
export async function importXlsxBuffer(db, projectId, buffer) {
  const XLSX = (await import('xlsx')).default || (await import('xlsx'))
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return { processed: 0, skipped: 0, errors: ['工作簿没有 sheet'] }
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (rows.length < 2) return { processed: 0, skipped: 0, errors: ['表格为空'] }

  const header = rows[0].map((s) => String(s || '').trim())
  // record_id 必须在第一列(或者至少存在)
  const idIdx = header.indexOf('record_id')
  if (idIdx === -1) return { processed: 0, skipped: 0, errors: ['缺少 record_id 列,请用模板下载'] }

  const columns = listColumns(db, projectId)
  const colKeys = new Set(columns.map((c) => c.key))

  // 列 key → 列号
  const keyToCol = {}
  header.forEach((h, i) => {
    if (colKeys.has(h)) keyToCol[h] = i
  })

  // 本项目允许的 record_id
  const includedIds = new Set(listIncludedRecords(db, projectId).map((r) => r.id))

  const errors = []
  let processed = 0
  let skipped = 0

  // 跳过第二行(label row)
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue
    const recordId = String(row[idIdx] || '').trim()
    if (!recordId) { skipped++; continue }
    if (!includedIds.has(recordId)) {
      skipped++
      if (errors.length < 10) errors.push(`第 ${i + 1} 行 record_id 不在纳入列表:${recordId}`)
      continue
    }

    const fields = {}
    for (const [k, colIdx] of Object.entries(keyToCol)) {
      const v = row[colIdx]
      if (v === '' || v === null || v === undefined) continue
      fields[k] = String(v)
    }

    try {
      upsertMatrixRow(db, { projectId, recordId, fields, filledBy: 'user' })
      processed++
    } catch (e) {
      skipped++
      if (errors.length < 10) errors.push(`第 ${i + 1} 行写入失败:${e.message}`)
    }
  }

  return { processed, skipped, errors }
}

// ============================================================
// 添加自定义列(用户主导)
// ============================================================
export function addCustomColumn(db, projectId, { key, label, description, ai_prompt_template, is_quantitative }) {
  if (!key || !label) throw new Error('key 和 label 必填')
  const safeKey = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)
  if (!safeKey) throw new Error('key 不合法(只允许 a-z 0-9 _)')

  // 校验不重名
  const existing = db.prepare(
    `SELECT id FROM matrix_columns WHERE project_id = ? AND key = ?`
  ).get(projectId, safeKey)
  if (existing) throw new Error('该列已存在')

  // display_order 放到最后
  const maxRow = db.prepare(
    `SELECT MAX(display_order) AS m FROM matrix_columns WHERE project_id = ?`
  ).get(projectId)
  const order = (maxRow?.m || 0) + 10

  const id = randomId('mcol')
  db.prepare(
    `INSERT INTO matrix_columns
       (id, project_id, key, label, description, ai_prompt_template,
        is_quantitative, is_default, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id, projectId, safeKey,
    String(label).slice(0, 80),
    description ? String(description).slice(0, 200) : null,
    ai_prompt_template ? String(ai_prompt_template).slice(0, 2000) : null,
    is_quantitative ? 1 : 0,
    order,
  )
  return { id, key: safeKey }
}

// ============================================================
// 一次性总 prompt:把所有列拼成一段大 prompt
// 用户把这段 prompt + 论文全文喂给自己的 AI(Claude/ChatGPT),
// 一次性输出所有字段的 JSON,然后粘到 matrix 行或 Excel。
// ============================================================
export function buildMasterExtractionPrompt(db, projectId, project) {
  const columns = listColumns(db, projectId)
  const p = project || {}
  const lines = []

  lines.push('# 文献矩阵抽取(一次性总 prompt)')
  lines.push('')
  lines.push('你是一位严谨的 SLR(系统性文献综述)数据抽取助手。')
  lines.push('我会给你一篇论文的完整全文(可能是 PDF / Markdown / 纯文本)。')
  lines.push('请按下面的字段定义,**一次性**输出一段 JSON,把每个字段填完。')
  lines.push('')

  // 项目上下文 — 帮 AI 更精准判断
  if (p.title || p.topic || p.discipline) {
    lines.push('## 本 SLR 项目背景(供你理解抽取语境)')
    if (p.title)      lines.push(`- 项目标题:${p.title}`)
    if (p.topic)      lines.push(`- 主题:${p.topic}`)
    if (p.discipline) lines.push(`- 学科:${p.discipline}`)
    if (p.goal)       lines.push(`- 研究目标:${p.goal}`)
    lines.push('')
  }

  // 字段定义
  lines.push(`## 字段(共 ${columns.length} 个)`)
  lines.push('')
  for (const c of columns) {
    const typeTag = c.is_quantitative ? '[数字]' : '[文本]'
    lines.push(`### \`${c.key}\` — ${c.label} ${typeTag}`)
    if (c.description) lines.push(`说明:${c.description}`)
    if (c.ai_prompt_template) {
      // 删除 prompt 里"论文(完整全文):\n{{paper}}"段(总 prompt 末尾会统一附论文)
      const cleaned = c.ai_prompt_template
        .replace(/论文\(完整全文\)[\s\S]*?\{\{paper\}\}/g, '')
        .replace(/\{\{paper\}\}/g, '')
        .trim()
      if (cleaned) lines.push(`抽取要点:\n${cleaned}`)
    }
    lines.push('')
  }

  // 输出 schema 示例
  lines.push('## 输出格式(严格 JSON,字段名一字不差)')
  lines.push('```json')
  lines.push('{')
  columns.forEach((c, i) => {
    const comma = i < columns.length - 1 ? ',' : ''
    const placeholder = c.is_quantitative ? '0' : '""'
    lines.push(`  "${c.key}": ${placeholder}${comma}`)
  })
  lines.push('}')
  lines.push('```')
  lines.push('')

  // 规则
  lines.push('## 规则(必须遵守)')
  lines.push('1. 输出**只能**是一个 JSON 代码块,不要前后加任何解释。')
  lines.push('2. 字段名必须**一字不差**(case-sensitive),不要省略字段。')
  lines.push('3. [数字] 字段输出整数;找不到用 `-1`;明确不适用用 `0`。')
  lines.push('4. [文本] 字段输出短句,找不到用 `""` 空字符串。')
  lines.push('5. 只摘取作者**显式陈述**的内容,不要替作者推断。')
  lines.push('6. 涉及方法、数据、伦理这类信息,请**读完整全文**(不要只看摘要)。')
  lines.push('')

  lines.push('## 论文')
  lines.push('请把论文全文粘贴/上传在下面(或这条消息之后单独发):')
  lines.push('```')
  lines.push('<在此粘贴论文全文 — Title / Authors / Abstract / Body / References>')
  lines.push('```')

  return lines.join('\n')
}

// ============================================================
// 刷新默认列的 prompt 模板到最新版(DEFAULT_MATRIX_COLUMNS)
// 只更新 is_default=1 的列,保留用户自定义列不动。
// 用户在矩阵页点"刷新默认列模板"触发。
// ============================================================
export function refreshDefaultColumnPrompts(db, projectId) {
  const updateStmt = db.prepare(
    `UPDATE matrix_columns
     SET description = ?, ai_prompt_template = ?
     WHERE project_id = ? AND key = ? AND is_default = 1`
  )
  let updated = 0
  const tx = db.transaction(() => {
    for (const c of DEFAULT_MATRIX_COLUMNS) {
      const r = updateStmt.run(
        c.description || null,
        c.ai_prompt_template || null,
        projectId,
        c.key,
      )
      if (r.changes) updated += 1
    }
  })
  tx()
  return { updated }
}

// ============================================================
// AI 定制列建议 — system + user prompt 构造器
// 调用方:routes/projects/matrix.js POST /:id/matrix/suggest-columns
// ============================================================
export const SUGGEST_COLUMNS_SYSTEM = `你是 SLR 文献矩阵定制顾问。
基于用户的项目主题 + 研究协议 + 已有列,反推 3-6 个**对这个具体项目特别有用**
但通用模板里没有的额外列。

判断标准:
- 跟项目研究问题、概念组、纳排标准强相关
- 通用 21 列覆盖不到的子维度(例如医学影像 SLR 才需要"影像模态",教育干预 SLR 才需要"教育阶段")
- 能从一篇论文的全文中提取(不要凭空发明无法从论文里读到的字段)

避免:
- 跟现有列重复 / 高度相似
- 完全主观的判断(如"创新性"这种无法从论文事实提取)
- 一次给超过 6 个

**输出严格 JSON,不要任何前后文字 / Markdown / 代码围栏**:
{
  "suggestions": [
    {
      "key": "<英文 snake_case,简短>",
      "label": "<中文短标签,≤10字>",
      "description": "<≤30字 说明这个字段干啥>",
      "is_quantitative": <true|false>,
      "ai_prompt_template": "<≤200字 中文 prompt,告诉读全文的 AI 如何提取此字段。占位符必含 {{paper}}>",
      "reasoning": "<≤40字 中文,说明为什么这个项目特别需要这列>"
    }
  ],
  "overall_reasoning": "<≤120字 中文,总览思路>"
}`

export function buildSuggestColumnsPrompt({ project, protocol, existingKeys }) {
  const p = project || {}
  const pr = protocol || {}
  const lines = []
  lines.push('请基于以下项目信息,给出 3-6 个**专属定制列**(通用 21 列已覆盖的不要重复)。')
  lines.push('')
  if (p.title)      lines.push(`项目标题:${p.title}`)
  if (p.topic)      lines.push(`主题:${p.topic}`)
  if (p.discipline) lines.push(`学科:${p.discipline}`)
  if (p.goal)       lines.push(`研究目标:${p.goal}`)

  const rqs = Array.isArray(pr.research_questions) ? pr.research_questions : []
  if (rqs.length) {
    lines.push('')
    lines.push('研究问题:')
    rqs.forEach((q, i) => lines.push(`  RQ${i + 1}. ${q}`))
  }
  const cg = Array.isArray(pr.concept_groups) ? pr.concept_groups : []
  if (cg.length) {
    lines.push('')
    lines.push('概念组:')
    cg.forEach((g, i) => {
      const terms = Array.isArray(g.terms) ? g.terms : []
      lines.push(`  ${i + 1}. ${g.name || '未命名'}: ${terms.slice(0, 8).join(' | ')}`)
    })
  }
  const ic = Array.isArray(pr.inclusion_criteria) ? pr.inclusion_criteria : []
  if (ic.length) {
    lines.push('')
    lines.push('纳入标准:')
    ic.forEach((c) => lines.push(`  - ${c}`))
  }

  lines.push('')
  lines.push('已有列(请不要重复):')
  lines.push((existingKeys || []).join(' / '))

  lines.push('')
  lines.push('请输出 JSON({ suggestions: [...], overall_reasoning })。')
  return lines.join('\n')
}

/**
 * 解析 LLM 的 suggest-columns 输出 → 安全字段数组
 */
export function normalizeSuggestColumns(raw, { existingKeys } = {}) {
  if (!raw || typeof raw !== 'object') return { suggestions: [], overall_reasoning: '' }
  // 剥 wrapper
  let r = raw
  for (let i = 0; i < 3; i++) {
    if (Array.isArray(r.suggestions)) break
    const inner = r.result || r.data || r.output || r.response
    if (inner && typeof inner === 'object') r = inner
    else break
  }
  if (!Array.isArray(r.suggestions)) return { suggestions: [], overall_reasoning: '' }

  const known = new Set((existingKeys || []).map((k) => String(k).toLowerCase()))
  const out = []
  for (const item of r.suggestions.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const key = String(item.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40)
    if (!key || known.has(key)) continue
    const label = String(item.label || '').trim().slice(0, 30)
    if (!label) continue
    out.push({
      key,
      label,
      description: String(item.description || '').trim().slice(0, 120),
      is_quantitative: !!item.is_quantitative,
      ai_prompt_template: String(item.ai_prompt_template || '').trim().slice(0, 800),
      reasoning: String(item.reasoning || '').trim().slice(0, 200),
    })
  }
  return {
    suggestions: out,
    overall_reasoning: String(r.overall_reasoning || '').trim().slice(0, 400),
  }
}

// ============================================================
// 删自定义列;默认列禁删
// ============================================================
export function deleteCustomColumn(db, projectId, colId) {
  const row = db.prepare(
    `SELECT id, key, is_default FROM matrix_columns WHERE id = ? AND project_id = ?`
  ).get(colId, projectId)
  if (!row) throw new Error('列不存在')
  if (row.is_default) throw new Error('默认列不可删除')
  db.prepare(`DELETE FROM matrix_columns WHERE id = ?`).run(colId)
  // 注意:literature_matrix.fields 里残留的该 key 不主动清理(保留数据,
  // 用户万一加回同名列还能用;listColumns 也不会再渲染)
  return { ok: true, key: row.key }
}
