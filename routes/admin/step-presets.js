/**
 * /admin/step-presets — 超管编辑 3 套模型预设(高性能 / 平衡 / 经济)。
 *
 * 挂载(server.js):
 *   app.use('/admin/step-presets', requireSuperAdmin, adminStepPresetsRouter)
 */

import { Router } from 'express'
import {
  PRESET_IDS,
  listPresets,
  getPreset,
  updatePreset,
  setDefaultPreset,
} from '../../services/step-presets.js'
import {
  STEP_KEYS, STEP_SPECS, AVAILABLE_MODELS, REASONING_LEVELS_BY_PROVIDER, ALL_REASONING_IDS,
} from '../../services/settings.js'

const router = Router()

function flash(req, type, message) {
  if (req.session) req.session.flash = { type, message }
}

// 渲染:全部预设的对比 + 每个的编辑表单
router.get('/', (req, res) => {
  const db = req.app.locals.db
  const presets = listPresets(db)
  res.render('admin/step-presets', {
    title: '步骤模型预设',
    presets,
    presetIds: PRESET_IDS,
    stepKeys: STEP_KEYS,
    stepSpecs: STEP_SPECS,
    availableModels: AVAILABLE_MODELS,
    reasoningLevels: REASONING_LEVELS_BY_PROVIDER,
  })
})

// 更新某个预设
router.post('/:presetId/update', (req, res) => {
  const db = req.app.locals.db
  const presetId = req.params.presetId
  if (!PRESET_IDS.includes(presetId)) {
    flash(req, 'error', '无效的预设 ID')
    return res.redirect('/admin/step-presets')
  }

  // 从 form 取 label / description / step_model.<step> / step_reasoning.<step>
  const label = String(req.body.label || '').trim().slice(0, 80)
  const description = String(req.body.description || '').trim().slice(0, 400)
  const config = { step_model: {}, step_reasoning: {} }
  for (const step of STEP_KEYS) {
    const m = String(req.body['model_' + step] || '').trim()
    const r = String(req.body['reasoning_' + step] || '').trim()
    if (m) config.step_model[step] = m
    if (r && ALL_REASONING_IDS.has(r)) config.step_reasoning[step] = r
  }

  try {
    updatePreset(db, presetId, { label, description, config, updatedByUserId: req.user.id, req })
    flash(req, 'success', `预设 "${label}" 已保存`)
  } catch (e) {
    flash(req, 'error', '保存失败:' + e.message)
  }
  res.redirect('/admin/step-presets')
})

// 把某个预设设为默认
router.post('/:presetId/set-default', (req, res) => {
  const db = req.app.locals.db
  const presetId = req.params.presetId
  if (!PRESET_IDS.includes(presetId)) {
    flash(req, 'error', '无效的预设 ID')
    return res.redirect('/admin/step-presets')
  }
  try {
    setDefaultPreset(db, presetId, { updatedByUserId: req.user.id, req })
    flash(req, 'success', `已将 ${presetId} 设为默认`)
  } catch (e) {
    flash(req, 'error', '设置失败:' + e.message)
  }
  res.redirect('/admin/step-presets')
})

export default router
