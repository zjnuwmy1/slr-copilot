/**
 * Anthropic API adapter.
 *
 * 暴露两个函数:
 *   testApiKey(apiKey)                          — 用最小请求 ping 一下,确认 key 可用
 *   sendMessage({ apiKey, model, system, prompt, maxTokens })
 *                                               — 标准 messages 调用,给 Phase 1.5 LLM router 用
 *
 * 注意:
 * - 5 秒超时(AbortController)
 * - 错误里 NEVER 回显 apiKey
 * - 返回 status code 但不返回 response body 里的敏感字段
 */

const API_BASE = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 5000
const PING_MODEL = 'claude-haiku-4-5'

function withTimeout(ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  return { signal: ac.signal, cancel: () => clearTimeout(t) }
}

/**
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, error?: string, model?: string, latencyMs: number }>}
 */
export async function testApiKey(apiKey) {
  const started = Date.now()
  if (!apiKey || typeof apiKey !== 'string') {
    return { ok: false, error: 'empty_key', latencyMs: 0 }
  }

  const { signal, cancel } = withTimeout(DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PING_MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })

    const latencyMs = Date.now() - started

    if (res.status === 200) {
      let model
      try {
        const body = await res.json()
        model = body?.model
      } catch {
        // body 解析失败但 200 也算成功
      }
      return { ok: true, model: model || PING_MODEL, latencyMs }
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_key', latencyMs }
    }

    // 拿一些可读 hint 但不回显 key
    let hint = ''
    try {
      const body = await res.json()
      hint = body?.error?.type || body?.error?.message || ''
      hint = String(hint).slice(0, 120)
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `http_${res.status}${hint ? ': ' + hint : ''}`,
      latencyMs,
    }
  } catch (e) {
    const latencyMs = Date.now() - started
    if (e?.name === 'AbortError') {
      return { ok: false, error: 'timeout', latencyMs }
    }
    return { ok: false, error: `network: ${String(e?.message || e).slice(0, 120)}`, latencyMs }
  } finally {
    cancel()
  }
}

// reasoning id → extended-thinking 预算 tokens(0 = 关闭)
const REASONING_TO_BUDGET = {
  off: 0,
  think: 2048,
  think_hard: 4096,
  think_harder: 8192,
  ultrathink: 16384,
}

/**
 * 给汇总层 / LLM router 用。
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} [args.system]
 * @param {string} args.prompt
 * @param {string} [args.reasoning] — off | think | think_hard | think_harder | ultrathink
 * @param {number} [args.maxTokens]
 * @returns {Promise<{ text: string, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function sendMessage({ apiKey, model, system, prompt, reasoning, maxTokens = 1024 }) {
  if (!apiKey) throw new Error('sendMessage: apiKey required')
  if (!model) throw new Error('sendMessage: model required')
  if (!prompt) throw new Error('sendMessage: prompt required')

  // extended thinking 仅在 budget > 0 时启用;启用后 max_tokens 必须 > budget + 缓冲
  const budget = REASONING_TO_BUDGET[String(reasoning || '').toLowerCase()] || 0
  const effectiveMax = budget > 0 ? Math.max(maxTokens, budget + 4096) : maxTokens

  const body = {
    model,
    max_tokens: effectiveMax,
    messages: [{ role: 'user', content: prompt }],
  }
  if (system) body.system = system
  if (budget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
    body.temperature = 1  // Anthropic 文档要求:thinking 必须搭配 temperature=1
  }

  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let errType = ''
    let errMsg = ''
    try {
      const j = await res.json()
      errType = j?.error?.type || ''
      errMsg = j?.error?.message || ''
    } catch {
      // ignore
    }
    const err = new Error(`anthropic_api_error: status=${res.status} type=${errType} msg=${errMsg}`)
    err.status = res.status
    err.error_type = errType
    throw err
  }

  const json = await res.json()
  const text = Array.isArray(json?.content)
    ? json.content
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
    : ''
  const usage = {
    input_tokens: json?.usage?.input_tokens ?? 0,
    output_tokens: json?.usage?.output_tokens ?? 0,
  }
  return { text, usage }
}
