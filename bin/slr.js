#!/usr/bin/env node
/**
 * bin/slr.js — P1.5/P1.6 (2026-05-31): SLR Copilot CLI
 *
 * 本地 AI agent / 人最顺手的入口 —— 薄包装 HTTP API(routes/api/index.js)。
 * 零依赖(Node 18+ 全局 fetch)。
 *
 * 配置(环境变量):
 *   SLR_API_URL    平台地址(默认 https://slr.yourai.asia)
 *   SLR_API_TOKEN  个人 API token(在网页 /account/api-tokens 生成,只显示一次)
 *
 * 命令:
 *   slr list                                列出我的项目
 *   slr create --topic "..." [--title T] [--review-type systematic_review]
 *              [--discipline D] [--autonomous]        新建项目 → 打印 id
 *   slr status <projectId>                  9 步状态 + 下一步
 *   slr run <projectId>                     启动自治流水线
 *   slr run-status <projectId>              流水线运行状态(卡在哪步 / 为什么)
 *   slr plan <projectId>                    预览会跑哪些步
 *   slr manuscript <projectId>              打印已生成章节(markdown)
 *   slr write --topic "..." [--review-type ...] [--discipline ...] [--autonomous]
 *                                           create + run + 轮询到完成/卡住 + 打印手稿
 *
 * 退出码:0 成功;1 运行错误;2 用法错误;3 流水线 blocked(需补数据)。
 */

const API_URL = (process.env.SLR_API_URL || 'https://slr.yourai.asia').replace(/\/+$/, '')
const TOKEN = process.env.SLR_API_TOKEN || ''

function die(msg, code = 1) { process.stderr.write(`slr: ${msg}\n`); process.exit(code) }

// 极简 --flag / --flag value / 位置参数 解析
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { flags[key] = true }
      else { flags[key] = next; i++ }
    } else positional.push(a)
  }
  return { positional, flags }
}

async function api(method, path, body) {
  if (!TOKEN) die('SLR_API_TOKEN not set — 在网页 /account/api-tokens 生成一枚,然后 export SLR_API_TOKEN=...', 2)
  let res
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) { die(`network error: ${e.message}`) }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!json) die(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`)
  if (!res.ok && json.ok !== true) {
    die(`HTTP ${res.status}: ${json.error || json.status || text.slice(0, 200)}`)
  }
  return json
}

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n') }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cmdList() {
  const r = await api('GET', '/api/projects')
  for (const p of r.data.projects) {
    process.stdout.write(`${p.id}  [${p.review_type || '?'}${p.autonomous_mode ? ' · auto' : ''}]  ${p.title}\n`)
  }
  if (r.data.count === 0) process.stdout.write('(no projects)\n')
}

async function cmdCreate(flags) {
  if (!flags.topic) die('create: --topic required', 2)
  const r = await api('POST', '/api/projects', {
    topic: flags.topic,
    title: flags.title,
    review_type: flags['review-type'],
    discipline: flags.discipline,
    goal: flags.goal,
    autonomous: !!flags.autonomous,
  })
  out(r.data)
  return r.data.id
}

async function cmdStatus(id) {
  if (!id) die('status: <projectId> required', 2)
  const r = await api('GET', `/api/projects/${id}/status`)
  const d = r.data
  process.stdout.write(`project ${d.project.id}  (${d.project.review_type || '?'}${d.project.autonomous_mode ? ' · autonomous' : ''})\n`)
  for (const s of d.steps) process.stdout.write(`  ${s.status === 'done' ? '✓' : s.status === 'locked' ? '·' : '○'} ${s.key.padEnd(12)} ${s.status}${s.summary ? '  — ' + s.summary : ''}\n`)
  process.stdout.write(`next: ${d.next_step ? d.next_step.key + (d.next_step.ready ? ' (ready)' : ' (locked)') : '— all done'}\n`)
}

async function cmdRun(id) {
  if (!id) die('run: <projectId> required', 2)
  const r = await api('POST', `/api/projects/${id}/run`)
  out(r.data || r)
}

async function cmdRunStatus(id) {
  if (!id) die('run-status: <projectId> required', 2)
  const r = await api('GET', `/api/projects/${id}/run/status`)
  out(r.data)
}

async function cmdPlan(id) {
  if (!id) die('plan: <projectId> required', 2)
  const r = await api('GET', `/api/projects/${id}/run/plan`)
  out(r.data)
}

async function cmdManuscript(id) {
  if (!id) die('manuscript: <projectId> required', 2)
  const r = await api('GET', `/api/projects/${id}/manuscript`)
  if (r.data.section_count === 0) { process.stdout.write('(no sections generated yet)\n'); return }
  for (const s of r.data.sections) {
    process.stdout.write(`\n\n## ${s.section}\n\n${s.content_markdown}\n`)
  }
}

// P1.6:一键 create + run + 轮询到完成/卡住 + 打印手稿
async function cmdWrite(flags) {
  if (!flags.topic) die('write: --topic required', 2)
  process.stderr.write('[slr write] creating project…\n')
  const created = await api('POST', '/api/projects', {
    topic: flags.topic, title: flags.title, review_type: flags['review-type'],
    discipline: flags.discipline, goal: flags.goal,
    autonomous: flags.autonomous === undefined ? true : !!flags.autonomous,   // write 默认 autonomous
  })
  const id = created.data.id
  process.stderr.write(`[slr write] project ${id} created; starting pipeline…\n`)
  await api('POST', `/api/projects/${id}/run`)

  // 轮询直到 pipeline 不再 running
  const intervalMs = Number(flags['poll-interval'] || 15000)
  const maxMs = Number(flags['max-wait'] || 6 * 60 * 60 * 1000)   // 默认最多等 6h
  const start = Date.now()
  let last = ''
  while (Date.now() - start < maxMs) {
    await sleep(intervalMs)
    const s = await api('GET', `/api/projects/${id}/run/status`)
    const job = s.data.job || {}
    const cur = job.current_step || '(starting)'
    if (cur !== last) { process.stderr.write(`[slr write] step: ${cur} (${job.done || 0}/${job.total || '?'})\n`); last = cur }
    if (!s.data.running) {
      if (job.blocked_step) {
        process.stderr.write(`[slr write] BLOCKED at ${job.blocked_step}: ${job.blocked_reason}\n`)
        process.stderr.write(`[slr write] 补齐该步所需数据后,重新 slr run ${id} 即从此处继续。\n`)
        process.exit(3)
      }
      if (job.status === 'failed') die(`pipeline failed at ${cur}: ${job.last_error || 'unknown'}`)
      process.stderr.write('[slr write] pipeline finished. manuscript:\n')
      await cmdManuscript(id)
      return
    }
  }
  die(`write: timed out after ${Math.round(maxMs / 60000)} min (still running; check: slr run-status ${id})`)
}

const HELP = `slr — SLR Copilot CLI
  env: SLR_API_URL (default https://slr.yourai.asia), SLR_API_TOKEN (required)

  slr list
  slr create --topic "..." [--title T] [--review-type systematic_review] [--discipline D] [--autonomous]
  slr status <projectId>
  slr run <projectId>
  slr run-status <projectId>
  slr plan <projectId>
  slr manuscript <projectId>
  slr write --topic "..." [--review-type ...] [--discipline ...] [--autonomous] [--poll-interval ms] [--max-wait ms]
`

async function main() {
  const [, , cmd, ...rest] = process.argv
  const { positional, flags } = parseArgs(rest)
  switch (cmd) {
    case 'list': return cmdList()
    case 'create': return void (await cmdCreate(flags))
    case 'status': return cmdStatus(positional[0])
    case 'run': return cmdRun(positional[0])
    case 'run-status': return cmdRunStatus(positional[0])
    case 'plan': return cmdPlan(positional[0])
    case 'manuscript': case 'export': return cmdManuscript(positional[0])
    case 'write': return cmdWrite(flags)
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP); return
    default: die(`unknown command: ${cmd}\n\n${HELP}`, 2)
  }
}

main().catch((e) => die(e?.message || String(e)))
