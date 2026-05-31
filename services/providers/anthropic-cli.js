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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000
const BIN = () => process.env.CLAUDE_BIN || 'claude'

// Dump 大 stdout(>2KB)的完整 envelope 到 /tmp/claude_cli_dump_<ts>.txt
//   触发条件:stdout 是大 envelope OR extractText 输出可疑(<1024 或不以 { 开头)。
//   保留 7 天给排查用,旧文件 cron / tmpreaper 自动清。
function maybeDumpStdoutForDebug(stdout, extractedText, contextLabel) {
  try {
    const isSuspicious = extractedText && (extractedText.length < 1024 || !/^[\{\[]/.test(extractedText.trim()))
    const isLarge = stdout && stdout.length > 2048
    if (!isLarge && !isSuspicious) return null
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const fname = `claude_cli_dump_${contextLabel || 'unknown'}_${ts}.txt`
    const fpath = path.join(os.tmpdir(), fname)
    const header = [
      `# Claude CLI stdout dump`,
      `# Generated: ${new Date().toISOString()}`,
      `# Context: ${contextLabel || 'unknown'}`,
      `# stdout length: ${stdout.length}`,
      `# extracted text length: ${(extractedText || '').length}`,
      `# extracted starts with: ${JSON.stringify((extractedText || '').slice(0, 80))}`,
      `# suspicious: ${isSuspicious}`,
      `# --- raw stdout below ---`,
      '',
    ].join('\n')
    fs.writeFileSync(fpath, header + stdout, 'utf8')
    console.warn(`[anthropic-cli] dumped stdout to ${fpath} (stdout=${stdout.length}, extracted=${(extractedText || '').length})`)
    return fpath
  } catch (e) {
    console.error('[anthropic-cli] dump failed:', e.message)
    return null
  }
}

// Linux execve 限制:单个 argv 元素硬上限 MAX_ARG_STRLEN = PAGE_SIZE * 32 = 128KB。
// 超过就 spawn E2BIG。Step 6 synthesis 喂 117 篇 + matrix + RoB 实测 ~300-400KB。
// 阈值取 96KB(留 32KB 余量),超阈值时 prompt / system 走 stdin 而不是 argv。
const ARGV_SAFE_BYTES = 96 * 1024
function bytesLen(s) {
  return Buffer.byteLength(s || '', 'utf8')
}

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
 * @param {string} [args.sessionId] — 优化打磨包 / Session-continuity:UUID
 *                  - 首次设此 sid → claude CLI 在 ~/.claude/projects/.. 落地新 session
 *                  - 后续传 resumeSession=true → claude CLI --resume <sid>,LLM 看见上次对话原文
 *                  - 跨学科 / 跨章节复用,确保语气、术语、引用风格一致
 * @param {boolean} [args.resumeSession] — true → 用 --resume(必须 session 已存在),false / 未传 → --session-id 新建
 * @returns {Promise<{ text: string, latencyMs: number, raw?: object, sessionId?: string }>}
 */
export async function sendMessage({
  homePath,
  model,
  system,
  prompt,
  reasoning,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sessionId = null,
  resumeSession = false,
}) {
  if (!homePath) throw new Error('anthropic-cli.sendMessage: homePath required')
  if (!model) throw new Error('anthropic-cli.sendMessage: model required')
  if (!prompt) throw new Error('anthropic-cli.sendMessage: prompt required')

  const effectivePrompt = withReasoningPrefix(prompt, reasoning)

  // E2BIG 防护:超阈值的 prompt 走 stdin(`claude -p` 在 stdin 非 TTY 时读 stdin)。
  // System prompt 一般 < 30KB 直接走 argv;若极少数情况下 system 也超阈值,
  // 则把 system 拼到 prompt 头部(用分隔符)一起走 stdin。
  const promptIsBig = bytesLen(effectivePrompt) > ARGV_SAFE_BYTES
  const systemIsBig = !!system && bytesLen(system) > ARGV_SAFE_BYTES

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--disallowedTools',
    DISALLOWED_TOOLS,
  ]

  // 优化打磨包 / Session-continuity:
  //   - resumeSession=true → 'claude -p ... --resume <sid>' 续会话(LLM 看上次对话原文)
  //   - sessionId 单传 → 'claude -p ... --session-id <sid>' 新建会话(后续可 resume)
  //   - 都不传 → 默认 stateless 调用(原行为,session 不写盘)
  if (sessionId) {
    const sid = String(sessionId).trim()
    // UUID 校验(Claude CLI 要求 valid UUID;若非法直接 throw 让上层 fallback 到 stateless)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
      throw new Error(`anthropic-cli.sendMessage: sessionId must be a valid UUID (got "${sid.slice(0, 40)}")`)
    }
    if (resumeSession) {
      args.push('--resume', sid)
    } else {
      args.push('--session-id', sid)
    }
  } else {
    // 没传 session 时关闭 session 落盘 — 避免污染 ~/.claude/projects/
    args.push('--no-session-persistence')
  }

  let stdinPayload = null
  if (promptIsBig || systemIsBig) {
    // Big path: prompt via stdin
    if (systemIsBig) {
      // 把 system 也塞 stdin,用边界标记区分(claude CLI 无 --system-stdin,
      // 退而求其次:把 system 当成 prompt 头部一节)
      stdinPayload = `<<<SYSTEM>>>\n${system || ''}\n<<<USER>>>\n${effectivePrompt}`
    } else {
      stdinPayload = effectivePrompt
      if (system) args.push('--append-system-prompt', system)
    }
  } else {
    // Small path: 走原本 argv 路径
    //   ⚠ BUG fix(2026-05-24): args 第 0 项是 '-p',要在 index 1(紧跟 -p 后)插 prompt,
    //   不是 index 2(否则会插到 '--output-format' 和 'json' 中间,把 prompt 当成
    //   --output-format 的 value,claude 报 invalid + exit 1 + 回显 prompt 到 stdout)。
    //   实测 Step 7 overlay 5KB 小 prompt 撞到这个 bug;Step 6 synthesis 因 >96KB 走 stdin path 没踩到。
    args.splice(1, 0, effectivePrompt) // 在 '-p'(index 0)后插入 prompt → ['-p', prompt, '--output-format', 'json', ...]
    if (system) args.push('--append-system-prompt', system)
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
        // stdinPayload 非空时 stdin 走 pipe,否则保持 ignore(原行为)
        stdio: [stdinPayload ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // detached + 自成进程组 → timeout 时 kill(-pid) 杀整组,防 wrapper 的子子进程僵尸吃配额
        detached: true,
      })
    } catch (e) {
      return reject(new Error(`spawn_failed: ${e.message}`))
    }

    if (stdinPayload) {
      try {
        proc.stdin.on('error', (err) => {
          // EPIPE 可能在 CLI 早退时触发 — 不直接 reject(让 close handler 报真实 exit_code)
          if (err && err.code !== 'EPIPE') {
            // 其他写入错误也吞了,等 close 决定
          }
        })
        proc.stdin.write(stdinPayload, 'utf8')
        proc.stdin.end()
      } catch (e) {
        // 写 stdin 失败极罕见,降级:让进程自然超时或退出
      }
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
        // 2026-05-25 BUG FIX:claude CLI 经常 exit 1 但 stdout 是**完整** JSON envelope
        //   (e.g. is_error=true / subtype=error_max_turns / result 含真实错误描述)。
        //   之前直接塞 stdout 尾部 300 字符 → 用户看到 "ce_tier":"standard",... 这种截断
        //   片段,完全不知道是什么错。
        //
        //   现在按 3 级优先:
        //     1) stdout 整体能 parse 成 JSON → 看 envelope 的 is_error/subtype/result
        //        - subtype=error_max_turns / error_token_limit 等 → 给清晰的错误名 + 提示
        //        - is_error=true 但 result 是有用文本 → 把它当成 error message
        //        - is_error=false 但 exit !=0(可能 CLI bug)→ 把 result 当成成功内容返回!
        //     2) stdout 不是 JSON → fallback 到老逻辑(stderr/stdout 尾巴,但 tail 加长到 1024)
        let raw = null
        try { raw = JSON.parse(stdout) } catch { raw = null }

        if (raw && typeof raw === 'object') {
          const subtype = raw.subtype || raw.type || ''
          const isError = !!raw.is_error
          const innerResult = typeof raw.result === 'string' ? raw.result : (raw.result ? JSON.stringify(raw.result) : '')

          // (1.A) 非错误 envelope + 完整 result → CLI exit 1 是 cosmetic,把 result 当成功返回
          //   (常见原因:OAuth 子进程 cleanup race / detached pgid 报 SIGHUP 但 stdout 已完整)
          if (!isError && innerResult && innerResult.length > 50) {
            console.warn(`[anthropic-cli] exit_${code} but valid envelope found; salvaging result (${innerResult.length}B). subtype=${subtype}`)
            const text = extractText(stdout)
            const respSessionId = (raw && (raw.session_id || raw.sessionId)) || sessionId || null
            return resolve({ text, latencyMs, raw, sessionId: respSessionId, salvagedFromExitCode: code })
          }

          // (1.B) 真错误 envelope → 给用户清晰错误名
          const usage = raw.usage || {}
          const numTurns = raw.num_turns != null ? raw.num_turns : '?'
          const costUsd = raw.total_cost_usd != null ? raw.total_cost_usd : null
          let errLabel = subtype || (isError ? 'unknown_error' : `exit_${code}`)
          // 友好化常见 error subtype
          const friendlyMap = {
            error_max_turns:    'LLM 跑超过最大 turn 数(agentic 任务太复杂 / prompt 引导 LLM 反复用工具)',
            error_token_limit:  'LLM 上下文超 token 上限(prompt 太大)',
            error_rate_limit:   'API 频次限制',
            error_overloaded:   'Anthropic 服务过载',
          }
          let friendly = friendlyMap[subtype] || ''
          // 2026-05-25:result === "Prompt is too long" 也是 token 超限,subtype 没标但 result 标了
          //   这是 claude CLI 在 input > context window 时常见的返回(subtype 可能仍是 'success')。
          //   给个统一的"prompt 太长"提示 + 建议(用 Opus 1M / 减少 rawMatrixRows)
          if (innerResult && /prompt is too long/i.test(innerResult)) {
            errLabel = 'prompt_too_long'
            friendly = 'Prompt 超出 Claude context 窗口(输入太大)。建议:① 在 /admin/users 切换到 Opus(1M context);② 或在 /report 重生 plan / overlay 时减少 sample paper 数;③ 或拆分章节单独跑'
          }
          const detailMsg = [
            errLabel,
            friendly && `(${friendly})`,
            numTurns !== '?' && `turns=${numTurns}`,
            costUsd != null && `cost=$${costUsd}`,
            innerResult && innerResult.length < 400 && `result=${innerResult.slice(0, 400)}`,
          ].filter(Boolean).join(' · ')
          return reject(new Error(`claude_cli_error: ${detailMsg}`))
        }

        // (2) 老 fallback:stdout 非 JSON,只能从 raw 尾部猜。tail 升到 1024 字符
        //   且抓 head+tail 而不是只 tail —— claude CLI 出错时关键信息往往在开头几行
        const stderrTail = stderr ? stderr.slice(-1024).trim() : ''
        const stdoutHead = stdout ? stdout.slice(0, 400).trim() : ''
        const stdoutTail = stdout ? stdout.slice(-700).trim() : ''
        const stdoutBlock = stdout
          ? `STDOUT(${stdout.length}B,head)=${stdoutHead} ... STDOUT(tail)=${stdoutTail}`
          : 'STDOUT(empty)'
        const detail = [
          stderrTail ? `STDERR(${stderr.length}B)=${stderrTail}` : 'STDERR(empty)',
          stdoutBlock,
        ].join(' || ')
        return reject(new Error(`exit_${code}: ${detail}`))
      }
      // JSON 双层解析:外层 envelope → 内层 result
      const text = extractText(stdout)
      let raw
      try {
        raw = JSON.parse(stdout)
      } catch {
        raw = undefined
      }
      // Debug dump:大 envelope OR 可疑短/不以 {/[ 开头的提取结果(说明 envelope 截断/格式异常)
      //   M29 后续:proj_2afd 25 分钟跑成功但 result 字段只剩尾部 5584 字符,需要看完整 envelope 才能定位
      maybeDumpStdoutForDebug(stdout, text, model)
      // 优化打磨包 / Session-continuity:把 sessionId 回传(我们传进去什么,就回什么 —
      // claude CLI 的 envelope 也有 session_id 字段可校验,但简单起见用传入值即可)
      const respSessionId = (raw && (raw.session_id || raw.sessionId)) || sessionId || null
      resolve({ text, latencyMs, raw, sessionId: respSessionId })
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
