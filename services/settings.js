/**
 * System settings (admin 可改的全局配置)KV 抽象。
 *
 * 现在用的 key:
 *   step_model.protocol_gen        — 协议生成
 *   step_model.search_strategy     — 检索式
 *   step_model.screening           — 标题/摘要初筛
 *   step_model.extraction          — 全文抽取
 *   step_model.synthesis           — 主题聚类
 *   step_model.drafting            — 章节写作
 *
 * 值可以是 model alias('heavy' / 'light')或具体模型名:
 *   anthropic: claude-opus-{4-7,4-6,4-5} / claude-sonnet-4-6 / claude-haiku-4-5
 *              (Sonnet/Haiku 4-7 不存在,实测 404)
 *   openai:    gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark / gpt-5.2
 *
 * llm.js 在 runLlm 入口先调 resolveStepModel(),按用户已绑凭证 provider 选合适模型。
 */

// ============================================================
// 可选模型清单 — Admin UI 用,LLM router 也用作"用户没绑该 provider 时降级"
// ============================================================

// 实测验证(2026-05-20 用 Claude Max 订阅 + ChatGPT Pro 订阅 + 各自 CLI 实测)
// Anthropic:claude-sonnet-4-7 / claude-haiku-4-7 都 404,Anthropic 目前只有 Opus 升到 4.7
// OpenAI:gpt-5 / o3 / gpt-4o 系列已被 gpt-5.x 取代
export const AVAILABLE_MODELS = {
  anthropic: [
    { id: 'claude-opus-4-7',          label: 'Claude Opus 4.7 (旗舰 · 1M 上下文 / 64K 输出)', tier: 'flagship' },
    { id: 'claude-opus-4-6',          label: 'Claude Opus 4.6 (上一代旗舰)',                  tier: 'flagship' },
    { id: 'claude-opus-4-5',          label: 'Claude Opus 4.5 (更早旗舰)',                    tier: 'flagship' },
    { id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 (推荐 · 600K 上下文)',        tier: 'standard' },
    { id: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5 (快且便宜)',                   tier: 'light' },
    { id: 'claude-haiku-4-5-20251001',label: 'Claude Haiku 4.5 (snapshot 20251001)',          tier: 'light' },
  ],
  openai: [
    { id: 'gpt-5.5',              label: 'GPT-5.5 (旗舰最新)',                tier: 'flagship' },
    { id: 'gpt-5.4',              label: 'GPT-5.4 (推荐 / 平衡)',             tier: 'standard' },
    { id: 'gpt-5.4-mini',         label: 'GPT-5.4 mini (快/便宜)',            tier: 'light' },
    { id: 'gpt-5.3-codex',        label: 'GPT-5.3 Codex (代码专长)',          tier: 'flagship' },
    { id: 'gpt-5.3-codex-spark',  label: 'GPT-5.3 Codex Spark (Pro 预览)',    tier: 'flagship' },
    { id: 'gpt-5.2',              label: 'GPT-5.2 (上一代)',                  tier: 'standard' },
  ],
}

// ============================================================
// 步骤元信息(给 Admin UI 用 + LLM router 做 fallback default)
// ============================================================

export const STEP_SPECS = {
  protocol_gen: {
    label: '协议生成 (Protocol)',
    description: '生成研究问题 + 纳排标准 + 概念组',
    defaultTier: 'standard',
    defaultReasoning: 'medium',
  },
  search_strategy: {
    label: '检索式生成 (Search)',
    description: 'WoS / Scopus / PubMed × 3 版检索式',
    defaultTier: 'standard',
    defaultReasoning: 'medium',
  },
  screening: {
    label: '标题摘要初筛 (Screening)',
    description: '快速判断纳入/排除/待定 — 用便宜模型',
    defaultTier: 'light',
    defaultReasoning: 'minimal',
  },
  extraction: {
    label: '全文结构化抽取 (Extraction)',
    description: '深度阅读 PDF 抽 finding / 限制 / 方法 — 用强模型',
    defaultTier: 'flagship',
    defaultReasoning: 'high',
  },
  synthesis: {
    label: '主题聚类 + Evidence Matrix (Synthesis)',
    description: '跨论文综合 — 用强模型',
    defaultTier: 'flagship',
    defaultReasoning: 'high',
  },
  drafting: {
    label: '综述章节写作 (Drafting)',
    description: 'Introduction / Methods / Results / Discussion 写作',
    defaultTier: 'standard',
    defaultReasoning: 'medium',
  },
  iteration: {
    label: '复盘 & 协议迭代 (Iteration)',
    description: '综合所有前序步骤数据,反推协议问题并产出优化版 —— 高 stake,默认旗舰 + 高思考',
    defaultTier: 'flagship',
    defaultReasoning: 'high',
  },
}

export const STEP_KEYS = Object.keys(STEP_SPECS)

// ============================================================
// 默认模型(provider × tier)— 当 settings 没设值时用
// ============================================================

const DEFAULT_BY_PROVIDER_AND_TIER = {
  anthropic: {
    flagship: 'claude-opus-4-7',     // 实测可用,1M context
    standard: 'claude-sonnet-4-6',   // Sonnet 4-7 不存在,4-6 仍是 standard
    light:    'claude-haiku-4-5',    // Haiku 4-7 不存在
  },
  openai: {
    flagship: 'gpt-5.5',
    standard: 'gpt-5.4',
    light:    'gpt-5.4-mini',
  },
}

// ============================================================
// KV 表读写
// ============================================================

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setSetting(db, { key, value, updatedByUserId }) {
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_by_user_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `).run(key, String(value), updatedByUserId || null)
}

export function listAllSettings(db) {
  return db.prepare('SELECT key, value, updated_at, updated_by_user_id FROM system_settings').all()
}

// ============================================================
// Step model resolver — 这是 llm.js 真正调的
// ============================================================

/**
 * 给定 actionType + provider,返回应该用的具体模型名。
 *
 *   1) 先查 settings.step_model.<actionType>
 *   2) 如果值是 alias 'heavy'/'standard'/'light',按 provider 解析成具体型号
 *   3) 如果值是具体模型名,直接返回(警告:可能跟 provider 不匹配,调用方负责)
 *   4) settings 没值 → 按 STEP_SPECS[actionType].defaultTier + provider 解析
 *   5) actionType 不在 STEP_SPECS → 用 standard
 */
export function resolveStepModel(db, { actionType, provider }) {
  const settingKey = `step_model.${actionType}`
  const configured = getSetting(db, settingKey)

  if (configured) {
    const v = String(configured).trim()
    // alias
    if (['flagship', 'heavy', 'standard', 'light'].includes(v)) {
      const tier = v === 'heavy' ? 'flagship' : v
      return DEFAULT_BY_PROVIDER_AND_TIER[provider]?.[tier]
          || DEFAULT_BY_PROVIDER_AND_TIER.anthropic.standard
    }
    // 具体型号 — 校验是不是本 provider 的
    const ownList = AVAILABLE_MODELS[provider] || []
    if (ownList.some((m) => m.id === v)) return v
    // 跨 provider:警告并 fallback 到本 provider 同 tier
    for (const p of Object.keys(AVAILABLE_MODELS)) {
      const m = AVAILABLE_MODELS[p].find((x) => x.id === v)
      if (m) {
        return DEFAULT_BY_PROVIDER_AND_TIER[provider]?.[m.tier]
            || DEFAULT_BY_PROVIDER_AND_TIER.anthropic.standard
      }
    }
    // 不认识的型号字符串,直接透传(让 provider 报错可见)
    return v
  }

  // 没配 → 用 step 的默认 tier
  const tier = STEP_SPECS[actionType]?.defaultTier || 'standard'
  return DEFAULT_BY_PROVIDER_AND_TIER[provider]?.[tier]
      || DEFAULT_BY_PROVIDER_AND_TIER.anthropic.standard
}

/**
 * 一次性返回所有 step 的当前配置(给 admin UI 渲染)。
 *   → { protocol_gen: 'claude-sonnet-4-6', screening: 'light', ... }
 */
export function getAllStepModels(db) {
  const out = {}
  for (const action of STEP_KEYS) {
    out[action] = getSetting(db, `step_model.${action}`) || ''  // 空 = 用默认
  }
  return out
}

// ============================================================
// 推理强度(thinking / reasoning_effort)
//
// Claude 用 "think keywords"(把关键词放进 prompt 头部就触发 extended thinking,
//   或调 API 时用 thinking: { type:'enabled', budget_tokens })
// Codex (GPT-5 系列)用 reasoning_effort: minimal / low / medium / high
//
// 我们存的是 provider-neutral 字符串(其实就是 Claude 那 5 档 + Codex 那 4 档去重),
// 在适配器里翻译成具体值。Admin UI 显示时按当前选的模型 provider 动态切换可选项。
// ============================================================

export const REASONING_LEVELS_BY_PROVIDER = {
  anthropic: [
    { id: 'off',          label: '不思考(最快)',                cliKeyword: '',            budgetTokens: 0 },
    { id: 'think',        label: '思考 · think',                  cliKeyword: 'think',       budgetTokens: 2048 },
    { id: 'think_hard',   label: '深度思考 · think hard',          cliKeyword: 'think hard',  budgetTokens: 4096 },
    { id: 'think_harder', label: '更深度思考 · think harder',     cliKeyword: 'think harder',budgetTokens: 8192 },
    { id: 'ultrathink',   label: '极致思考 · ultrathink(最慢)', cliKeyword: 'ultrathink',  budgetTokens: 16384 },
  ],
  openai: [
    { id: 'minimal', label: '最低 · minimal(最快)',     effort: 'minimal' },
    { id: 'low',     label: '低 · low',                    effort: 'low' },
    { id: 'medium',  label: '中 · medium(推荐)',         effort: 'medium' },
    { id: 'high',    label: '高 · high(最慢/最深入)',    effort: 'high' },
  ],
}

// 所有合法 reasoning id(扁平,用于校验)
export const ALL_REASONING_IDS = new Set([
  ...REASONING_LEVELS_BY_PROVIDER.anthropic.map((r) => r.id),
  ...REASONING_LEVELS_BY_PROVIDER.openai.map((r) => r.id),
])

/**
 * 跨 provider 翻译:admin 配置时基于 step_model 的 provider 选了一个 reasoning,
 * 但运行时 LLM 调用走的可能是另一个 provider 的平台凭证。这里给个语义对等映射。
 */
const ANTHROPIC_TO_OPENAI = {
  off: 'minimal', think: 'minimal',
  think_hard: 'low',
  think_harder: 'medium',
  ultrathink: 'high',
}
const OPENAI_TO_ANTHROPIC = {
  minimal: 'off',
  low: 'think',
  medium: 'think_hard',
  high: 'ultrathink',
}

export function mapReasoningToProvider(level, provider) {
  if (!level) return null
  const l = String(level).trim().toLowerCase()
  if (!l) return null
  const set = REASONING_LEVELS_BY_PROVIDER[provider] || []
  if (set.some((r) => r.id === l)) return l  // 已是目标 provider 的合法值
  if (provider === 'openai' && ANTHROPIC_TO_OPENAI[l]) return ANTHROPIC_TO_OPENAI[l]
  if (provider === 'anthropic' && OPENAI_TO_ANTHROPIC[l]) return OPENAI_TO_ANTHROPIC[l]
  return null
}

/**
 * 解析某 step 应该用的 reasoning(已翻译到指定 provider)。
 *   1) settings.step_reasoning.<actionType> → 跨 provider 翻译
 *   2) 否则用 STEP_SPECS[actionType].defaultReasoning → 翻译
 *   3) 找不到 → 该 provider 的 "medium" 等价
 *   4) actionType 不在 STEP_SPECS → 返回 null(让 provider 用自家默认)
 */
export function resolveStepReasoning(db, { actionType, provider }) {
  const settingKey = `step_reasoning.${actionType}`
  const configured = getSetting(db, settingKey)
  if (configured) {
    const m = mapReasoningToProvider(configured, provider)
    if (m) return m
  }
  const fallback = STEP_SPECS[actionType]?.defaultReasoning
  if (fallback) {
    const m = mapReasoningToProvider(fallback, provider)
    if (m) return m
  }
  return mapReasoningToProvider('medium', provider) || null
}

export function getAllStepReasonings(db) {
  const out = {}
  for (const action of STEP_KEYS) {
    out[action] = getSetting(db, `step_reasoning.${action}`) || ''
  }
  return out
}

/** 拿某 reasoning id 在某 provider 下的元信息(label / budgetTokens / effort 等)。 */
export function getReasoningMeta(level, provider) {
  if (!level) return null
  const list = REASONING_LEVELS_BY_PROVIDER[provider] || []
  return list.find((r) => r.id === level) || null
}
