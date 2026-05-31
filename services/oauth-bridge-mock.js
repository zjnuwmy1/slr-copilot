/**
 * services/oauth-bridge-mock.js
 *
 * 本地开发 / 没装 claude / codex 二进制时使用的 fake bridge。
 * 不真正 spawn,而是用 setTimeout 模拟整套 login dance 的时序:
 *
 *   t=0       startLogin → mkdir stageHome,state='awaiting_url',in-memory session 占位
 *   t=1s      "CLI" 吐出 fake URL → UPDATE prompt_url + state='awaiting_code'
 *   t=submit  用户 paste code → submitCode → 写入 in-memory(不校验内容)
 *   t=+1s     "进程退出 0" → 在 stageHome 里写一个假的 .claude/fake-credential.json,
 *             改名到永久路径,创建 user_credentials 行,state='completed'
 *
 * 与 oauth-bridge.js 暴露同样的 API,供 startLogin 入口在 CLAUDE_BIN/CODEX_BIN==='mock' 时 delegate。
 */

import fs from 'node:fs'
import path from 'node:path'
import { encryptJson, randomId } from './crypto.js'
import { audit } from './audit.js'

const sessions = new Map() // sessionId → { userId, provider, stageHome, code, exited, timer1, timer2 }

const DATA_DIR = process.env.DATA_DIR || './.data'

function stageHomeFor(userId, sessionId) {
  return path.resolve(DATA_DIR, 'user-homes', String(userId), `stage-${sessionId}`)
}
function permHomeFor(userId, credentialId) {
  return path.resolve(DATA_DIR, 'user-homes', String(userId), String(credentialId))
}

function updateSession(db, sessionId, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const set = keys.map((k) => `${k} = ?`).join(', ')
  const vals = keys.map((k) => fields[k])
  db.prepare(`UPDATE oauth_bind_sessions SET ${set} WHERE id = ?`).run(...vals, sessionId)
}

export function startLogin({ db, sessionId, userId, provider, req = null }) {
  const stageHome = stageHomeFor(userId, sessionId)
  fs.mkdirSync(stageHome, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(stageHome, 0o700)
  } catch {
    // best-effort
  }

  const entry = {
    userId,
    provider,
    stageHome,
    code: null,
    exited: false,
    timer1: null,
    timer2: null,
    timeoutTimer: null,
    stdoutBuf: '',
    stderrBuf: '',
    mock: true,
    isCodex: provider === 'openai',
    deviceCode: null, // 在 timer1 里给 codex 填一个假 code
  }
  sessions.set(sessionId, entry)

  audit(db, req, {
    eventType: 'oauth_bind_start',
    userId,
    payload: { provider, sessionId, mock: true },
  })

  // 1s 后吐出 fake URL(codex 模式同时给个 fake device code)
  entry.timer1 = setTimeout(() => {
    if (entry.exited) return
    const fakeUrl = entry.isCodex
      ? 'https://example.test/codex/device'
      : `https://example.test/auth?session=${sessionId}&provider=${provider}`
    entry.stdoutBuf += `Open this URL to authorize:\n  ${fakeUrl}\n`
    if (entry.isCodex) {
      entry.deviceCode = 'TEST-CODE'
      entry.stdoutBuf += `Enter this one-time code (expires in 15 minutes)\n  ${entry.deviceCode}\n`
    }
    updateSession(db, sessionId, {
      prompt_url: fakeUrl,
      state: 'awaiting_code',
    })
    // codex 模式:device-auth 流不需要等用户 paste,2s 后自动"完成"
    if (entry.isCodex) {
      entry.timer2 = setTimeout(() => {
        if (entry.exited) return
        completeSuccess(db, sessionId, req)
      }, 2000)
    }
  }, 1000)

  // 5 分钟超时(mock 也保留行为一致)
  entry.timeoutTimer = setTimeout(() => {
    if (entry.exited) return
    finishFailed(db, sessionId, 'timeout', 'timeout: no code received within 5 minutes', req)
  }, 5 * 60 * 1000)
}

export function submitCode({ db, sessionId, code, req = null }) {
  const entry = sessions.get(sessionId)
  if (!entry) return { ok: false, error: 'session_not_in_memory' }
  if (entry.exited) return { ok: false, error: 'already_finished' }
  if (entry.isCodex) {
    // codex device-auth:用户在浏览器输 code,这里只 ack
    return { ok: true, note: 'codex_device_auth_no_stdin' }
  }
  if (entry.code) return { ok: false, error: 'code_already_submitted' }
  entry.code = code

  // 1s 后"进程退出 0"
  entry.timer2 = setTimeout(() => {
    if (entry.exited) return
    completeSuccess(db, sessionId, req)
  }, 1000)

  return { ok: true }
}

export function cancel({ db, sessionId, req = null }) {
  const entry = sessions.get(sessionId)
  if (!entry) return { ok: false, error: 'session_not_in_memory' }
  finishFailed(db, sessionId, 'failed', 'user_cancelled', req)
  return { ok: true }
}

export function getInMemorySession(sessionId) {
  return sessions.get(sessionId) || null
}

export function killUserActiveSessions(db, userId, req = null) {
  // 把这个用户所有 awaiting_* 的会话 cancel 掉
  const rows = db
    .prepare(
      `SELECT id FROM oauth_bind_sessions WHERE user_id = ? AND state IN ('awaiting_url','awaiting_code')`
    )
    .all(userId)
  for (const r of rows) {
    if (sessions.has(r.id)) {
      finishFailed(db, r.id, 'failed', 'superseded_by_new_session', req)
    } else {
      // 内存里没有(进程重启) → 直接标 failed
      updateSession(db, r.id, {
        state: 'failed',
        error_message: 'orphaned_after_restart',
        finished_at: new Date().toISOString(),
      })
    }
  }
}

function completeSuccess(db, sessionId, req) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.exited) return
  entry.exited = true
  clearTimers(entry)

  const row = db.prepare('SELECT user_id, provider FROM oauth_bind_sessions WHERE id = ?').get(sessionId)
  if (!row) return

  // 在 stageHome 里写一个假的 credential 文件,模拟登录成功
  const subdir = row.provider === 'anthropic' ? '.claude' : '.codex'
  const credDir = path.join(entry.stageHome, subdir)
  try {
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(credDir, 'fake-credential.json'),
      JSON.stringify({ provider: row.provider, mock: true, issued_at: new Date().toISOString() }),
      { mode: 0o600 }
    )
  } catch (e) {
    return finishFailed(db, sessionId, 'failed', `mock_fs_error: ${e.message}`, req)
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
    return finishFailed(db, sessionId, 'failed', `mock_rename_error: ${e.message}`, req)
  }

  const label = `${row.provider === 'anthropic' ? 'Claude' : 'Codex'}(订阅 · mock)`
  const blob = encryptJson({ home_path: permHome })
  try {
    db.prepare(
      `INSERT INTO user_credentials
         (id, user_id, provider, auth_type, label, credential_blob_enc, status, last_validated_at)
       VALUES (?, ?, ?, 'oauth', ?, ?, 'active', datetime('now', '+8 hours'))`
    ).run(credentialId, row.user_id, row.provider, label, blob)
  } catch (e) {
    return finishFailed(db, sessionId, 'failed', `db_insert_error: ${e.message}`, req)
  }

  updateSession(db, sessionId, {
    state: 'completed',
    finished_at: new Date().toISOString(),
  })

  audit(db, req, {
    eventType: 'oauth_bind_completed',
    userId: row.user_id,
    payload: { provider: row.provider, sessionId, credentialId, mock: true },
  })

  sessions.delete(sessionId)
}

function finishFailed(db, sessionId, state, errorMessage, req) {
  const entry = sessions.get(sessionId)
  if (entry) {
    if (entry.exited) return
    entry.exited = true
    clearTimers(entry)
    // 清理 stage home(如果还没改名)
    try {
      if (fs.existsSync(entry.stageHome)) {
        fs.rmSync(entry.stageHome, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }
  const row = db.prepare('SELECT user_id, provider FROM oauth_bind_sessions WHERE id = ?').get(sessionId)
  updateSession(db, sessionId, {
    state,
    error_message: errorMessage,
    finished_at: new Date().toISOString(),
  })
  if (row) {
    audit(db, req, {
      eventType: 'oauth_bind_failed',
      userId: row.user_id,
      payload: { provider: row.provider, sessionId, state, error: errorMessage, mock: true },
    })
  }
  sessions.delete(sessionId)
}

function clearTimers(entry) {
  if (entry.timer1) clearTimeout(entry.timer1)
  if (entry.timer2) clearTimeout(entry.timer2)
  if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer)
}
