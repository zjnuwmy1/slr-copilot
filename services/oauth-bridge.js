/**
 * services/oauth-bridge.js
 *
 * Web 化复现 `claude login` / `codex login` 的核心:
 *   1. mkdir stage HOME(随机的、用户私有)
 *   2. spawn binary 的 `login` 子命令,env 里 HOME 指向 stage,**不**继承外层 HOME
 *   3. 监听 stdout:正则抓首个 https URL → UPDATE oauth_bind_sessions.prompt_url + state='awaiting_code'
 *   4. /account/oauth/:id/code 收到 code 后,经 submitCode 写到子进程 stdin
 *   5. 子进程 close:
 *      - exit 0 && stage 下有 .claude/ 或 .codex/ → 改名到永久路径,创建 user_credentials,state='completed'
 *      - 否则 → 清 stage,state='failed',error_message = stderr tail
 *   6. 5 分钟超时 → SIGTERM,state='timeout'
 *
 * 进程重启后内存 Map 会丢。route 层在访问 awaiting_* 状态的 session 时如果发现内存里没有
 * 对应 entry,会标记为 failed("orphaned_after_restart")并要用户重试。
 *
 * 关键状态机:
 *
 *      [创建行]
 *         |
 *         v
 *   awaiting_url  ──(stdout 出现 URL)──>  awaiting_code
 *         │                                   │
 *         │                                   │ submitCode → stdin
 *         │                                   v
 *         │                              (子进程 exit)
 *         │                              ┌─────────┐
 *         │                              │ exit 0  │──> completed
 *         │                              │ exit≠0  │──> failed
 *         │                              └─────────┘
 *         │
 *         └──(5min timeout 任意时刻)──> timeout
 *         └──(POST /cancel)         ──> failed (user_cancelled)
 *
 * STDOUT 格式假设(防御性):
 *   假设 `claude login` 会以 "Open this URL: <https://...>" 或类似形式打印授权 URL。
 *   实际格式未确认 — 我们抓 `https?://[^\s'"<>]+` 第一个匹配,完整 stdout 落进
 *   oauth_bind_sessions 没有列存,只能进日志 / audit payload(payload 字段截尾 4 KiB)。
 *   如果跑真二进制发现 URL 没抓到,看 audit_events 里 oauth_bind_failed 的 payload.stdout_tail。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { encryptJson, randomId } from './crypto.js'
import { audit } from './audit.js'
import * as mockBridge from './oauth-bridge-mock.js'

const TIMEOUT_MS = 5 * 60 * 1000
const STDOUT_CAP = 64 * 1024 // 防止 CLI 无限输出爆内存
const URL_REGEX = /https?:\/\/[^\s'"<>`]+/i

const DATA_DIR = process.env.DATA_DIR || './.data'

// sessionId → { proc, stdoutBuf, stderrBuf, timer, stageHome, userId, provider, gotUrl, exited }
const sessions = new Map()

function stageHomeFor(userId, sessionId) {
  return path.resolve(DATA_DIR, 'user-homes', String(userId), `stage-${sessionId}`)
}
function permHomeFor(userId, credentialId) {
  return path.resolve(DATA_DIR, 'user-homes', String(userId), String(credentialId))
}

function binForProvider(provider) {
  if (provider === 'anthropic') return process.env.CLAUDE_BIN || 'claude'
  if (provider === 'openai') return process.env.CODEX_BIN || 'codex'
  throw new Error(`unknown provider: ${provider}`)
}

// 实测的真实子命令(用 `<bin> --help` 探测出来):
//   claude:  `claude auth login`  → 打印 OAuth URL,从 stdin 读 code
//   codex:   待真二进制确认,先假设 `codex login`(SUMMARY-C.md 已注明)
function loginArgsForProvider(provider) {
  if (provider === 'anthropic') return ['auth', 'login']
  if (provider === 'openai') return ['login']
  throw new Error(`unknown provider: ${provider}`)
}

function isMock(provider) {
  if (provider === 'anthropic') return (process.env.CLAUDE_BIN || '').toLowerCase() === 'mock'
  if (provider === 'openai') return (process.env.CODEX_BIN || '').toLowerCase() === 'mock'
  return false
}

function updateSession(db, sessionId, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const set = keys.map((k) => `${k} = ?`).join(', ')
  const vals = keys.map((k) => fields[k])
  db.prepare(`UPDATE oauth_bind_sessions SET ${set} WHERE id = ?`).run(...vals, sessionId)
}

/**
 * 入口:启动一条 login dance。同步立即返回,异步推进状态。
 *
 * 调用前 route 层已经:
 *   - 校验过 provider
 *   - 杀过用户旧的 awaiting 会话(见 killUserActiveSessions)
 *   - INSERT 了 oauth_bind_sessions 行(state='awaiting_url', stage_home_path = …)
 */
export function startLogin({ db, sessionId, userId, provider, req = null }) {
  if (isMock(provider)) {
    return mockBridge.startLogin({ db, sessionId, userId, provider, req })
  }

  const stageHome = stageHomeFor(userId, sessionId)
  try {
    fs.mkdirSync(stageHome, { recursive: true, mode: 0o700 })
    fs.chmodSync(stageHome, 0o700)
  } catch (e) {
    updateSession(db, sessionId, {
      state: 'failed',
      error_message: `mkdir_stage_home: ${e.message}`,
      finished_at: new Date().toISOString(),
    })
    audit(db, req, {
      eventType: 'oauth_bind_failed',
      userId,
      payload: { provider, sessionId, error: 'mkdir_failed', detail: e.message },
    })
    return
  }

  const bin = binForProvider(provider)
  let proc
  try {
    // env 显式不继承外层 HOME / XDG_*。
    const env = {
      ...process.env,
      HOME: stageHome,
      XDG_CONFIG_HOME: path.join(stageHome, '.config'),
      XDG_DATA_HOME: path.join(stageHome, '.local/share'),
      XDG_CACHE_HOME: path.join(stageHome, '.cache'),
    }
    proc = spawn(bin, loginArgsForProvider(provider), {
      cwd: stageHome,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    updateSession(db, sessionId, {
      state: 'failed',
      error_message: `spawn_failed: ${e.message}`,
      finished_at: new Date().toISOString(),
    })
    audit(db, req, {
      eventType: 'oauth_bind_failed',
      userId,
      payload: { provider, sessionId, error: 'spawn_failed', detail: e.message },
    })
    try {
      fs.rmSync(stageHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
    return
  }

  const entry = {
    proc,
    stdoutBuf: '',
    stderrBuf: '',
    timer: null,
    stageHome,
    userId,
    provider,
    gotUrl: false,
    exited: false,
    sessionId,
  }
  sessions.set(sessionId, entry)

  audit(db, req, {
    eventType: 'oauth_bind_start',
    userId,
    payload: { provider, sessionId, pid: proc.pid, bin },
  })

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  proc.stdout.on('data', (chunk) => {
    if (entry.stdoutBuf.length < STDOUT_CAP) {
      entry.stdoutBuf = (entry.stdoutBuf + chunk).slice(-STDOUT_CAP)
    }
    if (!entry.gotUrl) {
      const m = entry.stdoutBuf.match(URL_REGEX)
      if (m) {
        entry.gotUrl = true
        const url = m[0]
        try {
          updateSession(db, sessionId, { prompt_url: url, state: 'awaiting_code' })
        } catch (e) {
          console.error('[oauth-bridge] db update prompt_url failed:', e.message)
        }
      }
    }
  })

  proc.stderr.on('data', (chunk) => {
    if (entry.stderrBuf.length < STDOUT_CAP) {
      entry.stderrBuf = (entry.stderrBuf + chunk).slice(-STDOUT_CAP)
    }
    // 有些 CLI 把 URL 打到 stderr;也试着抓
    if (!entry.gotUrl) {
      const m = entry.stderrBuf.match(URL_REGEX)
      if (m) {
        entry.gotUrl = true
        const url = m[0]
        try {
          updateSession(db, sessionId, { prompt_url: url, state: 'awaiting_code' })
        } catch (e) {
          console.error('[oauth-bridge] db update prompt_url failed:', e.message)
        }
      }
    }
  })

  proc.on('error', (err) => {
    if (entry.exited) return
    entry.exited = true
    clearTimer(entry)
    finalizeFailed(db, sessionId, entry, `proc_error: ${err.message}`, req)
  })

  proc.on('close', (code, signal) => {
    if (entry.exited) return
    entry.exited = true
    clearTimer(entry)

    if (code === 0) {
      // 成功 — 检查 stage 下有没有 .claude / .codex
      finalizeSuccess(db, sessionId, entry, req).catch((e) => {
        console.error('[oauth-bridge] finalizeSuccess threw:', e)
      })
    } else {
      const tail = (entry.stderrBuf || entry.stdoutBuf || '').slice(-1024).trim()
      const msg = signal
        ? `killed_by_signal:${signal}`
        : `exit_${code}${tail ? `: ${tail}` : ''}`
      finalizeFailed(db, sessionId, entry, msg, req)
    }
  })

  // 5 分钟超时
  entry.timer = setTimeout(() => {
    if (entry.exited) return
    entry.exited = true
    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
    // 给点时间让 close 事件跑完,但不阻塞:直接收尾为 timeout
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, 2000)
    finalizeFailed(db, sessionId, entry, 'timeout: no completion within 5 minutes', req, 'timeout')
  }, TIMEOUT_MS)
}

/**
 * 用户提交 code → 找内存 entry → 写子进程 stdin
 */
export function submitCode({ db, sessionId, code, req = null }) {
  const entry = sessions.get(sessionId)
  if (!entry) {
    return { ok: false, error: 'session_not_in_memory' }
  }
  if (entry.exited) {
    return { ok: false, error: 'already_finished' }
  }
  if (entry.mock) {
    // mock 模式的 entry 没有 proc,delegate
    return mockBridge.submitCode({ db, sessionId, code, req })
  }
  try {
    entry.proc.stdin.write(String(code).trim() + '\n')
  } catch (e) {
    return { ok: false, error: `stdin_write_failed: ${e.message}` }
  }
  return { ok: true }
}

/**
 * 用户取消 / 被新会话挤掉
 */
export function cancel({ db, sessionId, reason = 'user_cancelled', req = null }) {
  const entry = sessions.get(sessionId)
  if (!entry) {
    // 内存里没了,可能已 exit。直接 DB 标 failed(如果还是 awaiting_*)
    const row = db
      .prepare(`SELECT state FROM oauth_bind_sessions WHERE id = ?`)
      .get(sessionId)
    if (row && (row.state === 'awaiting_url' || row.state === 'awaiting_code')) {
      updateSession(db, sessionId, {
        state: 'failed',
        error_message: reason,
        finished_at: new Date().toISOString(),
      })
    }
    return { ok: true, note: 'not_in_memory' }
  }
  if (entry.mock) {
    return mockBridge.cancel({ db, sessionId, req })
  }
  entry.exited = true
  clearTimer(entry)
  try {
    entry.proc.kill('SIGTERM')
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      entry.proc.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, 2000)
  finalizeFailed(db, sessionId, entry, reason, req)
  return { ok: true }
}

export function getInMemorySession(sessionId) {
  const entry = sessions.get(sessionId)
  if (entry) return entry
  // 也看 mock map
  return mockBridge.getInMemorySession(sessionId)
}

/**
 * 同一个用户同时只允许一个 awaiting_* 会话。开新的前 cancel 旧的。
 * 内存里没的(进程重启 orphan)→ DB 直接标 failed。
 */
export function killUserActiveSessions(db, userId, req = null) {
  const rows = db
    .prepare(
      `SELECT id, provider FROM oauth_bind_sessions
       WHERE user_id = ? AND state IN ('awaiting_url','awaiting_code')`
    )
    .all(userId)
  for (const r of rows) {
    if (sessions.has(r.id)) {
      cancel({ db, sessionId: r.id, reason: 'superseded_by_new_session', req })
    } else if (mockBridge.getInMemorySession(r.id)) {
      mockBridge.cancel({ db, sessionId: r.id, req })
    } else {
      updateSession(db, r.id, {
        state: 'failed',
        error_message: 'orphaned_after_restart',
        finished_at: new Date().toISOString(),
      })
      audit(db, req, {
        eventType: 'oauth_bind_failed',
        userId,
        payload: {
          provider: r.provider,
          sessionId: r.id,
          error: 'orphaned_after_restart',
        },
      })
    }
  }
}

/**
 * Route 层访问 session 时调用:如果 DB 说 awaiting_* 但内存里没有 entry,标 failed。
 * 返回最新的 DB 行。
 */
export function reconcileSession(db, sessionId, req = null) {
  const row = db
    .prepare(
      `SELECT id, user_id, provider, state, prompt_url, error_message, stage_home_path,
              expires_at, created_at, finished_at
       FROM oauth_bind_sessions WHERE id = ?`
    )
    .get(sessionId)
  if (!row) return null
  if (row.state === 'awaiting_url' || row.state === 'awaiting_code') {
    const inMem = sessions.has(sessionId) || !!mockBridge.getInMemorySession(sessionId)
    if (!inMem) {
      updateSession(db, sessionId, {
        state: 'failed',
        error_message: 'orphaned_after_restart',
        finished_at: new Date().toISOString(),
      })
      audit(db, req, {
        eventType: 'oauth_bind_failed',
        userId: row.user_id,
        payload: {
          provider: row.provider,
          sessionId,
          error: 'orphaned_after_restart',
        },
      })
      row.state = 'failed'
      row.error_message = 'orphaned_after_restart'
    }
  }
  return row
}

// --- internal helpers ---

function clearTimer(entry) {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

async function finalizeSuccess(db, sessionId, entry, req) {
  const row = db
    .prepare(`SELECT user_id, provider FROM oauth_bind_sessions WHERE id = ?`)
    .get(sessionId)
  if (!row) {
    sessions.delete(sessionId)
    return
  }

  // 真实 claude auth login 成功后凭证落点不固定:可能是
  //   ~/.claude/                (Claude Code 传统路径)
  //   ~/.claude.json            (单文件格式)
  //   ~/.config/claude/         (XDG)
  // 所以宽容检测:exit 0 + stage 下有任何 claude/codex 相关文件即可。
  const candidates = row.provider === 'anthropic'
    ? ['.claude', '.claude.json', '.config/claude']
    : ['.codex', '.codex.json', '.config/codex']
  const hit = candidates.find((p) => fs.existsSync(path.join(entry.stageHome, p)))
  if (!hit) {
    return finalizeFailed(
      db,
      sessionId,
      entry,
      `cli_exited_0_but_no_credential_artifact (looked for ${candidates.join(', ')})`,
      req
    )
  }

  const credentialId = randomId('cred')
  const permHome = permHomeFor(row.user_id, credentialId)
  try {
    fs.mkdirSync(path.dirname(permHome), { recursive: true })
    fs.renameSync(entry.stageHome, permHome)
    try {
      fs.chmodSync(permHome, 0o700)
    } catch {
      // best-effort
    }
  } catch (e) {
    return finalizeFailed(
      db,
      sessionId,
      entry,
      `rename_stage_failed: ${e.message}`,
      req
    )
  }

  const label = `${row.provider === 'anthropic' ? 'Claude' : 'Codex'}(订阅)`
  const blob = encryptJson({ home_path: permHome })
  try {
    db.prepare(
      `INSERT INTO user_credentials
         (id, user_id, provider, auth_type, label, credential_blob_enc, status, last_validated_at)
       VALUES (?, ?, ?, 'oauth', ?, ?, 'active', datetime('now'))`
    ).run(credentialId, row.user_id, row.provider, label, blob)
  } catch (e) {
    updateSession(db, sessionId, {
      state: 'failed',
      error_message: `credential_insert_failed: ${e.message}`,
      finished_at: new Date().toISOString(),
    })
    audit(db, req, {
      eventType: 'oauth_bind_failed',
      userId: row.user_id,
      payload: {
        provider: row.provider,
        sessionId,
        error: 'credential_insert_failed',
        detail: e.message,
      },
    })
    sessions.delete(sessionId)
    return
  }

  updateSession(db, sessionId, {
    state: 'completed',
    finished_at: new Date().toISOString(),
  })

  audit(db, req, {
    eventType: 'oauth_bind_completed',
    userId: row.user_id,
    payload: {
      provider: row.provider,
      sessionId,
      credentialId,
      stdout_tail: (entry.stdoutBuf || '').slice(-512),
    },
  })

  sessions.delete(sessionId)
}

function finalizeFailed(db, sessionId, entry, errorMessage, req, stateOverride = 'failed') {
  // 清理 stage(如果还在)
  try {
    if (entry?.stageHome && fs.existsSync(entry.stageHome)) {
      fs.rmSync(entry.stageHome, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }
  const row = db
    .prepare(`SELECT user_id, provider FROM oauth_bind_sessions WHERE id = ?`)
    .get(sessionId)
  updateSession(db, sessionId, {
    state: stateOverride,
    error_message: String(errorMessage).slice(0, 1000),
    finished_at: new Date().toISOString(),
  })
  if (row) {
    audit(db, req, {
      eventType: 'oauth_bind_failed',
      userId: row.user_id,
      payload: {
        provider: row.provider,
        sessionId,
        state: stateOverride,
        error: String(errorMessage).slice(0, 200),
        stdout_tail: (entry?.stdoutBuf || '').slice(-512),
        stderr_tail: (entry?.stderrBuf || '').slice(-512),
      },
    })
  }
  sessions.delete(sessionId)
}

// 暴露常量给 route 用
export const constants = {
  TIMEOUT_MS,
  DATA_DIR,
  stageHomeFor,
  permHomeFor,
}
