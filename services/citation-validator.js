// =============================================================================
// services/citation-validator.js
// -----------------------------------------------------------------------------
// 校验 LLM 生成的 content_markdown 中的 [rec_xxx] 引文是否都在 include 集合里。
//
// 2026-05-25 P0-6:之前只在 view 层用 computeCitationCoverage 事后探测,
// 现在改成生成时立刻校验,把幻觉 rec_id 写到 draft_sections.hallucinated_recs_json,
// 让 UI / export / preview 都能 surface。
//
// 引文 placeholder 形态(跟 view 层 / preview 层正则一致):
//   [rec_xxx]
//   [rec_a, rec_b, rec_c]      // 逗号分隔
//   [rec_a; rec_b]             // 分号分隔
//
// 输入:
//   content       string  LLM 返回的 content_markdown
//   includeSet    Set<string> | Array<string>  include 集合的 record_id
//   citationMap   Array<{ placeholder, paper_id }>  LLM 返回的 citation_map(可空)
//
// 输出:
//   {
//     legitimate:    Array<string>   都在 include 集合的 rec_id(去重)
//     hallucinated:  Array<string>   不在 include 的 rec_id(去重)
//     in_text_count: number          正文出现的引文总次数
//     citation_map_orphans: Array<string>   出现在 citation_map 但不在正文的 paper_id
//   }
//
// 注意:
//   - 字段 schema 跟 services/drafting-helpers.js computeCitationCoverage 兼容
//   - 不抛异常,无效输入返 empty arrays
// =============================================================================

const REC_PLACEHOLDER_RE = /\[(rec_[A-Za-z0-9_,;\s-]+)\]/g
const REC_TOKEN_RE = /^rec_[A-Za-z0-9_-]+$/

// ----------------------------------------------------------------------------
// 2026-06-10 — 引文 ID 抄写纠错(transcription recovery)
//   record_id 是 `rec_` + 32 位随机 hex。LLM 抄这种长随机串时偶尔会丢/错位几位
//   (实测:把 rec_02117d7ff6c4dfebd8088917c106d2ab 中间 8 位漏掉,写成
//    rec_02117d7ff8088917c106d2ab),导致精确比对判它"幻觉"——但其实是真纳入文献。
//   既然两条不同真 id 的编辑距离 ~25+,而抄错版与其真源只差几位,做"唯一近似回收"
//   极其安全:只在与某条 include 记录编辑距离很小、且明显唯一时,才纠正成真 id。
// ----------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1)
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 把"看似幻觉"的 token 尝试回收成 include 集里唯一近似的真 id。
 * @param {Iterable<string>} tokens         待回收的 rec token
 * @param {Set<string>|Array<string>} includeSet  合法 include id
 * @returns {{ corrections: Record<string,string>, stillHallucinated: string[] }}
 */
export function recoverHallucinatedRecs(tokens, includeSet) {
  const corrections = {}
  const stillHallucinated = []
  const includeArr = includeSet instanceof Set
    ? Array.from(includeSet)
    : (Array.isArray(includeSet) ? includeSet : [])
  const okSet = includeSet instanceof Set ? includeSet : new Set(includeArr)
  const toks = Array.from(new Set(Array.from(tokens || []).map((t) => String(t))))
  if (!includeArr.length) return { corrections, stillHallucinated: toks }

  const includeHex = includeArr.map((id) => ({ id, hex: id.replace(/^rec_/, '') }))

  for (const tok of toks) {
    if (okSet.has(tok)) continue   // 已合法
    const hex = tok.replace(/^rec_/, '')
    // 太短的 token 歧义太大,不回收(避免误纠)
    if (hex.length < 16) { stillHallucinated.push(tok); continue }
    let best = null, bestDist = Infinity, secondDist = Infinity
    for (const cand of includeHex) {
      if (Math.abs(cand.hex.length - hex.length) > 14) continue   // 长度差太大不可能是抄错
      const d = levenshtein(hex, cand.hex)
      if (d < bestDist) { secondDist = bestDist; bestDist = d; best = cand }
      else if (d < secondDist) { secondDist = d }
    }
    // 阈值:与最佳 ≤ maxDist,且明显唯一(次佳比最佳远 ≥ 6,因随机 hex 互距 ~25+,真源永远孤立)
    const maxDist = best ? Math.min(12, Math.ceil(best.hex.length * 0.45)) : 12
    if (best && bestDist <= maxDist && (secondDist - bestDist) >= 6) {
      corrections[tok] = best.id
    } else {
      stillHallucinated.push(tok)
    }
  }
  return { corrections, stillHallucinated }
}

/** 把 content 里抄错的 rec id 整词替换成真 id。corrections: { 错id: 真id } */
export function applyRecCorrections(content, corrections) {
  if (typeof content !== 'string' || !content || !corrections) return content
  let out = content
  for (const bad of Object.keys(corrections)) {
    const good = corrections[bad]
    if (!bad || !good || bad === good) continue
    out = out.split(bad).join(good)   // bad 是长唯一串,直接整串替换安全
  }
  return out
}

/**
 * @param {string} content      LLM content_markdown
 * @param {Set<string>|Array<string>} includeSet  合法 rec_id 集合
 * @param {Array<{placeholder:string, paper_id:string}>} [citationMap=[]]
 * @returns {{legitimate:string[], hallucinated:string[], in_text_count:number, citation_map_orphans:string[]}}
 */
export function validateCitationsAgainstInclude(content, includeSet, citationMap = []) {
  const out = {
    legitimate: [],
    hallucinated: [],
    in_text_count: 0,
    citation_map_orphans: [],
  }
  if (typeof content !== 'string' || !content) return out

  // 归一 includeSet 为 Set
  const okSet = includeSet instanceof Set
    ? includeSet
    : new Set(Array.isArray(includeSet) ? includeSet : [])

  // 1) 扫正文 [rec_xxx] / [rec_a, rec_b] placeholders
  const legitimateSet = new Set()
  const hallucinatedSet = new Set()
  let inTextRecs = new Set()  // 用于跟 citation_map 比对 orphans
  let count = 0
  let m
  REC_PLACEHOLDER_RE.lastIndex = 0
  while ((m = REC_PLACEHOLDER_RE.exec(content)) !== null) {
    const inner = m[1]
    for (const tok of inner.split(/[,;]\s*/)) {
      const t = tok.trim()
      if (!REC_TOKEN_RE.test(t)) continue
      count += 1
      inTextRecs.add(t)
      if (okSet.has(t)) legitimateSet.add(t)
      else hallucinatedSet.add(t)
    }
  }

  // 2) 扫 citation_map (LLM 也应该在 citation_map 里列出引用的 paper_id)
  //    任何 citation_map.paper_id 不在 include 集合 → 算 hallucination
  //    任何 citation_map.paper_id 不在正文 → 算 orphan(可能 LLM 写了引用但又删了)
  if (Array.isArray(citationMap)) {
    for (const entry of citationMap) {
      const pid = entry && typeof entry.paper_id === 'string' ? entry.paper_id : null
      if (!pid || !REC_TOKEN_RE.test(pid)) continue
      if (!okSet.has(pid)) hallucinatedSet.add(pid)
      if (!inTextRecs.has(pid)) out.citation_map_orphans.push(pid)
    }
  }

  // 2026-06-10 — 对"看似幻觉"的做抄写纠错回收:与某条 include 唯一近似的 → 视为合法 + 记纠正映射
  const { corrections, stillHallucinated } = recoverHallucinatedRecs(hallucinatedSet, okSet)
  for (const bad of Object.keys(corrections)) legitimateSet.add(corrections[bad])

  // 去重 + 排序输出
  out.legitimate = Array.from(legitimateSet).sort()
  out.hallucinated = Array.from(new Set(stillHallucinated)).sort()
  out.corrections = corrections           // { 抄错id: 真id } — 供调用方改写 content
  out.in_text_count = count
  out.citation_map_orphans = Array.from(new Set(out.citation_map_orphans)).sort()
  return out
}
