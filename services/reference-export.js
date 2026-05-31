/**
 * services/reference-export.js — Agent J (Phase 4)
 *
 * 批量导出 records 为 BibTeX / RIS / CSL JSON / Markdown References。
 * 纯函数,接收已 normalize(authors 是数组,keywords 是数组) 或原始 row 都行 —
 * 内部都先过一遍 normalizeRecord。
 */

import {
  normalizeRecord,
  formatCitation,
  _internal,
} from './citation-format.js';

const { surnameOf, getYear, getTitle, getJournalOrVenue } = _internal;

// ---------------------------------------------------------------------------
// 通用 cite key 生成:wang_2025_endoarss
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'and', 'or',
  'with', 'from', 'by', 'as', 'is', 'are', 'be', 'this', 'that', 'these',
  'those', 'using', 'via', 'based', 'novel', 'new', 'study', 'analysis',
]);

function firstSignificantWords(title, count = 2) {
  if (!title) return [];
  // 按非字母数字(含 CJK)分词
  const tokens = String(title)
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    out.push(t);
    if (out.length >= count) break;
  }
  return out;
}

function asciiSlug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // 去音标
    .replace(/[^a-z0-9一-鿿]/g, '');
}

/**
 * 生成 BibTeX / CSL id。
 * 例如:wang_2025_endoarss
 */
function makeCiteKey(r, usedKeys) {
  const first = r.authors && r.authors[0];
  const sur = asciiSlug(first ? surnameOf(first) : '') || 'anon';
  const year = getYear(r) || 'nd';
  const words = firstSignificantWords(r.title || '', 2).map(asciiSlug).filter(Boolean);
  let base = [sur, year, ...words].filter(Boolean).join('_');
  if (!base) base = 'ref';
  let key = base;
  if (usedKeys) {
    let i = 2;
    while (usedKeys.has(key)) {
      key = base + '_' + i++;
    }
    usedKeys.add(key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

const BIBTEX_TYPE = {
  journalArticle: 'article',
  conferencePaper: 'inproceedings',
  bookSection: 'incollection',
  book: 'book',
  webpage: 'misc',
  other: 'misc',
};

/** LaTeX 转义:& % $ # _ { } 加反斜杠;~ ^ \ 也处理 */
function escapeLatex(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** BibTeX author field: 'Surname, Given and Surname2, Given2' */
function bibtexAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  return authors
    .map((a) => {
      const sur = (a.surname || '').trim();
      const given = (a.givenName || '').trim();
      if (sur && given) return `${escapeLatex(sur)}, ${escapeLatex(given)}`;
      if (sur) return escapeLatex(sur);
      if (given) return escapeLatex(given);
      return escapeLatex(a.full || '');
    })
    .filter(Boolean)
    .join(' and ');
}

function bibtexField(name, value, opts = {}) {
  if (value == null || value === '') return '';
  const v = opts.raw ? String(value) : escapeLatex(value);
  if (opts.protectTitle) {
    return `  ${name} = {{${v}}},\n`;
  }
  return `  ${name} = {${v}},\n`;
}

/**
 * BibTeX 导出。返回完整字符串。
 */
export function exportBibTeX(records, { collectionName = 'slr' } = {}) {
  const usedKeys = new Set();
  const arr = Array.isArray(records) ? records : [];
  const blocks = [];

  blocks.push(`% BibTeX export from SLR Copilot — collection: ${collectionName}`);
  blocks.push(`% ${arr.length} record(s)`);
  blocks.push('');

  for (const raw of arr) {
    const r = normalizeRecord(raw);
    const entryType = BIBTEX_TYPE[r.item_type] || 'misc';
    const key = makeCiteKey(r, usedKeys);

    let s = `@${entryType}{${key},\n`;

    if (r.title) s += bibtexField('title', r.title, { protectTitle: true });
    if (r.authors && r.authors.length) {
      const au = bibtexAuthors(r.authors);
      if (au) s += `  author = {${au}},\n`;
    }
    const year = getYear(r);
    if (year) s += bibtexField('year', year);

    if (r.item_type === 'conferencePaper') {
      if (r.journal || r.publisher) {
        s += bibtexField('booktitle', r.journal || r.publisher);
      }
    } else if (r.item_type === 'bookSection') {
      if (r.journal || r.publisher) {
        s += bibtexField('booktitle', r.journal || r.publisher);
      }
      if (r.publisher && r.journal) s += bibtexField('publisher', r.publisher);
    } else if (r.item_type === 'journalArticle') {
      if (r.journal) s += bibtexField('journal', r.journal);
    } else {
      if (r.journal) s += bibtexField('howpublished', r.journal);
      if (r.publisher) s += bibtexField('publisher', r.publisher);
    }

    // 2026-05-25 M35:BibTeX volume / number / pages — Zotero 高质量字段
    if (r.volume) s += bibtexField('volume', r.volume);
    if (r.issue)  s += bibtexField('number', r.issue);
    if (r.pages)  s += bibtexField('pages', String(r.pages).replace(/-/g, '--'));
    if (r.doi) {
      const d = String(r.doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      s += bibtexField('doi', d);
    }
    if (r.url) s += bibtexField('url', r.url, { raw: true });
    if (r.abstract) s += bibtexField('abstract', r.abstract);
    if (r.keywords && r.keywords.length) {
      s += bibtexField('keywords', r.keywords.join('; '));
    }
    if (r.notes) s += bibtexField('note', r.notes);

    // 去掉最后多余逗号
    s = s.replace(/,\n$/, '\n');
    s += '}\n';
    blocks.push(s);
  }

  return blocks.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

const RIS_TYPE = {
  journalArticle: 'JOUR',
  conferencePaper: 'CONF',
  bookSection: 'CHAP',
  book: 'BOOK',
  webpage: 'ELEC',
  other: 'GEN',
};

function risLine(tag, value) {
  if (value == null || value === '') return '';
  // 多行 value 折成多个相同 tag 行
  return String(value)
    .split(/\r?\n/)
    .map((line) => `${tag.padEnd(2, ' ')}  - ${line}`)
    .join('\n') + '\n';
}

/**
 * RIS 导出(用于 EndNote / RefMan)。
 */
export function exportRIS(records) {
  const arr = Array.isArray(records) ? records : [];
  const out = [];

  for (const raw of arr) {
    const r = normalizeRecord(raw);
    const ty = RIS_TYPE[r.item_type] || 'GEN';

    let s = '';
    s += risLine('TY', ty);
    if (r.title) s += risLine('TI', r.title);
    if (r.authors && r.authors.length) {
      for (const a of r.authors) {
        const sur = (a.surname || '').trim();
        const given = (a.givenName || '').trim();
        let au;
        if (sur && given) au = `${sur}, ${given}`;
        else au = a.full || sur || given || '';
        if (au) s += risLine('AU', au);
      }
    }
    const year = getYear(r);
    if (year) s += risLine('PY', year);
    if (r.date_text) s += risLine('DA', r.date_text);

    if (r.item_type === 'conferencePaper') {
      if (r.journal || r.publisher) s += risLine('T2', r.journal || r.publisher);
    } else if (r.item_type === 'bookSection') {
      if (r.journal || r.publisher) s += risLine('T2', r.journal || r.publisher);
      if (r.publisher) s += risLine('PB', r.publisher);
    } else if (r.item_type === 'journalArticle') {
      if (r.journal) s += risLine('JO', r.journal);
    } else {
      if (r.publisher) s += risLine('PB', r.publisher);
    }

    // 2026-05-25 M35:RIS VL / IS / SP / EP — Zotero 高质量字段
    if (r.volume) s += risLine('VL', r.volume);
    if (r.issue)  s += risLine('IS', r.issue);
    if (r.pages) {
      // 如 "123-145" 拆 SP / EP;若单页或非范围,只写 SP
      const m = String(r.pages).match(/^(\d+)\s*-\s*(\d+)$/)
      if (m) {
        s += risLine('SP', m[1]); s += risLine('EP', m[2]);
      } else {
        s += risLine('SP', r.pages);
      }
    }
    if (r.doi) {
      const d = String(r.doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      s += risLine('DO', d);
    }
    if (r.url) s += risLine('UR', r.url);
    if (r.abstract) s += risLine('AB', r.abstract);
    if (r.keywords && r.keywords.length) {
      for (const k of r.keywords) s += risLine('KW', k);
    }
    if (r.notes) s += risLine('N1', r.notes);

    s += 'ER  - \n';
    out.push(s);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CSL JSON
// ---------------------------------------------------------------------------

const CSL_TYPE = {
  journalArticle: 'article-journal',
  conferencePaper: 'paper-conference',
  bookSection: 'chapter',
  book: 'book',
  webpage: 'webpage',
  other: 'document',
};

function toCslItem(r, usedKeys) {
  const id = makeCiteKey(r, usedKeys);
  const item = {
    id,
    type: CSL_TYPE[r.item_type] || 'document',
  };
  if (r.title) item.title = r.title;
  if (r.authors && r.authors.length) {
    item.author = r.authors.map((a) => {
      const out = {};
      if (a.surname) out.family = a.surname;
      if (a.givenName) out.given = a.givenName;
      if (!out.family && !out.given && a.full) out.literal = a.full;
      return out;
    }).filter((x) => x.family || x.given || x.literal);
  }
  const year = getYear(r);
  if (year) {
    item.issued = { 'date-parts': [[Number(year)]] };
  }
  const venue = getJournalOrVenue(r);
  if (venue) item['container-title'] = venue;
  if (r.publisher && r.publisher !== r.journal) item.publisher = r.publisher;
  // 2026-05-25 M35:CSL volume / issue / page — Zotero 高质量字段
  if (r.volume) item.volume = r.volume;
  if (r.issue)  item.issue  = r.issue;
  if (r.pages)  item.page   = r.pages;
  if (r.doi) {
    item.DOI = String(r.doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  }
  if (r.url) item.URL = r.url;
  if (r.abstract) item.abstract = r.abstract;
  if (r.keywords && r.keywords.length) item.keyword = r.keywords.join('; ');
  if (r.notes) item.note = r.notes;
  return item;
}

/**
 * CSL JSON 导出(已 pretty stringify)。
 */
export function exportCslJson(records) {
  const usedKeys = new Set();
  const arr = Array.isArray(records) ? records : [];
  const items = arr.map((raw) => toCslItem(normalizeRecord(raw), usedKeys));
  return JSON.stringify(items, null, 2);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 行内引文短形(给 preview 页 [rec_xxx] 占位转成 "(Smith 2024)" 等用)
// ---------------------------------------------------------------------------
/**
 * 给一条 record 输出短行内引文文本(APA author-year),用于 preview 页的 [rec_xxx]
 * placeholder 替换 + LaTeX-fill 的引文小抄。
 *
 *   1 author:  Smith (2024)
 *   2 authors: Smith & Brown (2024)
 *   3+ author: Smith et al. (2024)
 *   missing:   ? (n.d.)
 *
 * 注意:刻意不带括号、不带分号 — 调用方按 [rec_xxx] 上下文自己包装。
 *
 * @param {object} raw  record(任意形态,内部 normalize)
 * @returns {string}
 */
export function inlineCitationShort(raw) {
  if (!raw) return '? (n.d.)'
  const r = normalizeRecord(raw)
  const yr = getYear(r) || 'n.d.'
  let authors = Array.isArray(r.authors) ? r.authors : []
  if (!authors.length) return `Anon. (${yr})`

  // 2026-05-26 数据质量防御:某些导入(WoS/Scopus 老数据 / Zotero 没规范)
  //   把多作者 smushed 成一条字符串 — "Dubey A.; Baghel D.; Kalita R.; ..."
  //   normalizeRecord 拿到 authors_json 是 1 条 → 走 1 author 分支 →
  //   surnameOf 把整串当 surname → 输出 "(Dubey A.; Baghel D.; ...; Lashkari 2026)" 怪格式。
  //   防御:如果 authors.length === 1 且 first item 含 ; / | / 多个逗号(逗号分隔的姓),
  //   按这些分隔符再分一次,let downstream 走 multi-author 分支正确出 "Dubey et al."
  if (authors.length === 1) {
    const first = typeof authors[0] === 'string' ? authors[0]
                 : (authors[0]?.full || authors[0]?.surname || '')
    if (typeof first === 'string' && /[;|]/.test(first)) {
      // 用 ; 或 | 分割(这两个绝对不会出现在合法 surname 里)
      const parts = first.split(/[;|]/).map(s => s.trim()).filter(Boolean)
      if (parts.length > 1) authors = parts
    } else if (typeof first === 'string' && (first.match(/,/g) || []).length >= 2) {
      // 3+ 个逗号 → 多半是 "Surname1, Initial1, Surname2, Initial2, ..." 之类的 smushed
      //   (Last, First) 格式正常是 1 个逗号,2+ 逗号通常说明含多作者
      const parts = first.split(/,\s*/).map(s => s.trim()).filter(Boolean)
      if (parts.length >= 4) {
        // 每 2 个 token 凑一个作者(Surname, Initial 形式)
        const grouped = []
        for (let i = 0; i < parts.length; i += 2) {
          const surname = parts[i] || ''
          const initial = parts[i + 1] || ''
          grouped.push(initial ? `${surname}, ${initial}` : surname)
        }
        if (grouped.length > 1) authors = grouped
      }
    }
  }

  const sur1 = surnameOf(authors[0]) || 'Anon.'
  if (authors.length === 1) return `${sur1} (${yr})`
  if (authors.length === 2) {
    const sur2 = surnameOf(authors[1]) || 'Anon.'
    return `${sur1} & ${sur2} (${yr})`
  }
  return `${sur1} et al. (${yr})`
}

/**
 * 批量给一组 records 构造 record_id → 短引文 + anchor id 的 map。
 * preview 页用这个 map 把 [rec_xxx] 占位换成 <a href="#ref-rec_xxx">(Smith 2024)</a>。
 *
 * @param {Array} records
 * @returns {Object<string, {short: string, anchor: string}>}
 */
export function buildInlineCitationMap(records) {
  const out = {}
  if (!Array.isArray(records)) return out
  for (const r of records) {
    if (!r?.id) continue
    out[r.id] = {
      short: inlineCitationShort(r),
      anchor: 'ref-' + r.id,
    }
  }
  return out
}

// Markdown References 章节
// ---------------------------------------------------------------------------

/**
 * 渲染 References 章节(Markdown)。
 *   - APA / GB/T 7714 / Chicago / MLA: 不编号,按第一作者 surname A-Z(空作者垫底)
 *   - IEEE: 加 [N] 编号;无引用上下文,fallback 按 (年份倒序, 作者 A-Z)
 */
export function exportReferencesSection(records, { style = 'apa' } = {}) {
  const arr = Array.isArray(records) ? records : [];
  const items = arr.map((raw) => normalizeRecord(raw));

  const isIeee = style === 'ieee';
  let sorted;
  if (isIeee) {
    sorted = items.slice().sort((a, b) => {
      const ya = Number(getYear(a) || 0);
      const yb = Number(getYear(b) || 0);
      if (ya !== yb) return yb - ya;
      const sa = (a.authors && a.authors[0] && surnameOf(a.authors[0])) || '';
      const sb = (b.authors && b.authors[0] && surnameOf(b.authors[0])) || '';
      return sa.localeCompare(sb);
    });
  } else {
    sorted = items.slice().sort((a, b) => {
      const sa = (a.authors && a.authors[0] && surnameOf(a.authors[0])) || '￿';
      const sb = (b.authors && b.authors[0] && surnameOf(b.authors[0])) || '￿';
      const cmp = sa.localeCompare(sb);
      if (cmp !== 0) return cmp;
      const ya = Number(getYear(a) || 0);
      const yb = Number(getYear(b) || 0);
      return ya - yb;
    });
  }

  const lines = ['## References', ''];
  sorted.forEach((r, i) => {
    const cite = formatCitation(r, style);
    // 2026-05-25:每条加一个不可见 anchor span 让 preview 页 [rec_xxx] 引文可以
    // 滚动定位过来。导出 Markdown 时 anchor 仍然有效(GitHub / VS Code 都识别 HTML)。
    const anchor = r && r.id ? `<span id="ref-${r.id}"></span>` : '';
    if (isIeee) {
      lines.push(`${anchor}[${i + 1}] ${cite}`);
    } else {
      lines.push(`${anchor}${cite}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
