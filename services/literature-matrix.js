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
import { cleanBilingualTitle } from './citation-format.js'

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
    label: '研究对象(含具体特征)',
    description: '人群类型 + 年龄(M±SD)+ 性别比例 + 健康/学段',
    is_quantitative: 0,
    display_order: 20,
    ai_prompt_template:
`提取研究对象的具体特征:
  1. 人群类型(如"高中生"/"住院冠心病患者"/"软件工程师")
  2. 年龄:**带具体数字**(如"M=15.3, SD=1.2"或"18-65 岁,M=42.5")
  3. 性别比例:**带百分比或人数**(如"女性 62% (n=74)")
  4. 健康/学段/职业状态
40 字以内,一行写完。作者只说"成年人"没年龄 → 写"年龄未报告";"性别均衡"没数字 → 写"性别比例未量化"。
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
如果是综述、方法学论文、不适用,或论文里没给具体数字 → 输出空字符串 ""(UI 会渲染为 "—")。
不要用 -1、0、null、"N/A"、"unknown" 这类占位词。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'sample_size_per_group',
    label: '各组样本量(数字)',
    description: '如:实验组 30 / 对照组 28(必须带数字)',
    is_quantitative: 0,
    display_order: 50,
    ai_prompt_template:
`如果这篇论文有分组,列出各组**具体人数**,格式严格:"实验组 30 / 对照组 28"或"组A 24 / 组B 24 / 组C 24"。
**必须有数字**;作者只说"两组规模相当"没数字 → 写"作者未给具体数字"。
没有分组就写"单组(n=X)"或"不适用"。一行写完,不要解释。
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
    label: '干预/技术(含剂量)',
    description: '做了什么 + 工具/版本 + 时长 + 频率/剂量',
    is_quantitative: 0,
    display_order: 70,
    ai_prompt_template:
`描述这篇论文的核心干预,**必须包含**(若作者有给):
  1. 做了什么(具体操作)
  2. 用了什么工具(名称 + 版本/型号)
  3. **持续多久**(带单位:天/周/月,如"持续 8 周")
  4. **频率/剂量**(如"每周 2 次,每次 50 分钟"/"剂量 50mg/天")
60 字以内,优先用数字,不要"旨在""探究"这类八股。
作者只说"短期培训"没具体时长 → 写"作者未给时长";没说频率 → 写"频率未说明"。
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
    label: '关键发现(优先量化)',
    description: '谁比谁差多少 — 优先用百分比/效应量,而非"显著高于"',
    is_quantitative: 0,
    display_order: 110,
    ai_prompt_template:
`用一两句中文讲清核心发现。**关键:能用数字就用数字** —
  ✓ 好:"实验组得分高出 23%(M=82 vs 67),p<.001,d=0.8"
  ✗ 差:"实验组显著优于对照组" — 这是定性描述,把数字省了
**优先抽**:百分比变化、平均值±SD、effect size(d/η²/r²)、置信区间、p 值方向。
如果作者只给"显著"没数字,写"仅称显著,未报告效应量"。
80 字以内,直接说结论,不要"本研究表明"这种八股。
论文(完整全文):
{{paper}}`,
  },
  {
    key: 'quantitative_results',
    label: '量化结果(p / 效应量 / CI)',
    description: '逐条提取统计检验数值;不编造数字',
    is_quantitative: 1,
    display_order: 120,
    ai_prompt_template:
`从这篇论文里**逐条提取所有**显著性检验、效应量、置信区间的具体数值。
格式:每个发现一行,如:
  "前后测对比:t(58)=2.31, p=.024, d=0.61, 95% CI [0.12, 1.10]"
  "干预 vs 对照:F(1,116)=8.7, p=.004, η²=.069"
  "Pearson r=.42, p<.001 (n=120)"

**严格规则**:
  - 只摘**论文里实际出现的数字**,**绝不编造**(如把"显著"改写成"p=.04"是禁止的)。
  - 作者只说"有效""显著"但没给数值 → 这一行写"仅称'显著'但未报告 p 值/效应量"。
  - 没有量化结果(纯质性 / 综述)写"不适用"。
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
export async function buildXlsxTemplate(db, projectId, project = null) {
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
    // xlsx 模板下载 — 标题用 cleanBilingualTitle 拆掉 `; [翻译]` 后缀,
    //   避免用户在 Excel 里看到一长串看似重复的双语标题
    const row = [
      r.id,
      cleanBilingualTitle(r.title).title,
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

  // ────────────────────────────────────────────────────────────
  // 第 2 个 sheet:使用说明 + 一次性总 prompt
  //   用户能在本地把 prompt + 论文全文一起喂给 Claude / ChatGPT,
  //   再把生成的 JSON 字段粘贴回"文献矩阵"sheet。
  // ────────────────────────────────────────────────────────────
  const masterPrompt = buildMasterExtractionPrompt(db, projectId, project || {})
  const guideLines = [
    ['📋 使用说明 — 文献矩阵手动抽取流程'],
    [''],
    ['本工作簿包含 2 个 sheet:'],
    ['  1) "文献矩阵" — 每行一篇纳入论文,前 5 列(record_id/title/authors/year/doi)只读,后面是要填的列。'],
    ['  2) "使用说明"(当前) — 一次性总 prompt + 操作流程。'],
    [''],
    ['── 推荐操作流程(每篇 ~3 分钟) ──'],
    [''],
    ['Step 1. 复制下面"一次性总 prompt"完整内容(从 # 开始到最后一行)。'],
    ['Step 2. 打开 Claude / ChatGPT / 任何你信任的 AI 网页。'],
    ['Step 3. 粘贴 prompt,然后把一篇论文的全文(PDF 转文字 / Markdown / 纯文本)粘贴到 prompt 末尾的 ``` ``` 占位符里。'],
    ['Step 4. AI 会回一段 JSON,字段名跟"文献矩阵"sheet 表头(第 1 行)一一对应。'],
    ['Step 5. 把 JSON 里每个字段的值粘贴到对应的列(同一行),数字列填整数,文本列填短句。'],
    ['Step 6. 全部填完后,回到 SLR Copilot 矩阵页 → 上传这个 xlsx → 系统按 record_id 写回。'],
    [''],
    ['── 小技巧 ──'],
    [''],
    ['• 字段"找不到 / 不适用 / N/A" 统一留空(数字列和文本列都填空白格)。系统会渲染为 "—",不要写 -1 / 0 / "N/A" / "未报告"。'],
    ['• Claude 一次回 1-2 篇没问题;ChatGPT 长文截断更狠,可以让它"先输出 JSON,再确认"。'],
    ['• 想要更适合本项目的专属列?回 SLR Copilot 矩阵页点 🎯 "AI 定制专属列",再重新下载本模板。'],
    [''],
    ['────────────────────────────────────────────────────────'],
    ['一次性总 prompt(复制下面这一整段)'],
    ['────────────────────────────────────────────────────────'],
    [''],
  ]
  // master prompt 按行展开,每行一格(避免单元格超长)
  for (const ln of masterPrompt.split('\n')) {
    guideLines.push([ln])
  }
  const wsGuide = XLSX.utils.aoa_to_sheet(guideLines)
  wsGuide['!cols'] = [{ wch: 120 }]
  XLSX.utils.book_append_sheet(wb, wsGuide, '使用说明')

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
export function buildMasterExtractionPrompt(db, projectId, project, { variant = 'copy' } = {}) {
  // 优先用 LLM 优化过的版本(POST /matrix/optimize-master-prompt 写入 projects.matrix_master_prompt_*)
  //   variant='batch' → 批量抽取用(更细、含 few-shot);buildAutomatedMasterPrompt 调用
  //   variant='copy'  → 给用户复制到外部 AI 的简化版;UI 复制按钮调用
  // 都没就走下面的默认模板。
  try {
    const row = db.prepare(
      `SELECT matrix_master_prompt_batch, matrix_master_prompt_copy
         FROM projects WHERE id = ?`
    ).get(projectId)
    if (row) {
      if (variant === 'batch' && row.matrix_master_prompt_batch) return row.matrix_master_prompt_batch
      if (variant === 'copy'  && row.matrix_master_prompt_copy)  return row.matrix_master_prompt_copy
    }
  } catch { /* M22 列还没建,fallback 到默认 */ }

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
    // 占位符全部用 "" — 提示 LLM 没值就空字符串(数字和文本一致),不要写 0 / -1 / null
    const placeholder = '""'
    lines.push(`  "${c.key}": ${placeholder}${comma}`)
  })
  lines.push('}')
  lines.push('```')
  lines.push('')

  // 规则
  lines.push('## 规则(必须遵守)')
  lines.push('0. **输出语言:所有 [文本] 字段一律用 English 填写**(无论论文原文是中/英/西/日)。综述最终成稿是英文,矩阵必须语言一致才能直接进 narrative synthesis / evidence table。中文术语翻译成学术英文(如 higher education / "double reduction" policy),英文术语原样保留。数字用 SI 单位,统计量用国际通用形式(p<.001, Cohen\'s d, Hedges\' g, 95% CI)。禁止中英混写("60 名 college students" ❌ → "60 college students" ✓)。这是硬约束,优先级高于"忠实原文措辞"。')
  lines.push('1. 输出**只能**是一个 JSON 代码块,不要前后加任何解释。')
  lines.push('2. 字段名必须**一字不差**(case-sensitive),不要省略字段。')
  lines.push('3. [数字] 字段输出正整数(如 "120");**找不到 / 不适用 / N/A 都用空字符串 ""**(不要用 -1、0、null 占位词,UI 会渲染为 "—")。')
  lines.push('4. [文本] 字段:**英文 fragment 风格**(Cochrane / JBI "Characteristics of included studies" 风格)。')
  lines.push('   **最高原则:完整性 / 量化 / 准确性优先,不要为字符数砍信息**。')
  lines.push('   作者显式陈述的数字、效应量、CI、对照、剂量、时长、工具、概念定义 — 一律保留,不许因"太长"砍掉。')
  lines.push('   下游 narrative synthesis / evidence table / GRADE 评级要能直接从矩阵抄,不必回去重读原文。')
  lines.push('   ')
  lines.push('   风格(为可读性,不是硬约束):')
  lines.push('   - 省略冠词/连接词,用 `;` `|` `→` 分隔多组结构化信息;不要写综述段落口吻。')
  lines.push('   - 数字必带单位(min / week / mg / n=);统计量用国际形式(p<.001, Cohen\'s d, 95% CI […])。')
  lines.push('   ')
  lines.push('   字段长度合理范围(参考,可超 — 信息完整始终优先):')
  lines.push('   - **结构化短字段**(study_design / country / setting):30–200 chars,1–5 词。')
  lines.push('   - **描述性中字段**(intervention / comparator / outcomes_measured / sample_characteristics):200–1500 chars,完整 PICO + 数字 + 单位 + 工具 + 必要限定。')
  lines.push('   - **叙事字段**(key_findings / limitations / implications):400–3000 chars,含每个 outcome 的 effect size + CI + p;多个 outcome 各成一段。')
  lines.push('   - **唯一硬上限 ≤ 5000 chars** — 超出基本是在写综述,砍叙事保数字。')
  lines.push('   找不到 / 不适用 / N/A 都用 `""` 空字符串(不要 -1 / 0 / "Not reported" 占位)。')
  lines.push('5. 只摘取作者**显式陈述**的内容,不要替作者推断、不要外推。')
  lines.push('5a. **例外:对高确定性可推断字段(study_design / country_region / 学习者层级),允许从原文短语锚定的明确线索做轻量推断**。例:从 "we randomly assigned … vs control" 推 RCT;从 "in 3 Hong Kong public secondary schools" 推 country=Hong Kong。这类字段如果原文有明确锚定就填,**不要因"不是逐字陈述"就留空**。')
  lines.push('6. 涉及方法、数据、伦理这类信息,请**读完整全文**(不要只看摘要)。结构化摘要(医学/教育/工科 STEM)经常含简短的 method / results / 关键 outcome 数字 / 限制陈述 — 这些也该如实摘出,不要预设"摘要里没有"。')
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
基于用户的项目主题 + 研究协议 + 现有列,做**两件事**:

【A】rewrites — 把通用默认列的 label / description / ai_prompt_template **改写成更贴合本项目学科与协议的表达**。
   适用场景:
   - 学科特异化:文科论文不应该出现"代码 / repo / 实验复现"这类工科术语,
     医学论文需要把"样本"细化为"队列 / 受试者",
     工程论文需要把"分析方法"细化为"仿真平台 / 实验装置 / 数据集"。
   - 把通用问句改成对本项目研究问题的指向性问句。
   - 注意:**只改写表述,不改 key**,key 一字不差。不需要全部 21 列都改写 — 只对
     "明显需要本项目化表达"的列动手,通常 3-8 列。其余列不要出现在 rewrites 里。

【B】suggestions — 反推 3-6 个**对这个具体项目特别有用**但通用模板没覆盖的额外列。
   判断标准:
   - 跟项目研究问题、概念组、纳排标准强相关
   - 例如医学影像 SLR 才需要"影像模态",教育干预 SLR 才需要"教育阶段",
     政策研究才需要"政策工具类型"
   - 能从一篇论文全文中**事实性**提取(不要发明主观判断字段如"创新性")
   - 不要跟现有列重复
   - 一次最多 6 个

通用约束:
- 学科风格优先级:学科 → 研究主题 → 研究问题 → 概念组
- 所有 ai_prompt_template 必须含 \`{{paper}}\` 占位符,要求"读全文,只摘作者显式陈述"
- 中文输出文本字段,key 英文 snake_case

**输出严格 JSON,不要任何前后文字 / Markdown / 代码围栏**:
{
  "rewrites": [
    {
      "key": "<必须命中现有默认列的 key,一字不差>",
      "label": "<可选,新的中文短标签 ≤14字;不改就省略此字段>",
      "description": "<可选,新的中文 ≤40字 说明;不改就省略>",
      "ai_prompt_template": "<可选,新的 ≤220字 中文 prompt,必含 {{paper}};不改就省略>",
      "reasoning": "<≤40字 为什么本项目需要这样改写>"
    }
  ],
  "suggestions": [
    {
      "key": "<英文 snake_case,简短>",
      "label": "<中文短标签 ≤10字>",
      "description": "<≤30字 说明这个字段干啥>",
      "is_quantitative": <true|false>,
      "ai_prompt_template": "<≤220字 中文 prompt,必含 {{paper}}>",
      "reasoning": "<≤40字 中文,说明为什么这个项目特别需要这列>"
    }
  ],
  "overall_reasoning": "<≤140字 中文,总览思路 — 学科与协议怎么驱动你的 rewrites + suggestions>"
}`

export function buildSuggestColumnsPrompt({ project, protocol, existingColumns, existingKeys }) {
  const p = project || {}
  const pr = protocol || {}
  const lines = []
  lines.push('请基于以下项目信息,做两件事:')
  lines.push('  (A) **rewrites** — 把通用默认列改写成贴合本项目学科 / 协议的表达;')
  lines.push('  (B) **suggestions** — 反推 3-6 个本项目专属新列(通用列覆盖不到的)。')
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

  // 现有列详情 — 必须给 AI 看到当前 label/description 才能判断哪些需要改写。
  // 为了让 haiku 反应快,只发 key/label/desc,不发当前 ai_prompt_template(太长且 AI 改写时会重新写)。
  const cols = Array.isArray(existingColumns) ? existingColumns : []
  if (cols.length) {
    lines.push('')
    lines.push('## 现有列(rewrites 只能命中以下 default 列的 key,suggestions 不要重复任何 key)')
    for (const c of cols) {
      const flag = c.is_default ? '[默认]' : '[用户自加]'
      const desc = c.description ? ' — ' + String(c.description).slice(0, 50) : ''
      lines.push(`- \`${c.key}\` ${flag} ${c.label || ''}${desc}`)
    }
  } else if (existingKeys && existingKeys.length) {
    lines.push('')
    lines.push('已有列 keys(不要重复):')
    lines.push(existingKeys.join(' / '))
  }

  lines.push('')
  lines.push('请输出 JSON:{ rewrites: [...], suggestions: [...], overall_reasoning }。')
  lines.push('注意:rewrites 是改写**现有**默认列的表述;suggestions 是**新增**列。两者都是数组,可以为空(但 suggestions 至少给 1 个,rewrites 通常 3-8 个)。')
  return lines.join('\n')
}

/**
 * 解析 LLM 的 suggest-columns 输出 → 安全字段数组
 *   - existingKeys: 已存在列 keys(用于 suggestions 去重 + rewrites 命中校验)
 *   - defaultKeys: 默认列 keys(rewrites 只允许命中 is_default=1 的列)
 */
export function normalizeSuggestColumns(raw, { existingKeys, defaultKeys } = {}) {
  if (!raw || typeof raw !== 'object') return { suggestions: [], rewrites: [], overall_reasoning: '' }
  // 剥 wrapper
  let r = raw
  for (let i = 0; i < 3; i++) {
    if (Array.isArray(r.suggestions) || Array.isArray(r.rewrites)) break
    const inner = r.result || r.data || r.output || r.response
    if (inner && typeof inner === 'object') r = inner
    else break
  }

  const known = new Set((existingKeys || []).map((k) => String(k).toLowerCase()))
  const allowedRewriteKeys = new Set(
    (defaultKeys && defaultKeys.length ? defaultKeys : existingKeys || []).map((k) => String(k).toLowerCase())
  )

  // suggestions
  const suggestionsOut = []
  if (Array.isArray(r.suggestions)) {
    for (const item of r.suggestions.slice(0, 8)) {
      if (!item || typeof item !== 'object') continue
      const key = String(item.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40)
      if (!key || known.has(key)) continue
      const label = String(item.label || '').trim().slice(0, 30)
      if (!label) continue
      suggestionsOut.push({
        key,
        label,
        description: String(item.description || '').trim().slice(0, 120),
        is_quantitative: !!item.is_quantitative,
        ai_prompt_template: String(item.ai_prompt_template || '').trim().slice(0, 800),
        reasoning: String(item.reasoning || '').trim().slice(0, 200),
      })
    }
  }

  // rewrites — 只接受命中已有默认列的 key,且至少有一个字段需要改写
  const rewritesOut = []
  if (Array.isArray(r.rewrites)) {
    const seenKeys = new Set()
    for (const item of r.rewrites.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue
      const key = String(item.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40)
      if (!key || seenKeys.has(key)) continue
      if (!allowedRewriteKeys.has(key)) continue
      const label = item.label != null ? String(item.label).trim().slice(0, 40) : null
      const description = item.description != null ? String(item.description).trim().slice(0, 200) : null
      let promptTpl = item.ai_prompt_template != null ? String(item.ai_prompt_template).trim().slice(0, 1000) : null
      // ai_prompt_template 若改写,必须含 {{paper}};否则丢弃此字段(只接受 label/description 的改写)
      if (promptTpl && !promptTpl.includes('{{paper}}')) promptTpl = null
      // 至少要有一个字段非空才记录
      const hasAny = (label && label.length) || (description && description.length) || (promptTpl && promptTpl.length)
      if (!hasAny) continue
      seenKeys.add(key)
      rewritesOut.push({
        key,
        label,
        description,
        ai_prompt_template: promptTpl,
        reasoning: String(item.reasoning || '').trim().slice(0, 200),
      })
    }
  }

  return {
    suggestions: suggestionsOut,
    rewrites: rewritesOut,
    overall_reasoning: String(r.overall_reasoning || '').trim().slice(0, 500),
  }
}

/**
 * 应用 AI 推荐的列改写:UPDATE matrix_columns 的 label/description/ai_prompt_template。
 *   - 只动 is_default=1 的列(避免覆盖用户自定义列)
 *   - 字段为 null 表示该字段不动(COALESCE)
 * 返回 { updated: N }
 */
export function applyColumnRewrites(db, projectId, rewrites) {
  if (!Array.isArray(rewrites) || rewrites.length === 0) return { updated: 0 }
  const stmt = db.prepare(
    `UPDATE matrix_columns
       SET label = COALESCE(?, label),
           description = COALESCE(?, description),
           ai_prompt_template = COALESCE(?, ai_prompt_template)
     WHERE project_id = ? AND key = ? AND is_default = 1`
  )
  let updated = 0
  const tx = db.transaction(() => {
    for (const rw of rewrites) {
      if (!rw || !rw.key) continue
      const r = stmt.run(
        rw.label || null,
        rw.description || null,
        rw.ai_prompt_template || null,
        projectId,
        rw.key,
      )
      if (r.changes > 0) updated += 1
    }
  })
  tx()
  return { updated }
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

// ============================================================
// AI 批量抽取 — Step 4 自动路径
//   核心思路:对每篇 include+PDF 论文,一次 LLM 调用,用 master prompt 把所有列填完。
//   结果统一写入 literature_matrix.fields(跟 xlsx 手动路径 / inline 编辑同表)。
// ============================================================

export const MATRIX_BATCH_SYSTEM = `你是一位严谨的 SLR(系统性文献综述)数据抽取助手。
我会给你一篇论文的全文 / 仅摘要 + 一个固定字段列表。请仅基于论文显式陈述的内容,
按字段列表输出一段严格 JSON,字段名一字不差。

【输出语言 — 强制】
0. 所有 [文本] 字段一律用 **English** 填写,无论原论文是中文/西班牙文/日文/还是英文。
   - 综述的最终成稿是英文,矩阵必须语言一致才能直接用在 narrative synthesis、evidence table、final manuscript 里。
   - 中文术语翻译成学术英文(higher education / "double reduction" policy 等)。
   - 英文原样保留 + 必要术语规整。
   - 人名/机构名/地名按原论文呈现(已英文就保留;中文用作者发表的英文拼写;摘要里没给就音译并加 [zh] 标注)。
   - 数字/单位/统计量用国际通用形式(SI / p<.001 / Cohen's d / Hedges' g / 95% CI)。
   - 禁止中英混写:"60 名 college students" ❌ → "60 college students" ✓。
   - 硬约束,优先级高于"忠实原文措辞"。

【输出长度 — 完整性 / 量化 / 准确性优先,不要为字符数砍信息】

最高原则:**只要是作者显式陈述的数字、效应量、CI、对照、剂量、时长、工具、概念定义 — 一律保留,不许因"太长"砍掉**。Cochrane / JBI 的 "Characteristics of included studies" 单元格 500–4000+ chars 都常见,关键是信息完备到下游做 narrative synthesis / evidence table / GRADE 评级时不必回去重读原文。

风格建议(为可读性,不是硬约束):
- **片段(fragment)而非整句**:省略冠词/连接词,用 ; / | / → 分隔多组结构化信息;
  避免 "The authors found that …" 这种综述段落口吻 — 那是 Step 6 干的事。
  例:"RCT; n=120 college students; 8-week intervention; ChatGPT-4 + reflection prompts" 比
  "This is a randomized controlled trial of 120 college students who participated in …" 好。
- 多个并列项用 ; 或换行分隔,不要写成大段叙述。
- 数字必带单位(min / week / mg / n=);统计量用国际形式(p<.001, Cohen's d=0.74, 95% CI [0.45, 1.03], Hedges' g)。

字段长度的合理范围(参考,可超 — 信息完整始终优先):
- **结构化短字段**(study_design, country, setting, study_period, sampling_method)— 通常 1–5 词 / 30–200 chars。
  例:"RCT (cluster-randomized, 2 arms)" / "Hong Kong, 3 public secondary schools" / "2022 Sept – 2023 Jan, 16-week intervention + 8-week follow-up"
- **描述性中字段**(intervention, comparator, outcomes_measured, sample_characteristics, data_collection_method, theoretical_framework)— 200–1500 chars 常见,完整 PICO + 数字 + 单位 + 工具 + 必要限定。
  例:"8-week AI-writing tutorial integrated into Year-2 English-major writing course: ChatGPT-4 (Plus tier) with metacognitive scaffolding prompts auto-injected by teacher (planning / monitoring / evaluation cues at sentence/paragraph boundaries); 45 min × 2/week × 8 weeks (16 sessions, 12 h total); teacher facilitates 10-min whole-class reflection at end of each session; control arm = identical writing tasks + same teacher + paper feedback only (no AI); pre/post writing samples + IELTS Writing Task 2 rubric (0–9 band) + Metacognitive Awareness Inventory (MAI, 52 items, 5-pt Likert)"
- **叙事字段**(key_findings, limitations, implications, mechanism_of_effect)— 400–3000 chars,
  含每个 outcome 的效应量 + CI + p + 子组分析 + 关键解释。多个 outcome 各成一段。
  例:"Writing quality: intervention M=6.8 (SD=1.1) vs control M=5.9 (SD=1.3), Hedges' g=0.74, 95% CI [0.45, 1.03], p<.001, n=120; Metacognitive awareness (MAI total): +0.42 (SD=0.21), p=.002, d=0.61; MAI sub-scale Planning d=0.83 (largest); MAI sub-scale Evaluation d=0.41; Grammar accuracy: no group difference (p=.21, ns). Mechanism: post-hoc analysis shows reflection-quality (rubric 0-3) mediated 47% of writing-quality effect, p<.01. Limitations: single site (university in eastern China), 16-week follow-up only (no 6-mo retention test), self-report MAI, no delayed post-test."

**唯一硬上限**:单 cell ≤ 5000 chars(约一页 A4 文字)— 真到这个长度通常是 LLM 在写综述段落,请砍叙事连接词,保数字保 effect size。但若是真有效应量 + CI + 子组,4000 chars 也合理。

【输出格式规则】
1. 输出**只能**是一个 JSON 代码块,不要前后加任何解释、不加 markdown 标题/列表。
2. 字段名必须**一字不差**(case-sensitive),不要省略字段、不要新增字段。
3. [数字] 字段:作者明确给的整数(如 sample_size=120 → "120")。**找不到 / 不适用 / N/A 都用空字符串 ""**(不要用 -1、0、null、"N/A"、"unknown" 等占位词,UI 会把空字符串渲染为"—")。
4. [文本] 字段:**English** 片段(参考上面三档长度);找不到 / 不适用 → 空字符串 ""(不要写 "Not reported" / "N/A" / "—" 之类的占位)。

【量化优先 — 决定综述质量的关键】
5. 对量化字段(sample_size_total / quantitative_results 等):
   - 只摘取作者**明确给出的数字 + 单位 + 上下文**(如 "n=120 学生" / "t(58)=2.31, p=.024, d=0.61")。
   - 作者若只说"显著""有效""明显改善"而**没给具体数值**,写"仅称显著未给数值"或"未报告"
   - **绝不把定性结论改写成虚构数字**(如不能把"显著高于"改写成"高出 23%")。
6. 对文本字段(intervention / key_findings 等):
   - **优先用数字描述**(如"实验组得分提升 1.2σ,p<.001")而不是只说"显著高于对照组"。
   - 时长 / 剂量 / 频率必须**带单位**(天 / 周 / mg / 次/周)。
   - 样本特征必须**带具体值**(平均年龄 ± SD、性别比例%)而不是"成年人"。

【反编造 — 重要】
7. 只摘取作者**显式陈述**的内容,不要替作者推断、不要外推。
7a. **例外:对高确定性可推断字段,允许从原文明确线索做轻量推断**(必须有原文短语锚定,不能跨论文外推):
   - study_design:从 "we randomly assigned … to … vs control" 推 "RCT";从 "pre/post survey of one cohort" 推 "single-group pre-post";从 "secondary analysis of dataset X" 推 "secondary data analysis"。
   - country_region / setting:从作者机构地址 / "in Hong Kong public secondary schools" / "n=120 medical students at McGill" 等地标推。
   - 学习者层级:"undergraduate" / "Year-2 medical students" / "K-12" / "graduate students" 等明示词照搬。
   - 这类字段如果原文有明确锚定就填,**不要因为"不是逐字陈述"而留空**。
8. 仅看到摘要时(本提示词末尾会标 abstract_only 模式):
   - 结构化摘要(尤其医学 / 教育 / 工科 STEM)经常含**简短的 method / results / 关键 outcome 数字 / 限制陈述** — 这些都该如实摘出,不要预设"摘要里没有"。
   - 摘要里**确实没**的字段才输出空字符串 ""(不要主观判断"通常没"而预先放弃)。
   - 别根据领域常识"补"作者没说的内容(如医学常见样本量、教育研究常见时长)。

【学科风格】
9. 引用术语应贴合该学科语境(协议会告诉你学科):工科用"被试 / 装置",医学用"受试者 / 队列",社科用"参与者",教育用"学习者"。`

/**
 * 从 paper_chunks 拼出全文文本(给 LLM 输入)。
 * 没 chunks 就用 abstract 兜底。truncate 到 maxChars 以保护上下文窗口。
 *
 * maxChars=250_000 ≈ 62K tokens(中英混合 ~4 char/token)。给 Claude 4.7 1M
 * window 留出充足 thinking + output 空间;覆盖 95%+ 论文全文(典型 STEM 论文
 * 正文 50-150K chars,长综述 / 大型 RCT 偶尔超 200K)。
 * 历史上这里是 80K,对 200K window 时代合理,对 1M 模型偏小 → 升到 250K。
 */
export function buildPaperTextFromChunks(db, recordId, record, { maxChars = 250_000 } = {}) {
  const chunks = db.prepare(`
    SELECT section_type, heading, text, chunk_index, page_start
      FROM paper_chunks
     WHERE record_id = ?
     ORDER BY chunk_index ASC, page_start ASC
  `).all(recordId)

  // LLM prompt 里也用清洗后的主标题 — 否则 LLM 会把"; [翻译]"误读成标题一部分,
  // 抽取出来的 Title 字段塞翻译版,矩阵/综述/参考文献都会被污染。
  const __cleanTitle = cleanBilingualTitle(record?.title || '').title

  if (chunks.length === 0) {
    const abstract = String(record?.abstract || '').trim()
    if (!abstract) return { text: '', source: 'none', truncated: false }
    return {
      text: `## Title\n${__cleanTitle}\n\n## Abstract\n${abstract}`,
      source: 'abstract_only',
      truncated: false,
    }
  }

  // 按 section 拼,保留结构感,LLM 抽取更准
  let out = `## Title\n${__cleanTitle}\n\n`
  if (record?.abstract) out += `## Abstract\n${record.abstract}\n\n`
  let bySection = new Map()
  for (const c of chunks) {
    const k = c.section_type || 'other'
    if (!bySection.has(k)) bySection.set(k, [])
    bySection.get(k).push(c)
  }
  // 按常见顺序输出
  const order = ['introduction', 'background', 'related_work', 'methods', 'methodology',
                 'results', 'findings', 'discussion', 'conclusion', 'limitations', 'other']
  const sections = [
    ...order.filter((s) => bySection.has(s)),
    ...[...bySection.keys()].filter((s) => !order.includes(s)),
  ]
  for (const s of sections) {
    out += `## ${s}\n`
    for (const c of bySection.get(s)) {
      if (c.heading) out += `### ${c.heading}\n`
      out += `${c.text}\n\n`
    }
  }

  let truncated = false
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + '\n\n[...全文已在此处截短,模型只看到前 ' + maxChars + ' 字符]'
    truncated = true
  }
  return { text: out, source: 'chunks', truncated, chunkCount: chunks.length }
}

/**
 * 构造给 batch runner 用的 master user-prompt(把 buildMasterExtractionPrompt 的人类版
 * <在此粘贴论文全文> 占位符替换成真实文本)。
 *   - 列定义 / 字段说明 / JSON schema 跟人类版一致,确保两条路径产出可对齐
 *   - 末尾的论文全文已注入
 */
export function buildAutomatedMasterPrompt(db, projectId, project, record, paperText, opts = {}) {
  const paperSource = opts.paperSource || 'chunks'   // 'chunks' | 'abstract_only' | 'none'
  // variant='batch' 拿优化版的批量抽取专属 prompt(若有);否则走默认 copy 模板
  const base = buildMasterExtractionPrompt(db, projectId, project, { variant: 'batch' })
  // 去掉末尾的"## 论文 …"占位段,替换成真实论文文本
  const trimmed = base.replace(/## 论文[\s\S]*$/, '').trimEnd()

  // 输入声明:让 LLM 知道这次拿到的是全文还是仅摘要,严格不编造
  let sourceWarning = ''
  if (paperSource === 'abstract_only') {
    sourceWarning =
      '\n\n## ⚠️ 输入声明 — abstract_only 模式\n' +
      '本次只提供论文的 **标题 + 作者 + 摘要 + 元数据**(无全文 PDF)。请严格遵守:\n' +
      '1. 只填摘要里**显式提到**的字段。摘要确实没的字段(包括 [数字] 和 [文本])一律输出空字符串 ""(不要写 "Not reported" / "未提及" / -1 / 0 / "N/A" 之类的占位词,UI 会渲染为 "—")。\n' +
      '2. **绝不**根据领域常识"补"作者没说的内容(如医学常见样本量、教育研究常见时长)。\n' +
      '3. **绝不**把定性描述("有效改善")改写成数字("提升 23%")。\n' +
      '4. 但**不要预设"通常没就不填"** — 结构化摘要(尤其医学 / 教育 / 工科 STEM)经常含简短的 method / results / 关键 outcome 数字 / 局限性陈述。逐字段过一遍摘要,有就摘,没才空。\n' +
      '5. 高确定性可推断字段(study_design / country_region / 学习者层级)允许从摘要明确线索锚定推断:从 "RCT", "randomized", "pre/post survey" 等关键词推设计;从 "in Hong Kong", "n=120 Year-2 medical students" 推地区 / 层级。这类字段不要因为"非逐字"就留空。\n' +
      '6. 在 study_design / population / intervention 这种摘要里通常会说的字段,优先直接摘自摘要原文。'
  } else if (paperSource === 'none') {
    sourceWarning =
      '\n\n## ⚠️ 输入声明 — 无任何论文文本\n' +
      '没有任何可读的论文内容。所有字段(包括数字)一律输出空字符串 "",不要编造、不要用 -1/0/"N/A" 占位。'
  } else {
    sourceWarning =
      '\n\n## ✓ 输入声明 — 全文模式\n' +
      '本次提供论文全文(可能截短)。请尽可能从全文里抽取每个字段,**优先量化**(数字 + 单位 + 上下文)。'
  }

  return trimmed + sourceWarning +
    '\n\n## 论文文本\n```\n' +
    String(paperText || '').slice(0, 120_000) +
    '\n```\n\n请按上面"输出格式"输出一段 JSON。'
}

/**
 * 解析 LLM 输出的字段 JSON → 安全的 { key: value } 对象。
 * 只接受 columns 里定义过的 key;[数字] 列尝试 parseInt,其余 toString。
 * 返回 { fields, kept, skipped: { unknown_keys: [...], invalid: [...] } }
 */
// 哨兵词:历史上 prompt 让 LLM 用这些表达"没找到/不适用",现在统一变成 "" 不入库。
// 数字字段:-1 / "-1" 也要剔(早期 prompt 设计)
const MISSING_TEXT_SENTINELS = new Set([
  '', '—', '-', 'n/a', 'na', 'none', 'null', 'undefined',
  '未报告', '未提及', '未明确', '未说明', '未注明', '不适用',
  'not reported', 'not specified', 'not stated', 'not mentioned',
  'not applicable', 'unspecified', 'unknown',
])
function isMissingText(s) {
  if (s == null) return true
  const t = String(s).trim().toLowerCase()
  if (!t) return true
  if (MISSING_TEXT_SENTINELS.has(t)) return true
  // "n=N/A" 这种边角
  if (/^[-=:\s]*(n\/a|na|none|null|未报告|未提及|未说明)[-=:\s]*$/i.test(t)) return true
  return false
}

export function parseMatrixBatchOutput(raw, columns) {
  if (!raw || typeof raw !== 'object') {
    return { fields: {}, kept: 0, skipped: { unknown_keys: [], invalid: ['raw_not_object'] } }
  }
  // 剥常见 wrapper
  let r = raw
  for (let i = 0; i < 3; i++) {
    if (columns.some((c) => Object.prototype.hasOwnProperty.call(r, c.key))) break
    const inner = r.result || r.data || r.output || r.response || r.fields
    if (inner && typeof inner === 'object') r = inner
    else break
  }
  const keyToCol = new Map(columns.map((c) => [c.key, c]))
  const fields = {}
  const unknownKeys = []
  let kept = 0
  for (const [k, v] of Object.entries(r)) {
    const col = keyToCol.get(k)
    if (!col) { unknownKeys.push(k); continue }
    if (v == null) continue
    if (col.is_quantitative) {
      const n = parseInt(v, 10)
      // 历史 prompt 让 LLM 用 -1 = 没找到、0 = 不适用 — 现在两者都视为"没值"不入库,
      // 显示层就只有"数字" 或 "—"两种状态,不会再看到 -1 / 0 的诡异值。
      // 真正"零样本"的论文(综述/方法论文)极少,且通常 study_design 字段已经说明白了。
      if (Number.isFinite(n) && n > 0) {
        fields[k] = String(n)
        kept++
      }
      // n <= 0 / NaN / 字符串数字解析失败 → 不入库,显示层渲染 "—"
    } else {
      // 5000 chars 上限:跟 prompt 的"硬上限 ≤ 5000"对齐。
      // 之前是 1800,太紧 — 一个 narrative 字段(key_findings 含多 outcome + effect size + CI)
      // 很容易超 1800 然后被砍掉关键统计量。
      const s = String(v).trim().slice(0, 5000)
      if (s && !isMissingText(s)) {
        fields[k] = s
        kept++
      }
    }
  }
  return { fields, kept, skipped: { unknown_keys: unknownKeys, invalid: [] } }
}

// ============================================================
// 一键优化总 prompt — 每个协议版本一次
//   输入:协议 + 当前列定义(含 AI 定制列)+ 3-5 篇代表性 include 论文标题+摘要
//   LLM 输出 JSON:{ batch_prompt, copy_prompt, rationale }
//     batch_prompt — 给系统跑批量抽取的版本(精炼指令 + few-shot,稍长)
//     copy_prompt  — 给用户复制到 ChatGPT/Claude 的简化版(去 few-shot,≈1-2KB)
//   写入 projects.matrix_master_prompt_{batch,copy} + _at_version。
// ============================================================

export const OPTIMIZE_PROMPT_SYSTEM = `你是 prompt 工程专家,专注帮 SLR(系统性文献综述)项目优化文献矩阵抽取的"总 prompt"。

任务:给定一个项目的协议、矩阵列定义、3-5 篇代表性 include 论文样本,产出两个版本的优化 prompt:
  1) batch_prompt — 给系统跑批量自动抽取用,可以更详细、可含 few-shot 示例(基于样本论文)、强调易错点
  2) copy_prompt  — 给用户复制到外部 AI 平台(ChatGPT / Claude / Gemini)用,简洁、去掉 few-shot 和过细规则,只保留核心指令 + 列定义 + JSON 模板

设计原则:
- batch_prompt 长度上限 ~6000 字符;copy_prompt 上限 ~3000 字符
- 都要明确"输出语言一律 English"约束(综述成稿是英文)
- 都要保留三档长度建议(short 30-150 / medium 200-800 / narrative 400-1500,硬上限 2000)
- 都要保留"只摘取作者显式陈述"反编造约束
- batch_prompt 可以基于样本论文给 1-2 个填写示例(few-shot),让模型更准
- copy_prompt 不要 few-shot,只描述规则 — 用户复制方便
- 输出 JSON,字段名一字不差

输出格式(严格 JSON):
{
  "batch_prompt": "...",
  "copy_prompt": "...",
  "rationale": "200 字内,简述你做的关键定制(贴合本项目领域 / 强调的易错点 / few-shot 选择理由 等)"
}`

/**
 * 抽 N 篇代表性 include 论文(有 abstract、按年份分散)— 给 LLM 做样本输入。
 */
function sampleRepresentativeIncludeRecords(db, projectId, n = 4) {
  const rows = db.prepare(`
    SELECT r.id, r.title, r.year, r.journal, r.abstract
      FROM records r
      INNER JOIN screening_decisions sd
         ON sd.record_id = r.id AND sd.project_id = r.project_id
        AND sd.human_decision = 'include'
     WHERE r.project_id = ?
       AND (r.duplicate_of_record_id IS NULL OR r.duplicate_of_record_id = '')
       AND r.abstract IS NOT NULL AND length(r.abstract) > 200
     ORDER BY r.year DESC, r.id
  `).all(projectId)
  if (rows.length <= n) return rows
  // 简单均匀采样:取首、尾、中间
  const picks = new Set()
  picks.add(0); picks.add(rows.length - 1)
  const step = Math.floor(rows.length / n)
  for (let i = 1; picks.size < n && i < n; i++) picks.add(i * step)
  return [...picks].sort((a, b) => a - b).slice(0, n).map((i) => rows[i])
}

/**
 * 把 protocol 行(JSON 字段是字符串)解析为数组,跟 routes/projects/index.js parseProtocol 一致。
 *   research_questions / inclusion_criteria / exclusion_criteria / concept_groups 都是 TEXT(JSON)
 * 容错:解析失败返回空数组。
 */
function parseProtocolJsonArr(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const x = JSON.parse(raw)
    return Array.isArray(x) ? x : []
  } catch { return [] }
}

/** 把任意 criterion item 归一为字符串(支持 string / {text}/ {label} / 任意 object) */
function criterionText(c) {
  if (typeof c === 'string') return c.trim()
  if (c && typeof c === 'object') {
    return String(c.text || c.label || c.description || JSON.stringify(c)).trim()
  }
  return ''
}

/**
 * 构造给 OPTIMIZE_PROMPT_SYSTEM 用的 user prompt。
 * 输入维度:
 *   1) 当前默认总 prompt(优化基线 — 让 LLM 知道要改什么)
 *   2) 项目元信息(title / discipline / topic / goal / 年份)
 *   3) **已审批协议完整字段**(research_questions / 完整 inclusion-exclusion / concept_groups / review_type / rationale / notes)
 *      ← 之前漏掉的关键部分。协议是 SLR 的"宪法",批量抽取的 prompt 必须严格贴合,否则抽出来的内容跟综述目标对不上。
 *   4) 当前矩阵列定义(含 AI 定制列)
 *   5) 3-5 篇代表性 include 论文样本(title + abstract)
 */
export function buildOptimizePromptUserPrompt(db, projectId, project, protocol) {
  const columns = listColumns(db, projectId)
  const samples = sampleRepresentativeIncludeRecords(db, projectId, 4)

  // 协议字段反序列化(DB 里都是 JSON 字符串,不解析直接传会丢)
  const researchQuestions = parseProtocolJsonArr(protocol?.research_questions)
  const inclusionCriteria = parseProtocolJsonArr(protocol?.inclusion_criteria)
  const exclusionCriteria = parseProtocolJsonArr(protocol?.exclusion_criteria)
  const conceptGroups     = parseProtocolJsonArr(protocol?.concept_groups)

  const lines = []

  // (1) 优化基线
  lines.push('## 当前默认总 prompt(优化基线)')
  lines.push('```')
  lines.push(buildMasterExtractionPrompt(db, projectId, project, { variant: 'copy' }).slice(0, 3500))
  lines.push('```')
  lines.push('')

  // (2) 项目元信息
  lines.push('## 项目元信息')
  if (project?.title)      lines.push(`- 项目标题:${project.title}`)
  if (project?.discipline) lines.push(`- 学科:${project.discipline}`)
  if (project?.topic)      lines.push(`- 主题:${project.topic}`)
  if (project?.goal)       lines.push(`- 研究目标:${project.goal}`)
  if (project?.year_start || project?.year_end) {
    lines.push(`- 年份范围:${project.year_start || '?'} – ${project.year_end || '?'}`)
  }
  lines.push('')

  // (3) 已审批协议 — 完整字段,batch_prompt 必须严格贴合
  lines.push(`## 已审批协议 v${protocol?.version || '?'}(关键依据 — batch_prompt 必须严格贴合每一项)`)

  if (protocol?.recommended_review_type) {
    lines.push(`### Review 类型`)
    lines.push(`${protocol.recommended_review_type}`)
    lines.push('')
  }

  if (researchQuestions.length) {
    lines.push(`### 研究问题(${researchQuestions.length} 条 — 全文)`)
    for (const q of researchQuestions) {
      const t = criterionText(q)
      if (t) lines.push(`- ${t}`)
    }
    lines.push('')
  }

  if (conceptGroups.length) {
    lines.push(`### 概念组(跨库共用 PICO / 抽取焦点 — 必须在 prompt 里强调这些原词不要意译丢)`)
    for (const g of conceptGroups) {
      if (!g || typeof g !== 'object') continue
      const name = g.name || g.concept || g.label || '(unnamed)'
      const terms = Array.isArray(g.terms) ? g.terms : (Array.isArray(g.keywords) ? g.keywords : [])
      const role = g.role || g.pico_role || ''
      const head = role ? `**${name}** [${role}]` : `**${name}**`
      lines.push(`- ${head}`)
      if (g.description) lines.push(`  说明:${String(g.description).slice(0, 240)}`)
      if (terms.length) {
        const sample = terms.slice(0, 10).map((t) => typeof t === 'string' ? t : (t.term || JSON.stringify(t))).join(', ')
        lines.push(`  关键词样本:${sample}${terms.length > 10 ? ` … 共 ${terms.length} 个` : ''}`)
      }
    }
    lines.push('')
  }

  if (inclusionCriteria.length) {
    lines.push(`### 纳入标准(${inclusionCriteria.length} 条 — 全文,不截断)`)
    for (const c of inclusionCriteria) {
      const t = criterionText(c)
      if (t) lines.push(`- ${t}`)
    }
    lines.push('')
  }

  if (exclusionCriteria.length) {
    lines.push(`### 排除标准(${exclusionCriteria.length} 条 — 全文,不截断)`)
    for (const c of exclusionCriteria) {
      const t = criterionText(c)
      if (t) lines.push(`- ${t}`)
    }
    lines.push('')
  }

  if (protocol?.rationale) {
    lines.push(`### Rationale(协议生成时的方法学考量)`)
    lines.push(String(protocol.rationale).slice(0, 1500))
    lines.push('')
  }

  if (protocol?.notes) {
    lines.push(`### 用户补充 notes`)
    lines.push(String(protocol.notes).slice(0, 1000))
    lines.push('')
  }

  // (4) 矩阵列定义
  lines.push(`## 当前矩阵列(${columns.length} 个,含 AI 定制列 — batch_prompt 必须覆盖每一个 key)`)
  for (const c of columns) {
    lines.push(`- \`${c.key}\` (${c.is_quantitative ? '数字' : '文本'}) — ${c.label}`)
    if (c.description) lines.push(`  说明:${String(c.description).slice(0, 240)}`)
  }
  lines.push('')

  // (5) 代表性 include 论文样本
  lines.push(`## 代表性 include 论文样本(${samples.length} 篇 — 帮你看到本项目真实数据形态,可基于此做 few-shot)`)
  for (const r of samples) {
    lines.push(`### ${r.title || '(无标题)'} (${r.year || '?'})`)
    if (r.journal) lines.push(`*${r.journal}*`)
    lines.push(`Abstract: ${String(r.abstract).slice(0, 800)}`)
    lines.push('')
  }

  // 输出要求
  lines.push('---')
  lines.push('## 输出要求')
  lines.push('请按 system 指示输出 JSON(batch_prompt + copy_prompt + rationale)。')
  lines.push('')
  lines.push('**两个 prompt 必须做到**:')
  lines.push('- 嵌入本项目协议的核心约束 — 纳入标准里的"only RCTs"就在 study_design 字段说明里强调;概念组里的关键词(如 "metacognition / SRL / scaffolding")要在 outcomes_measured / intervention 等相关字段提醒"保留这些原词,不要意译"。')
  lines.push('- 按 review_type 调整字段措辞 — systematic review of intervention / scoping review / mixed-methods 三种的关注点不同。')
  lines.push('- 明确告诉 LLM:**输出语言一律 English**,字段名 case-sensitive 一字不差,只摘作者显式陈述。')
  lines.push('- 保留三档长度建议(short 30–150 / medium 200–800 / narrative 400–1500,硬上限 2000)。')
  lines.push('')
  lines.push('**两个 prompt 的区别**:')
  lines.push('- `batch_prompt` 可基于以上样本论文给 1-2 个 few-shot 填写示例,引用真实字段名 + 真实摘要片段,演示理想答案的颗粒度。')
  lines.push('- `copy_prompt` 不要 few-shot(用户复制累赘),只保留指令 + 列定义 + JSON 模板 + 关键约束(包括协议关键点的简短引用)。')

  return lines.join('\n')
}

/**
 * 校验并清洗 LLM 输出。
 */
export function normalizeOptimizePromptOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  const batch = typeof raw.batch_prompt === 'string' ? raw.batch_prompt.trim() : ''
  const copy  = typeof raw.copy_prompt  === 'string' ? raw.copy_prompt.trim()  : ''
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim().slice(0, 600) : ''
  if (batch.length < 500 || copy.length < 300) return null  // 明显太短不收
  return {
    batch_prompt: batch.slice(0, 12000),  // 安全上限
    copy_prompt:  copy.slice(0, 6000),
    rationale,
  }
}
