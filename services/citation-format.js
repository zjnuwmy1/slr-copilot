/**
 * services/citation-format.js — Agent J (Phase 4)
 *
 * 纯函数模块。把 record 渲染为 5 种引文格式的字符串。
 * 不依赖 DB,不依赖任何全局状态。任何字段问题都尽力 fallback,不抛异常。
 *
 * 斜体用 *...* 表达(后续可由调用方转换为 HTML / Markdown)。
 */

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * 安全 parse JSON;失败返回 fallback。
 */
function safeParseJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s; // already parsed
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 把 DB row 形态(authors_json / keywords_json 是 JSON 字符串)
 * 规范化为对象形态(authors / keywords 为数组)。
 *
 * 不修改原 row,返回浅拷贝 + 补充字段。
 */
export function normalizeRecord(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') return {};
  const out = { ...rawRow };

  // authors
  let authors = rawRow.authors;
  if (!Array.isArray(authors)) {
    authors = safeParseJson(rawRow.authors_json, []);
    if (!Array.isArray(authors)) authors = [];
  }
  // 规范化每个作者条目
  out.authors = authors
    .map((a) => {
      if (!a) return null;
      if (typeof a === 'string') {
        // 'Wang Guankun' 或 'Wang, Guankun'
        const t = a.trim();
        if (!t) return null;
        if (t.includes(',')) {
          const [s, g] = t.split(',').map((x) => x.trim());
          return { surname: s || '', givenName: g || '', full: t };
        }
        const parts = t.split(/\s+/);
        if (parts.length === 1) return { surname: parts[0], givenName: '', full: t };
        return { surname: parts[parts.length - 1], givenName: parts.slice(0, -1).join(' '), full: t };
      }
      return {
        surname: (a.surname || a.family || '').trim(),
        givenName: (a.givenName || a.given || '').trim(),
        full: (a.full || '').trim(),
      };
    })
    .filter((a) => a && (a.surname || a.givenName || a.full));

  // keywords
  let kws = rawRow.keywords;
  if (!Array.isArray(kws)) {
    kws = safeParseJson(rawRow.keywords_json, []);
    if (!Array.isArray(kws)) kws = [];
  }
  out.keywords = kws.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());

  // year coerce
  if (out.year != null) {
    const y = Number(out.year);
    out.year = Number.isFinite(y) ? y : null;
  }
  if (!out.year && out.date_text) {
    const m = String(out.date_text).match(/(\d{4})/);
    if (m) out.year = Number(m[1]);
  }

  return out;
}

// ---------------------------------------------------------------------------
// helpers — 作者名格式化
// ---------------------------------------------------------------------------

/**
 * 取首字母 + '.'  'Guankun' -> 'G.'   'Jean-Luc' -> 'J.-L.'
 */
function initialsOf(givenName) {
  if (!givenName) return '';
  const parts = String(givenName)
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .map((p) => {
      // 处理 hyphenated: 'Jean-Luc'
      const subs = p.split('-').filter(Boolean);
      return subs.map((s) => firstChar(s) + '.').join('-');
    })
    .join(' ');
}

function firstChar(s) {
  // 取第一个字符(考虑 surrogate / Unicode)
  if (!s) return '';
  const arr = Array.from(s);
  return arr[0] || '';
}

/** 'G' 形式(不带点),GB/T 7714 用 */
function initialsNoDot(givenName) {
  if (!givenName) return '';
  const parts = String(givenName).split(/[\s-]+/).filter(Boolean);
  return parts.map((p) => firstChar(p)).join('');
}

/** 'Wang' (surname only,fallback to full) */
function surnameOf(a) {
  if (!a) return '';
  if (a.surname) return a.surname;
  if (a.full) {
    const parts = a.full.trim().split(/\s+/);
    return parts[parts.length - 1] || a.full;
  }
  return '';
}

/** 'Guankun' (givenName,fallback try to extract from full) */
function givenOf(a) {
  if (!a) return '';
  if (a.givenName) return a.givenName;
  if (a.full && a.surname) {
    return a.full.replace(new RegExp('\\s*' + escapeRe(a.surname) + '\\s*$'), '').trim();
  }
  return '';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 是否 CJK 姓氏(用于切换中文姓名渲染) */
function isCjk(s) {
  return !!s && /[㐀-鿿]/.test(s);
}

/** 中文姓名渲染:surname + givenName(无逗号、无空格) */
function cjkFullName(a) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  return (sur || '') + (given || '');
}

// ---------------------------------------------------------------------------
// helpers — 数据规范
// ---------------------------------------------------------------------------

function getYear(r) {
  if (r.year && Number.isFinite(Number(r.year))) return String(r.year);
  if (r.date_text) {
    const m = String(r.date_text).match(/(\d{4})/);
    if (m) return m[1];
  }
  return null;
}

function getTitle(r) {
  return (r.title || '').trim();
}

function getJournalOrVenue(r) {
  return (r.journal || r.publisher || '').trim();
}

function doiUrl(doi) {
  if (!doi) return null;
  const trimmed = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (!trimmed) return null;
  return 'https://doi.org/' + trimmed;
}

function trimEndPunct(s) {
  return String(s || '').replace(/[.,;:\s]+$/, '');
}

// ---------------------------------------------------------------------------
// APA 7th
// ---------------------------------------------------------------------------

function formatApaAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  // > 20 作者:列前 19 + ', ... ' + 最后一位
  if (authors.length > 20) {
    const first19 = authors.slice(0, 19).map(apaAuthor);
    const last = apaAuthor(authors[authors.length - 1]);
    return first19.join(', ') + ', ... ' + last;
  }
  const fs = authors.map(apaAuthor);
  if (fs.length === 1) return fs[0];
  if (fs.length === 2) return fs[0] + ', & ' + fs[1];
  return fs.slice(0, -1).join(', ') + ', & ' + fs[fs.length - 1];
}

function apaAuthor(a) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  if (!sur && !given) return a.full || '';
  if (isCjk(sur) || isCjk(given)) return cjkFullName(a);
  if (!sur) return given;
  const inits = initialsOf(given);
  return inits ? `${sur}, ${inits}` : sur;
}

function formatApa(r) {
  const authorsStr = formatApaAuthors(r.authors);
  const year = getYear(r) || 'n.d.';
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const doi = doiUrl(r.doi);

  const parts = [];
  if (authorsStr) {
    // 末尾如果已是 '.' 则不再加,否则补一个
    const authorTail = /[.]\s*$/.test(authorsStr) ? authorsStr : authorsStr + '.';
    parts.push(authorTail + ' ');
    parts.push(`(${year}). `);
    if (title) parts.push(title.endsWith('.') ? title + ' ' : title + '. ');
  } else {
    // 没有作者 — APA 把标题前移
    if (title) parts.push(title.endsWith('.') ? title + ' ' : title + '. ');
    parts.push(`(${year}). `);
  }

  if (r.item_type === 'conferencePaper' && venue) {
    parts.push(`In *${venue}*. `);
  } else if (r.item_type === 'bookSection' && venue) {
    parts.push(`In *${venue}*. `);
  } else if (r.item_type === 'webpage') {
    if (venue) parts.push(`*${venue}*. `);
  } else if (venue) {
    parts.push(`*${venue}*. `);
  }

  if (doi) {
    parts.push(doi);
  } else if (r.url) {
    parts.push(r.url);
  }

  return trimEndPunct(parts.join('').trim()) + (doi || r.url ? '' : '.');
}

// ---------------------------------------------------------------------------
// IEEE
// ---------------------------------------------------------------------------

function ieeeAuthor(a) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  if (isCjk(sur) || isCjk(given)) return cjkFullName(a);
  const inits = initialsOf(given);
  if (!sur) return inits || a.full || '';
  return inits ? `${inits} ${sur}` : sur;
}

function formatIeeeAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  // > 6 作者用 et al.
  if (authors.length > 6) {
    return ieeeAuthor(authors[0]) + ' et al.';
  }
  const fs = authors.map(ieeeAuthor);
  if (fs.length === 1) return fs[0];
  if (fs.length === 2) return fs[0] + ' and ' + fs[1];
  return fs.slice(0, -1).join(', ') + ', and ' + fs[fs.length - 1];
}

function formatIeee(r) {
  const authorsStr = formatIeeeAuthors(r.authors);
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const year = getYear(r);
  const doi = r.doi ? String(r.doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null;

  const parts = [];
  if (authorsStr) parts.push(authorsStr + ', ');
  if (title) parts.push(`"${title}," `);
  if (venue) {
    if (r.item_type === 'conferencePaper') {
      parts.push(`in *${venue}*, `);
    } else {
      parts.push(`*${venue}*, `);
    }
  }
  if (year) parts.push(year);
  if (doi) {
    parts.push((year ? ', ' : '') + 'doi: ' + doi);
  } else if (r.url) {
    parts.push((year ? ', ' : '') + r.url);
  }
  return trimEndPunct(parts.join('').trim()) + '.';
}

// ---------------------------------------------------------------------------
// GB/T 7714-2015
// ---------------------------------------------------------------------------

const GB_TYPE = {
  journalArticle: 'J',
  conferencePaper: 'C',
  bookSection: 'M',
  book: 'M',
  webpage: 'EB/OL',
  other: 'Z',
};

function gbAuthor(a) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  // 中文姓名:surname 是 CJK 字符,直接 surname + given
  if (sur && /[㐀-鿿]/.test(sur)) {
    return sur + (given || '');
  }
  const inits = initialsNoDot(given);
  if (!sur) return inits || a.full || '';
  return inits ? `${sur} ${inits}` : sur;
}

function formatGbAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  // > 3 作者用 et al.
  if (authors.length > 3) {
    return authors.slice(0, 3).map(gbAuthor).join(', ') + ', et al';
  }
  return authors.map(gbAuthor).join(', ');
}

function formatGbT7714(r) {
  const authorsStr = formatGbAuthors(r.authors);
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const year = getYear(r);
  const docType = GB_TYPE[r.item_type] || 'Z';

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  if (title) parts.push(`${title}[${docType}]`);
  if (venue) parts.push('. ' + venue);
  if (year) parts.push(', ' + year);
  if (r.doi) {
    const d = String(r.doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    parts.push('. DOI: ' + d);
  } else if (r.url && r.item_type === 'webpage') {
    parts.push('. ' + r.url);
  }
  return trimEndPunct(parts.join('').trim()) + '.';
}

// ---------------------------------------------------------------------------
// Chicago author-date 17th
// ---------------------------------------------------------------------------

function chicagoAuthor(a, isFirst) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  if (isCjk(sur) || isCjk(given)) return cjkFullName(a);
  if (!sur) return given || a.full || '';
  if (isFirst) {
    // 首作者:Surname, Given
    return given ? `${sur}, ${given}` : sur;
  }
  return given ? `${given} ${sur}` : sur;
}

function formatChicagoAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  // > 10 作者:列前 7 + ", et al."
  if (authors.length > 10) {
    const first7 = authors.slice(0, 7).map((a, i) => chicagoAuthor(a, i === 0));
    return first7.join(', ') + ', et al';
  }
  const fs = authors.map((a, i) => chicagoAuthor(a, i === 0));
  if (fs.length === 1) return fs[0];
  if (fs.length === 2) return fs[0] + ', and ' + fs[1];
  return fs.slice(0, -1).join(', ') + ', and ' + fs[fs.length - 1];
}

function formatChicago(r) {
  const authorsStr = formatChicagoAuthors(r.authors);
  const year = getYear(r) || 'n.d.';
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const doi = doiUrl(r.doi);

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  parts.push(year + '. ');
  if (title) parts.push(`"${title}." `);
  if (venue) parts.push(`*${venue}*.`);
  if (doi) parts.push(' ' + doi + '.');
  else if (r.url) parts.push(' ' + r.url + '.');
  return parts.join('').trim();
}

// ---------------------------------------------------------------------------
// MLA 9th
// ---------------------------------------------------------------------------

function mlaAuthor(a, isFirst) {
  const sur = surnameOf(a);
  const given = givenOf(a);
  if (isCjk(sur) || isCjk(given)) return cjkFullName(a);
  if (!sur) return given || a.full || '';
  if (isFirst) {
    return given ? `${sur}, ${given}` : sur;
  }
  return given ? `${given} ${sur}` : sur;
}

function formatMlaAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  // 3+ 作者:首作者 + ", et al."
  if (authors.length >= 3) {
    return mlaAuthor(authors[0], true) + ', et al';
  }
  if (authors.length === 1) return mlaAuthor(authors[0], true);
  return mlaAuthor(authors[0], true) + ', and ' + mlaAuthor(authors[1], false);
}

function formatMla(r) {
  const authorsStr = formatMlaAuthors(r.authors);
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const year = getYear(r);
  const doi = doiUrl(r.doi);

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  if (title) parts.push(`"${title}." `);
  if (venue) parts.push(`*${venue}*`);
  if (year) parts.push((venue ? ', ' : '') + year);
  if (doi) parts.push(', ' + doi);
  else if (r.url) parts.push(', ' + r.url);
  return trimEndPunct(parts.join('').trim()) + '.';
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

const STYLES = {
  apa: formatApa,
  ieee: formatIeee,
  gb_t_7714: formatGbT7714,
  chicago: formatChicago,
  mla: formatMla,
};

/**
 * 把一条 record 渲染为指定 style 的引文字符串。
 * 任何错误都吞掉,fallback 到最小 string('Title' 或 '[Unknown record]')。
 */
export function formatCitation(record, style) {
  try {
    const r = normalizeRecord(record);
    // 完全空记录(无 title / 无 authors)— 直接返回占位
    if (!getTitle(r) && (!r.authors || r.authors.length === 0)) {
      return '[Unknown record]';
    }
    const fn = STYLES[style];
    if (!fn) return getTitle(r) || '[Unknown record]';
    const out = fn(r);
    if (!out || !out.trim()) {
      return getTitle(r) || '[Unknown record]';
    }
    return out;
  } catch {
    return (record && record.title) || '[Unknown record]';
  }
}

/**
 * 返回所有 5 种 style 的字符串。
 */
export function formatAllStyles(record) {
  const r = normalizeRecord(record);
  return {
    apa: formatCitation(r, 'apa'),
    ieee: formatCitation(r, 'ieee'),
    gb_t_7714: formatCitation(r, 'gb_t_7714'),
    chicago: formatCitation(r, 'chicago'),
    mla: formatCitation(r, 'mla'),
  };
}

// 暴露 helpers 给 export module 复用
export const _internal = {
  surnameOf,
  givenOf,
  initialsOf,
  initialsNoDot,
  getYear,
  getTitle,
  getJournalOrVenue,
  doiUrl,
};
