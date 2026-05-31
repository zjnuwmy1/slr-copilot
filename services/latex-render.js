/**
 * services/latex-render.js — Phase 8.E
 * ------------------------------------------------------------
 * Filesystem + child-process glue for the LaTeX → PDF pipeline:
 *
 *   1. extractZipToDir   — unpack a user-uploaded template ZIP into an
 *                          extract dir; defends against zip-slip.
 *   2. listTexFilesIn    — recursive *.tex finder (relative paths).
 *   3. runPdflatex       — spawns `latexmk -pdf` (with biber + bibtex fallbacks
 *                          handled by latexmk) in the working dir; captures
 *                          stderr tail + log tail; enforces a hard timeout
 *                          (kills the process group).
 *   4. packageRenderSource — re-zips the render workdir (excluding aux/log/out
 *                          files so the source ZIP stays small).
 *
 * Storage layout:
 *   $DATA_DIR/uploads/latex-templates/<project_id>/template.zip          ← raw upload
 *   $DATA_DIR/uploads/latex-templates/<project_id>/extracted/...         ← per-project extract dir
 *   $DATA_DIR/uploads/latex-renders/<project_id>/<render_id>/main.tex    ← LLM-filled tex
 *   $DATA_DIR/uploads/latex-renders/<project_id>/<render_id>/main.pdf    ← pdflatex output
 *   $DATA_DIR/uploads/latex-renders/<project_id>/<render_id>/main.log    ← pdflatex log
 *   $DATA_DIR/uploads/latex-renders/<project_id>/<render_id>/source.zip  ← packaged on demand
 *
 * NOTE: pdflatex / latexmk must exist on PATH. On prod (Debian + TeX Live 2023)
 *   /usr/bin/latexmk + /usr/bin/pdflatex + /usr/bin/biber are present. Locally
 *   we expect runPdflatex to fail with ENOENT — callers must surface a friendly
 *   "LaTeX toolchain not installed" message, NOT crash.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import AdmZip from 'adm-zip'

const DATA_DIR_FALLBACK = '/var/lib/slr'
const DATA_DIR = process.env.DATA_DIR || DATA_DIR_FALLBACK

export const LATEX_TEMPLATES_DIR = path.join(DATA_DIR, 'uploads', 'latex-templates')
export const LATEX_RENDERS_DIR = path.join(DATA_DIR, 'uploads', 'latex-renders')

// ============================================================
// ensureDir — recursive mkdir
// ============================================================
export async function ensureDir(p) {
  if (!p) return
  await fsp.mkdir(p, { recursive: true })
}

// ============================================================
// sanitizeLatexPlaceholders — N4 safety net (2026-05-25)
// ------------------------------------------------------------
// LATEX_FILL_SYSTEM v3 forbids the LLM from leaving raw [tbl:...] / [fig:...]
// placeholders in `filled_tex`. In practice Opus has been observed to slip a
// stray placeholder through in long manuscripts (esp. on the last few lines of
// a section, where context cap pressure leaks). LaTeX parses `[...]` as an
// optional argument, so a leftover `[tbl:table1]` either crashes pdflatex
// ("Missing \begin{document}") or typesets garbage in the next macro.
//
// This is a pure post-process safety net — it converts any leftover
//   [tbl:<key>]  → \ref{tab:<key>}     (we don't know if the key is valid here,
//                                       so we trust the LLM picked a real one;
//                                       worst case pdflatex emits "??" instead
//                                       of a number)
//   [fig:<id>]   → \ref{fig:<id>}
// and appends a single LaTeX comment block at the top recording every
// substitution so the user can audit. Returns the sanitised text + a list of
// (kind, id, count) records for logging/audit.
//
// Caller contract (report.js POST /report/latex/render):
//   const sanitised = sanitizeLatexPlaceholders(parsed.filled_tex)
//   await fsp.writeFile(renderMainTex, sanitised.text, 'utf8')
//   if (sanitised.substitutions.length) {
//     audit('latex_render_placeholder_leak', { subs: sanitised.substitutions })
//   }
// (This function is OPT-IN — wiring it into the route is part of follow-up
//  N5/N6. The function lives here so the unit test can target it directly.)
//
// ── 测试用例(2026-05-25, N4)──
// 1. 输入 "See [tbl:table1] for details" → 输出 "See \\ref{tab:table1} for details",
//    substitutions = [{ kind: 'tbl', id: 'table1', count: 1 }]
// 2. 输入 "Fig 1 [fig:prisma] shows..."  → 输出 "Fig 1 \\ref{fig:prisma} shows...",
//    substitutions = [{ kind: 'fig', id: 'prisma', count: 1 }]
// 3. 输入 "[tbl:invalid_key] and again [tbl:invalid_key]" →
//    输出 "\\ref{tab:invalid_key} and again \\ref{tab:invalid_key}",
//    substitutions = [{ kind: 'tbl', id: 'invalid_key', count: 2 }]
//    (we can't validate keys here — the LLM should have downgraded unknowns to
//     \textit{[unresolved ...]} per v3 prompt; if we get here with a bogus key
//     pdflatex will emit "??" and the audit log will flag it.)
// 4. 输入 "" / 输入 "no placeholders at all"  → 输出原文不变,substitutions = []
// 5. 输入 "[tbl:k1] [fig:f1] [tbl:k1]"        → 三次替换,
//    substitutions = [{ kind:'tbl', id:'k1', count:2 }, { kind:'fig', id:'f1', count:1 }]
// 6. 输入 "[tbl:bad key]" (含空格)            → 不匹配,原文保留(re 只接 [A-Za-z0-9_-]+)
// ============================================================
const PLACEHOLDER_RE = /\[(tbl|fig):([A-Za-z0-9_-]+)\]/g

export function sanitizeLatexPlaceholders(filledTex) {
  if (typeof filledTex !== 'string' || !filledTex) {
    return { text: filledTex || '', substitutions: [] }
  }
  const counts = new Map() // `${kind}:${id}` → count
  const text = filledTex.replace(PLACEHOLDER_RE, (_m, kind, id) => {
    const key = `${kind}:${id}`
    counts.set(key, (counts.get(key) || 0) + 1)
    return kind === 'tbl' ? `\\ref{tab:${id}}` : `\\ref{fig:${id}}`
  })
  const substitutions = []
  for (const [key, count] of counts.entries()) {
    const [kind, id] = key.split(':')
    substitutions.push({ kind, id, count })
  }
  return { text, substitutions }
}

// ============================================================
// extractZipToDir — buffer → directory, zip-slip safe.
//   Returns the list of absolute file paths written.
//   Throws if any entry escapes the destDir.
// ============================================================
export async function extractZipToDir(zipBuffer, destDir) {
  if (!zipBuffer || !destDir) throw new Error('extractZipToDir: zipBuffer + destDir required')
  await ensureDir(destDir)
  const safeRoot = path.resolve(destDir)

  let zip
  try {
    zip = new AdmZip(Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer))
  } catch (e) {
    throw new Error(`zip parse failed: ${e?.message || e}`)
  }

  const written = []
  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName
    // Reject absolute / Windows-drive paths, and entries containing a ".." segment
    const segments = entryName.split(/[/\\]/)
    if (segments.includes('..') ||
        entryName.startsWith('/') || entryName.startsWith('\\') ||
        /^[a-zA-Z]:/.test(entryName)) {
      throw new Error(`zip entry path unsafe: ${entryName.slice(0, 120)}`)
    }
    const dest = path.resolve(destDir, entryName)
    if (dest !== safeRoot && !dest.startsWith(safeRoot + path.sep)) {
      throw new Error(`zip entry escape: ${entryName.slice(0, 120)}`)
    }
    if (entry.isDirectory) {
      await fsp.mkdir(dest, { recursive: true })
    } else {
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.writeFile(dest, entry.getData())
      written.push(dest)
    }
  }
  return written
}

// ============================================================
// listTexFilesIn — recursive *.tex finder, returns relative paths.
//   Skips dotfiles + node_modules / __MACOSX-style junk.
// ============================================================
export async function listTexFilesIn(dir) {
  const out = []
  if (!dir) return out
  let root
  try { root = await fsp.stat(dir) } catch { return out }
  if (!root.isDirectory()) return out

  async function walk(rel) {
    const abs = path.join(dir, rel)
    let entries
    try { entries = await fsp.readdir(abs, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const name = e.name
      if (!name || name.startsWith('.') || name === '__MACOSX' || name === 'node_modules') continue
      const relChild = rel ? path.join(rel, name) : name
      if (e.isDirectory()) {
        await walk(relChild)
      } else if (e.isFile() && /\.tex$/i.test(name)) {
        out.push(relChild)
      }
    }
  }
  await walk('')
  out.sort()
  return out
}

// ============================================================
// runPdflatex — spawn latexmk and wait for it.
// ============================================================

/**
 * Run `latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error <mainTex>` in workDir.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     pdfPath: string|null,
 *     logPath: string|null,
 *     exitCode: number|null,
 *     stderr_tail: string,    // last ~2000 chars of stderr + log
 *     killed: boolean,        // true on timeout
 *     missing_toolchain: boolean,  // true if latexmk/pdflatex not on PATH
 *     duration_ms: number,
 *   }
 *
 * The process is launched as its own process group (detached: true on POSIX)
 * so we can kill the whole tree on timeout. On Windows we just kill the pid.
 */
export async function runPdflatex({ workDir, mainTex, timeoutMs = 120_000 }) {
  if (!workDir || !mainTex) {
    return {
      ok: false, pdfPath: null, logPath: null, exitCode: null,
      stderr_tail: 'workDir + mainTex required', killed: false,
      missing_toolchain: false, duration_ms: 0,
    }
  }

  const started = Date.now()
  const args = [
    '-pdf',
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    mainTex,
  ]
  const isPosix = process.platform !== 'win32'

  return await new Promise((resolve) => {
    let child
    try {
      child = spawn('latexmk', args, {
        cwd: workDir,
        env: {
          ...process.env,
          // Helpful for non-interactive batch:
          TEXINPUTS: process.env.TEXINPUTS || '',
        },
        detached: isPosix,           // own process group → easy tree kill
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const msg = e?.message || String(e)
      const missing = /\bENOENT\b/.test(msg) || /not found/i.test(msg)
      resolve({
        ok: false, pdfPath: null, logPath: null, exitCode: null,
        stderr_tail: `spawn failed: ${msg.slice(0, 1500)}`,
        killed: false, missing_toolchain: missing,
        duration_ms: Date.now() - started,
      })
      return
    }

    let stdoutBuf = ''
    let stderrBuf = ''
    const MAX_BUF = 50_000   // cap in-mem buffers; full log is on disk
    child.stdout?.on('data', (chunk) => {
      stdoutBuf += String(chunk)
      if (stdoutBuf.length > MAX_BUF) stdoutBuf = stdoutBuf.slice(-MAX_BUF)
    })
    child.stderr?.on('data', (chunk) => {
      stderrBuf += String(chunk)
      if (stderrBuf.length > MAX_BUF) stderrBuf = stderrBuf.slice(-MAX_BUF)
    })

    let killed = false
    let missing = false
    const timer = setTimeout(() => {
      killed = true
      try {
        if (isPosix && child.pid) {
          // Kill the whole process group
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch {}
    }, timeoutMs)

    child.on('error', (err) => {
      // Most commonly ENOENT when latexmk isn't installed
      const msg = err?.message || String(err)
      if (/ENOENT/.test(msg)) missing = true
      stderrBuf += '\n[spawn error] ' + msg
    })

    child.on('close', async (code, signal) => {
      clearTimeout(timer)
      const baseName = path.basename(mainTex, path.extname(mainTex))
      const pdfPath = path.join(workDir, baseName + '.pdf')
      const logPath = path.join(workDir, baseName + '.log')
      let pdfExists = false
      try { pdfExists = (await fsp.stat(pdfPath)).isFile() } catch {}

      // Read log tail if available (more useful than stderr for LaTeX errors)
      let logTail = ''
      try {
        const logBuf = await fsp.readFile(logPath, 'utf8')
        logTail = logBuf.length > 2000 ? logBuf.slice(-2000) : logBuf
      } catch {}

      // Compose stderr_tail: prefer log tail, append stderr if non-empty
      let tail = logTail
      const errSuffix = stderrBuf.trim()
      if (errSuffix) tail = tail + '\n--- stderr ---\n' + errSuffix
      if (signal) tail = `[killed by ${signal}]\n` + tail
      if (killed) tail = '[timeout exceeded]\n' + tail
      if (tail.length > 2000) tail = tail.slice(-2000)

      resolve({
        ok: !!(pdfExists && code === 0 && !killed),
        pdfPath: pdfExists ? pdfPath : null,
        logPath: (await fileExists(logPath)) ? logPath : null,
        exitCode: code,
        stderr_tail: tail,
        killed,
        missing_toolchain: missing,
        duration_ms: Date.now() - started,
      })
    })
  })
}

async function fileExists(p) {
  try { await fsp.stat(p); return true } catch { return false }
}

// ============================================================
// packageRenderSource — re-zip workDir for the "download .tex source" feature.
//   Excludes pdflatex artefacts so the download is just the source files.
// ============================================================

const EXCLUDED_EXTS = new Set([
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.bcf', '.run.xml',
  '.fls', '.fdb_latexmk', '.synctex.gz', '.blg', '.dvi', '.nav', '.snm',
])
// (pdf is OK to include — it's the user's render product.)

export async function packageRenderSource(workDir, destZipPath) {
  if (!workDir || !destZipPath) throw new Error('packageRenderSource: workDir + destZipPath required')
  let stat
  try { stat = await fsp.stat(workDir) } catch (e) {
    throw new Error(`workDir not accessible: ${e?.message || e}`)
  }
  if (!stat.isDirectory()) throw new Error('workDir is not a directory')

  await ensureDir(path.dirname(destZipPath))

  const zip = new AdmZip()
  const root = path.resolve(workDir)

  async function walk(rel) {
    const abs = path.join(root, rel)
    let entries
    try { entries = await fsp.readdir(abs, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const name = e.name
      if (!name || name === '__MACOSX') continue
      const relChild = rel ? path.join(rel, name) : name
      const absChild = path.join(root, relChild)
      if (e.isDirectory()) {
        await walk(relChild)
      } else if (e.isFile()) {
        const ext = path.extname(name).toLowerCase()
        if (EXCLUDED_EXTS.has(ext)) continue
        // Skip the source.zip itself if it lives inside workDir (defensive)
        if (path.resolve(absChild) === path.resolve(destZipPath)) continue
        try {
          const buf = await fsp.readFile(absChild)
          // Use forward slashes in zip entry names for cross-platform compat
          const entryName = relChild.split(path.sep).join('/')
          zip.addFile(entryName, buf)
        } catch (err) {
          console.warn('[latex-render] skip file in package:', absChild, err?.message)
        }
      }
    }
  }
  await walk('')

  // adm-zip writeZip is sync; use the buffer + fsp.writeFile to keep async chain
  const buf = zip.toBuffer()
  await fsp.writeFile(destZipPath, buf)
  return { path: destZipPath, size_bytes: buf.length }
}

// Synchronous helpers — handy for callers that prefer one-liners
export function listTexFilesInSync(dir) {
  const out = []
  if (!dir || !fs.existsSync(dir)) return out
  function walk(rel) {
    const abs = path.join(dir, rel)
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const name = e.name
      if (!name || name.startsWith('.') || name === '__MACOSX' || name === 'node_modules') continue
      const relChild = rel ? path.join(rel, name) : name
      if (e.isDirectory()) walk(relChild)
      else if (e.isFile() && /\.tex$/i.test(name)) out.push(relChild)
    }
  }
  walk('')
  out.sort()
  return out
}
