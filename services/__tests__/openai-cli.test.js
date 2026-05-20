/**
 * services/__tests__/openai-cli.test.js — Agent R (Phase 7)
 *
 * 手跑:
 *   node services/__tests__/openai-cli.test.js
 *
 * 用 console.log + assert 验证 — 不依赖任何测试框架。
 *
 * 测两件事:
 *   1. buildExecArgs 产生的 args 含正确的 codex exec flags
 *   2. sendMessage 在 mock 的 codex 二进制下能拿到 last-message 文件里的文本
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildExecArgs, sendMessage } from '../providers/openai-cli.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1
      console.log(`  ok  ${name}`)
    })
    .catch((e) => {
      failed += 1
      console.error(`  FAIL ${name}: ${e.message}`)
    })
}

// ---------------------------------------------------------------------------
// 1) buildExecArgs 含正确 flags
// ---------------------------------------------------------------------------
await test('buildExecArgs has correct codex exec flags', () => {
  const args = buildExecArgs({
    model: 'gpt-5',
    fullPrompt: 'hello',
    outFile: '/tmp/codex_out_test.txt',
  })
  assert.equal(args[0], 'exec')
  assert.ok(args.includes('--json'), 'should include --json')
  assert.ok(args.includes('--skip-git-repo-check'), 'should include --skip-git-repo-check')
  assert.ok(args.includes('--ephemeral'), 'should include --ephemeral')
  assert.ok(args.includes('-m'), 'should include -m')
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5')
  assert.ok(args.includes('-o'), 'should include -o')
  assert.equal(args[args.indexOf('-o') + 1], '/tmp/codex_out_test.txt')
  const sandboxIdx = args.indexOf('-c')
  assert.ok(sandboxIdx >= 0, 'should include -c')
  assert.match(
    args[sandboxIdx + 1],
    /sandbox_permissions=\["disk-full-read-access"\]/,
    'sandbox_permissions config'
  )
  assert.equal(args[args.length - 1], 'hello', 'prompt is last')
})

// ---------------------------------------------------------------------------
// 2) sendMessage 用 mock 二进制 → 拿到 last-message 文件内容
// ---------------------------------------------------------------------------
// 用一个 sh 脚本扮演 codex:它写 outFile,然后 echo 一条 JSONL event,exit 0。
await test('sendMessage reads --output-last-message file (mock binary)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex_test_'))
  const fakeBin = path.join(tmp, 'fake-codex.sh')
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh
# 解析 -o <outfile>:取下一个 token
prev=""
outfile=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then
    outfile="$a"
  fi
  prev="$a"
done
if [ -n "$outfile" ]; then
  printf 'Hello from fake codex\\n' > "$outfile"
fi
printf '{"type":"agent_message","message":"Hello from fake codex"}\\n'
printf '{"type":"token_count","tokens":{"input":12,"output":7}}\\n'
exit 0
`,
    { mode: 0o755 }
  )

  process.env.CODEX_BIN = fakeBin
  try {
    const result = await sendMessage({
      homePath: tmp,
      model: 'gpt-5',
      system: 'sys',
      prompt: 'usr',
      timeoutMs: 10_000,
    })
    assert.equal(result.text, 'Hello from fake codex')
    assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0)
    assert.equal(result.usage.input_tokens, 12)
    assert.equal(result.usage.output_tokens, 7)
  } finally {
    delete process.env.CODEX_BIN
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3) sendMessage 清理 tmp out file(成功路径)
// ---------------------------------------------------------------------------
await test('sendMessage cleans up tmp out file on success', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex_test_'))
  const fakeBin = path.join(tmp, 'fake-codex.sh')
  // 这次记录 outfile 到 sentinel,然后 finish
  const sentinel = path.join(tmp, 'sentinel.txt')
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh
prev=""
outfile=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then
    outfile="$a"
  fi
  prev="$a"
done
if [ -n "$outfile" ]; then
  printf 'ok' > "$outfile"
  printf '%s' "$outfile" > "${sentinel}"
fi
exit 0
`,
    { mode: 0o755 }
  )
  process.env.CODEX_BIN = fakeBin
  try {
    await sendMessage({
      homePath: tmp,
      model: 'gpt-5',
      prompt: 'p',
      timeoutMs: 10_000,
    })
    const recordedOut = fs.readFileSync(sentinel, 'utf8').trim()
    assert.ok(recordedOut.length > 0, 'sentinel captured outfile path')
    assert.equal(fs.existsSync(recordedOut), false, 'tmp out file should be unlinked')
  } finally {
    delete process.env.CODEX_BIN
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4) sendMessage 失败时 reject 含 stderr tail
// ---------------------------------------------------------------------------
await test('sendMessage rejects with stderr tail on non-zero exit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex_test_'))
  const fakeBin = path.join(tmp, 'fake-codex.sh')
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh
echo "oops something broke" 1>&2
exit 3
`,
    { mode: 0o755 }
  )
  process.env.CODEX_BIN = fakeBin
  try {
    let threw = null
    try {
      await sendMessage({ homePath: tmp, model: 'gpt-5', prompt: 'p', timeoutMs: 10_000 })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, 'should reject')
    assert.match(threw.message, /exit_3/)
    assert.match(threw.message, /oops/)
  } finally {
    delete process.env.CODEX_BIN
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 总结
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
