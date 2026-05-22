# SUMMARY-W — Phase 9 · Step 8 期刊模板 + 插图

> harness 拒 .md 写入,由汇总层代落。

## 文件清单

**新建**:
- `services/journal-template.js` — `parsePdfFile()` + `extractJournalTemplate()`(LLM 抽 JSON → upsert)+ `buildSectionStyleHint()` 注入器
- `services/figures.js` — 程序生图(年度趋势 SVG / evidence map SVG / PRISMA 转发)+ 3 类 AI 提示词(注入项目 topic + theme 名)
- `routes/projects/journal-template.js` — GET 页 / POST upload(multer 30MB)/ POST clear
- `views/projects/journal-template.ejs` — 上传表单 + 已上传后的结构 metadata 表

**修改**:
- `services/prompts/drafting.js` — 加 `augmentSystemWithTemplate(system, styleHint)`,无模板时透传(零回归)
- `routes/projects/report.js` — generate-section/all 在 runLlm 前注入风格 hint;GET 塞插图数据;audit payload 加 `with_journal_template`
- `views/projects/report.ejs` — 顶部加期刊模板卡(链 /journal-template);底部加"插图"区(2 SVG + 3 AI prompt + 复制按钮)

## server.js 接入
```js
import projectJournalTemplateRouter from './routes/projects/journal-template.js'
// 加在 projectsRouter 之前:
app.use('/projects', requireUser, projectJournalTemplateRouter)
```

## 审计事件
- `journal_template_uploaded` / `journal_template_extracted` / `journal_template_extract_failed`
- `journal_template_cleared`
- `figure_prompts_viewed`(每次打开 /report 页)
- `report_section_generated` payload 加 `with_journal_template: bool`

## 不变量
- 路径 safety:`isInsideDataDir()` 双层校验,multer destination + 上传后 + clear 时
- 文件名清洗:`<ts>__<safebase>.pdf`,过滤路径遍历
- PDF parse 失败 / LLM 失败 / sections 空 → flash 错误 + DB 不写;PDF 文件保留可重传
- 没模板 → `buildSectionStyleHint()` 返空 → `augmentSystemWithTemplate()` 透传 → 旧行为不变
- 不动 server.js / schema / package.json / 其他 phase routes / partials

## 关于"用 codex 生成图"(用户问题)

**Codex CLI 是文本模型**(GPT-5.x / Claude Sonnet 系列),**直接画图做不到**。所有 provider 都是 text completion。真正的图像生成要单独走 OpenAI DALL-E / `gpt-image-1` endpoint,跟 codex CLI 是两套 API 两份配额。

**本次取舍**:
- **"程序能算的图"**(PRISMA flow / 年度趋势 / evidence map)平台用 SQL + 手写 SVG / Mermaid 直接出图,不调 LLM,导出 Markdown 时也直接嵌入
- **"程序算不出的图"**(概念框架 / 主题关系 / 美化漏斗)只生成 prompt(自动注入项目实际 topic + theme 名 + PRISMA 数字),UI 加蓝色 callout 明确告诉用户**复制到 ChatGPT 网页版**(自带 DALL-E)或 Midjourney 自己出图,绝不让用户误以为点按钮就出图

未来若接 DALL-E API,只需在 `figures.js` 加一个 `generateImageViaOpenAI(prompt)` 即可,prompts 已经按图像模型的格式写好。

## 验证
- 所有 JS 文件 `node --check` 通过
- 两个 EJS `ejs.compile` 通过
