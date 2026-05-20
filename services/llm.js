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

import { getDecrypted, listForUser } from './credentials.js'
import { checkQuotaBeforeCall } from './quota.js'
import * as anthropicApi from './providers/anthropic-api.js'
import * as anthropicCli from './providers/anthropic-cli.js'
import * as openaiApi from './providers/openai-api.js'
import * as openaiCli from './providers/openai-cli.js'

// 模型默认值(可被调用方 model 参数覆盖)
const DEFAULT_MODEL = {
  anthropic: process.env.CLAUDE_MODEL_HEAVY || 'claude-sonnet-4-6',
  openai: process.env.OPENAI_MODEL_HEAVY || 'gpt-4o',
}
const LIGHT_MODEL = {
  anthropic: process.env.CLAUDE_MODEL_LIGHT || 'claude-haiku-4-5',
  openai: process.env.OPENAI_MODEL_LIGHT || 'gpt-4o-mini',
}

/**
 * 从模型字符串里提取语义:'light' → provider 默认轻量模型;'heavy' → 默认重模型;其他直接当模型名
 */
function resolveModel(model, provider) {
  if (!model || model === 'heavy') return DEFAULT_MODEL[provider]
  if (model === 'light') return LIGHT_MODEL[provider]
  return model
}

/**
 * 选凭证:
 *   - 显式 credentialId → 直接用(校验属于用户 + active)
 *   - 否则按 preferredProvider / preferredAuthType 过滤 active 列表,取第一个
 *   - 都不指定时,任意一条 active
 */
function pickCredential(db, { userId, credentialId, preferredProvider, preferredAuthType }) {
  if (credentialId) {
    const cred = db
      .prepare(
        `SELECT id, user_id, provider, auth_type, label, status
         FROM user_credentials WHERE id = ? AND user_id = ?`
      )
      .get(credentialId, userId)
    if (!cred) return { ok: false, reason: 'credential_not_found' }
    if (cred.status !== 'active') return { ok: false, reason: 'credential_not_active', detail: cred.status }
    return { ok: true, cred }
  }

  const all = listForUser(db, userId).filter((c) => c.status === 'active')
  if (all.length === 0) return { ok: false, reason: 'no_active_credential' }

  let candidates = all
  if (preferredProvider) candidates = candidates.filter((c) => c.provider === preferredProvider)
  if (preferredAuthType) candidates = candidates.filter((c) => c.auth_type === preferredAuthType)
  if (candidates.length === 0) {
    // 退化:fall back 到任意 active
    candidates = all
  }
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

/** 宽容解析:原样,然后剥行尾逗号,然后剥单行 // 注释。 */
function tryParseLenient(s) {
  if (typeof s !== 'string') return undefined
  const candidates = [
    s,
    s.replace(/,\s*([}\]])/g, '$1'),                            // 剥行尾逗号
    s.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'), // 剥 // 注释 + 行尾逗号
  ]
  for (const c of candidates) {
    try {
      const v = JSON.parse(c)
      if (v != null && (typeof v === 'object')) return v
    } catch {}
  }
  return undefined
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
    decrypted = getDecrypted(db, { userId, credentialId: cred.id })
  } catch (e) {
    return {
      ok: false, status: 'config_error',
      error: 'decrypt_failed', errorDetail: e.message,
    }
  }

  // 4. 解析模型
  const model = resolveModel(modelHint, cred.provider)

  // 5. 路由到 provider 适配器
  const started = Date.now()
  let providerResult
  try {
    if (cred.provider === 'anthropic' && cred.auth_type === 'api_key') {
      providerResult = await withTimeout(
        anthropicApi.sendMessage({ apiKey: decrypted.api_key, model, system, prompt, maxTokens }),
        timeoutMs ?? 60_000,
      )
    } else if (cred.provider === 'anthropic' && cred.auth_type === 'oauth') {
      providerResult = await anthropicCli.sendMessage({
        homePath: decrypted.home_path,
        model, system, prompt,
        timeoutMs: timeoutMs ?? 180_000,
      })
    } else if (cred.provider === 'openai' && cred.auth_type === 'api_key') {
      providerResult = await withTimeout(
        openaiApi.sendMessage({ apiKey: decrypted.api_key, model, system, prompt, maxTokens }),
        timeoutMs ?? 60_000,
      )
    } else if (cred.provider === 'openai' && cred.auth_type === 'oauth') {
      providerResult = await openaiCli.sendMessage({
        homePath: decrypted.home_path,
        model, system, prompt,
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
