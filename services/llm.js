/**
 * LLM 路由器 — 把"用户 → 凭证 → provider 适配器 → 调用"串起来,统一记 usage_logs。
 *
 * 用法:
 *   const result = await runLlm(db, {
 *     userId, actionType: 'protocol_gen',
 *     system: '你是 SLR 方法学专家...',
 *     prompt: '我想做...',
 *     expectJson: true,
 *   })
 *   if (!result.ok) handleError(result)
 *   else useResult(result.data ?? result.text)
 *
 * 返回(永远 resolve,不 throw):
 *   {
 *     ok: boolean,
 *     status: 'success' | 'rate_limited' | 'timeout' | 'error' | 'quota_exceeded' | 'no_credential' | 'config_error',
 *     text?: string,
 *     data?: any,                  // expectJson 时尝试解析
 *     model?: string,
 *     provider?: 'anthropic' | 'openai',
 *     authType?: 'api_key' | 'oauth',
 *     credentialId?: string,
 *     durationMs?: number,
 *     usage?: { input_tokens: number, output_tokens: number },
 *     error?: string,
 *     errorDetail?: string,
 *     usageLogId?: number,
 *   }
 */

import { getDecrypted, listForUser, listUsableForUser, getDecryptedForUsage } from './credentials.js'
import { checkQuotaBeforeCall } from './quota.js'
import { getPlatformCredentialRow, PROVIDERS as PLATFORM_PROVIDERS } from './platform-credentials.js'
import * as anthropicApi from './providers/anthropic-api.js'
import * as anthropicCli from './providers/anthropic-cli.js'
import * as openaiApi from './providers/openai-api.js'
import * as openaiCli from './providers/openai-cli.js'

// 模型默认值(可被调用方 model 参数覆盖)
const DEFAULT_MODEL = {
  anthropic: process.env.CLAUDE_MODEL_HEAVY || 'claude-sonnet-4-6',
  openai: process.env.OPENAI_MODEL_HEAVY || 'gpt-5.4',
}
const LIGHT_MODEL = {
  anthropic: process.env.CLAUDE_MODEL_LIGHT || 'claude-haiku-4-5',
  openai: process.env.OPENAI_MODEL_LIGHT || 'gpt-5.4-mini',
}

import { resolveStepModel, resolveStepReasoning } from './settings.js'

/**
 * 从模型字符串里提取语义。优先级:
 *   1) 调用方传入了 model 字符串(不是 alias) → 直接用
 *   2) 调用方传 'heavy'/'light' 或没传 → 查 system_settings 里 step_model.<actionType>
 *   3) settings 没值 → 用 STEP_SPECS 的 defaultTier + provider 推
 *   4) 还不行 → 老的 env-var 默认
 *
 * 这样 admin 在 UI 改"协议生成用什么模型",立刻生效;同时保留旧的 'heavy'/'light' 调用方代码兼容。
 */
function resolveModel(db, { model, provider, actionType }) {
  const alias = (model || 'heavy').toString().toLowerCase()
  const isAlias = ['heavy', 'light', 'flagship', 'standard', ''].includes(alias)

  if (!isAlias && model) {
    // 调用方明确指定了具体型号,尊重它
    return model
  }
  // alias → 走 settings resolver
  try {
    const resolved = resolveStepModel(db, { actionType, provider })
    if (resolved) return resolved
  } catch (e) {
    // settings 表不存在或异常 → fallback 到 env 默认
  }
  // 最后兜底 env 默认
  if (alias === 'light') return LIGHT_MODEL[provider]
  return DEFAULT_MODEL[provider]
}

/**
 * 选凭证。最高优先级规则:
 *
 *   1. 用户不是超管 → 强制走平台凭证(超管在 /admin/platform-credentials 配置的那套)
 *      — 忽略用户自己的 user_credentials 与所有 credential_shares;
 *      — 按 preferredProvider 选 anthropic / openai,其次按 active 顺序兜底;
 *      — 平台凭证未配置或失效 → 返回 no_platform_credential,前端提示联系超管。
 *
 *   2. 用户是超管 → 旧行为:显式 credentialId 优先,否则 owner-first + 共享列表。
 *
 * 这样保证「所有普通用户共享超管的订阅 token」,同时超管仍可独立调试或绑定多套。
 */
function pickCredential(db, { userId, credentialId, preferredProvider, preferredAuthType }) {
  // 0. 查 super-admin 标志
  const userRow = db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(userId)
  const isSuper = !!(userRow && userRow.is_super_admin)

  // —— 非超管:强制走平台凭证 ——
  if (!isSuper) {
    const order = preferredProvider
      ? [preferredProvider, ...PLATFORM_PROVIDERS.filter((p) => p !== preferredProvider)]
      : PLATFORM_PROVIDERS
    for (const p of order) {
      const row = getPlatformCredentialRow(db, p)
      if (!row) continue
      if (row.status !== 'active') continue
      if (preferredAuthType && row.auth_type !== preferredAuthType) continue
      return { ok: true, cred: { ...row, via: 'platform' } }
    }
    // 退化:不强求 authType 匹配
    if (preferredAuthType) {
      for (const p of order) {
        const row = getPlatformCredentialRow(db, p)
        if (row && row.status === 'active') {
          return { ok: true, cred: { ...row, via: 'platform' } }
        }
      }
    }
    return { ok: false, reason: 'no_platform_credential' }
  }

  // —— 超管:走旧逻辑 ——
  if (credentialId) {
    const own = db
      .prepare(
        `SELECT id, user_id, provider, auth_type, label, status
         FROM user_credentials WHERE id = ? AND user_id = ?`
      )
      .get(credentialId, userId)
    if (own) {
      if (own.status !== 'active') return { ok: false, reason: 'credential_not_active', detail: own.status }
      return { ok: true, cred: { ...own, via: 'owner' } }
    }
    const shared = db.prepare(`
      SELECT uc.id, uc.user_id, uc.provider, uc.auth_type, uc.label, uc.status
      FROM credential_shares cs
      JOIN user_credentials uc ON uc.id = cs.credential_id
      WHERE cs.credential_id = ? AND cs.shared_with_user_id = ?
    `).get(credentialId, userId)
    if (!shared) return { ok: false, reason: 'credential_not_found' }
    if (shared.status !== 'active') return { ok: false, reason: 'credential_not_active', detail: shared.status }
    return { ok: true, cred: { ...shared, via: 'shared' } }
  }

  const all = listUsableForUser(db, userId)
  if (all.length === 0) return { ok: false, reason: 'no_active_credential' }
  let candidates = all
  if (preferredProvider) candidates = candidates.filter((c) => c.provider === preferredProvider)
  if (preferredAuthType) candidates = candidates.filter((c) => c.auth_type === preferredAuthType)
  if (candidates.length === 0) candidates = all
  return { ok: true, cred: candidates[0] }
}

/** 从 LLM 回复文本里尽力提取 JSON。失败返回 null。 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null

  // 1) 任意 ```json ... ``` / ``` ... ``` 围栏(允许 \r\n、无尾换行)
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]+?)```/g
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = m[1].trim()
    const parsed = tryParseLenient(inner)
    if (parsed !== undefined) return parsed
  }

  // 2) 扫描每个 { 或 [ 作为起点,做 depth-balanced。
  //    如果整段扫到最后 depth 仍 > 0(截断),尝试补齐括号再解析。
  for (let s = 0; s < text.length; s++) {
    const c = text[s]
    if (c !== '{' && c !== '[') continue
    const result = scanBalanced(text, s)
    if (result == null) continue
    const parsed = tryParseLenient(result.slice)
    if (parsed !== undefined) return parsed
    // 截断的情况:result.truncated == true
    if (result.truncated) {
      const repaired = tryRepairTruncated(result.slice, result.openStack)
      if (repaired !== undefined) return repaired
    }
  }

  return null
}

/** 从 text[start] 开始 depth-balanced 扫描。返回 { slice, truncated, openStack }。 */
function scanBalanced(text, start) {
  let depth = 0, inStr = false, esc = false
  const stack = []
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === '\\' && inStr) { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{' || c === '[') { stack.push(c); depth++ }
    else if (c === '}' || c === ']') {
      stack.pop()
      depth--
      if (depth === 0) {
        return { slice: text.slice(start, i + 1), truncated: false, openStack: [] }
      }
    }
  }
  // 走到末尾还没闭合:截断
  return { slice: text.slice(start), truncated: true, openStack: stack }
}

/** 宽容解析:原样,然后剥行尾逗号,然后剥单行 // 注释,最后修内嵌未转义双引号。 */
function tryParseLenient(s) {
  if (typeof s !== 'string') return undefined
  const candidates = [
    s,
    s.replace(/,\s*([}\]])/g, '$1'),                              // 剥行尾逗号
    s.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'),  // 剥 // 注释 + 行尾逗号
    repairInnerDoubleQuotes(s),                                   // 修内嵌未转义 " (中文 LLM 常见)
    repairInnerDoubleQuotes(s.replace(/,\s*([}\]])/g, '$1')),     // 双修
  ]
  for (const c of candidates) {
    if (c === undefined) continue
    try {
      const v = JSON.parse(c)
      if (v != null && (typeof v === 'object')) return v
    } catch {}
  }
  return undefined
}

/**
 * 修 LLM 输出 JSON 时字符串值内部包了未转义半角双引号的情况。
 *
 * 典型坑(中文 LLM 高频):
 *   "summary": "协议要求"同时涉及设计思维"过窄"
 *                       ↑↑ 内部 " 没转义,JSON.parse 在第一个就当 string 结束了
 *
 * 启发式:从左到右扫,跟踪 inString 状态。遇到 \`"\` 时看下一个非空白字符:
 *   - 是 \`,\` \`}\` \`]\` \`:\` 或 EOF → 这是 string 的合法闭引号
 *   - 否则 → 这是字符串内部的引号,替换为 \\\"
 *
 * 这个函数尽力而为 — 若启发式判断错了,后续 JSON.parse 仍会失败,
 * 不会让本来能 parse 的 JSON 变得 parse 不了(因为我们只在 inString=true 时改)。
 */
function repairInnerDoubleQuotes(text) {
  if (typeof text !== 'string') return undefined
  let out = ''
  let inString = false
  let escapeNext = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escapeNext) { out += c; escapeNext = false; continue }
    if (c === '\\') { out += c; escapeNext = true; continue }
    if (c !== '"') { out += c; continue }

    if (!inString) {
      // 开引号
      out += c
      inString = true
    } else {
      // 已在字符串内:这是闭引号还是内嵌引号?
      // 向后看到第一个非空白字符
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const next = text[j]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        // 合法闭引号
        out += c
        inString = false
      } else {
        // 内嵌引号 — 转义掉
        out += '\\"'
      }
    }
  }
  return out
}

/** 截断修复:openStack 是未闭合的开括号栈,顺序追加对应闭括号。 */
function tryRepairTruncated(slice, openStack) {
  if (!openStack || openStack.length === 0) return undefined
  // 切掉最后一个不完整的 token(常见:字符串没闭合、数字没写完、逗号孤立)
  let s = slice
  // 如果以未闭合的双引号结尾,尝试补一个 "
  const openQuotes = (s.match(/(?<!\\)"/g) || []).length
  if (openQuotes % 2 === 1) {
    // 找最后一个 " 之后是不是有意义内容,补 "
    s += '"'
  }
  // 倒序补闭括号
  for (let i = openStack.length - 1; i >= 0; i--) {
    s += openStack[i] === '{' ? '}' : ']'
  }
  return tryParseLenient(s)
}

function recordUsage(db, fields) {
  const stmt = db.prepare(`
    INSERT INTO usage_logs
      (user_id, credential_id, project_id, action_type, provider, auth_type, model,
       prompt_tokens, completion_tokens, duration_ms, status, error_message, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `)
  const r = stmt.run(
    fields.userId,
    fields.credentialId ?? null,
    fields.projectId ?? null,
    fields.actionType,
    fields.provider,
    fields.authType,
    fields.model ?? null,
    fields.promptTokens ?? null,
    fields.completionTokens ?? null,
    fields.durationMs ?? null,
    fields.status,
    fields.errorMessage ?? null,
  )
  return r.lastInsertRowid
}

/**
 * 主入口
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 */
export async function runLlm(db, opts) {
  const {
    userId,
    actionType,
    system,
    prompt,
    expectJson = false,
    model: modelHint,
    maxTokens = 1024,
    projectId = null,
    preferredProvider = null,
    preferredAuthType = null,
    credentialId: credIdOverride = null,
    timeoutMs,
  } = opts

  if (!userId) {
    return { ok: false, status: 'config_error', error: 'missing_userId' }
  }
  if (!actionType) {
    return { ok: false, status: 'config_error', error: 'missing_actionType' }
  }
  if (!prompt) {
    return { ok: false, status: 'config_error', error: 'missing_prompt' }
  }

  // 1. 选凭证
  const pick = pickCredential(db, {
    userId,
    credentialId: credIdOverride,
    preferredProvider,
    preferredAuthType,
  })
  if (!pick.ok) {
    return {
      ok: false,
      status: 'no_credential',
      error: pick.reason,
      errorDetail: pick.detail,
    }
  }
  const cred = pick.cred

  // 2. 校验配额
  const q = checkQuotaBeforeCall(db, {
    userId,
    provider: cred.provider,
    authType: cred.auth_type,
  })
  if (!q.ok) {
    const usageLogId = recordUsage(db, {
      userId, credentialId: cred.id, projectId, actionType,
      provider: cred.provider, authType: cred.auth_type,
      durationMs: 0, status: 'quota_exceeded',
      errorMessage: q.message,
    })
    return {
      ok: false, status: 'quota_exceeded',
      error: q.reason, errorDetail: q.message,
      provider: cred.provider, authType: cred.auth_type, credentialId: cred.id,
      usageLogId,
    }
  }

  // 3. 解密凭证
  let decrypted
  try {
    // 用 ForUsage 版本:既允许 owner 自有,也允许"共享给我的"
    decrypted = getDecryptedForUsage(db, { userId, credentialId: cred.id })
  } catch (e) {
    return {
      ok: false, status: 'config_error',
      error: 'decrypt_failed', errorDetail: e.message,
    }
  }

  // 4. 解析模型 + 思考强度(后者会自动按 provider 翻译)
  const model = resolveModel(db, { model: modelHint, provider: cred.provider, actionType })
  const reasoning = (() => {
    try { return resolveStepReasoning(db, { actionType, provider: cred.provider }) }
    catch { return null }
  })()

  // 5. 路由到 provider 适配器
  const started = Date.now()
  let providerResult
  try {
    if (cred.provider === 'anthropic' && cred.auth_type === 'api_key') {
      providerResult = await withTimeout(
        anthropicApi.sendMessage({ apiKey: decrypted.api_key, model, system, prompt, reasoning, maxTokens }),
        timeoutMs ?? 60_000,
      )
    } else if (cred.provider === 'anthropic' && cred.auth_type === 'oauth') {
      providerResult = await anthropicCli.sendMessage({
        homePath: decrypted.home_path,
        model, system, prompt, reasoning,
        timeoutMs: timeoutMs ?? 180_000,
      })
    } else if (cred.provider === 'openai' && cred.auth_type === 'api_key') {
      providerResult = await withTimeout(
        openaiApi.sendMessage({ apiKey: decrypted.api_key, model, system, prompt, reasoning, maxTokens }),
        timeoutMs ?? 60_000,
      )
    } else if (cred.provider === 'openai' && cred.auth_type === 'oauth') {
      providerResult = await openaiCli.sendMessage({
        homePath: decrypted.home_path,
        model, system, prompt, reasoning,
        timeoutMs: timeoutMs ?? 180_000,
      })
    } else {
      throw new Error(`unsupported (provider=${cred.provider}, authType=${cred.auth_type})`)
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const errMsg = e?.message || String(e)
    const status = inferErrorStatus(errMsg)
    const usageLogId = recordUsage(db, {
      userId, credentialId: cred.id, projectId, actionType,
      provider: cred.provider, authType: cred.auth_type, model,
      durationMs, status, errorMessage: errMsg.slice(0, 1000),
    })
    // 标记凭证错误(只有 API key 401/403)
    if (status === 'error' && (e?.status === 401 || e?.status === 403)) {
      try {
        db.prepare(
          `UPDATE user_credentials SET status = 'error', last_validation_error = ? WHERE id = ?`
        ).run(errMsg.slice(0, 500), cred.id)
      } catch {}
    }
    return {
      ok: false, status,
      error: errMsg, errorDetail: e?.error_type || e?.code || null,
      provider: cred.provider, authType: cred.auth_type, credentialId: cred.id,
      model, durationMs, usageLogId,
    }
  }

  const durationMs = Date.now() - started
  const text = providerResult.text ?? ''
  const usage = providerResult.usage ?? null
  const data = expectJson ? extractJson(text) : undefined
  const jsonParseFailed = expectJson && (data == null)

  // 6. 落 usage_logs — 解析失败的明确标 parse_failed 并保存原文片段供 debug
  const usageLogId = recordUsage(db, {
    userId, credentialId: cred.id, projectId, actionType,
    provider: cred.provider, authType: cred.auth_type, model,
    promptTokens: usage?.input_tokens ?? null,
    completionTokens: usage?.output_tokens ?? null,
    durationMs,
    status: jsonParseFailed ? 'parse_failed' : 'success',
    errorMessage: jsonParseFailed
      ? `json_parse_failed; raw_text_length=${text.length}; raw_text(first 8000):\n${text.slice(0, 8000)}`
      : null,
  })

  // 7. 更新凭证 last_used_at
  try {
    db.prepare(`UPDATE user_credentials SET last_used_at = datetime('now') WHERE id = ?`).run(cred.id)
  } catch {}

  return {
    ok: true,
    status: 'success',
    text,
    data,
    model,
    reasoning: reasoning || null,
    provider: cred.provider,
    authType: cred.auth_type,
    credentialId: cred.id,
    durationMs,
    usage,
    usageLogId,
  }
}

/** Promise 加超时包装(给 API key 路径用) */
function withTimeout(promise, ms) {
  let to
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error('timeout_exceeded')), ms)
  })
  return Promise.race([
    promise.then((v) => { clearTimeout(to); return v }),
    timeout,
  ])
}

function inferErrorStatus(msg) {
  if (!msg) return 'error'
  if (/timeout/i.test(msg)) return 'timeout'
  if (/rate.?limit|429|usage.?limit/i.test(msg)) return 'rate_limited'
  return 'error'
}
