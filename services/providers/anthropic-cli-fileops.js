/**
 * services/providers/anthropic-cli-fileops.js — 2026-05-26
 *
 * Claude CLI 文件操作模式 — 跟 anthropic-cli.js 平行,但 Claude 用 Read/Write/Edit/Glob
 * 工具在一个 sandbox 工作目录里干活,代替"一次性 JSON 输出"模式。
 *
 * 用途:Step 9 LaTeX fill — 论文已锁,filling 本质是文件操作。Claude 一段一段
 *   Read sections/*.md + Read template/main.tex,然后 Write 出 out/main.tex。
 *   不再被单次 stream 50K LaTeX 输出 + JSON envelope escape 卡住。
 *
 * 用法:
 *   import { runFileOpsClaude } from './anthropic-cli-fileops.js'
 *   const { exitCode, stdout, stderr, latencyMs } = await runFileOpsClaude({
 *     homePath: '/var/lib/slr/user-homes/.../cred_xxx',  // OAuth 凭证 HOME
 *     model: 'claude-opus-4-8',
 *     fallbackModel: 'claude-sonnet-4-6',                  // Opus overloaded 时自动降级
 *     cwd: '/var/lib/slr/uploads/latex-renders/.../fill',  // Claude 在这里 Read/Write
 *     prompt: 'Read INSTRUCTIONS.md and follow it.',
 *     allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
 *     timeoutMs: 45 * 60 * 1000,
 *   })
 *
 * 关键差异(vs anthropic-cli.js sendMessage):
 *   - --allowedTools(白名单),非 --disallowedTools(黑名单)— 默认开 Read/Write/Edit/Glob/Grep,
 *     默认仍封 Bash / WebFetch / Agent 等(防 sandbox 漏)
 *   - spawn `cwd` = 工作目录(不是 homePath);HOME env 仍指 credential
 *   - 不传 --output-format json — stdout 是 tool-call 摘要文本,直接返回 stdout 给 caller
 *   - --fallback-model 启用 Anthropic 自动降级(Opus Overloaded → 自动跑 Sonnet)
 *   - timeout 默认 45 min(file ops 任务比单 LLM call 长)
 *   - 不解 JSON envelope — caller 看 out/<expected>.tex 文件来判断成功(stdout 只是诊断)
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000   // 45 min
const BIN = () => process.env.CLAUDE_BIN || 'claude'

// E2BIG 防护:argv 单元素硬上限 128KB,prompt > 96KB 走 stdin
const ARGV_SAFE_BYTES = 96 * 1024
function bytesLen(s) { return Buffer.byteLength(s || '', 'utf8') }

/**
 * @param {object} args
 * @param {string} args.homePath        - OAuth 凭证 HOME(.claude/ 在下面)
 * @param {string} args.model           - e.g. claude-opus-4-8
 * @param {string} [args.fallbackModel] - e.g. claude-sonnet-4-6;Opus 限流时 Anthropic 端自动切
 * @param {string} args.cwd             - Claude 操作的工作目录(必须存在 + 可写)
 * @param {string} args.prompt          - 启动 prompt(简短,通常指向 cwd 里的 INSTRUCTIONS.md)
 * @param {string[]} [args.allowedTools] - 默认 ['Read','Write','Edit','Glob','Grep']
 * @param {number} [args.timeoutMs]     - 默认 45 min
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, latencyMs: number,
 *                     timedOut?: boolean, signal?: string }>}
 */
export async function runFileOpsClaude({
  homePath,
  model,
  fallbackModel = null,
  cwd,
  prompt,
  allowedTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!homePath) throw new Error('runFileOpsClaude: homePath required')
  if (!model) throw new Error('runFileOpsClaude: model required')
  if (!cwd) throw new Error('runFileOpsClaude: cwd required')
  if (!prompt) throw new Error('runFileOpsClaude: prompt required')

  const promptIsBig = bytesLen(prompt) > ARGV_SAFE_BYTES

  const args = [
    '-p',
    '--model', model,
    '--allowed-tools', allowedTools.join(','),
    '--no-session-persistence',     // 每次 fileops 独立,不要落盘 session
  ]
  if (fallbackModel) {
    args.push('--fallback-model', fallbackModel)
  }

  let stdinPayload = null
  if (promptIsBig) {
    stdinPayload = prompt
  } else {
    // small prompt 走 argv:在 '-p' 后立即插入 prompt(同 anthropic-cli.js bug fix 经验)
    args.splice(1, 0, prompt)
  }

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
        cwd,    // ← 工作目录(Claude Read/Write 的相对路径起点)
        env,
        stdio: [stdinPayload ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,  // 子进程组 — timeout 时 kill(-pid) 杀整组
      })
    } catch (e) {
      return reject(new Error(`spawn_failed: ${e.message}`))
    }

    if (stdinPayload) {
      try {
        proc.stdin.on('error', (err) => {
          if (err && err.code !== 'EPIPE') {
            // 其他写入错误吞 — 等 close 决定
          }
        })
        proc.stdin.write(stdinPayload, 'utf8')
        proc.stdin.end()
      } catch (e) {
        // 写 stdin 失败 → 让 Claude 自然 timeout
      }
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    function killTree(sig) {
      try { process.kill(-proc.pid, sig) }
      catch {
        try { proc.kill(sig) } catch {}
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      timedOut = true
      killTree('SIGTERM')
      setTimeout(() => killTree('SIGKILL'), 2000)
      // 不 reject — 给 caller 半成品 stdout / stderr 用于诊断
      resolve({
        exitCode: -1,
        stdout,
        stderr,
        latencyMs: Date.now() - started,
        timedOut: true,
        signal: 'SIGTERM',
      })
    }, timeoutMs)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (c) => { stdout += c })
    proc.stderr.on('data', (c) => { stderr += c })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`proc_error: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        latencyMs: Date.now() - started,
        timedOut,
        signal: signal || undefined,
      })
    })
  })
}
