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
 *     "step_model":     { "protocol_gen": "claude-opus-4-7", ... },
 *     "step_reasoning": { "protocol_gen": "ultrathink", ... }
 *   }
 *   key 必须在 STEP_SPECS(services/settings.js)里。
 *   value 可以是具体型号名(claude-opus-4-7 / gpt-5.5 / ...)或别名(flagship/standard/light)。
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
        protocol_gen:    'claude-opus-4-7',
        search_strategy: 'claude-opus-4-7',
        screening:       'claude-opus-4-7',
        extraction:      'claude-opus-4-7',
        synthesis:       'claude-opus-4-7',
        drafting:        'claude-opus-4-7',
        iteration:       'claude-opus-4-7',
      },
      step_reasoning: {
        protocol_gen:    'ultrathink',
        search_strategy: 'ultrathink',
        screening:       'think_hard',     // 批量,ultrathink 太慢
        extraction:      'ultrathink',
        synthesis:       'ultrathink',
        drafting:        'think_harder',
        iteration:       'ultrathink',
      },
    },
  },

  balanced: {
    label: '平衡(推荐 · 默认)',
    description: '日常 SLR 推荐。基础设施 Opus + ultrathink,批量步骤 Sonnet/Opus + think_harder。',
    is_default: 1,
    config: {
      step_model: {
        protocol_gen:    'claude-opus-4-7',
        search_strategy: 'claude-opus-4-7',
        screening:       'claude-sonnet-4-6',
        extraction:      'claude-opus-4-7',
        synthesis:       'claude-opus-4-7',
        drafting:        'claude-opus-4-7',
        iteration:       'claude-opus-4-7',
      },
      step_reasoning: {
        protocol_gen:    'ultrathink',
        search_strategy: 'think_harder',
        screening:       'think',
        extraction:      'think_harder',
        synthesis:       'ultrathink',
        drafting:        'think_harder',
        iteration:       'ultrathink',
      },
    },
  },

  economy: {
    label: '经济',
    description: '快速 + 省 token。适合试验性项目 / 预算紧 / 急着出初稿看效果。Haiku/Sonnet 为主。',
    is_default: 0,
    config: {
      step_model: {
        protocol_gen:    'claude-sonnet-4-6',
        search_strategy: 'claude-sonnet-4-6',
        screening:       'claude-haiku-4-5',
        extraction:      'claude-sonnet-4-6',
        synthesis:       'claude-opus-4-7',   // 综合还是上 Opus,影响整篇质量
        drafting:        'claude-sonnet-4-6',
        iteration:       'claude-opus-4-7',   // 复盘也上 Opus,频率低
      },
      step_reasoning: {
        protocol_gen:    'think_hard',
        search_strategy: 'think_hard',
        screening:       'off',
        extraction:      'think_hard',
        synthesis:       'think_harder',
        drafting:        'think_hard',
        iteration:       'think_harder',
      },
    },
  },
}

/**
 * Bootstrap:确保 3 个预设都在表里。已存在不动(可能超管改过)。
 * 也保证恰好一条 is_default = 1(数据被人手动篡改时兜底)。
 */
export function seedDefaultPresets(db) {
  for (const id of PRESET_IDS) {
    const existing = db.prepare('SELECT id FROM step_model_presets WHERE id = ?').get(id)
    if (!existing) {
      const def = DEFAULT_PRESETS[id]
      if (!def) continue
      db.prepare(
        `INSERT INTO step_model_presets (id, label, description, config_json, is_default)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, def.label, def.description, JSON.stringify(def.config), def.is_default || 0)
    }
  }
  // 保证恰好一个 default,没有就给 balanced
  const defRow = db.prepare('SELECT id FROM step_model_presets WHERE is_default = 1 LIMIT 1').get()
  if (!defRow) {
    db.prepare(`UPDATE step_model_presets SET is_default = 1 WHERE id = 'balanced'`).run()
  }
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
         updated_at = datetime('now')
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
       SET is_default = 1, updated_by_user_id = ?, updated_at = datetime('now')
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
