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

  // 去重 + 排序输出
  out.legitimate = Array.from(legitimateSet).sort()
  out.hallucinated = Array.from(hallucinatedSet).sort()
  out.in_text_count = count
  out.citation_map_orphans = Array.from(new Set(out.citation_map_orphans)).sort()
  return out
}
