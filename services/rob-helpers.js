/**
 * services/rob-helpers.js — RoB 相关共享小工具(避免 routes 之间循环依赖)
 *
 * 当前唯一函数:`ratingToValence(rating, tool)`
 *
 * 把 5 种工具的 overall_rating 映射到统一 valence:
 *   good | middle | bad | unrated
 *
 * 之前在 routes/projects/rob.js(`ratingValenceSrv`)和 routes/projects/synthesis.js
 * (`ratingToValence`)各有一份重复定义,Step 7 也要用 → 抽到这里成单一 source of truth。
 *
 * 5 个工具的 rating 来源(对照 services/rob.js 各 SYSTEM prompt 的 enum):
 *   mmat:       'screening_failed' | '0/5' | '1/5' | '2/5' | '3/5' | '4/5' | '5/5'
 *   nos:        'high_quality' | 'moderate_quality' | 'low_quality'
 *   jbi_cs:     'high' | 'moderate' | 'low'
 *   rob2:       'low' | 'some_concerns' | 'high'
 *   robins_i:   'low' | 'moderate' | 'serious' | 'critical'
 *
 * Valence 用途:
 *   - Step 5 RoB 列表 review_priority 排序(差 → 中 → 好 → 未评)
 *   - Step 6 synthesis 网络图论文节点染色(绿/黄/红/灰)
 *   - Step 7 certainty 主题级 GRADE risk_of_bias 维度本地建议
 */

export function ratingToValence(rating, tool) {
  if (!rating) return 'unrated'
  if (tool === 'mmat') {
    if (rating === 'screening_failed') return 'bad'
    const m = String(rating).match(/^(\d+)\/(\d+)$/)
    if (m) {
      const r = parseInt(m[1], 10) / parseInt(m[2], 10)
      if (r >= 0.8) return 'good'
      if (r >= 0.4) return 'middle'
      return 'bad'
    }
    return 'unrated'
  }
  if (tool === 'nos') {
    if (rating === 'high_quality') return 'good'
    if (rating === 'moderate_quality') return 'middle'
    return 'bad'
  }
  if (tool === 'jbi_cs') {
    if (rating === 'high') return 'good'
    if (rating === 'moderate') return 'middle'
    return 'bad'
  }
  // RoB 2 / ROBINS-I
  if (rating === 'low') return 'good'
  if (rating === 'some_concerns' || rating === 'moderate') return 'middle'
  if (rating === 'high' || rating === 'serious' || rating === 'critical') return 'bad'
  return 'unrated'
}
