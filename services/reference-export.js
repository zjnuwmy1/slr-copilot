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
    if (isIeee) {
      lines.push(`[${i + 1}] ${cite}`);
    } else {
      lines.push(cite);
    }
    lines.push('');
  });

  return lines.join('\n');
}
