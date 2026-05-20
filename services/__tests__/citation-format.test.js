/**
 * services/__tests__/citation-format.test.js — Agent J (Phase 4)
 *
 * 手跑:
 *   node services/__tests__/citation-format.test.js
 *
 * 用 console.log 验证 — 不依赖任何测试框架。
 */

import { formatCitation, formatAllStyles, normalizeRecord } from '../citation-format.js';
import {
  exportBibTeX,
  exportRIS,
  exportCslJson,
  exportReferencesSection,
} from '../reference-export.js';

// ---------------------------------------------------------------------------
// 主样本:6 作者期刊文章
// ---------------------------------------------------------------------------
const sample = {
  item_type: 'journalArticle',
  title:
    'EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery',
  authors: [
    { surname: 'Wang', givenName: 'Guankun' },
    { surname: 'Tang', givenName: 'Rui' },
    { surname: 'Xu', givenName: 'Mengya' },
    { surname: 'Bai', givenName: 'Long' },
    { surname: 'Gao', givenName: 'Huxin' },
    { surname: 'Ren', givenName: 'Hongliang' },
  ],
  year: 2025,
  journal: 'Advanced Intelligent Systems',
  doi: '10.1002/aisy.202500288',
  url: 'https://onlinelibrary.wiley.com/doi/abs/10.1002/aisy.202500288',
  abstract: 'Endoscopic surgery is the gold standard...',
  keywords: ['foundation model', 'endoscopic surgery', 'multitask learning'],
};

console.log('========== 5 styles for main sample ==========');
for (const style of ['apa', 'ieee', 'gb_t_7714', 'chicago', 'mla']) {
  console.log(`--- ${style} ---`);
  console.log(formatCitation(sample, style));
  console.log();
}

console.log('========== exportBibTeX ==========');
console.log(exportBibTeX([sample]));

console.log('========== exportRIS ==========');
console.log(exportRIS([sample]));

console.log('========== exportCslJson ==========');
console.log(exportCslJson([sample]));

// ---------------------------------------------------------------------------
// 边界:缺字段
// ---------------------------------------------------------------------------
const partial = { item_type: 'webpage', title: 'X', url: 'https://a' };
console.log('========== partial — webpage with only title + url ==========');
console.log('--- partial APA ---');
console.log(formatCitation(partial, 'apa'));
console.log('--- partial IEEE ---');
console.log(formatCitation(partial, 'ieee'));
console.log('--- partial BibTeX ---');
console.log(exportBibTeX([partial]));
console.log('--- partial RIS ---');
console.log(exportRIS([partial]));

// ---------------------------------------------------------------------------
// 中文
// ---------------------------------------------------------------------------
const cn = {
  ...sample,
  title: '生成式 AI 在高等教育中的应用研究',
  journal: '教育研究',
  authors: [
    { surname: '李', givenName: '明' },
    { surname: '王', givenName: '小红' },
    { surname: '张', givenName: '伟' },
  ],
  doi: null,
  url: null,
};
console.log('========== 中文 sample ==========');
console.log('--- 中文 APA ---');
console.log(formatCitation(cn, 'apa'));
console.log('--- 中文 GB/T 7714 ---');
console.log(formatCitation(cn, 'gb_t_7714'));
console.log('--- 中文 BibTeX ---');
console.log(exportBibTeX([cn]));

// ---------------------------------------------------------------------------
// DB row 形态(authors_json 是字符串)
// ---------------------------------------------------------------------------
const dbRow = {
  id: 'rec_xxx',
  item_type: 'conferencePaper',
  title: 'Attention Is All You Need',
  authors_json: JSON.stringify([
    { surname: 'Vaswani', givenName: 'Ashish' },
    { surname: 'Shazeer', givenName: 'Noam' },
    { surname: 'Parmar', givenName: 'Niki' },
    { surname: 'Uszkoreit', givenName: 'Jakob' },
    { surname: 'Jones', givenName: 'Llion' },
    { surname: 'Gomez', givenName: 'Aidan N' },
    { surname: 'Kaiser', givenName: 'Łukasz' },
    { surname: 'Polosukhin', givenName: 'Illia' },
  ]),
  year: 2017,
  journal: 'Advances in Neural Information Processing Systems',
  doi: null,
  url: 'https://arxiv.org/abs/1706.03762',
  keywords_json: JSON.stringify(['transformer', 'attention']),
};
console.log('========== DB row (authors_json string) — conferencePaper ==========');
console.log('--- normalizeRecord ---');
const normed = normalizeRecord(dbRow);
console.log('authors count:', normed.authors.length, 'first:', normed.authors[0]);
console.log('keywords:', normed.keywords);
console.log('--- APA ---');
console.log(formatCitation(dbRow, 'apa'));
console.log('--- IEEE ---');
console.log(formatCitation(dbRow, 'ieee'));
console.log('--- GB/T 7714 ---');
console.log(formatCitation(dbRow, 'gb_t_7714'));
console.log('--- Chicago ---');
console.log(formatCitation(dbRow, 'chicago'));
console.log('--- MLA ---');
console.log(formatCitation(dbRow, 'mla'));

// ---------------------------------------------------------------------------
// formatAllStyles
// ---------------------------------------------------------------------------
console.log('========== formatAllStyles ==========');
console.log(JSON.stringify(formatAllStyles(sample), null, 2));

// ---------------------------------------------------------------------------
// References section
// ---------------------------------------------------------------------------
console.log('========== exportReferencesSection — APA ==========');
console.log(exportReferencesSection([sample, dbRow, cn, partial], { style: 'apa' }));

console.log('========== exportReferencesSection — IEEE (numbered) ==========');
console.log(exportReferencesSection([sample, dbRow, cn, partial], { style: 'ieee' }));

// ---------------------------------------------------------------------------
// LaTeX 转义 — title 里带 & % $ 等
// ---------------------------------------------------------------------------
const tricky = {
  item_type: 'journalArticle',
  title: 'Cost & Benefit Analysis: 50% Improvement with $X_{1}$',
  authors: [{ surname: 'Smith', givenName: 'John' }],
  year: 2024,
  journal: 'Journal of Tricky Things',
};
console.log('========== LaTeX-tricky title — BibTeX ==========');
console.log(exportBibTeX([tricky]));

// ---------------------------------------------------------------------------
// 错误吞掉:传 null / 空
// ---------------------------------------------------------------------------
console.log('========== null safety ==========');
console.log('--- formatCitation(null, "apa") ---');
console.log(formatCitation(null, 'apa'));
console.log('--- formatCitation({}, "apa") ---');
console.log(formatCitation({}, 'apa'));
console.log('--- formatCitation(sample, "unknown") ---');
console.log(formatCitation(sample, 'unknown'));
console.log('--- exportBibTeX([]) ---');
console.log(JSON.stringify(exportBibTeX([])));
console.log('--- exportRIS([]) ---');
console.log(JSON.stringify(exportRIS([])));
console.log('--- exportCslJson([]) ---');
console.log(exportCslJson([]));

console.log('\n========== DONE ==========');
