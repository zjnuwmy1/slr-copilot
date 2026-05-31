/**
 * services/figure-assets.js — Phase 8.C
 * ------------------------------------------------------------
 * 用户外部生成 / 上传的图片(BioRender / draw.io / DALL-E 出图)
 * 落盘 + figure_assets 表管理。
 *
 * 物理布局:
 *   <FIGURE_ASSETS_DIR>/<project_id>/<asset_id><ext>
 *   默认 FIGURE_ASSETS_DIR = process.env.DATA_DIR/uploads/figures
 *                          (fallback /var/lib/slr/uploads/figures)
 *
 * DB 表:figure_assets(M32-c 迁移建)
 *   id / project_id / figure_key / original_filename / file_path /
 *   mime_type / size_bytes / alt_text / caption / intended_section /
 *   uploaded_by_user_id / uploaded_at
 *
 * 注意:
 *   - 路由层负责 multer 处理(memoryStorage),把 { originalname, mimetype,
 *     size, buffer } 喂进 saveFigureAsset。
 *   - 本服务不做 mime / 大小校验(那是路由层的事,因为业务规则可能改)。
 *   - delete 会同时 unlink 文件 + 删 DB 行;unlink 失败只 warn,不阻塞 DB 删除。
 */

import crypto from 'crypto'
import path from 'node:path'
import fs from 'node:fs/promises'

const DATA_DIR_FALLBACK = '/var/lib/slr'
const DATA_DIR = process.env.DATA_DIR || DATA_DIR_FALLBACK
export const FIGURE_ASSETS_DIR = path.join(DATA_DIR, 'uploads', 'figures')

/**
 * 构造 figure asset 的 HTTP URL(2026-05-25 新加,P0-1 修复)。
 *
 * 之前的 bug:export.md 和 preview 直接嵌入 asset.file_path
 *   `/var/lib/slr/uploads/figures/figasset_xxx.png`(磁盘绝对路径)
 *   → 下载的 .md 在 Word / VS Code / GitHub 打开全是 broken image。
 *
 * 正确路径:走已有的 HTTP 路由 `/projects/:id/report/figures/:assetId/file`。
 *
 * @param {string} projectId
 * @param {string} assetId
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  外部 base(如 'https://slr.yourai.asia');
 *                                 传了 → 绝对 URL(给 export.md 用);
 *                                 不传 → 相对 URL(给 preview / 同源 view 用)。
 * @returns {string}  URL string,空字符串如果 projectId/assetId 缺失
 */
export function buildFigureUrl(projectId, assetId, { baseUrl = '' } = {}) {
  if (!projectId || !assetId) return ''
  const relPath = `/projects/${encodeURIComponent(projectId)}/report/figures/${encodeURIComponent(assetId)}/file`
  if (baseUrl) {
    return String(baseUrl).replace(/\/+$/, '') + relPath
  }
  return relPath
}

// 从 originalname 提取小写后缀(.png / .jpg / .svg / .pdf 等)。
function extFromName(name) {
  if (!name) return ''
  const ext = path.extname(String(name)).toLowerCase()
  // 限白名单字符,防御穿越
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return ''
  return ext
}

function genAssetId() {
  return 'figasset_' + crypto.randomBytes(10).toString('hex')
}

/**
 * 保证根目录 + project 子目录存在。
 */
export async function ensureDir(projectId) {
  await fs.mkdir(FIGURE_ASSETS_DIR, { recursive: true })
  if (projectId) {
    await fs.mkdir(path.join(FIGURE_ASSETS_DIR, projectId), { recursive: true })
  }
}

/**
 * 2026-05-25 M34 新加 helper:从 projects.figure_prompts_ai_optimized 里找出
 *   id === figureKey 的那条 figure prompt,把 title / caption / alt_text / intended_section
 *   返回 — 给上传/编辑路由做自动 prefill。
 * @returns {{title, caption, alt_text, intended_section} | null}
 */
export function lookupAiFigurePrompt(db, projectId, figureKey) {
  if (!db || !projectId || !figureKey) return null
  if (figureKey === 'manual') return null   // 用户自由上传 → 没有匹配 prompt
  try {
    const row = db.prepare(
      `SELECT figure_prompts_ai_optimized FROM projects WHERE id = ?`
    ).get(projectId)
    if (!row || !row.figure_prompts_ai_optimized) return null
    let payload = null
    try { payload = JSON.parse(row.figure_prompts_ai_optimized) } catch { return null }
    const figs = Array.isArray(payload?.figures) ? payload.figures : []
    const hit = figs.find((f) => f && String(f.id) === String(figureKey))
    if (!hit) return null
    return {
      title:           hit.title           ? String(hit.title).slice(0, 200)        : '',
      caption:         hit.caption         ? String(hit.caption).slice(0, 2000)
                       : hit.description   ? String(hit.description).slice(0, 2000)
                       : '',
      alt_text:        hit.alt_text        ? String(hit.alt_text).slice(0, 1000)    : '',
      intended_section: hit.intended_section ? String(hit.intended_section).slice(0, 50) : '',
    }
  } catch {
    return null
  }
}

/**
 * 写入 buffer 到 <root>/<project_id>/<asset_id><ext>,INSERT 一行 figure_assets。
 *
 * @param {Database} db                       better-sqlite3 instance
 * @param {object}   opts
 * @param {string}   opts.projectId
 * @param {string}   opts.figureKey            分组键:一般是 ai 优化图的 id(如 'theme_network')
 *                                             或 'manual'(用户自由上传)。
 * @param {object}   opts.file                 { originalname, mimetype, size, buffer }
 * @param {string}   opts.userId
 * @param {string=}  opts.title                短标题(用户没传时,如果 figureKey 命中 ai prompt,自动填 prompt.title)
 * @param {string=}  opts.caption              图注 publication-grade(同上 fallback)
 * @param {string=}  opts.altText              accessibility 描述(同上 fallback)
 * @param {string=}  opts.intendedSection      introduction / methods / results / discussion / conclusion
 * @returns {object} 入库行(含 id / file_path / title / caption / alt_text)
 */
export async function saveFigureAsset(db, {
  projectId,
  figureKey,
  file,
  userId,
  title,
  caption,
  altText,
  intendedSection,
}) {
  if (!db) throw new Error('saveFigureAsset: db required')
  if (!projectId) throw new Error('saveFigureAsset: projectId required')
  if (!file || !file.buffer) throw new Error('saveFigureAsset: file.buffer required')

  await ensureDir(projectId)

  const assetId = genAssetId()
  const ext = extFromName(file.originalname)
  const fileName = assetId + ext
  const filePath = path.join(FIGURE_ASSETS_DIR, projectId, fileName)

  await fs.writeFile(filePath, file.buffer)

  const sizeBytes = Number(file.size) || (file.buffer?.length || 0)
  const mimeType = String(file.mimetype || '').slice(0, 200)
  const originalFilename = String(file.originalname || '').slice(0, 500)

  // 2026-05-25 M34:auto-fill from AI prompt — 用户没填 title/caption/altText 且
  //   figureKey 命中某 LLM 推荐的 figure prompt → 复用 prompt 里的字段。
  //   用户填的内容永远优先(允许 override LLM 推荐)。
  const aiFallback = lookupAiFigurePrompt(db, projectId, figureKey)
  const _title    = (title    && String(title).trim())    || (aiFallback?.title    || '')
  const _caption  = (caption  && String(caption).trim())  || (aiFallback?.caption  || '')
  const _altText  = (altText  && String(altText).trim())  || (aiFallback?.alt_text || '')
  const _section  = (intendedSection && String(intendedSection).trim()) || (aiFallback?.intended_section || '')

  try {
    db.prepare(`
      INSERT INTO figure_assets
        (id, project_id, figure_key, original_filename, file_path,
         mime_type, size_bytes, title, alt_text, caption, intended_section,
         uploaded_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assetId,
      projectId,
      String(figureKey || 'manual').slice(0, 100),
      originalFilename,
      filePath,
      mimeType,
      sizeBytes,
      _title  ? String(_title).slice(0, 200)   : null,
      _altText ? String(_altText).slice(0, 1000) : null,
      _caption ? String(_caption).slice(0, 2000) : null,
      _section ? String(_section).slice(0, 50)  : null,
      userId || null,
    )
  } catch (e) {
    // DB 写失败:回收已落盘的文件,避免孤儿
    try { await fs.unlink(filePath) } catch {}
    throw e
  }

  return getFigureAsset(db, projectId, assetId)
}

/**
 * 列出该项目所有 figure_assets,按 figure_key + 上传时间排序。
 */
export function listFigureAssets(db, projectId) {
  if (!db || !projectId) return []
  try {
    return db.prepare(`
      SELECT * FROM figure_assets
       WHERE project_id = ?
       ORDER BY figure_key ASC, uploaded_at ASC
    `).all(projectId)
  } catch {
    return []
  }
}

/**
 * 单 asset(用于 download / edit / delete 校验)。
 */
export function getFigureAsset(db, projectId, assetId) {
  if (!db || !projectId || !assetId) return null
  try {
    return db.prepare(`
      SELECT * FROM figure_assets
       WHERE project_id = ? AND id = ?
    `).get(projectId, assetId) || null
  } catch {
    return null
  }
}

/**
 * 删 DB 行 + unlink 文件。文件不在了只 warn(可能 sysadmin 手动清过)。
 */
export async function deleteFigureAsset(db, projectId, assetId) {
  const row = getFigureAsset(db, projectId, assetId)
  if (!row) return { ok: false, error: 'not_found' }

  try {
    db.prepare(`DELETE FROM figure_assets WHERE id = ? AND project_id = ?`)
      .run(assetId, projectId)
  } catch (e) {
    return { ok: false, error: 'db_delete_failed:' + (e?.message || '') }
  }

  if (row.file_path) {
    try {
      await fs.unlink(row.file_path)
    } catch (e) {
      // 文件不在 / 权限错 — 不阻塞,只 warn
      console.warn('[figure-assets] unlink failed for', row.file_path, ':', e?.message)
    }
  }
  return { ok: true, deleted: row }
}

/**
 * 2026-05-26:一键删该项目所有 figure_assets(DB 行 + 文件)。
 *   返回 { ok, count: 删的张数, errors: [{assetId, error}] }(部分失败也返 ok=true)
 *   适配 /report 页"删除全部上传插图"按钮 — 用户没法逐张点。
 */
export async function deleteAllFigureAssets(db, projectId) {
  const all = listFigureAssets(db, projectId) || []
  let count = 0
  const errors = []
  for (const row of all) {
    const r = await deleteFigureAsset(db, projectId, row.id)
    if (r.ok) count++
    else errors.push({ assetId: row.id, error: r.error })
  }
  return { ok: true, count, total: all.length, errors }
}

/**
 * 改 title / caption / altText / intendedSection(figure_key 不允许改 — 改了等于换组,
 * 那是 delete + re-upload 的事)。
 *   2026-05-25 M34:加 title 字段。
 */
export function updateFigureAsset(db, projectId, assetId, {
  title,
  caption,
  altText,
  intendedSection,
}) {
  const row = getFigureAsset(db, projectId, assetId)
  if (!row) return { ok: false, error: 'not_found' }

  const fields = []
  const args = []
  if (title !== undefined) {
    fields.push('title = ?')
    args.push(title ? String(title).slice(0, 200) : null)
  }
  if (caption !== undefined) {
    fields.push('caption = ?')
    args.push(caption ? String(caption).slice(0, 2000) : null)
  }
  if (altText !== undefined) {
    fields.push('alt_text = ?')
    args.push(altText ? String(altText).slice(0, 1000) : null)
  }
  if (intendedSection !== undefined) {
    fields.push('intended_section = ?')
    args.push(intendedSection ? String(intendedSection).slice(0, 50) : null)
  }
  if (fields.length === 0) return { ok: true, row }

  args.push(assetId, projectId)
  try {
    db.prepare(
      `UPDATE figure_assets SET ${fields.join(', ')} WHERE id = ? AND project_id = ?`
    ).run(...args)
  } catch (e) {
    return { ok: false, error: 'db_update_failed:' + (e?.message || '') }
  }
  return { ok: true, row: getFigureAsset(db, projectId, assetId) }
}
