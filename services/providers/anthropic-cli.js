/**
 * services/providers/anthropic-cli.js
 *
 * 用 `claude -p` 通过 OAuth 订阅凭证(stored in $HOME/.claude/)发起一次推理。
 * Phase 1 不直接调用 — 这是给后面汇总层 / LLM router 准备的实现框架。
 *
 * 用法:
 *   import { sendMessage } from './anthropic-cli.js'
 *   const { text, latencyMs } = await sendMessage({
 *     homePath: '/var/lib/slr/user-homes/.../cred_xxx',
 *     model: 'claude-sonnet-4-5',
 *     system: 'You are a literature reviewer.',
 *     prompt: 'Summarize ...',
 *   })
 *
 * 关键点:
 *   - env 设 HOME=homePath,**不**继承外层 HOME(订阅凭证才会被读到)
 *   - --output-format json 让 stdout 是一行 envelope JSON,里面 .result 或 .content 又是内层 JSON / text
 *   - --disallowedTools 防止子进程随便 read/write/run bash
 *   - 3 分钟超时
 *   - 不回显 prompt 到错误里
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000
const BIN = () => process.env.CLAUDE_BIN || 'claude'

const DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Agent',
  'NotebookEdit',
  'TodoWrite',
].join(',')

/**
 * Claude CLI 的 extended-thinking 关键词。把这些词放到 prompt 头部,
 * CLI 会自动启用对应预算的 thinking。
 *   off          → 不加前缀,模型完全不思考
 *   think        → 'think' 关键词
 *   think_hard   → 'think hard'
 *   think_harder → 'think harder'
 *   ultrathink   → 'ultrathink'
 *
 * 不认识的值当成 'off' 处理。
 */
const REASONING_TO_CLI_KEYWORD = {
  off: '',
  think: 'think',
  think_hard: 'think hard',
  think_harder: 'think harder',
  ultrathink: 'ultrathink',
}

function withReasoningPrefix(prompt, reasoning) {
  const kw = REASONING_TO_CLI_KEYWORD[String(reasoning || '').toLowerCase()]
  if (!kw) return prompt
  // Claude 文档里推荐放在 prompt 开头,后面跟实际任务
  return `${kw}.\n\n${prompt}`
}

/**
 * @param {object} args
 * @param {string} args.homePath  — 用户 OAuth 凭证所在的 HOME(下面应有 .claude/)
 * @param {string} args.model
 * @param {string} [args.system]
 * @param {string} args.prompt
 * @param {string} [args.reasoning] — off | think | think_hard | think_harder | ultrathink
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ text: string, latencyMs: number, raw?: object }>}
 */
export async function sendMessage({
  homePath,
  model,
  system,
  prompt,
  reasoning,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!homePath) throw new Error('anthropic-cli.sendMessage: homePath required')
  if (!model) throw new Error('anthropic-cli.sendMessage: model required')
  if (!prompt) throw new Error('anthropic-cli.sendMessage: prompt required')

  const effectivePrompt = withReasoningPrefix(prompt, reasoning)

  const args = [
    '-p',
    effectivePrompt,
    '--output-format',
    'json',
    '--model',
    model,
    '--disallowedTools',
    DISALLOWED_TOOLS,
  ]
  if (system) {
    args.push('--append-system-prompt', system)
  }

  const env = {
    ...process.env,
    HOME: homePath,
    // 也清掉一些常见会污染 CLI 行为的 XDG 路径
    XDG_CONFIG_HOME: undefined,
    XDG_DATA_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  }
  // 删 undefined
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]

  const started = Date.now()
  return await new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(BIN(), args, {
        cwd: homePath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached + 自成进程组 → timeout 时 kill(-pid) 杀整组,防 wrapper 的子子进程僵尸吃配额
        detached: true,
      })
    } catch (e) {
      return reject(new Error(`spawn_failed: ${e.message}`))
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    // 杀整个进程组(detached spawn 时 pid 就是 pgid)
    function killTree(sig) {
      try { process.kill(-proc.pid, sig) }
      catch {
        try { proc.kill(sig) } catch {}
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree('SIGTERM')
      setTimeout(() => killTree('SIGKILL'), 2000)
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
      // JSON 双层解析:外层 envelope → 内层 result
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
 * 从 `claude -p --output-format json` 的 stdout 里抽出文本。
 *
 * 实测格式(随版本可能变,所以多重 fallback):
 *   envelope = { type: 'result', subtype: 'success', result: '<string or JSON-encoded>', ... }
 *
 * 如果 result 本身又是 JSON-encoded(envelope 套 envelope),再解一层。
 */
function extractText(stdout) {
  const s = (stdout || '').trim()
  if (!s) return ''
  let outer
  try {
    outer = JSON.parse(s)
  } catch {
    return s // 不是 JSON 直接当文本
  }
  // 常见字段
  let candidate =
    outer?.result ??
    outer?.content ??
    outer?.text ??
    outer?.output ??
    outer?.message ??
    null
  if (candidate == null) return JSON.stringify(outer)
  if (typeof candidate !== 'string') return JSON.stringify(candidate)

  // 第二层 JSON?
  const trimmed = candidate.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const inner = JSON.parse(trimmed)
      if (typeof inner === 'string') return inner
      if (inner?.text) return String(inner.text)
      if (Array.isArray(inner?.content)) {
        return inner.content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('')
      }
      return candidate
    } catch {
      return candidate
    }
  }
  return candidate
}
