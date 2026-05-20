/**
 * services/providers/openai-cli.js
 *
 * TODO: codex CLI 的精确 headless subcommand 我没查到稳定文档。这里假设是
 *   `codex exec <prompt>`
 * 并把 --model 当参数。等真实测试时可能要改成 `codex -p` 或别的 — 等连真二进制再调。
 *
 * Phase 1 不直接调用。框架对齐 anthropic-cli.js。
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000
const BIN = () => process.env.CODEX_BIN || 'codex'

/**
 * @param {object} args
 * @param {string} args.homePath
 * @param {string} args.model
 * @param {string} [args.system]
 * @param {string} args.prompt
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ text: string, latencyMs: number, raw?: object }>}
 */
export async function sendMessage({
  homePath,
  model,
  system,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!homePath) throw new Error('openai-cli.sendMessage: homePath required')
  if (!model) throw new Error('openai-cli.sendMessage: model required')
  if (!prompt) throw new Error('openai-cli.sendMessage: prompt required')

  // TODO confirm: 真实 codex CLI 的 subcommand / 输出格式参数。
  const args = ['exec', '--model', model]
  if (system) args.push('--system', system)
  args.push(prompt)

  const env = {
    ...process.env,
    HOME: homePath,
    XDG_CONFIG_HOME: undefined,
    XDG_DATA_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]

  const started = Date.now()
  return await new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(BIN(), args, {
        cwd: homePath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return reject(new Error(`spawn_failed: ${e.message}`))
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 2000)
      reject(new Error('timeout'))
    }, timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (c) => {
      stdout += c
    })
    proc.stderr.on('data', (c) => {
      stderr += c
    })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`proc_error: ${err.message}`))
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      if (code !== 0) {
        const tail = (stderr || stdout).slice(-512).trim()
        return reject(new Error(`exit_${code}: ${tail}`))
      }
      const text = extractText(stdout)
      let raw
      try {
        raw = JSON.parse(stdout)
      } catch {
        raw = undefined
      }
      resolve({ text, latencyMs, raw })
    })
  })
}

/**
 * 防御性 stdout 解析。codex 可能直接打文本,也可能 JSON 包一层。
 */
function extractText(stdout) {
  const s = (stdout || '').trim()
  if (!s) return ''
  if (!(s.startsWith('{') || s.startsWith('['))) return s
  try {
    const outer = JSON.parse(s)
    let candidate =
      outer?.result ??
      outer?.output ??
      outer?.text ??
      outer?.content ??
      outer?.message ??
      null
    if (candidate == null) return JSON.stringify(outer)
    if (typeof candidate !== 'string') return JSON.stringify(candidate)
    const trimmed = candidate.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const inner = JSON.parse(trimmed)
        if (typeof inner === 'string') return inner
        if (inner?.text) return String(inner.text)
        return candidate
      } catch {
        return candidate
      }
    }
    return candidate
  } catch {
    return s
  }
}
