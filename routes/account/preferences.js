/**
 * /account/preferences — 用户选自己的 step model preset(高性能/平衡/经济)。
 *
 * 挂载(server.js):
 *   app.use('/account/preferences', requireUser, accountPreferencesRouter)
 */

import { Router } from 'express'
import {
  PRESET_IDS,
  listPresets,
  getDefaultPresetId,
  getEffectivePresetIdForUser,
  setUserPreset,
} from '../../services/step-presets.js'
import { STEP_KEYS, STEP_SPECS } from '../../services/settings.js'

const router = Router()

function flash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const presets = listPresets(db)
  const effectiveId = getEffectivePresetIdForUser(db, req.user.id)
  const defaultId = getDefaultPresetId(db)
  // user.step_model_preset 字段:NULL 表示"跟随默认"
  const userRow = db
    .prepare(`SELECT step_model_preset FROM users WHERE id = ?`)
    .get(req.user.id)
  const userExplicitChoice = userRow && userRow.step_model_preset ? userRow.step_model_preset : null

  res.render('account/preferences', {
    title: '我的偏好(模型方案)',
    presets,
    effectiveId,
    defaultId,
    userExplicitChoice,
    stepKeys: STEP_KEYS,
    stepSpecs: STEP_SPECS,
  })
})

router.post('/', (req, res) => {
  const db = req.app.locals.db
  const raw = String(req.body.preset || '').trim()
  let presetId = null
  if (raw === '' || raw === 'default' || raw === 'inherit') {
    presetId = null  // 清除 — 跟随系统默认
  } else if (PRESET_IDS.includes(raw)) {
    presetId = raw
  } else {
    flash(req, 'error', '无效的预设')
    return res.redirect('/account/preferences')
  }
  try {
    setUserPreset(db, req.user.id, presetId, { actorUserId: req.user.id, req })
    flash(req, 'success', presetId
      ? `已切换到「${presetId}」预设。下次跑 AI 自动生效。`
      : '已清除自选,跟随系统默认。')
  } catch (e) {
    flash(req, 'error', '保存失败:' + e.message)
  }
  res.redirect('/account/preferences')
})

export default router
