/**
 * 文献去重 — 在 records 表落库后跑一次。
 *
 * 规则:
 *   Level 1: DOI 完全匹配(忽略大小写,去常见前缀)
 *   Level 2: normalized_title 完全匹配 + year ±1 + 第一作者姓相同
 *
 * 同组共享 duplicate_group_id (randomId('dup'));后到者 duplicate_of_record_id
 * 指向同组中最早创建的那条(canonical/leader)。
 */

import { randomId } from './crypto.js'

// ---------- 公共归一化工具 ----------

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'and', 'or', 'to', 'for', 'with', 'at', 'by'])

/**
 * 标题归一化:
 *   lowercase → 把所有非字母数字/中文字符替换为空格 → 去 stopwords → 去多余空格
 * 兼顾中英文(中文 lowercase 无副作用)。
 */
export function normalizeTitle(s) {
  if (s == null) return ''
  const lower = String(s).toLowerCase()
  // 保留:字母 / 数字 / 下划线 / 中日韩统一汉字 + 扩展 A。其余替换成空格。
  // 用 u 标志 + \p{Script=Han} 取中日韩汉字 + \p{L}\p{N} 取通用字母数字。
  const cleaned = lower.replace(/[^\p{L}\p{N}_]+/gu, ' ')
  const tokens = cleaned.split(/\s+/).filter((t) => t && !STOPWORDS.has(t))
  return tokens.join(' ').trim()
}

/**
 * DOI 归一化:
 *   trim → lowercase → 剥离 'doi:' / 'https://doi.org/' / 'https://dx.doi.org/' / 'http://...' 前缀
 *   尾部空白/句点也清掉
 */
export function normalizeDoi(s) {
  if (s == null) return ''
  let v = String(s).trim().toLowerCase()
  // 反复剥前缀,允许 "DOI: 10.x..." 这种空格
  for (let i = 0; i < 4; i++) {
    if (v.startsWith('doi:')) v = v.slice(4).trim()
    else if (v.startsWith('doi ')) v = v.slice(4).trim()
    else if (v.startsWith('https://doi.org/')) v = v.slice('https://doi.org/'.length).trim()
    else if (v.startsWith('http://doi.org/')) v = v.slice('http://doi.org/'.length).trim()
    else if (v.startsWith('https://dx.doi.org/')) v = v.slice('https://dx.doi.org/'.length).trim()
    else if (v.startsWith('http://dx.doi.org/')) v = v.slice('http://dx.doi.org/'.length).trim()
    else break
  }
  // 末尾常见垃圾(句点 / 反斜杠 / 引号)
  v = v.replace(/[.\\"'\s]+$/, '')
  return v
}

/** 从 authors_text("Wang G, Tang R, Xu M") 取第一作者姓(归一化为 lowercase) */
function firstAuthorSurname(authorsText) {
  if (!authorsText) return ''
  const first = String(authorsText).split(',')[0].trim()
  // "Wang G" → surname 是开头到首个空格前
  const m = first.match(/^(\S+)/)
  return m ? m[1].toLowerCase() : ''
}

// ---------- 主入口 ----------

/**
 * 对 projectId 下所有 records 跑去重并写回 duplicate_group_id / duplicate_of_record_id。
 * 返回 { groups_found, records_merged }。
 *
 * 实现:
 *   1) 把先前所有去重结果清空(idempotent)
 *   2) 按 created_at ASC 拉全部 records
 *   3) Level 1 — 用 normalizeDoi(doi) 为 key,把同 DOI 的 records 归到一组
 *   4) Level 2 — 剩下尚未分组的 records,按 normalized_title 聚类,再按 year ±1 + 第一作者姓筛
 *   5) 同组里以最早创建的为 leader,其余写 duplicate_of_record_id 指向它,所有成员共享同一 group_id
 *
 * 注意:即使一组只有 1 条,我们不写 group_id(只有 ≥2 才算重复组)。
 */
export function dedupProject(db, { projectId }) {
  // Step 1: reset 之前的去重结果(让函数可重入)
  db.prepare(`
    UPDATE records SET duplicate_group_id = NULL, duplicate_of_record_id = NULL
    WHERE project_id = ?
  `).run(projectId)

  // Step 2: 拉全部 records
  const rows = db.prepare(`
    SELECT id, doi, normalized_title, year, authors_text, created_at
    FROM records
    WHERE project_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(projectId)

  if (rows.length === 0) return { groups_found: 0, records_merged: 0 }

  // 用 Map<recordId, groupId> 记录分组结果
  const groupOf = new Map()
  // 用 Map<groupId, [recordIds...]> 反向
  const members = new Map()

  function assign(recordId, groupId) {
    groupOf.set(recordId, groupId)
    if (!members.has(groupId)) members.set(groupId, [])
    members.get(groupId).push(recordId)
  }

  // ---- Level 1: DOI 完全匹配 ----
  // 注意:只把"真正配上对的 DOI"(at least 2 rows 共享同一 normalized DOI)归组。
  //       单条 DOI 的不分组,以免占住 Level 2 的位置 —— Level 2 还要看它能不能跟
  //       无 DOI 的同篇 records 通过 title 匹配。
  // 早期 bug:旧实现给每条有 DOI 的记录都 assign 一个 group_id(哪怕只有自己一条),
  //          导致 "Scopus(有 DOI)+ Zotero(无 DOI)同篇" 永远不会在 Level 2 合并 —
  //          因为 Scopus 已经被 Level 1 占住、Level 2 直接 continue 跳过。
  const doiGroups = new Map() // normDoi → [recordIds]
  for (const r of rows) {
    const nd = normalizeDoi(r.doi)
    if (!nd) continue
    if (!doiGroups.has(nd)) doiGroups.set(nd, [])
    doiGroups.get(nd).push(r.id)
  }
  for (const [_nd, ids] of doiGroups) {
    if (ids.length < 2) continue   // 单 DOI 不算"匹配上"
    const gid = randomId('dup')
    for (const rid of ids) assign(rid, gid)
  }

  // ---- Level 2: normalized_title + year±1 + 第一作者姓 ----
  // 先按 normalized_title 聚类。被 Level 1 真正归过组(>= 2 条 DOI 匹配)的跳过,
  // 但只有自己一条的、有 DOI 的 records 仍然走 Level 2 —— 它们可能跟无 DOI 的同篇配对。
  const byTitle = new Map() // normTitle → [rows...]
  for (const r of rows) {
    if (!r.normalized_title) continue
    if (groupOf.has(r.id)) continue // 已被 DOI 真组(>=2)归过的不再 title 归
    const t = r.normalized_title
    if (!byTitle.has(t)) byTitle.set(t, [])
    byTitle.get(t).push(r)
  }

  for (const [_t, group] of byTitle) {
    if (group.length < 2) continue
    // 同标题里再按 (year ± 1, 第一作者姓) 收紧
    // 简化算法:第一条为种子,后续每条若与种子兼容则合并;
    // 若不兼容,尝试与已存在子组合并,否则成为新种子。
    const subgroups = [] // [{ leader, yearRange:[y-1,y+1], surname, members:[] }]

    for (const r of group) {
      const sn = firstAuthorSurname(r.authors_text)
      let matched = false
      for (const sg of subgroups) {
        const yearOk =
          r.year == null || sg.leaderYear == null
            ? true
            : Math.abs(r.year - sg.leaderYear) <= 1
        const surnameOk = !sn || !sg.leaderSurname || sn === sg.leaderSurname
        if (yearOk && surnameOk) {
          sg.members.push(r)
          matched = true
          break
        }
      }
      if (!matched) {
        subgroups.push({
          leaderYear: r.year,
          leaderSurname: sn,
          members: [r],
        })
      }
    }

    for (const sg of subgroups) {
      if (sg.members.length < 2) continue
      // 检查是否任一成员已属于 DOI group(应不会,被前面 filter 掉了,但稳一手)
      const existingGid = sg.members.find((m) => groupOf.has(m.id))
      const gid = existingGid ? groupOf.get(existingGid.id) : randomId('dup')
      for (const m of sg.members) {
        if (!groupOf.has(m.id)) assign(m.id, gid)
      }
    }
  }

  // ---- 写回数据库 ----
  // leader = 同组中 created_at 最早的(rows 已按 created_at ASC,所以第一个 push 进去的)
  const upd = db.prepare(`
    UPDATE records SET duplicate_group_id = ?, duplicate_of_record_id = ?
    WHERE id = ? AND project_id = ?
  `)

  let recordsMerged = 0
  let realGroups = 0

  const tx = db.transaction(() => {
    for (const [gid, ids] of members) {
      if (ids.length < 2) continue
      realGroups++
      const leaderId = ids[0]
      for (let i = 0; i < ids.length; i++) {
        const rid = ids[i]
        const dupOf = i === 0 ? null : leaderId
        upd.run(gid, dupOf, rid, projectId)
        if (i > 0) recordsMerged++
      }
    }
  })
  tx()

  return { groups_found: realGroups, records_merged: recordsMerged }
}
