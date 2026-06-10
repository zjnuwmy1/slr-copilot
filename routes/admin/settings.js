/**
 * Admin 系统设置路由 — 当前主要是"每一步 LLM 调用使用哪个模型"。
 *
 * 整个 router 在 server.js 用 requireAdmin 中间件保护:
 *   import adminSettingsRouter from './routes/admin/settings.js'
 *   app.use('/admin/settings', requireAdmin, adminSettingsRouter)  // 在 /admin 之前
 *
 * 路径(相对挂载点 /admin/settings):
 *   GET   /        → 渲染设置页(每个 step 一组 form)
 *   POST  /        → 保存所有 step_model.<actionType> 值
 *   POST  /reset   → 清空所有 step_model.* 配置,回到默认
 */

import { Router } from 'express'
import {
  STEP_SPECS,
  STEP_KEYS,
  AVAILABLE_MODELS,
  REASONING_LEVELS_BY_PROVIDER,
  ALL_REASONING_IDS,
  getAllStepModels,
  getAllStepReasonings,
  getSetting,
  setSetting,
  getGlobalModelOverride,
  GLOBAL_MODEL_OVERRIDE_KEY,
  GLOBAL_OVERRIDE_PRESETS,
} from '../../services/settings.js'
import { audit } from '../../services/audit.js'

const router = Router()

// 合法 alias(空 = 用默认)
const VALID_ALIASES = new Set(['heavy', 'flagship', 'standard', 'light'])

// 所有具体模型 id 白名单(扁平)
const ALL_MODEL_IDS = new Set(
  Object.values(AVAILABLE_MODELS).flat().map((m) => m.id)
)

// 是否合法的 reasoning id(空 = 用默认)
function isValidReasoning(v) {
  if (v === '' || v == null) return true
  const s = String(v).trim()
  if (s === '') return true
  return ALL_REASONING_IDS.has(s)
}

function flash(req, type, message) {
  if (!req.session) return
  req.session.flash = { type, message }
}

// 是否合法 value:空(清除)/ alias / 具体模型 id
function isValidValue(v) {
  if (v === '' || v == null) return true
  const s = String(v).trim()
  if (s === '') return true
  if (VALID_ALIASES.has(s)) return true
  if (ALL_MODEL_IDS.has(s)) return true
  return false
}

// ============================================================
// GET / — 渲染配置页
// ============================================================

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const current = getAllStepModels(db)                  // model
  const currentReasoning = getAllStepReasonings(db)     // reasoning

  const configuredCount = STEP_KEYS.filter(
    (k) =>
      (current[k] && String(current[k]).trim()) ||
      (currentReasoning[k] && String(currentReasoning[k]).trim())
  ).length

  res.render('admin/settings', {
    title: '步骤模型配置',
    stepKeys: STEP_KEYS,
    stepSpecs: STEP_SPECS,
    availableModels: AVAILABLE_MODELS,
    reasoningLevels: REASONING_LEVELS_BY_PROVIDER,
    current,
    currentReasoning,
    configuredCount,
    totalCount: STEP_KEYS.length,
    globalOverride: getGlobalModelOverride(db),  // { mode, provider, model, label }
    isSuperAdmin: !!(req.user && req.user.is_super_admin),  // 全局开关只对超管展示
  })
})

// ============================================================
// POST /global-model — 全局一键开关(凌驾所有步骤配置)
//   body.mode ∈ { 'off' | 'codex' | 'claude' }
// ============================================================

router.post('/global-model', (req, res) => {
  const db = req.app.locals.db
  // 全局开关决定全平台用哪套订阅凭证 → 与平台凭证同级,仅超级管理员可改。
  if (!(req.user && req.user.is_super_admin)) {
    flash(req, 'error', '只有超级管理员可以修改全局模型开关。')
    return res.redirect('/admin/settings')
  }
  const mode = String((req.body && req.body.mode) || '').trim().toLowerCase()
  if (!['off', 'codex', 'claude'].includes(mode)) {
    flash(req, 'error', `非法的全局开关值:${mode}`)
    return res.redirect('/admin/settings')
  }

  const before = getGlobalModelOverride(db)
  try {
    if (mode === 'off') {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run(GLOBAL_MODEL_OVERRIDE_KEY)
    } else {
      setSetting(db, { key: GLOBAL_MODEL_OVERRIDE_KEY, value: mode, updatedByUserId: req.user.id })
    }
  } catch (e) {
    console.error('[admin/settings] global-model save failed:', e.message)
    flash(req, 'error', '保存失败:' + e.message)
    return res.redirect('/admin/settings')
  }

  audit(db, req, {
    eventType: 'admin_global_model_override_changed',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: { from: before.mode, to: mode },
  })

  const labels = {
    off: '已关闭全局开关 — 恢复按各步骤配置',
    codex: `已全平台强制 → ${GLOBAL_OVERRIDE_PRESETS.codex.label}(LaTeX 文件填充仍走 Claude)`,
    claude: `已全平台强制 → ${GLOBAL_OVERRIDE_PRESETS.claude.label}`,
  }
  flash(req, 'success', labels[mode])
  res.redirect('/admin/settings')
})

// ============================================================
// POST / — 保存
// ============================================================

router.post('/', (req, res) => {
  const db = req.app.locals.db
  const body = req.body || {}

  // 1. 收集 step_model.<key> 和 step_reasoning.<key> 字段
  const incomingModel = {}      // { stepKey -> trimmed value }
  const incomingReasoning = {}
  for (const field of Object.keys(body)) {
    if (field.startsWith('step_model.')) {
      const key = field.slice('step_model.'.length)
      if (!STEP_KEYS.includes(key)) {
        flash(req, 'error', `非法步骤:${key}`)
        return res.redirect('/admin/settings')
      }
      const value = (body[field] == null ? '' : String(body[field])).trim()
      if (!isValidValue(value)) {
        flash(req, 'error', `非法模型值:${key} = ${value}`)
        return res.redirect('/admin/settings')
      }
      incomingModel[key] = value
    } else if (field.startsWith('step_reasoning.')) {
      const key = field.slice('step_reasoning.'.length)
      if (!STEP_KEYS.includes(key)) {
        flash(req, 'error', `非法步骤(reasoning):${key}`)
        return res.redirect('/admin/settings')
      }
      const value = (body[field] == null ? '' : String(body[field])).trim()
      if (!isValidReasoning(value)) {
        flash(req, 'error', `非法思考强度:${key} = ${value}`)
        return res.redirect('/admin/settings')
      }
      incomingReasoning[key] = value
    }
  }

  // 2. diff 出真正变化(model + reasoning 一起算)
  const changes = []  // { kind, key, old_value, new_value }
  for (const key of STEP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incomingModel, key)) {
      const settingKey = `step_model.${key}`
      const oldRaw = getSetting(db, settingKey) || ''
      const newVal = incomingModel[key]
      if (oldRaw !== newVal) changes.push({ kind: 'model', key, settingKey, old_value: oldRaw || null, new_value: newVal || null })
    }
    if (Object.prototype.hasOwnProperty.call(incomingReasoning, key)) {
      const settingKey = `step_reasoning.${key}`
      const oldRaw = getSetting(db, settingKey) || ''
      const newVal = incomingReasoning[key]
      if (oldRaw !== newVal) changes.push({ kind: 'reasoning', key, settingKey, old_value: oldRaw || null, new_value: newVal || null })
    }
  }

  if (changes.length === 0) {
    flash(req, 'success', '没有变化')
    return res.redirect('/admin/settings')
  }

  // 3. 在事务里一次写完
  try {
    const tx = db.transaction(() => {
      for (const ch of changes) {
        if (ch.new_value == null || ch.new_value === '') {
          db.prepare('DELETE FROM system_settings WHERE key = ?').run(ch.settingKey)
        } else {
          setSetting(db, {
            key: ch.settingKey,
            value: ch.new_value,
            updatedByUserId: req.user.id,
          })
        }
      }
    })
    tx()
  } catch (e) {
    console.error('[admin/settings] save failed:', e.message)
    flash(req, 'error', '保存失败:' + e.message)
    return res.redirect('/admin/settings')
  }

  audit(db, req, {
    eventType: 'admin_settings_updated',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: { changes },
  })

  const modelChanges = changes.filter((c) => c.kind === 'model').length
  const reasonChanges = changes.filter((c) => c.kind === 'reasoning').length
  flash(req, 'success', `已保存:${modelChanges} 项模型 · ${reasonChanges} 项思考强度`)
  res.redirect('/admin/settings')
})

// ============================================================
// POST /reset — 清空所有 step_model.*
// ============================================================

router.post('/reset', (req, res) => {
  const db = req.app.locals.db

  const beforeModel = getAllStepModels(db)
  const beforeReason = getAllStepReasonings(db)
  const removedSteps = STEP_KEYS.filter(
    (k) =>
      (beforeModel[k] && String(beforeModel[k]).trim()) ||
      (beforeReason[k] && String(beforeReason[k]).trim())
  )

  if (removedSteps.length === 0) {
    flash(req, 'success', '所有步骤已经是默认值,无需重置')
    return res.redirect('/admin/settings')
  }

  try {
    const tx = db.transaction(() => {
      for (const key of STEP_KEYS) {
        db.prepare('DELETE FROM system_settings WHERE key = ?').run(`step_model.${key}`)
        db.prepare('DELETE FROM system_settings WHERE key = ?').run(`step_reasoning.${key}`)
      }
    })
    tx()
  } catch (e) {
    console.error('[admin/settings] reset failed:', e.message)
    flash(req, 'error', '重置失败:' + e.message)
    return res.redirect('/admin/settings')
  }

  audit(db, req, {
    eventType: 'admin_settings_reset',
    userId: req.user.id,
    actorUserId: req.user.id,
    payload: {
      cleared: removedSteps.map((k) => ({
        key: k,
        old_model: beforeModel[k] || null,
        old_reasoning: beforeReason[k] || null,
      })),
    },
  })

  flash(req, 'success', `已重置 ${removedSteps.length} 项,全部回到默认`)
  res.redirect('/admin/settings')
})

export default router
