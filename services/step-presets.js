/**
 * step-presets — 超管配置的 3 套"step×模型×reasoning"预设。
 *
 *   performance(高性能) / balanced(平衡 · 默认) / economy(经济)
 *
 * 数据模型:
 *   表 step_model_presets:id (枚举 3 个固定值) / label / description /
 *                          config_json / is_default / updated_by / 时间戳
 *   users.step_model_preset:用户选了哪个预设;NULL = 用 is_default 的那个。
 *
 * 配置格式(config_json):
 *   {
 *     "step_model":     { "protocol_gen": "claude-opus-4-8", ... },
 *     "step_reasoning": { "protocol_gen": "ultrathink", ... }
 *   }
 *   key 必须在 STEP_SPECS(services/settings.js)里。
 *   value 可以是具体型号名(claude-opus-4-8 / gpt-5.5 / ...)或别名(flagship/standard/light)。
 *
 * 解析优先级(services/settings.js resolveStepModel / resolveStepReasoning):
 *   1. 用户的 preset config[step_X] →
 *   2. 兼容旧:system_settings.step_model.<step> →
 *   3. STEP_SPECS[step].defaultTier 配 provider 默认。
 */

import { audit } from './audit.js'

export const PRESET_IDS = ['performance', 'balanced', 'economy']

/**
 * 3 套默认预设。bootstrap 时如果 step_model_presets 表里相应 id 不存在就 INSERT。
 * 已存在的不会被覆盖(超管可能改过)。
 *
 * 设计基线参见用户认可的"平衡"配置 + ultrathink 推演的两端方案。
 */
export const DEFAULT_PRESETS = {
  performance: {
    label: '高性能',
    description: '不计时间,质量最大化。适合发表级 SLR / 高 stake 评审。Opus + ultrathink 满压。',
    is_default: 0,
    config: {
      step_model: {
        protocol_gen:           'claude-opus-4-8',
        search_strategy:        'claude-opus-4-8',
        screening:              'claude-opus-4-8',
        extraction:             'claude-opus-4-8',
        synthesis:              'claude-opus-4-8',
        drafting:               'claude-opus-4-8',
        iteration:              'claude-opus-4-8',
        matrix_suggest_columns:        'claude-opus-4-8',     // 改写默认列 + 反推专属列
        matrix_run_batch:              'claude-opus-4-8',     // master prompt 一篇一调
        matrix_optimize_master_prompt: 'claude-opus-4-8',     // 一次性 meta-prompt 优化,质量优先
        rob_assess_batch:              'claude-opus-4-8',     // Step 5 每篇 RoB 评估 — performance 档全 Opus
        rob_optimize_overlay:          'claude-opus-4-8',     // 一次性项目 overlay meta-prompt
        synthesis_optimize_overlay:    'claude-opus-4-8',     // Step 6 项目专用聚类指引,一次性 meta
        figure_prompts_optimize:       'claude-opus-4-8',     // Step 8 项目专属插图 prompt,一次性
        certainty:                     'claude-opus-4-8',     // Step 7 主题级 GRADE+CERQual rollup
        certainty_optimize_overlay:    'claude-opus-4-8',     // Step 7 项目专用 certainty 指引,一次性 meta
        drafting_plan:                 'claude-opus-4-8',     // Step 8 全局大纲(一次性 plan-then-write)
        drafting_optimize_overlay:     'claude-opus-4-8',     // Step 8 项目专用 drafting overlay,一次性 meta
        drafting_peer_summary:         'claude-haiku-4-5',    // Step 8 章节 150w 摘要,light 模型够
        table_recommend:               'claude-opus-4-8',     // Phase A5: 项目专属表格推荐,一次性 meta
        table_polish:                  'claude-opus-4-8',     // T3: per-table 精修(caption / headers / lead / footnotes)
        journal_template_extract:      'claude-opus-4-8',     // Step 8 一次性期刊模板抽取(v3 nested schema + per-section 引文计数,Opus 严格 + 精确)
        latex_overlay_extract:         'claude-opus-4-8',     // Step 8 LaTeX 模板抽 overlay,一次性 meta
        latex_fill:                    'claude-opus-4-8',     // Step 9 把全稿 8 章填进 LaTeX 模板,一次性大输出(16-32K tokens),Sonnet 经常 timeout
        latex_fill_section:            'claude-opus-4-8',     // Step 9 v5 分段填 — 每段 1 次 Opus 调用,5 min/段,避开 Overloaded
        latex_fill_fileops:            'claude-opus-4-8',     // Step 9 v6 文件操作模式 — Claude CLI 用 Read/Write/Edit 工具直接干,根治大段 stream timeout
      },
      step_reasoning: {
        protocol_gen:           'ultrathink',
        search_strategy:        'ultrathink',
        screening:              'think_hard',
        extraction:             'ultrathink',
        synthesis:              'ultrathink',
        drafting:               'think_harder',
        iteration:              'ultrathink',
        matrix_suggest_columns:        'think_hard',          // JSON 结构生成,think_hard 够
        matrix_run_batch:              'ultrathink',          // 每篇深度抽取
        matrix_optimize_master_prompt: 'ultrathink',          // meta-prompt 写作,最高推理
        rob_assess_batch:              'ultrathink',          // 每篇 RoB 判断 — performance 档加深
        rob_optimize_overlay:          'ultrathink',          // 一次性 meta,最高推理
        synthesis_optimize_overlay:    'ultrathink',          // Step 6 overlay meta,最高推理
        figure_prompts_optimize:       'ultrathink',          // Step 8 插图 prompt 一次性,最高推理
        certainty:                     'ultrathink',          // Step 7 主题级评估深度推理
        certainty_optimize_overlay:    'ultrathink',          // Step 7 overlay meta,最高推理
        drafting_plan:                 'ultrathink',          // performance 档大纲生成,最高推理
        drafting_optimize_overlay:     'ultrathink',          // Step 8 overlay meta,最高推理
        drafting_peer_summary:         'think',               // 150w 摘要,think 够
        table_recommend:               'ultrathink',          // Phase A5: 表格推荐 meta,最高推理
        table_polish:                  'ultrathink',          // T3: per-table 精修,最高推理
        journal_template_extract:      'ultrathink',          // Step 8 期刊模板抽取(数引文 + 嵌套 JSON)
        latex_overlay_extract:         'ultrathink',          // Step 8 LaTeX 模板 overlay
        latex_fill:                    'off',                 // Step 9 LaTeX fill — 机械任务(markdown → tex 转换 + verbatim 填模板),overlay 已做了 meta-thinking。开 reasoning 会让 Opus 在 think phase 烧 10+ min 触发 timeout,实测 think_harder 15 min 不够。off → 直接出 output。
        latex_fill_section:            'off',                 // 同 latex_fill,分段也 off
        latex_fill_fileops:            'off',                 // 文件操作模式,Claude 自己当 coding agent,不需要 reasoning
      },
    },
  },

  balanced: {
    label: '平衡(推荐 · 默认)',
    description: '日常 SLR 推荐。基础设施 Opus + ultrathink,批量步骤 Sonnet/Opus + think_harder。',
    is_default: 1,
    config: {
      step_model: {
        protocol_gen:           'claude-opus-4-8',
        search_strategy:        'claude-opus-4-8',
        screening:              'claude-sonnet-4-6',
        extraction:             'claude-opus-4-8',
        synthesis:              'claude-opus-4-8',
        drafting:               'claude-opus-4-8',
        iteration:              'claude-opus-4-8',
        matrix_suggest_columns:        'claude-sonnet-4-6',
        matrix_run_batch:              'claude-sonnet-4-6',   // 批量,Sonnet 速度 + 质量平衡
        matrix_optimize_master_prompt: 'claude-opus-4-8',     // 一次性 meta-prompt,即使 balanced 也上 Opus
        rob_assess_batch:              'claude-sonnet-4-6',   // 批量,Sonnet 读懂方法学 + JSON 输出够用;Opus×121 太贵
        rob_optimize_overlay:          'claude-opus-4-8',     // 一次性 meta-prompt,即使 balanced 也上 Opus
        synthesis_optimize_overlay:    'claude-opus-4-8',     // 一次性聚类指引,Opus 写得好
        figure_prompts_optimize:       'claude-opus-4-8',     // 一次性插图 prompt,Opus
        certainty:                     'claude-opus-4-8',     // Step 7 主题级评估,Opus 方法学判断稳
        certainty_optimize_overlay:    'claude-opus-4-8',     // 一次性 certainty 指引,Opus
        drafting_plan:                 'claude-opus-4-8',     // 一次性大纲,即使 balanced 也上 Opus
        drafting_optimize_overlay:     'claude-opus-4-8',     // Step 8 一次性 drafting overlay,Opus
        drafting_peer_summary:         'claude-haiku-4-5',    // 150w 摘要,Haiku 够
        table_recommend:               'claude-opus-4-8',     // Phase A5: 一次性表格推荐,balanced 也上 Opus
        table_polish:                  'claude-opus-4-8',     // T3: per-table 精修,balanced 也上 Opus
        journal_template_extract:      'claude-opus-4-8',     // Step 8 一次性期刊模板抽取(嵌套 JSON + per-section 引文计数),balanced 也上 Opus
        latex_overlay_extract:         'claude-opus-4-8',     // Step 8 LaTeX 模板 overlay,balanced 也上 Opus
        latex_fill:                    'claude-opus-4-8',     // Step 9 LaTeX fill,大输出 + 严格 verbatim,balanced 也上 Opus(Sonnet timeout 风险高)
        latex_fill_section:            'claude-opus-4-8',     // Step 9 v5 分段填,balanced 也上 Opus
        latex_fill_fileops:            'claude-opus-4-8',     // Step 9 v6 文件操作模式,balanced 也上 Opus
      },
      step_reasoning: {
        protocol_gen:           'ultrathink',
        search_strategy:        'think_harder',
        screening:              'think',
        extraction:             'think_harder',
        synthesis:              'ultrathink',
        drafting:               'think_harder',
        iteration:              'ultrathink',
        matrix_suggest_columns:        'think',
        matrix_run_batch:              'think_harder',
        matrix_optimize_master_prompt: 'think_harder',         // 比 columns 重,但比 ultrathink 省 token
        rob_assess_batch:              'think_harder',         // RoB 判断需要方法学推理,think_harder 比 think 稳得多
        rob_optimize_overlay:          'think_harder',         // 跟 matrix optimize 同档
        synthesis_optimize_overlay:    'think_harder',         // 跟 rob_optimize_overlay 同档
        figure_prompts_optimize:       'think_harder',         // balanced 档 figure prompt
        certainty:                     'think_harder',         // balanced 档 certainty rollup
        certainty_optimize_overlay:    'think_harder',         // balanced 档 overlay meta
        drafting_plan:                 'think_harder',         // balanced 档大纲
        drafting_optimize_overlay:     'think_harder',         // Step 8 balanced 档 overlay meta
        drafting_peer_summary:         'off',                  // 摘要无需推理
        table_recommend:               'think_harder',         // Phase A5: 表格推荐 balanced 档
        table_polish:                  'think_harder',         // T3: per-table 精修 balanced 档
        journal_template_extract:      'think_harder',         // Step 8 期刊模板抽取(数引文需要专注,balanced 档)
        latex_overlay_extract:         'think_harder',         // Step 8 LaTeX 模板 overlay
        latex_fill:                    'off',                  // Step 9 LaTeX fill — 机械任务,不开 reasoning(同 performance 档,见上方理由)
        latex_fill_section:            'off',                  // 同 latex_fill,分段也 off
        latex_fill_fileops:            'off',                  // 文件操作模式,无需 reasoning
      },
    },
  },

  economy: {
    label: '经济',
    description: '快速 + 省 token。适合试验性项目 / 预算紧 / 急着出初稿看效果。Haiku/Sonnet 为主。',
    is_default: 0,
    config: {
      step_model: {
        protocol_gen:           'claude-sonnet-4-6',
        search_strategy:        'claude-sonnet-4-6',
        screening:              'claude-haiku-4-5',
        extraction:             'claude-sonnet-4-6',
        synthesis:              'claude-opus-4-8',
        drafting:               'claude-sonnet-4-6',
        iteration:              'claude-opus-4-8',
        matrix_suggest_columns:        'claude-haiku-4-5',    // 经济档用 Haiku,~15s
        matrix_run_batch:              'claude-sonnet-4-6',
        matrix_optimize_master_prompt: 'claude-opus-4-8',     // 即使 economy 也用 Opus — 一次定终身,省这一次不值
        rob_assess_batch:              'claude-sonnet-4-6',   // 跟 matrix_run_batch 同档
        rob_optimize_overlay:          'claude-opus-4-8',     // 一次定终身,economy 也上 Opus
        synthesis_optimize_overlay:    'claude-opus-4-8',     // 同上,聚类指引也是一次性
        figure_prompts_optimize:       'claude-opus-4-8',     // 一次性,economy 也上 Opus
        certainty:                     'claude-opus-4-8',     // Step 7 主题级,economy 也用 Opus(方法学判断稳)
        certainty_optimize_overlay:    'claude-opus-4-8',     // 一次性,economy 也上 Opus
        drafting_plan:                 'claude-opus-4-8',     // 一次定终身,economy 也上 Opus
        drafting_optimize_overlay:     'claude-opus-4-8',     // Step 8 一次定终身,economy 也上 Opus
        drafting_peer_summary:         'claude-haiku-4-5',    // 摘要,Haiku 即可
        table_recommend:               'claude-opus-4-8',     // Phase A5: 一次性,economy 也上 Opus
        table_polish:                  'claude-opus-4-8',     // T3: per-table 精修,economy 也上 Opus
        journal_template_extract:      'claude-opus-4-8',     // Step 8 期刊模板,一次性 — economy 也上 Opus(数引文 + 嵌套 JSON,Sonnet 经常漏字段)
        latex_overlay_extract:         'claude-opus-4-8',     // Step 8 LaTeX 模板 overlay,economy 也上 Opus(一次定终身)
        latex_fill:                    'claude-opus-4-8',     // Step 9 LaTeX fill,economy 也上 Opus — 一次成稿不能错(Sonnet 经常 timeout / 漏 section)
        latex_fill_section:            'claude-opus-4-8',     // Step 9 v5 分段填,economy 也上 Opus
        latex_fill_fileops:            'claude-opus-4-8',     // Step 9 v6 文件操作模式,economy 也上 Opus(一次性)
      },
      step_reasoning: {
        protocol_gen:           'think_hard',
        search_strategy:        'think_hard',
        screening:              'off',
        extraction:             'think_hard',
        synthesis:              'think_harder',
        drafting:               'think_hard',
        iteration:              'think_harder',
        matrix_suggest_columns:        'off',
        matrix_run_batch:              'think',
        matrix_optimize_master_prompt: 'think_hard',           // economy 用 think_hard 而非 ultrathink,省一点 token
        rob_assess_batch:              'think',                // economy 档省 token
        rob_optimize_overlay:          'think_hard',           // 一次性,economy 用 think_hard
        synthesis_optimize_overlay:    'think_hard',           // 同上
        figure_prompts_optimize:       'think_hard',           // economy
        certainty:                     'think_hard',           // economy 档 certainty rollup
        certainty_optimize_overlay:    'think_hard',           // economy 档 overlay meta
        drafting_plan:                 'think_hard',           // economy 档大纲
        drafting_optimize_overlay:     'think_hard',           // Step 8 economy 档 overlay meta
        drafting_peer_summary:         'off',                  // 摘要无需推理
        table_recommend:               'think_hard',           // Phase A5: 表格推荐 economy 档
        table_polish:                  'think_hard',           // T3: per-table 精修 economy 档
        journal_template_extract:      'think_hard',           // Step 8 期刊模板,economy 档
        latex_overlay_extract:         'think_hard',           // Step 8 LaTeX 模板 overlay,economy 档
        latex_fill:                    'off',                  // Step 9 LaTeX fill — 机械任务,不开 reasoning(同 performance 档,见上方理由)
        latex_fill_section:            'off',                  // 同 latex_fill,分段也 off
        latex_fill_fileops:            'off',                  // 文件操作模式,无需 reasoning
      },
    },
  },
}

/**
 * Bootstrap:确保 3 个预设都在表里。
 *   - 不存在 → INSERT 完整默认
 *   - 已存在 → 只 merge 缺失的 step keys(给老版本数据库升级用,例如新增 matrix_suggest_columns
 *     不会覆盖超管已经手改过的 step,只是把缺的补上)。
 *
 * 也保证恰好一条 is_default = 1(数据被人手动篡改时兜底)。
 */
export function seedDefaultPresets(db) {
  for (const id of PRESET_IDS) {
    const def = DEFAULT_PRESETS[id]
    if (!def) continue
    const existing = db.prepare(
      'SELECT id, config_json FROM step_model_presets WHERE id = ?'
    ).get(id)
    if (!existing) {
      // 新装:INSERT 完整默认
      db.prepare(
        `INSERT INTO step_model_presets (id, label, description, config_json, is_default)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, def.label, def.description, JSON.stringify(def.config), def.is_default || 0)
    } else {
      // 已存在:只补缺 — 不覆盖超管已改过的 step。
      let cfg = {}
      try { cfg = JSON.parse(existing.config_json || '{}') } catch { cfg = {} }
      const merged = mergeMissingSteps(cfg, def.config)
      if (merged.changed) {
        db.prepare(`UPDATE step_model_presets SET config_json = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?`)
          .run(JSON.stringify(merged.config), id)
      }
    }
  }
  // 保证恰好一个 default,没有就给 balanced
  const defRow = db.prepare('SELECT id FROM step_model_presets WHERE is_default = 1 LIMIT 1').get()
  if (!defRow) {
    db.prepare(`UPDATE step_model_presets SET is_default = 1 WHERE id = 'balanced'`).run()
  }
}

// 把 default config 里缺的 step key(model + reasoning)merge 进现有 cfg,
// 不覆盖已有 step。返回 { config, changed: bool }。
function mergeMissingSteps(cfg, def) {
  const out = {
    step_model: { ...(cfg.step_model || {}) },
    step_reasoning: { ...(cfg.step_reasoning || {}) },
  }
  let changed = false
  for (const k of Object.keys(def.step_model || {})) {
    if (out.step_model[k] == null) { out.step_model[k] = def.step_model[k]; changed = true }
  }
  for (const k of Object.keys(def.step_reasoning || {})) {
    if (out.step_reasoning[k] == null) { out.step_reasoning[k] = def.step_reasoning[k]; changed = true }
  }
  return { config: out, changed }
}

/**
 * 读单个 preset。
 */
export function getPreset(db, presetId) {
  const row = db.prepare(
    `SELECT id, label, description, config_json, is_default, updated_by_user_id, updated_at
     FROM step_model_presets WHERE id = ?`
  ).get(presetId)
  if (!row) return null
  let config = {}
  try { config = JSON.parse(row.config_json || '{}') } catch { /* keep empty */ }
  return { ...row, config }
}

/**
 * 列出全部 preset(给 admin UI 渲染)。
 */
export function listPresets(db) {
  return PRESET_IDS.map((id) => getPreset(db, id)).filter(Boolean)
}

/**
 * 更新一个 preset(超管动作)。
 */
export function updatePreset(db, presetId, { label, description, config, updatedByUserId, req = null }) {
  if (!PRESET_IDS.includes(presetId)) throw new Error('invalid preset id')
  if (!config || typeof config !== 'object') throw new Error('invalid config')
  // 简单结构校验
  if (!config.step_model || !config.step_reasoning) {
    throw new Error('config must contain step_model and step_reasoning objects')
  }
  const existing = getPreset(db, presetId)
  db.prepare(
    `UPDATE step_model_presets
     SET label = COALESCE(?, label),
         description = COALESCE(?, description),
         config_json = ?,
         updated_by_user_id = ?,
         updated_at = datetime('now', '+8 hours')
     WHERE id = ?`
  ).run(
    label != null ? String(label).slice(0, 80) : null,
    description != null ? String(description).slice(0, 400) : null,
    JSON.stringify(config),
    updatedByUserId || null,
    presetId,
  )
  audit(db, req, {
    eventType: 'step_preset_updated',
    userId: updatedByUserId,
    actorUserId: updatedByUserId,
    payload: {
      preset_id: presetId,
      label_changed: !!(label && existing && label !== existing.label),
      step_model_diff: diffObject(existing?.config?.step_model, config.step_model),
      step_reasoning_diff: diffObject(existing?.config?.step_reasoning, config.step_reasoning),
    },
  })
}

/**
 * 设默认 preset(只一个生效)。
 */
export function setDefaultPreset(db, presetId, { updatedByUserId, req = null }) {
  if (!PRESET_IDS.includes(presetId)) throw new Error('invalid preset id')
  db.transaction(() => {
    db.prepare(`UPDATE step_model_presets SET is_default = 0`).run()
    db.prepare(
      `UPDATE step_model_presets
       SET is_default = 1, updated_by_user_id = ?, updated_at = datetime('now', '+8 hours')
       WHERE id = ?`
    ).run(updatedByUserId || null, presetId)
  })()
  audit(db, req, {
    eventType: 'step_preset_default_changed',
    userId: updatedByUserId,
    actorUserId: updatedByUserId,
    payload: { new_default: presetId },
  })
}

/**
 * 拿当前默认 preset 的 id。
 */
export function getDefaultPresetId(db) {
  const row = db.prepare(`SELECT id FROM step_model_presets WHERE is_default = 1 LIMIT 1`).get()
  return row ? row.id : 'balanced'
}

/**
 * 给定用户,返回 effective preset id(用户自选 OR 系统默认)。
 */
export function getEffectivePresetIdForUser(db, userId) {
  if (!userId) return getDefaultPresetId(db)
  const row = db.prepare(`SELECT step_model_preset FROM users WHERE id = ?`).get(userId)
  if (!row || !row.step_model_preset) return getDefaultPresetId(db)
  if (!PRESET_IDS.includes(row.step_model_preset)) return getDefaultPresetId(db)
  return row.step_model_preset
}

/**
 * 给定用户,返回 effective preset 的 config(已 parse,可直接用)。
 */
export function getEffectiveConfigForUser(db, userId) {
  const id = getEffectivePresetIdForUser(db, userId)
  const preset = getPreset(db, id)
  return preset ? preset.config : null
}

/**
 * 设置用户的 preset(用户自己 OR admin 代设)。
 *   presetId == null  → 清除(用 system 默认)
 *   presetId in PRESET_IDS → 设置
 */
export function setUserPreset(db, userId, presetId, { actorUserId, req = null } = {}) {
  if (presetId != null && !PRESET_IDS.includes(presetId)) {
    throw new Error('invalid preset id')
  }
  db.prepare(`UPDATE users SET step_model_preset = ? WHERE id = ?`).run(presetId, userId)
  audit(db, req, {
    eventType: 'user_step_preset_changed',
    userId: actorUserId || userId,
    actorUserId: actorUserId || userId,
    targetUserId: userId,
    payload: { user_id: userId, new_preset: presetId },
  })
}

// 小工具:对比两个 object 拿 diff 摘要(给 audit 用,避免存全量)
function diffObject(a, b) {
  if (!a || !b) return null
  const out = {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (a[k] !== b[k]) out[k] = { from: a[k] || null, to: b[k] || null }
  }
  return Object.keys(out).length ? out : null
}
