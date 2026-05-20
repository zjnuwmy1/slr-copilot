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
  getAllStepModels,
  getSetting,
  setSetting,
} from '../../services/settings.js'
import { audit } from '../../services/audit.js'

const router = Router()

// 合法 alias(空 = 用默认)
const VALID_ALIASES = new Set(['heavy', 'flagship', 'standard', 'light'])

// 所有具体模型 id 白名单(扁平)
const ALL_MODEL_IDS = new Set(
  Object.values(AVAILABLE_MODELS).flat().map((m) => m.id)
)

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
  const current = getAllStepModels(db)  // { protocol_gen: 'xxx' | '', ... }

  const configuredCount = STEP_KEYS.filter((k) => current[k] && String(current[k]).trim()).length

  res.render('admin/settings', {
    title: '步骤模型配置',
    stepKeys: STEP_KEYS,
    stepSpecs: STEP_SPECS,
    availableModels: AVAILABLE_MODELS,
    current,
    configuredCount,
    totalCount: STEP_KEYS.length,
  })
})

// ============================================================
// POST / — 保存
// ============================================================

router.post('/', (req, res) => {
  const db = req.app.locals.db
  const body = req.body || {}

  // 1. 收集 step_model.<key> 字段
  const incoming = {}  // { key -> value(已 trim) }
  for (const field of Object.keys(body)) {
    if (!field.startsWith('step_model.')) continue
    const key = field.slice('step_model.'.length)
    if (!STEP_KEYS.includes(key)) {
      flash(req, 'error', `非法步骤:${key}`)
      return res.redirect('/admin/settings')
    }
    const raw = body[field]
    const value = (raw == null ? '' : String(raw)).trim()
    if (!isValidValue(value)) {
      flash(req, 'error', `非法模型值:${key} = ${value}`)
      return res.redirect('/admin/settings')
    }
    incoming[key] = value
  }

  // 2. diff 出真正变化
  const changes = []  // { key, old_value, new_value }
  for (const key of STEP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue
    const settingKey = `step_model.${key}`
    const oldRaw = getSetting(db, settingKey) || ''
    const newVal = incoming[key]
    if (oldRaw === newVal) continue
    changes.push({ key, old_value: oldRaw || null, new_value: newVal || null })
  }

  if (changes.length === 0) {
    flash(req, 'success', '没有变化')
    return res.redirect('/admin/settings')
  }

  // 3. 在事务里一次写完
  try {
    const tx = db.transaction(() => {
      for (const ch of changes) {
        const settingKey = `step_model.${ch.key}`
        if (ch.new_value == null || ch.new_value === '') {
          db.prepare('DELETE FROM system_settings WHERE key = ?').run(settingKey)
        } else {
          setSetting(db, {
            key: settingKey,
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

  flash(req, 'success', `已保存 ${changes.length} 项变化`)
  res.redirect('/admin/settings')
})

// ============================================================
// POST /reset — 清空所有 step_model.*
// ============================================================

router.post('/reset', (req, res) => {
  const db = req.app.locals.db

  const before = getAllStepModels(db)
  const removedKeys = STEP_KEYS.filter((k) => before[k] && String(before[k]).trim())

  if (removedKeys.length === 0) {
    flash(req, 'success', '所有步骤已经是默认值,无需重置')
    return res.redirect('/admin/settings')
  }

  try {
    const tx = db.transaction(() => {
      for (const key of STEP_KEYS) {
        db.prepare('DELETE FROM system_settings WHERE key = ?').run(`step_model.${key}`)
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
      cleared: removedKeys.map((k) => ({ key: k, old_value: before[k] })),
    },
  })

  flash(req, 'success', `已重置 ${removedKeys.length} 项,全部回到默认`)
  res.redirect('/admin/settings')
})

export default router
