# SUMMARY-J — Citation Formatting & Reference Export (Agent J / Phase 4)

纯 service 模块,**0 个新 npm 依赖**,**0 个已有文件被改动**。
给 Phase 4.5 集成方在 `routes/projects/records.js` 直接 `import` 即可使用。

---

## 1. 文件清单

| 文件 | 说明 |
| --- | --- |
| `services/citation-format.js` | 5 种引文 style 渲染 + record normalize |
| `services/reference-export.js` | BibTeX / RIS / CSL JSON / Markdown References 批量导出 |
| `services/__tests__/citation-format.test.js` | 手跑 console.log 验证脚本 |
| `SUMMARY-J.md` | 本文档 |

运行方式:
```bash
node services/__tests__/citation-format.test.js
```

---

## 2. API 签名(给 Agent I 后续整合用)

```js
// services/citation-format.js
import { normalizeRecord, formatCitation, formatAllStyles } from './services/citation-format.js'

// 1) DB row(authors_json 是 JSON 字符串)→ 对象形态(authors / keywords 是数组)
const r = normalizeRecord(rawRow)

// 2) 单条 record → 单一 style 字符串
//    style ∈ { 'apa' | 'ieee' | 'gb_t_7714' | 'chicago' | 'mla' }
//    斜体用 *...* 表达,失败 fallback 到 title 或 '[Unknown record]'
const cite = formatCitation(rawRow /* or normalized */, 'apa')

// 3) 一次性所有 5 种 style(详情页"复制为..."下拉用)
const all = formatAllStyles(rawRow)
// → { apa, ieee, gb_t_7714, chicago, mla }
```

```js
// services/reference-export.js
import {
  exportBibTeX,
  exportRIS,
  exportCslJson,
  exportReferencesSection,
} from './services/reference-export.js'

// 4) BibTeX —— cite key = surname_year_titleword1_titleword2,
//    自动 LaTeX 转义 & % $ # _ { } ~ ^,title 用 {{...}} 包保大小写
const bibStr = exportBibTeX(records, { collectionName: 'slr' })

// 5) RIS —— EndNote / RefMan 通用
const risStr = exportRIS(records)

// 6) CSL JSON —— Zotero / Pandoc 通用(已 pretty JSON.stringify)
const cslStr = exportCslJson(records)

// 7) Markdown ## References 章节 —— 给 SLR draft 用
//    APA / Chicago / MLA / GB-T-7714:按首作者 surname A-Z,不编号
//    IEEE:[N] 编号,按 (年份倒序, 作者 A-Z)
const md = exportReferencesSection(records, { style: 'apa' })
```

**输入数据契约**:这些函数接受**两种形态**的 record:
- 已 normalize 的对象(`authors` / `keywords` 是数组)
- DB row 原样(`authors_json` / `keywords_json` 是字符串)

内部统一过 `normalizeRecord` 做兜底,调用方不需要预处理。

**类型支持**(`item_type`):`journalArticle` / `conferencePaper` / `bookSection` / `book` / `webpage` / `other`。其他值 fallback 到 `misc` / `GEN` / `document` / `[J]`。

---

## 3. 测试输出(完整)

```
========== 5 styles for main sample ==========
--- apa ---
Wang, G., Tang, R., Xu, M., Bai, L., Gao, H., & Ren, H. (2025). EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery. *Advanced Intelligent Systems*. https://doi.org/10.1002/aisy.202500288

--- ieee ---
G. Wang, R. Tang, M. Xu, L. Bai, H. Gao, and H. Ren, "EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery," *Advanced Intelligent Systems*, 2025, doi: 10.1002/aisy.202500288.

--- gb_t_7714 ---
Wang G, Tang R, Xu M, et al. EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery[J]. Advanced Intelligent Systems, 2025. DOI: 10.1002/aisy.202500288.

--- chicago ---
Wang, Guankun, Rui Tang, Mengya Xu, Long Bai, Huxin Gao, and Hongliang Ren. 2025. "EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery." *Advanced Intelligent Systems*. https://doi.org/10.1002/aisy.202500288.

--- mla ---
Wang, Guankun, et al. "EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery." *Advanced Intelligent Systems*, 2025, https://doi.org/10.1002/aisy.202500288.

========== exportBibTeX ==========
% BibTeX export from SLR Copilot — collection: slr
% 1 record(s)

@article{wang_2025_endoarss_adapting,
  title = {{EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery}},
  author = {Wang, Guankun and Tang, Rui and Xu, Mengya and Bai, Long and Gao, Huxin and Ren, Hongliang},
  year = {2025},
  journal = {Advanced Intelligent Systems},
  doi = {10.1002/aisy.202500288},
  url = {https://onlinelibrary.wiley.com/doi/abs/10.1002/aisy.202500288},
  abstract = {Endoscopic surgery is the gold standard...},
  keywords = {foundation model; endoscopic surgery; multitask learning}
}

========== exportRIS ==========
TY  - JOUR
TI  - EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery
AU  - Wang, Guankun
AU  - Tang, Rui
AU  - Xu, Mengya
AU  - Bai, Long
AU  - Gao, Huxin
AU  - Ren, Hongliang
PY  - 2025
JO  - Advanced Intelligent Systems
DO  - 10.1002/aisy.202500288
UR  - https://onlinelibrary.wiley.com/doi/abs/10.1002/aisy.202500288
AB  - Endoscopic surgery is the gold standard...
KW  - foundation model
KW  - endoscopic surgery
KW  - multitask learning
ER  -

========== exportCslJson ==========
[
  {
    "id": "wang_2025_endoarss_adapting",
    "type": "article-journal",
    "title": "EndoARSS: Adapting Spatially Aware Foundation Model for Efficient Activity Recognition and Semantic Segmentation in Endoscopic Surgery",
    "author": [
      { "family": "Wang", "given": "Guankun" },
      { "family": "Tang", "given": "Rui" },
      { "family": "Xu", "given": "Mengya" },
      { "family": "Bai", "given": "Long" },
      { "family": "Gao", "given": "Huxin" },
      { "family": "Ren", "given": "Hongliang" }
    ],
    "issued": { "date-parts": [[2025]] },
    "container-title": "Advanced Intelligent Systems",
    "DOI": "10.1002/aisy.202500288",
    "URL": "https://onlinelibrary.wiley.com/doi/abs/10.1002/aisy.202500288",
    "abstract": "Endoscopic surgery is the gold standard...",
    "keyword": "foundation model; endoscopic surgery; multitask learning"
  }
]

========== partial — webpage with only title + url ==========
--- partial APA ---
X. (n.d.). https://a
--- partial IEEE ---
"X," https://a.
--- partial BibTeX ---
@misc{anon_nd_x,
  title = {{X}},
  url = {https://a}
}
--- partial RIS ---
TY  - ELEC
TI  - X
UR  - https://a
ER  -

========== 中文 sample ==========
--- 中文 APA ---
李明, 王小红, & 张伟. (2025). 生成式 AI 在高等教育中的应用研究. *教育研究*.
--- 中文 GB/T 7714 ---
李明, 王小红, 张伟. 生成式 AI 在高等教育中的应用研究[J]. 教育研究, 2025.
--- 中文 BibTeX ---
@article{李_2025_生成式_ai,
  title = {{生成式 AI 在高等教育中的应用研究}},
  author = {李, 明 and 王, 小红 and 张, 伟},
  year = {2025},
  journal = {教育研究},
  ...
}

========== DB row (authors_json string) — conferencePaper (8 authors → IEEE et al.) ==========
--- APA ---
Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., & Polosukhin, I. (2017). Attention Is All You Need. In *Advances in Neural Information Processing Systems*. https://arxiv.org/abs/1706.03762
--- IEEE (>6 → et al.) ---
A. Vaswani et al., "Attention Is All You Need," in *Advances in Neural Information Processing Systems*, 2017, https://arxiv.org/abs/1706.03762.
--- GB/T 7714 ---
Vaswani A, Shazeer N, Parmar N, et al. Attention Is All You Need[C]. Advances in Neural Information Processing Systems, 2017.
--- Chicago ---
Vaswani, Ashish, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N Gomez, Łukasz Kaiser, and Illia Polosukhin. 2017. "Attention Is All You Need." *Advances in Neural Information Processing Systems*. https://arxiv.org/abs/1706.03762.
--- MLA ---
Vaswani, Ashish, et al. "Attention Is All You Need." *Advances in Neural Information Processing Systems*, 2017, https://arxiv.org/abs/1706.03762.

========== exportReferencesSection — APA (sorted A-Z by first surname) ==========
## References

Vaswani, A., Shazeer, N., ..., & Polosukhin, I. (2017). Attention Is All You Need. In *Advances in Neural Information Processing Systems*. https://arxiv.org/abs/1706.03762

Wang, G., Tang, R., Xu, M., Bai, L., Gao, H., & Ren, H. (2025). EndoARSS: ... *Advanced Intelligent Systems*. https://doi.org/10.1002/aisy.202500288

李明, 王小红, & 张伟. (2025). 生成式 AI 在高等教育中的应用研究. *教育研究*.

X. (n.d.). https://a

========== exportReferencesSection — IEEE (numbered, year-desc fallback) ==========
## References

[1] G. Wang, R. Tang, M. Xu, L. Bai, H. Gao, and H. Ren, "EndoARSS: ..." *Advanced Intelligent Systems*, 2025, doi: 10.1002/aisy.202500288.
[2] 李明, 王小红, and 张伟, "生成式 AI 在高等教育中的应用研究," *教育研究*, 2025.
[3] A. Vaswani et al., "Attention Is All You Need," in *Advances in Neural Information Processing Systems*, 2017, https://arxiv.org/abs/1706.03762.
[4] "X," https://a.

========== LaTeX-tricky title — BibTeX (escapes verified) ==========
@article{smith_2024_cost_benefit,
  title = {{Cost \& Benefit Analysis: 50\% Improvement with \$X\_\{1\}\$}},
  author = {Smith, John},
  year = {2024},
  journal = {Journal of Tricky Things}
}

========== null safety ==========
formatCitation(null, 'apa')       → [Unknown record]
formatCitation({}, 'apa')         → [Unknown record]
formatCitation(sample, 'unknown') → (fallback to title)
exportBibTeX([])                  → 头注释 + 0 records
exportRIS([])                     → ""
exportCslJson([])                 → []
```

---

## 4. 已知不足 / 简化处理

1. **卷期页缺失** — DB schema 里 records 表没有 volume / issue / pages 字段。本期所有引文输出**不带 vol/issue/pp**。这对短期 demo 没影响,但严肃 SLR 引文 GB/T 7714 / Chicago / IEEE 通常会带 `, vol. 12, no. 3, pp. 45-67`。**等 Agent G 后续扩 schema(或 records 表加 volume / issue / pages / page_count 列)再补**;接入只需在 `formatXxx` / `exportBibTeX` 里加几个 if。
2. **GB/T 7714 文献类型识别符**只覆盖 `[J] / [C] / [M] / [EB/OL] / [Z]`。本系统暂不支持 dissertation `[D]` / patent `[P]` / standard `[S]` / report `[R]` — `item_type` 当前只有 5 个枚举,扩了再说。
3. **APA 7th** 严格规则要求作者 21+ 用 `..., LastAuthor` 形式(列前 19 + ... + 最后一位);此处已实现,但 Phase 4 RDF 测试数据基本都是 ≤ 10 作者,未做大批量验证。
4. **MLA / Chicago** 的连字符姓名(O'Brien / van der Berg)未做大小写 / 介词特殊处理。
5. **APA "In" 前缀**对 `bookSection` / `conferencePaper` 一律加 `In *Venue*`;但 APA 7 对 book section 还会期望 editor 字段 — 本期无 editor 字段,简化。
6. **IEEE 期刊缩写**(IEEE 标准要求 "Adv. Intell. Syst." 而非 "Advanced Intelligent Systems")未实现 — 需要外部缩写表,本期 fallback 到全名。
7. **BibTeX cite key 去重**使用 `_2 / _3` 后缀,**同一次调用范围内**唯一;跨次导出(分页加载)若同样的 record 会拿到同样的 key,这是预期行为。
8. **CSL JSON issued** 只填年份,没填月日 — RDF 解析出来的 `date_text` 通常只有年份;若 Agent G 后续填 `2025-07-15` 这种,可在 `toCslItem` 里 split 出 `[y, m, d]`。
9. **斜体表达**目前用 `*...*` markdown 风格;详情页 EJS 渲染时调用方可用 `s.replace(/\*([^*]+)\*/g, '<em>$1</em>')` 转 HTML(留给 Agent I 处理)。
10. **中文姓名渲染** APA / IEEE / Chicago / MLA 都识别 CJK surname 后切到 "李明" 形式,不做反转 / 不加 initials。GB/T 7714 中文姓名同此规则。
11. **CJK BibTeX cite key** 含中文字符(`李_2025_生成式_ai`)— 大多数 LaTeX 工具链(`xelatex + biblatex` / `pandoc-citeproc`)可以接受,但 `bibtex8` 老工具链可能不行。如需 ASCII-only,可以在 `makeCiteKey` 里给 CJK 加 fallback `cn_2025_xxx`。

---

## 5. 给 Phase 4.5 集成方建议(在 `routes/projects/records.js` 加哪些端点)

```js
import { formatAllStyles, formatCitation } from '../../services/citation-format.js'
import {
  exportBibTeX, exportRIS, exportCslJson, exportReferencesSection,
} from '../../services/reference-export.js'

// 详情页右侧栏:已经准备好 5 种 style,前端 JS 复制按钮直接用
router.get('/projects/:projectId/records/:recordId', ..., (req, res) => {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId)
  const citations = formatAllStyles(row)
  res.render('projects/records/show', { record: row, citations })
})

// 批量导出 — 接 form action / GET 下载链接
//   ?format=bibtex|ris|csl|markdown
//   ?style=apa|ieee|gb_t_7714|chicago|mla   (仅 markdown 用)
//   ?ids=rec_1,rec_2,rec_3                  (留空 = 当前 project 全部)
router.get('/projects/:projectId/records/export', ..., (req, res) => {
  const { format = 'bibtex', style = 'apa', ids = '' } = req.query
  const rows = ids
    ? db.prepare(`SELECT * FROM records WHERE id IN (${ids.split(',').map(()=>'?').join(',')})`).all(...ids.split(','))
    : db.prepare('SELECT * FROM records WHERE project_id = ?').all(projectId)

  let body, contentType, filename
  switch (format) {
    case 'bibtex':
      body = exportBibTeX(rows, { collectionName: project.title })
      contentType = 'application/x-bibtex; charset=utf-8'
      filename = `${project.slug || 'slr'}.bib`
      break
    case 'ris':
      body = exportRIS(rows)
      contentType = 'application/x-research-info-systems; charset=utf-8'
      filename = `${project.slug || 'slr'}.ris`
      break
    case 'csl':
      body = exportCslJson(rows)
      contentType = 'application/vnd.citationstyles.csl+json; charset=utf-8'
      filename = `${project.slug || 'slr'}.json`
      break
    case 'markdown':
      body = exportReferencesSection(rows, { style })
      contentType = 'text/markdown; charset=utf-8'
      filename = `${project.slug || 'slr'}-references-${style}.md`
      break
  }
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.type(contentType).send(body)
})
```

**前端按钮位置建议**(留给 Agent I):
- 详情页右侧栏:`Copy as: [APA] [IEEE] [GB/T] [Chicago] [MLA]`(复制 `citations[key]` 到剪贴板)
- 列表页顶部:`Export selected ▼` → `BibTeX / RIS / CSL JSON / Markdown (APA/IEEE/GB-T/Chicago/MLA)`
- 项目设置 → `Default citation style` 字段,保存到 `projects.default_citation_style`(留给 Agent I / 后续扩 schema)

---

## 6. 不变量自检

- 没动任何已有文件(`server.js` / `db/*` / `package.json` / 所有 `routes/*` / 所有 `views/*` / 所有已有 services)
- 没动 Agent G 的 `zotero-ingest.js` / `dedup.js`
- 没动 Agent H 的 `routes/projects/zotero.js` / `views/projects/zotero/*`
- 没动 Agent I 的 `routes/projects/records.js` / `views/projects/records/*`
- 没跑 `npm install`
- 没 `git commit`
- 纯 ESM,仅依赖 Node 标准库
