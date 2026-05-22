// services/prompts/_taxonomy.js
// ============================================================
// 文献类型 / 语言的同义词归一化。
//
// 用途:协议里写的是 PubMed/MEDLINE 风格("Journal Article"),
//      但 LLM 给 WoS/Scopus 检索式时可能用 "Article" / "ar" / "research article",
//      这些**语义等价**,不应被当作"协议外类型"剔除。
//
// canonical key 选 lowercase 单数形式(article / review / conference paper / ...)。
// reverse map:任意同义词 → canonical。
// 比较方式:`canonicalDocType(a) === canonicalDocType(b)`,而不是字面比较。
//
// 找不到映射的字符串 fallback 到原值(避免误判用户自定义的小众类型)。
// ============================================================

const DOC_TYPE_SYNONYMS = {
  article: [
    'article',
    'journal article',
    'research article',
    'original article',
    'original research',
    'empirical article',
    'empirical study',
    'primary research',
    'ar',                  // Scopus 短代码
    '论文', '期刊论文', '学术论文', '研究论文',
  ],
  review: [
    'review',
    'review article',
    'systematic review',
    'literature review',
    'meta-analysis',
    'meta analysis',
    'narrative review',
    'scoping review',
    're',
    '综述', '系统综述', '文献综述',
  ],
  'conference paper': [
    'conference paper',
    'proceedings paper',
    'conference proceedings',
    'meeting abstract',
    'conference abstract',
    'meeting paper',
    'cp', 'cr',
    '会议论文', '会议摘要', '会议文章',
  ],
  editorial: [
    'editorial',
    'editorial material',
    'opinion',
    'opinion piece',
    'ed',
    '社论', '编者按',
  ],
  letter: [
    'letter',
    'letter to the editor',
    'comment',
    'correspondence',
    'le',
    '通讯', '评论', '读者来信',
  ],
  note: [
    'note',
    'brief note',
    'research note',
    'no',
    '简讯',
  ],
  'short survey': [
    'short survey',
    'sh',
  ],
  'book chapter': [
    'book chapter',
    'chapter',
    'ch',
    '书章节', '专著章节',
  ],
  book: [
    'book',
    'monograph',
    'bk',
    '专著', '书',
  ],
  erratum: [
    'erratum',
    'correction',
    'corrigendum',
    'er',
    '勘误',
  ],
  preprint: [
    'preprint',
    'pre-print',
    '预印本',
  ],
  thesis: [
    'thesis',
    'dissertation',
    'doctoral thesis',
    'master thesis',
    '学位论文', '博士论文', '硕士论文',
  ],
  'data paper': [
    'data paper',
    'dataset',
    'data article',
    'dp',
  ],
}

const LANG_SYNONYMS = {
  english: ['english', 'en', 'eng', 'en-us', 'en-gb', '英语', '英文'],
  chinese: ['chinese', 'zh', 'zh-cn', 'zh-tw', 'zho', 'mandarin', '中文', '汉语', '中文(简体)', '中文(繁体)', '简体中文', '繁体中文'],
  japanese: ['japanese', 'ja', 'jpn', '日语', '日文'],
  korean: ['korean', 'ko', 'kor', '韩语', '韩文'],
  german: ['german', 'de', 'deu', 'ger', '德语', '德文'],
  french: ['french', 'fr', 'fra', 'fre', '法语', '法文'],
  spanish: ['spanish', 'es', 'spa', '西班牙语'],
  russian: ['russian', 'ru', 'rus', '俄语', '俄文'],
  portuguese: ['portuguese', 'pt', 'por', '葡萄牙语'],
  italian: ['italian', 'it', 'ita', '意大利语'],
  dutch: ['dutch', 'nl', 'nld', '荷兰语'],
  arabic: ['arabic', 'ar', 'ara', '阿拉伯语'],
}

function buildReverseMap(synonymsTable) {
  const m = new Map()
  for (const [canonical, syns] of Object.entries(synonymsTable)) {
    m.set(canonical.toLowerCase().trim(), canonical)
    for (const syn of syns) {
      m.set(String(syn).toLowerCase().trim(), canonical)
    }
  }
  return m
}

const DOC_TYPE_REVERSE = buildReverseMap(DOC_TYPE_SYNONYMS)
const LANG_REVERSE = buildReverseMap(LANG_SYNONYMS)

/**
 * 把任意 doc-type 字符串归一化到 canonical key。
 * 找不到时 fallback 到 trim+lowercase 原值,避免误删用户自定义的小众类型。
 */
export function canonicalDocType(input) {
  if (input == null) return null
  const s = String(input).toLowerCase().trim()
  if (!s) return null
  return DOC_TYPE_REVERSE.get(s) || s
}

/**
 * 把任意 language 字符串归一化到 canonical key。
 */
export function canonicalLanguage(input) {
  if (input == null) return null
  const s = String(input).toLowerCase().trim()
  if (!s) return null
  return LANG_REVERSE.get(s) || s
}

/**
 * 给定一个候选数组(AI 输出)和允许数组(协议),返回:
 *   { kept: [...], removed: [...] }
 * kept:能映射到允许集合的(以候选**原字符串**形式保留,不改回协议字面值)
 * removed:协议外的(原字符串形式),供 warning 展示。
 */
export function partitionByCanonical(candidates, allowed, canonFn) {
  const allowedCanon = new Set()
  for (const a of (allowed || [])) {
    const c = canonFn(a)
    if (c) allowedCanon.add(c)
  }
  const kept = []
  const removed = []
  for (const cand of (candidates || [])) {
    const c = canonFn(cand)
    if (c && allowedCanon.has(c)) kept.push(cand)
    else removed.push(cand)
  }
  return { kept, removed }
}
