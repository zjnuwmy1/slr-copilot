/**
 * OpenAI API adapter.
 *
 * 暴露两个函数:
 *   testApiKey(apiKey)                          — GET /v1/models,5 秒超时
 *   sendMessage({ apiKey, model, system, prompt, maxTokens })
 *                                               — POST /v1/chat/completions
 *
 * 错误里 NEVER 回显 apiKey。
 */

const API_BASE = 'https://api.openai.com'
const DEFAULT_TIMEOUT_MS = 5000

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
    const res = await fetch(`${API_BASE}/v1/models`, {
      method: 'GET',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    const latencyMs = Date.now() - started

    if (res.status === 200) {
      let model
      try {
        const body = await res.json()
        if (Array.isArray(body?.data) && body.data.length > 0) {
          model = body.data[0]?.id
        }
      } catch {
        // ignore
      }
      return { ok: true, model: model || 'gpt-*', latencyMs }
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_key', latencyMs }
    }

    let hint = ''
    try {
      const body = await res.json()
      hint = body?.error?.code || body?.error?.message || ''
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

// GPT-5 系列接受的 reasoning_effort 取值
const OPENAI_VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} [args.system]
 * @param {string} args.prompt
 * @param {string} [args.reasoning] — minimal | low | medium | high
 * @param {number} [args.maxTokens]
 * @returns {Promise<{ text: string, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function sendMessage({ apiKey, model, system, prompt, reasoning, maxTokens = 1024 }) {
  if (!apiKey) throw new Error('sendMessage: apiKey required')
  if (!model) throw new Error('sendMessage: model required')
  if (!prompt) throw new Error('sendMessage: prompt required')

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
  }
  const effort = String(reasoning || '').toLowerCase()
  if (OPENAI_VALID_EFFORTS.has(effort)) {
    body.reasoning_effort = effort
  }

  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let errType = ''
    let errMsg = ''
    try {
      const j = await res.json()
      errType = j?.error?.type || j?.error?.code || ''
      errMsg = j?.error?.message || ''
    } catch {
      // ignore
    }
    const err = new Error(`openai_api_error: status=${res.status} type=${errType} msg=${errMsg}`)
    err.status = res.status
    err.error_type = errType
    throw err
  }

  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  const usage = {
    input_tokens: json?.usage?.prompt_tokens ?? 0,
    output_tokens: json?.usage?.completion_tokens ?? 0,
  }
  return { text, usage }
}
