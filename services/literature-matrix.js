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
论文信息:
标题:{{title}}
DOI:{{doi}}
摘要:{{abstract}}
如果摘要不足以判断,回答"无法从摘要判断"。`,
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
标题:{{title}}
摘要:{{abstract}}`,
  },
  {
    key: 'country_region',
    label: '国家/地区',
    description: '研究开展的国家或地区',
    is_quantitative: 0,
    display_order: 30,
    ai_prompt_template:
`这篇论文的数据来自哪个国家或地区?只输出国家/地区名(可多个,用逗号分隔)。
如果摘要没说,回答"未说明"。
标题:{{title}}
摘要:{{abstract}}`,
  },
  {
    key: 'sample_size_total',
    label: '样本量(总数)',
    description: '总参与者数,纯数字',
    is_quantitative: 1,
    display_order: 40,
    ai_prompt_template:
`这篇论文的总样本量是多少?只输出一个数字,不带"人""名""位",也不要带括号。
如果是综述/不适用,输出 0。如果摘要没给,输出 -1。
标题:{{title}}
摘要:{{abstract}}`,
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
标题:{{title}}
摘要:{{abstract}}`,
  },
  {
    key: 'recruitment',
    label: '招募方式',
    description: '便利抽样 / 随机抽样 / 在线召募 等',
    is_quantitative: 0,
    display_order: 60,
    ai_prompt_template:
`这篇论文的受试者是怎么招到的?常见类别:便利抽样、随机抽样、分层抽样、滚雪球、线上招募、课堂整班、社区/医院。
一句话讲清,20 字内。摘要没说就写"未说明"。
标题:{{title}}
摘要:{{abstract}}`,
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
标题:{{title}}
摘要:{{abstract}}`,
  },
  {
    key: 'comparator',
    label: '对照',
    description: '对照组接受了什么(传统教学 / 安慰剂 / 无 等)',
    is_quantitative: 0,
    display_order: 80,
    ai_prompt_template:
`这篇论文的对照组是什么?常见:传统教学、常规护理、空白对照、等待名单、安慰剂、无对照。
一句话写完。如果摘要没讲对照,写"未说明"或"无对照"。
标题:{{title}}
摘要:{{abstract}}`,
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
标题:{{title}}
摘要:{{abstract}}`,
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
摘要没给就写"未说明"。
标题:{{title}}
摘要:{{abstract}}`,
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
标题:{{title}}
摘要:{{abstract}}`,
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
没有量化结果(质性/综述)写"不适用"。摘要没给但是定量研究,写"全文需查"。
标题:{{title}}
摘要:{{abstract}}`,
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
摘要里通常不写局限,如果没有就回答"摘要未提"。
标题:{{title}}
摘要:{{abstract}}`,
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
