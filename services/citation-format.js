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
      // Object 形态:已经有 surname/givenName(zotero-ingest / 新 csv-ingest 走这条)
      if (typeof a === 'object' && (a.surname || a.family || a.givenName || a.given)) {
        return {
          surname: (a.surname || a.family || '').trim(),
          givenName: (a.givenName || a.given || '').trim(),
          full: (a.full || '').trim(),
        };
      }
      // Object 但只有 .full(老 csv-ingest 错误 INSERT 的兼容路径)
      //   走下方 string 解析逻辑;a.full 通常已经是 "Wang G" / "Wang, Gang" 风格
      const raw = typeof a === 'string' ? a : String(a?.full || '')
      const t = raw.trim()
      if (!t) return null
      // 2026-05-25 BUG FIX: 把 string → {surname, givenName} 的解析重写,
      //   覆盖 5 种常见输入,避免之前 "Wang G" 被解析成 {surname:G, givenName:Wang} 的姓名颠倒
      // ── Case 1: "Surname, Given"  (Zotero / WoS AF / Scopus AF)
      let m = t.match(/^([^,]+),\s*(.+?)\.?$/)
      if (m) {
        return { surname: m[1].trim(), givenName: m[2].trim().replace(/\.$/, ''), full: t }
      }
      // ── Case 2: "Surname Initials"  e.g. "Wang G", "Wang GK", "Wang G K", "Wang G."
      //   姓在前 + 后面跟 1-3 个大写首字母(可能有点/空格)— WoS / Scopus 老格式
      m = t.match(/^(\S+(?:\s\S+)*?)\s+([A-Z](?:\.?\s?[A-Z]\.?){0,3})\.?$/)
      if (m) {
        return { surname: m[1].trim(), givenName: m[2].replace(/\./g, '').replace(/\s+/g, ''), full: t }
      }
      // ── Case 3: 单 token (机构 / 残缺)
      const parts = t.split(/\s+/)
      if (parts.length === 1) return { surname: parts[0], givenName: '', full: t }
      // ── Case 4: "Initials Surname"  e.g. "G. Wang", "G K Wang"  (IEEE/MLA 输入)
      if (/^[A-Z]{1,3}\.?$/.test(parts[0])) {
        return {
          surname: parts[parts.length - 1],
          givenName: parts.slice(0, -1).join(' ').replace(/\./g, ''),
          full: t,
        }
      }
      // ── Case 5: 完整名 "Given Surname"(默认西式)— 把最后一个当 surname
      return {
        surname: parts[parts.length - 1],
        givenName: parts.slice(0, -1).join(' '),
        full: t,
      }
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

  // 双语标题清洗 — 见 cleanBilingualTitle 注释
  const cleaned = cleanBilingualTitle(out.title);
  if (cleaned.title_alt) {
    out.title = cleaned.title;
    out.title_alt = cleaned.title_alt;
  }

  return out;
}

/**
 * 把 Scopus / WoS 的双语标题(`<English>; [<其他语言翻译>]`)拆成主标题 + 翻译。
 *
 *   输入  "Foo; [Bar]"
 *   输出  { title: 'Foo', title_alt: 'Bar' }
 *
 *   输入  "Foo" / null / ''
 *   输出  { title: <原值>, title_alt: null }
 *
 * 用于所有需要把 record.title 给"下游"的地方:引文输出(APA / IEEE / GB/T 7714 / BibTeX /
 * RIS / CSL JSON)、LLM 抽取 prompt、综述初稿、PRISMA flow 等。
 * 不动 DB 原值。
 */
export function cleanBilingualTitle(rawTitle) {
  if (!rawTitle) return { title: rawTitle || '', title_alt: null };
  const s = String(rawTitle);
  const m = s.match(/^(.+?)\s*;\s*\[(.+)\]\s*$/s);
  if (!m) return { title: s, title_alt: null };
  return { title: m[1].trim(), title_alt: m[2].trim() };
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

// ============================================================
// 2026-05-25 M35:volume / issue / pages 标准化访问
// ------------------------------------------------------------
//   Zotero 导入(zotero-ingest.js)和 CSV 导入会把 volume / issue / pages 落到
//   records 表对应字段。下面 5 个 format 函数共用 vipBits/vipApa/vipIeee/vipGb/vipChicago/vipMla
//   把 volume(issue):pages 按 style 习惯拼出来,缺字段全 graceful skip。
// ============================================================
function vipBits(r) {
  return {
    vol:   r && r.volume ? String(r.volume).trim() : '',
    iss:   r && r.issue  ? String(r.issue).trim()  : '',
    pages: r && r.pages  ? String(r.pages).trim().replace(/^\s*pp?\.\s*/i, '') : '',
  }
}

/** APA 7:`<i>Journal</i>, V(I), pages.` */
function vipApa(r) {
  const { vol, iss, pages } = vipBits(r)
  if (!vol && !iss && !pages) return ''
  let s = ''
  if (vol) {
    s += `, *${vol}*`
    if (iss) s += `(${iss})`
  } else if (iss) {
    s += `, (${iss})`
  }
  if (pages) s += (s ? ', ' : ', ') + pages
  return s
}

/** IEEE:`, vol. V, no. I, pp. pages` */
function vipIeee(r) {
  const { vol, iss, pages } = vipBits(r)
  const out = []
  if (vol)   out.push('vol. ' + vol)
  if (iss)   out.push('no. ' + iss)
  if (pages) out.push('pp. ' + pages)
  return out.length ? ', ' + out.join(', ') : ''
}

/** GB/T 7714:`, year, V(I): pages.` — vol/issue/pages 部分(年份外部处理) */
function vipGb(r) {
  const { vol, iss, pages } = vipBits(r)
  if (!vol && !iss && !pages) return ''
  let s = ', '
  if (vol) {
    s += vol
    if (iss) s += '(' + iss + ')'
  } else if (iss) {
    s += '(' + iss + ')'
  }
  if (pages) s += ': ' + pages
  return s
}

/** Chicago author-date:` V (I): pages.` 紧跟 *Journal* 后 */
function vipChicago(r) {
  const { vol, iss, pages } = vipBits(r)
  if (!vol && !iss && !pages) return ''
  let s = ''
  if (vol) {
    s += ' ' + vol
    if (iss) s += ' (' + iss + ')'
  } else if (iss) {
    s += ' (' + iss + ')'
  }
  if (pages) s += ': ' + pages
  return s
}

/** MLA 9:`, vol. V, no. I, year, pp. pages,` — year 部分外面给,这里只 vol/issue/pages */
function vipMla(r) {
  const { vol, iss, pages } = vipBits(r)
  const out = []
  if (vol)   out.push('vol. ' + vol)
  if (iss)   out.push('no. ' + iss)
  if (pages) out.push('pp. ' + pages)
  return out.length ? ', ' + out.join(', ') : ''
}

function formatApa(r) {
  const authorsStr = formatApaAuthors(r.authors);
  const year = getYear(r) || 'n.d.';
  const title = getTitle(r);
  const venue = getJournalOrVenue(r);
  const doi = doiUrl(r.doi);
  const vip = vipApa(r)   // ", *V*(I), pages"

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

  // venue + vol/issue/pages
  if (r.item_type === 'conferencePaper' && venue) {
    parts.push(`In *${venue}*${vip}. `);
  } else if (r.item_type === 'bookSection' && venue) {
    parts.push(`In *${venue}*${vip}. `);
  } else if (r.item_type === 'webpage') {
    if (venue) parts.push(`*${venue}*. `);
  } else if (venue) {
    parts.push(`*${venue}*${vip}. `);
  } else if (vip) {
    // 没 venue 但有 vol/issue/pages — 也输出,删掉开头的 ", "
    parts.push(vip.replace(/^,\s*/, '') + '. ');
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
  const vip = vipIeee(r)   // ", vol. V, no. I, pp. pages"

  const parts = [];
  if (authorsStr) parts.push(authorsStr + ', ');
  if (title) parts.push(`"${title}," `);
  if (venue) {
    if (r.item_type === 'conferencePaper') {
      parts.push(`in *${venue}*`);
    } else {
      parts.push(`*${venue}*`);
    }
    if (vip) parts.push(vip)
    parts.push(', ');
  } else if (vip) {
    parts.push(vip.replace(/^,\s*/, '') + ', ');
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
  const vip = vipGb(r)   // ", V(I): pages"

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  if (title) parts.push(`${title}[${docType}]`);
  if (venue) parts.push('. ' + venue);
  if (year) parts.push(', ' + year);
  if (vip) parts.push(vip);
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
  const vip = vipChicago(r)   // " V (I): pages"

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  parts.push(year + '. ');
  if (title) parts.push(`"${title}." `);
  if (venue) {
    parts.push(`*${venue}*`);
    if (vip) parts.push(vip)
    parts.push('.');
  } else if (vip) {
    parts.push(vip.trim() + '.');
  }
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
  const vip = vipMla(r)   // ", vol. V, no. I, pp. pages"

  const parts = [];
  if (authorsStr) parts.push(authorsStr + '. ');
  if (title) parts.push(`"${title}." `);
  if (venue) parts.push(`*${venue}*`);
  if (vip) parts.push(vip)
  if (year) parts.push((venue || vip ? ', ' : '') + year);
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
  // 2026-05-25 M35:接受多种 GB/T 7714 别名(preview ?style=gbt7714 走这条)
  gb_t_7714: formatGbT7714,
  gbt7714: formatGbT7714,
  gb7714: formatGbT7714,
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
