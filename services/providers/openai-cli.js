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

/**
 * 内部:构造 codex exec args。导出供单测使用。
 */
export function buildExecArgs({ model, fullPrompt, outFile }) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m', model,
    '-o', outFile,
    '-c', 'sandbox_permissions=["disk-full-read-access"]',
    fullPrompt,
  ]
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

  // 3) args
  const args = buildExecArgs({ model, fullPrompt, outFile })

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
        const tail = (stderr || stdout).slice(-512).trim()
        cleanupOutFile(outFile)
        return reject(new Error(`exit_${code}: ${tail}`))
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
