/**
 * services/crossref.js — Phase 4.5 Agent K
 *
 * 简单的 Crossref REST API 客户端。
 *   fetchByDoi(doi) → null | normalized metadata object
 *
 * 不依赖任何外部 npm 包,只用 Node 18+ 的全局 fetch + AbortSignal.timeout。
 * 任何网络 / 解析错误都吞掉,返回 null —— 调用方拿不到数据时让用户手填即可。
 */

const CROSSREF_BASE = 'https://api.crossref.org/works/'

// Crossref 推荐每个客户端带可识别 User-Agent
// 见 https://api.crossref.org/swagger-ui/index.html
const USER_AGENT =
  'slr-copilot/0.1 (Phase 4.5 manual record entry; mailto:noreply@local)'

// Crossref type → 我们 records.item_type 映射
const TYPE_MAP = {
  'journal-article': 'journalArticle',
  'proceedings-article': 'conferencePaper',
  'book-chapter': 'bookSection',
  'book': 'book',
  'book-section': 'bookSection',
  'monograph': 'book',
  'reference-book': 'book',
  'edited-book': 'book',
  'report': 'other',
  'dataset': 'other',
  'dissertation': 'other',
  'standard': 'other',
}

function mapItemType(crossrefType) {
  if (!crossrefType) return 'other'
  return TYPE_MAP[crossrefType] || 'other'
}

function pickYear(message) {
  // Crossref 提供 issued / published-print / published-online 之一,date-parts: [[yyyy, mm, dd]]
  const candidates = ['issued', 'published-print', 'published-online', 'published']
  for (const k of candidates) {
    const dp = message?.[k]?.['date-parts']
    if (Array.isArray(dp) && Array.isArray(dp[0]) && Number.isFinite(dp[0][0])) {
      return Number(dp[0][0])
    }
  }
  return null
}

function extractAuthors(message) {
  const authors = Array.isArray(message?.author) ? message.author : []
  return authors
    .map((a) => {
      const surname = (a.family || '').trim()
      const givenName = (a.given || '').trim()
      const literal = (a.name || a.literal || '').trim()
      const full = literal || `${givenName} ${surname}`.trim()
      if (!surname && !givenName && !full) return null
      return { surname, givenName, full }
    })
    .filter(Boolean)
}

function firstString(v) {
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && x.trim()) || null
  if (typeof v === 'string' && v.trim()) return v
  return null
}

function cleanAbstract(s) {
  if (!s) return null
  // Crossref 的 abstract 经常是 JATS XML,去掉常见标签
  return String(s)
    .replace(/<jats:p[^>]*>/g, '')
    .replace(/<\/jats:p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim() || null
}

/**
 * 用 DOI 查 Crossref,返回 normalized metadata 或 null。
 * 错误(网络 / 超时 / 404 / 解析失败)一律返回 null。
 *
 * @param {string} doi
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<null | {
 *   title: string,
 *   authors: Array<{surname, givenName, full}>,
 *   year: number|null,
 *   journal: string|null,
 *   publisher: string|null,
 *   doi: string,
 *   url: string|null,
 *   abstract: string|null,
 *   item_type: string
 * }>}
 */
export async function fetchByDoi(doi, { timeoutMs = 5000 } = {}) {
  if (!doi || typeof doi !== 'string') return null
  const cleaned = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  if (!cleaned) return null

  let controller
  let timer
  try {
    // 兼容性:优先用 AbortSignal.timeout(Node 17.3+);fallback 用 AbortController
    let signal
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs)
    } else {
      controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)
      signal = controller.signal
    }

    const url = CROSSREF_BASE + encodeURIComponent(cleaned)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal,
    })

    if (!res || !res.ok) return null
    const json = await res.json()
    const m = json?.message
    if (!m || typeof m !== 'object') return null

    const title = firstString(m.title) || ''
    if (!title) return null

    const journal = firstString(m['container-title'])
    const publisher = typeof m.publisher === 'string' ? m.publisher.trim() : null
    const year = pickYear(m)
    const authors = extractAuthors(m)
    const itemUrl = (typeof m.URL === 'string' && m.URL.trim()) ? m.URL.trim() : null
    const abstract = cleanAbstract(m.abstract)
    const item_type = mapItemType(m.type)

    return {
      title: title.trim(),
      authors,
      year,
      journal: journal ? journal.trim() : null,
      publisher,
      doi: cleaned,
      url: itemUrl,
      abstract,
      item_type,
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
