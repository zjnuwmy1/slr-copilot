/**
 * services/figures.js — Phase 9 Agent W
 * ------------------------------------------------------------
 * 综述插图生成模块。分两类:
 *
 * 一、"程序生成"(平台可直接出图,不调 LLM 也不依赖外部图像服务):
 *   - PRISMA flow diagram(Mermaid,已有 prisma-flow.js,这里直接转发)
 *   - 年度趋势(纳入论文按发表年聚合)— 返回 { years, counts },前端用纯 SVG 渲染
 *   - Evidence map(主题 × 纳入论文数 bubble)— 同样返回数据,前端 SVG
 *
 * 二、"AI 生成提示词"(平台拿不到 image gen 后端,只能输出 prompt 让用户去 ChatGPT
 *   / Midjourney / DALL-E 网页版自己生图):
 *   - Conceptual framework
 *   - Theme-relationship diagram
 *   - 美化版 selection process funnel(PRISMA flow 的演示版)
 *
 * ⚠️ 重要前提:
 *   本平台后端目前只接 Anthropic / OpenAI 的"文本模型"(claude-sonnet / gpt-5.x),
 *   通过 codex / claude CLI 或 API 调用,**文本模型不能直接画图**。
 *   真正的图像生成走 OpenAI 的 DALL-E / gpt-image-1 endpoint,需要单独的 API 和配额。
 *   因此本模块只为这类图片生成"提示词",由用户自己拿去 ChatGPT(自带 DALL-E)生成。
 */

import {
  computePrismaFlow,
  renderPrismaMermaid,
  renderPrismaTextSummary,
} from './prisma-flow.js'

// ────────────────────────────────────────────────────────────
// 一、程序可直接生成的图
// ────────────────────────────────────────────────────────────

/**
 * PRISMA flow diagram(Mermaid 文本)— 转发 prisma-flow.js 的渲染。
 * 调用方:report.ejs 已经直接用 renderPrismaMermaid;这里提供给"插图"区统一汇总用。
 */
export function generateMermaidPrismaFlow(db, projectId) {
  const counts = computePrismaFlow(db, projectId)
  return {
    counts,
    mermaid: renderPrismaMermaid(counts),
    text_summary: renderPrismaTextSummary(counts),
  }
}

/**
 * 年度发表趋势:基于"已纳入"的 records(human_verified extraction 或 final include screening)。
 * 返回 { years: [...], counts: [...], total }。years 升序连续(中间缺的年份补 0)。
 */
export function generateYearTrendData(db, projectId) {
  if (!db || !projectId) return { years: [], counts: [], total: 0 }
  let rows = []
  try {
    rows = db.prepare(`
      SELECT r.year AS year, COUNT(DISTINCT r.id) AS n
      FROM records r
      LEFT JOIN extractions e ON e.record_id = r.id
      LEFT JOIN screening_decisions sd ON sd.record_id = r.id
        AND sd.stage = 'full_text' AND sd.human_decision = 'include'
      WHERE r.project_id = ?
        AND r.year IS NOT NULL
        AND (e.human_verified = 1 OR sd.id IS NOT NULL)
      GROUP BY r.year
      ORDER BY r.year ASC
    `).all(projectId)
  } catch {
    rows = []
  }

  // 若 full_text 阶段还没用,退而其次:title_abstract include
  if (rows.length === 0) {
    try {
      rows = db.prepare(`
        SELECT r.year AS year, COUNT(DISTINCT r.id) AS n
        FROM records r
        JOIN screening_decisions sd ON sd.record_id = r.id
          AND sd.stage = 'title_abstract' AND sd.human_decision = 'include'
        WHERE r.project_id = ? AND r.year IS NOT NULL
        GROUP BY r.year
        ORDER BY r.year ASC
      `).all(projectId)
    } catch {
      rows = []
    }
  }

  if (rows.length === 0) return { years: [], counts: [], total: 0 }

  // 填补中间缺的年份
  const map = new Map()
  for (const r of rows) {
    const y = Number(r.year)
    if (!Number.isFinite(y)) continue
    map.set(y, Number(r.n) || 0)
  }
  if (map.size === 0) return { years: [], counts: [], total: 0 }

  const minY = Math.min(...map.keys())
  const maxY = Math.max(...map.keys())
  const years = []
  const counts = []
  let total = 0
  for (let y = minY; y <= maxY; y++) {
    years.push(y)
    const c = map.get(y) || 0
    counts.push(c)
    total += c
  }
  return { years, counts, total }
}

/**
 * Evidence map 数据:每个主题 × 纳入论文数。
 * 返回 [{ theme_id, name, count, description }]。
 */
export function generateEvidenceMapData(db, projectId) {
  if (!db || !projectId) return { themes: [], total_records: 0 }
  let themes = []
  try {
    themes = db.prepare(`
      SELECT id, name, description, evidence_strength, supporting_record_ids
      FROM themes
      WHERE project_id = ?
      ORDER BY COALESCE(display_order, 9999), created_at ASC
    `).all(projectId)
  } catch {
    return { themes: [], total_records: 0 }
  }

  let totalRecords = 0
  const out = themes.map((t) => {
    let ids = []
    try {
      const x = JSON.parse(t.supporting_record_ids || '[]')
      if (Array.isArray(x)) ids = x
    } catch {}
    totalRecords += ids.length
    return {
      theme_id: t.id,
      name: t.name || '(未命名主题)',
      description: t.description || '',
      evidence_strength: t.evidence_strength || null,
      count: ids.length,
    }
  })

  return { themes: out, total_records: totalRecords }
}

// ────────────────────────────────────────────────────────────
// 二、AI 生成提示词(给用户拿去 ChatGPT 自己跑)
// ────────────────────────────────────────────────────────────

/**
 * 根据项目实际数据(主题 / 关键 findings)生成 3 类常见 SLR 插图的提示词。
 * 这些提示词专门为"扔进 ChatGPT 网页版(自带 DALL-E)/ Midjourney / Stable Diffusion"
 * 设计,所以风格说明是"学术插图 / 黑白线条 / 不要 cartoon",输出建议 SVG 矢量。
 *
 * @returns Array<{ id, title, prompt, when_to_use, copy_hint }>
 */
export function generateFigurePrompts(db, projectId) {
  // 拉项目基础信息 + themes(用于注入个性化内容)
  let project = null
  try {
    project = db.prepare(
      `SELECT id, title, topic, discipline FROM projects WHERE id = ?`
    ).get(projectId)
  } catch {}

  const ev = generateEvidenceMapData(db, projectId)
  const themes = ev.themes
  const counts = computePrismaFlow(db, projectId)

  const topic = (project?.topic || project?.title || '(项目主题未设置)').slice(0, 200)
  const discipline = project?.discipline || ''
  const themeNames = themes.length
    ? themes.slice(0, 8).map((t, i) => `${i + 1}. ${t.name}${t.count ? `(${t.count} 篇支持)` : ''}`).join('\n   ')
    : '(主题尚未生成,请先在 Step 7 跑主题聚类)'

  const stylePreamble = `
风格要求:
- 学术插图风格,黑白或淡灰色为主,允许 1-2 个强调色(蓝 #1e40af 或绿 #047857)
- 不要 cartoon / emoji / 3D / 拟人化元素
- 字体用 sans-serif(类似 Inter / Helvetica)
- 输出 SVG 矢量(优先)或 300 DPI PNG,长宽比 16:9 或 4:3
- 文字标签使用英文(便于投稿)
`.trim()

  return [
    {
      id: 'conceptual_framework',
      title: '概念框架图(Conceptual Framework)',
      when_to_use:
        '放在 Introduction 末尾或 Methods 开头。展示本综述关注的核心变量、关系与边界。' +
        '当综述涉及多个交互概念(如 antecedents → mediators → outcomes)时尤其有用。',
      copy_hint: '复制到 ChatGPT(GPT-4 / GPT-5)对话框 → 它会调 DALL-E 出图',
      prompt: [
        `请为我画一张系统性文献综述的"概念框架图(conceptual framework)"。`,
        ``,
        `本综述主题:${topic}`,
        discipline ? `学科:${discipline}` : '',
        ``,
        `框架需要可视化的核心概念(基于本综述已聚类出的主题):`,
        `   ${themeNames}`,
        ``,
        `要求:`,
        `- 把这些主题作为"中介"或"维度"放在中间`,
        `- 左侧放 antecedents(影响因素),右侧放 outcomes(产出/影响)`,
        `- 用箭头表示假设的因果或关联方向`,
        `- 在底部用一行小字标注 "Adapted from systematic review, n=${counts.studies_included} studies"`,
        ``,
        stylePreamble,
      ].filter(Boolean).join('\n'),
    },
    {
      id: 'theme_relationship',
      title: '主题关系图(Theme Relationship Diagram)',
      when_to_use:
        '放在 Results / Discussion 章节,把多个 themes 之间的相互关系可视化。' +
        '当不同主题之间存在嵌套 / 并列 / 矛盾时,比单纯的列表更有说服力。',
      copy_hint: '复制到 ChatGPT(支持 DALL-E)或 Midjourney(/imagine 后粘贴)',
      prompt: [
        `请画一张系统性文献综述的"主题关系图",展示以下主题之间的关系。`,
        ``,
        `综述主题:${topic}`,
        ``,
        `已识别的主题:`,
        `   ${themeNames}`,
        ``,
        `要求:`,
        `- 每个主题用一个圆形或圆角矩形节点,节点大小反映支持论文数`,
        `- 主题之间用实线表示"强相关"、虚线表示"弱相关"或"矛盾"`,
        `- 把意义最接近的主题放近,不相关的拉远(类似 cluster map)`,
        `- 节点内用 1-3 个英文关键词`,
        `- 不要标题文字,留出底部空间让我自己加 caption`,
        ``,
        stylePreamble,
      ].join('\n'),
    },
    {
      id: 'selection_map',
      title: '检索筛选漏斗图(Study Selection Funnel,PRISMA 美化版)',
      when_to_use:
        '可选 — 投高质量期刊时,在 Methods / Results 用美化版漏斗替代纯 Mermaid PRISMA flow。' +
        '本平台已经程序生成了标准 PRISMA Mermaid,这个图用于"投稿排版稿"时的美化。',
      copy_hint: '复制到 ChatGPT(支持 DALL-E)→ 让它出 SVG / PDF',
      prompt: [
        `请画一张系统综述的"研究筛选漏斗图(study selection funnel)",`,
        `视觉化下面的 PRISMA 2020 流程数字:`,
        ``,
        `1. Records identified: ${counts.records_identified_total}`,
        `2. After duplicates removed: ${counts.records_screened} (removed ${counts.duplicates_removed})`,
        `3. Title/abstract excluded: ${counts.excluded_title_abstract}`,
        `4. Full-text assessed: ${counts.full_text_assessed}`,
        `5. Full-text excluded: ${counts.full_text_excluded}`,
        `6. Studies included: ${counts.studies_included}`,
        ``,
        `要求:`,
        `- 漏斗从上至下逐渐变窄,每层标数字`,
        `- 右侧用一行小字标 "excluded: n=X" 表示该层排除数`,
        `- 顶部三个来源数据库分别用三个小入口汇入(如果有多个数据库)`,
        `- 不需要标题`,
        ``,
        stylePreamble,
      ].join('\n'),
    },
  ]
}

// ────────────────────────────────────────────────────────────
// SVG helpers — 供 ejs 调用,在视图层直接 <%- ... %>
// ────────────────────────────────────────────────────────────

/**
 * 渲染年度趋势条形图为 inline SVG 字符串。
 * 简洁实现:不依赖前端图表库,直接生成 SVG。
 */
export function renderYearTrendSvg(data, { width = 520, height = 180 } = {}) {
  if (!data || !Array.isArray(data.years) || data.years.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '"><text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="sans-serif">暂无年度数据(尚无已纳入论文)</text></svg>'
  }
  const { years, counts } = data
  const max = Math.max(1, ...counts)
  const pad = { l: 28, r: 12, t: 14, b: 28 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const barW = Math.max(4, Math.floor(innerW / years.length) - 4)
  const step = innerW / years.length

  const bars = years
    .map((y, i) => {
      const c = counts[i]
      const h = (c / max) * innerH
      const x = pad.l + i * step + (step - barW) / 2
      const yPos = pad.t + (innerH - h)
      return `<rect x="${x.toFixed(1)}" y="${yPos.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" fill="#1e40af" rx="2"/>` +
        (c > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(yPos - 2).toFixed(1)}" text-anchor="middle" fill="#1e40af" font-size="9" font-family="sans-serif">${c}</text>` : '')
    })
    .join('')

  // x 轴标签:稀疏化避免重叠(每 N 个一标)
  const labelStride = Math.max(1, Math.floor(years.length / 8))
  const labels = years
    .map((y, i) => {
      if (i % labelStride !== 0 && i !== years.length - 1) return ''
      const x = pad.l + i * step + step / 2
      return `<text x="${x.toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" fill="#64748b" font-size="10" font-family="sans-serif">${y}</text>`
    })
    .join('')

  // y 轴最大值
  const yLabel = `<text x="${pad.l - 4}" y="${(pad.t + 8).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="sans-serif">${max}</text>` +
                 `<text x="${pad.l - 4}" y="${(pad.t + innerH).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="sans-serif">0</text>`

  // 基线
  const axis = `<line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="#cbd5e1" stroke-width="1"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    axis + yLabel + bars + labels +
    '</svg>'
}

/**
 * 渲染 evidence map 为 inline SVG(简化版:横条 + 数字标注)。
 */
export function renderEvidenceMapSvg(data, { width = 520 } = {}) {
  const themes = (data && Array.isArray(data.themes)) ? data.themes : []
  if (themes.length === 0) {
    const h = 80
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}"><text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="sans-serif">暂无主题(Step 7 主题聚类尚未运行)</text></svg>`
  }
  const rowH = 22
  const pad = { l: 8, r: 8, t: 8, b: 8 }
  const labelW = Math.min(180, Math.floor(width * 0.4))
  const barAreaW = width - pad.l - pad.r - labelW - 40
  const max = Math.max(1, ...themes.map((t) => t.count || 0))
  const height = pad.t + pad.b + themes.length * rowH

  const rows = themes
    .map((t, i) => {
      const y = pad.t + i * rowH
      const w = ((t.count || 0) / max) * barAreaW
      const labelText = (t.name || '').slice(0, 26)
      const strengthColor = ({
        strong: '#047857',
        moderate: '#1e40af',
        weak: '#a16207',
        mixed: '#7c2d12',
      })[t.evidence_strength] || '#475569'
      return [
        `<text x="${pad.l + labelW - 6}" y="${y + 14}" text-anchor="end" fill="#334155" font-size="11" font-family="sans-serif">${escapeXml(labelText)}</text>`,
        `<rect x="${pad.l + labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" fill="${strengthColor}" opacity="0.85" rx="2"/>`,
        `<text x="${(pad.l + labelW + w + 4).toFixed(1)}" y="${y + 14}" fill="#475569" font-size="10" font-family="sans-serif">${t.count}</text>`,
      ].join('')
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${rows}</svg>`
}

function escapeXml(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
