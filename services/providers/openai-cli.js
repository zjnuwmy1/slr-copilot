/**
 * services/providers/openai-cli.js
 *
 * 真实 codex CLI(v0.132.0)headless 调用。Phase 7 重写。
 *
 * 用法:
 *   import { sendMessage } from './openai-cli.js'
 *   const { text, latencyMs, usage } = await sendMessage({
 *     homePath: '/var/lib/slr/user-homes/.../cred_xxx',
 *     model: 'gpt-5',
 *     system: 'You are ...',
 *     prompt: 'Summarize ...',
 *   })
 *
 * 关键点(实测得来):
 *   - 子命令是 `codex exec`(不是 `codex -p`)
 *   - 必带 `-m <model>`
 *   - 没有 `--system` 参数 → system 拼到 prompt 前
 *   - `--json` 输出 JSONL(每行一个 event)
 *   - `--output-last-message <FILE>`(短选项 `-o`)把 final message 写文件 → 最干净的取文本方式
 *   - `--skip-git-repo-check` 必加(我们 cwd 不一定是 git repo)
 *   - `--ephemeral` 不持久化 session(避免污染 stage HOME)
 *   - `-c sandbox_permissions=["disk-full-read-access"]`(只读访问,避免 codex 拒跑)
 *   - env HOME=homePath,不继承外层 HOME(订阅凭证才会被读到)
 *   - 3 分钟超时
 *   - JSONL 里如果有 token usage event 抓出 input/output tokens;抓不到就 null
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000
const BIN = () => process.env.CODEX_BIN || 'codex'

// codex 接受的 reasoning_effort 取值
const OPENAI_VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])

/**
 * 内部:构造 codex exec args。导出供单测使用。
 *
 * @param {object} a
 * @param {string} a.model
 * @param {string} a.fullPrompt
 * @param {string} a.outFile
 * @param {string} [a.reasoningEffort] — minimal | low | medium | high
 */
export function buildExecArgs({ model, fullPrompt, outFile, reasoningEffort }) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m', model,
    '-o', outFile,
    '-c', 'sandbox_permissions=["disk-full-read-access"]',
    // 关掉 codex 默认开的"工具"feature。
    // 原因:gpt-5.x 与 reasoning.effort='minimal' 配合时,API 不允许任何工具调用,
    // 但 codex 0.132.0 默认会带 image_generation + tool_search(=web_search)+
    // computer_use + browser_use 等。我们的 prompt 只是要 JSON 输出,完全不需要工具 —
    // 关掉它们既避免 minimal 冲突,又减少不必要的服务端开销。
    // 单元化用 --disable <feature>(等价于 -c features.<name>=false)
    '--disable', 'image_generation',
    '--disable', 'tool_search',
    '--disable', 'computer_use',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'in_app_browser',
    '--disable', 'multi_agent',
  ]
  if (reasoningEffort && OPENAI_VALID_EFFORTS.has(reasoningEffort)) {
    args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
  }
  args.push(fullPrompt)
  return args
}

/**
 * @param {object} args
 * @param {string} args.homePath  — 用户 OAuth 凭证所在的 HOME(下面应有 .codex/)
 * @param {string} args.model
 * @param {string} [args.system]
 * @param {string} args.prompt
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ text: string, latencyMs: number, usage: { input_tokens: number|null, output_tokens: number|null }, raw?: object }>}
 */
export async function sendMessage({
  homePath,
  model,
  system,
  prompt,
  reasoning,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!homePath) throw new Error('openai-cli.sendMessage: homePath required')
  if (!model) throw new Error('openai-cli.sendMessage: model required')
  if (!prompt) throw new Error('openai-cli.sendMessage: prompt required')

  // 1) 合并 system + prompt(codex 没有 --system)
  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt

  // 2) 临时 last-message 输出文件
  const outFile = path.join(
    os.tmpdir(),
    `codex_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
  )

  // 3) args(可选注入 reasoning_effort)
  // 防御:gpt-5.x + reasoning.effort='minimal' + 任何工具 = 400 invalid_request_error。
  // 我们已经 --disable 了 image_generation / tool_search / browser_use 等,
  // 但万一 codex 未来又默认开新工具,minimal 还是会炸。所以双保险:
  // 看到 minimal 就 bump 到 low(对 screening 影响极小,gpt-5.5 low 一样快)。
  let reasoningEffort = String(reasoning || '').toLowerCase()
  if (reasoningEffort === 'minimal') {
    reasoningEffort = 'low'
  }
  const args = buildExecArgs({
    model, fullPrompt, outFile,
    reasoningEffort: OPENAI_VALID_EFFORTS.has(reasoningEffort) ? reasoningEffort : null,
  })

  // 4) env:HOME 隔离
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
      cleanupOutFile(outFile)
      return reject(new Error(`spawn_failed: ${e.message}`))
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanupOutFile(outFile)
      fn()
    }

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
      cleanupOutFile(outFile)
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
      finish(() => reject(new Error(`proc_error: ${err.message}`)))
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      if (code !== 0) {
        // 智能错误提取:codex 0.132.0 stderr 会有 "Reading additional input from stdin..."
        // 这种**正常状态消息**;真正的失败信息在 stdout JSONL 的 turn.failed / type:error 事件里,
        // 或 stderr 较前面的 ERROR 行里。简单的 slice(-512) 只会拿到尾巴的噪音。
        const errMsg = extractFailureMessage(stdout, stderr) || `exit_${code}: ${(stderr || stdout).slice(-300).trim()}`
        cleanupOutFile(outFile)
        return reject(new Error(errMsg))
      }
      // 取 final message 优先从 outFile 读
      let text = ''
      try {
        if (fs.existsSync(outFile)) {
          text = fs.readFileSync(outFile, 'utf8').trim()
        }
      } catch (e) {
        // best-effort
      }
      // fallback: 从 JSONL 里挑 message 事件
      if (!text) {
        text = extractTextFromJsonl(stdout)
      }
      const usage = extractUsageFromJsonl(stdout)
      cleanupOutFile(outFile)
      resolve({ text, latencyMs, usage })
    })
  })
}

function cleanupOutFile(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    // ignore
  }
}

/**
 * 智能提取失败原因。codex 0.132.0 错误码分散在多个地方:
 *   1. stdout JSONL:`type=turn.failed`(权威,有 error.message),`type=error`(reconnect 重试)
 *   2. stderr 前段:ERROR codex_api::endpoint::... HTTP 401/403/429 等
 *   3. "Reading additional input from stdin..." 是状态消息,不是错误
 *
 * 优先返回最 actionable 的消息,加上常见错误的中文翻译。
 * 找不到具体错误 → 返回 null 让调用方走默认 tail 兜底。
 */
function extractFailureMessage(stdout, stderr) {
  // 1) 先在 stdout JSONL 找 turn.failed(权威错误)
  const lines = (stdout || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t || !t.startsWith('{')) continue
    let ev
    try { ev = JSON.parse(t) } catch { continue }
    if (ev?.type === 'turn.failed' && ev.error?.message) {
      return translateCodexError(ev.error.message)
    }
  }
  // 2) 再在 stdout 找最后一个 type:error 消息
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t || !t.startsWith('{')) continue
    let ev
    try { ev = JSON.parse(t) } catch { continue }
    if (ev?.type === 'error' && typeof ev.message === 'string' && ev.message.trim()) {
      // 跳过 "Reconnecting..." 这种中间重试消息,挑最后那个真错
      if (!/^Reconnecting/i.test(ev.message)) {
        return translateCodexError(ev.message)
      }
    }
  }
  // 3) stderr 里找 ERROR <module>: 行(codex_api / codex_core)
  const stderrLines = (stderr || '').split(/\r?\n/)
  for (const ln of stderrLines) {
    const m = ln.match(/\bERROR\s+codex_\w+(?:::\w+)*:\s*(.+)$/)
    if (m && m[1]) {
      const msg = m[1].trim()
      // 跳过明显的 noise(如 agents_md permission denied,无关本次失败)
      if (/agents_md|Permission denied \(os error 13\)/.test(msg)) continue
      return translateCodexError(msg)
    }
  }
  return null
}

/**
 * 把 codex 原始错误翻译成 actionable 中文消息。
 */
function translateCodexError(raw) {
  if (!raw) return 'codex_unknown_error'
  const s = String(raw)
  // 401 / 403:Token 失效或没登录
  if (/401\s*Unauthorized|Missing bearer|basic authentication/i.test(s)) {
    return 'codex_unauthorized: OAuth Token 失效或未登录 — 超管需要在管理后台重新绑定 Codex(OpenAI)凭证 [' + s.slice(0, 200) + ']'
  }
  // 429:限流
  if (/429|rate.?limit|too many requests/i.test(s)) {
    return 'codex_rate_limited: 触发限流,稍后重试 [' + s.slice(0, 200) + ']'
  }
  // 配额耗尽
  if (/quota|usage limit|insufficient_quota|monthly limit/i.test(s)) {
    return 'codex_quota_exceeded: 订阅配额耗尽 [' + s.slice(0, 200) + ']'
  }
  // 网络
  if (/network|connection|ECONN|timeout|timed out/i.test(s)) {
    return 'codex_network_error: ' + s.slice(0, 300)
  }
  // 模型不存在
  if (/model.*not.*found|unknown.?model|invalid.?model/i.test(s)) {
    return 'codex_invalid_model: ' + s.slice(0, 300)
  }
  return 'codex_error: ' + s.slice(0, 400)
}

/**
 * 从 JSONL stdout 里抠 final text(--output-last-message 失败时的兜底)。
 * 遍历每行,尝试 JSON.parse,挑最后一个 type 含 message/agent_message/result 的 event。
 */
function extractTextFromJsonl(stdout) {
  if (!stdout) return ''
  const lines = stdout.split(/\r?\n/)
  let best = ''
  for (const ln of lines) {
    const t = ln.trim()
    if (!t) continue
    if (!t.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    // 常见字段
    const candidate =
      ev?.message ??
      ev?.text ??
      ev?.content ??
      ev?.result ??
      ev?.output ??
      ev?.delta ??
      null
    if (typeof candidate === 'string' && candidate.trim()) {
      best = candidate
    } else if (Array.isArray(candidate)) {
      const joined = candidate
        .filter((b) => b && (b.type === 'text' || typeof b === 'string'))
        .map((b) => (typeof b === 'string' ? b : b.text))
        .join('')
      if (joined.trim()) best = joined
    }
  }
  return best
}

/**
 * 从 JSONL stdout 里抓 token usage。codex 的 event 形态没有稳定文档,
 * 防御性多字段匹配:`token_count`、`usage`、`tokens.{input,output}`、`{input_tokens,output_tokens}` 等。
 * 抓不到返回 { input_tokens: null, output_tokens: null }。
 */
function extractUsageFromJsonl(stdout) {
  const result = { input_tokens: null, output_tokens: null }
  if (!stdout) return result
  const lines = stdout.split(/\r?\n/)
  for (const ln of lines) {
    const t = ln.trim()
    if (!t || !t.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    // 找各种可能的字段位置
    const tokens =
      ev?.tokens ||
      ev?.usage ||
      ev?.token_count ||
      (ev?.type === 'token_count' ? ev : null) ||
      null
    if (tokens && typeof tokens === 'object') {
      const inT = tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens ?? null
      const outT = tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens ?? null
      if (typeof inT === 'number') result.input_tokens = inT
      if (typeof outT === 'number') result.output_tokens = outT
    } else {
      const inT = ev?.input_tokens ?? ev?.prompt_tokens ?? null
      const outT = ev?.output_tokens ?? ev?.completion_tokens ?? null
      if (typeof inT === 'number') result.input_tokens = inT
      if (typeof outT === 'number') result.output_tokens = outT
    }
  }
  return result
}
