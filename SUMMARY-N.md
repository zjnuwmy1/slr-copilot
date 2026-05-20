# SUMMARY-N — Phase 5 Agent N(全文结构化抽取)

> harness 拒 .md 写入,由汇总层代落。

## 文件清单
```
services/prompts/extraction.js
routes/projects/extraction.js
views/projects/extraction.ejs       (替换 Agent D 占位)
views/projects/extraction/review.ejs (新建)
```

## server.js 挂载
```js
import projectExtractionRouter from './routes/projects/extraction.js'
app.use('/projects', requireUser, projectExtractionRouter)  // 必须在 projectsRouter 之前
```

## 路由清单(8 个)
- `GET  /:id/extraction`                       列表(只显 screening 决定 include + has_pdf=1)
- `POST /:id/extraction/run-one/:recordId`     单条 LLM 抽取
- `POST /:id/extraction/run-batch`             后台 setImmediate 串行批跑
- `GET  /:id/extraction/progress.json`         批量进度
- `GET  /:id/extraction/:recordId/review`      审阅页(左 metadata + findings 表单 / 右 chunk 反向链接)
- `POST /:id/extraction/:recordId/verify`      标记/撤销 human_verified
- `POST /:id/extraction/:recordId/edit`        人工编辑 extracted_json
- `GET  /:id/extraction/export.json`           项目全量抽取 JSON

## AI 调用
- `runLlm`: `actionType: 'extraction'`, model `'heavy'`(sonnet-4.6), maxTokens 8192, timeoutMs 240_000
- normalize 校验 chunk_id 必须在 paper_chunks 表里;陌生 ID 置 null 并加 `unverified_chunk_id:xxx` 进 manual_check
- 无 paper_chunks 走 abstract 兜底,prompt_version 加 `+partial`,自动追加 `only_abstract_available_no_fulltext`
- normalize 空 / parse 失败 → 写 `__failed` JSON + usage_logs 存 raw_text 前 2000 字符

## 审计事件
- `extraction_ai_ran` / `extraction_ai_failed`
- `extraction_batch_started` / `extraction_batch_finished`
- `extraction_verified` / `extraction_edited` / `extraction_exported`

## 关键不变量
1. 仅 `screening_decisions.human_decision='include'` + `records.has_pdf=1` 可见可跑
2. 批量任务在进程内 Map 串行(避免 quota 爆),前端 4s 轮询
3. SQL 全参数化
4. 没动 server.js / schema / package.json

## UI 重点
- 列表:4 stats 卡 + 批量 + 进度条 + 过滤 chips
- review 页:左 = 结构化字段表单(study_type select / sample_size number / findings 动态卡片),隐藏 `extraction_json` 字段(JS 同步 state);右 = chunk 折叠列表 + "用"按钮把 chunk_id 写入选中 finding

## 后续 Phase 6 衔接
Agent O 的 synthesis 直接读 `extractions.extracted_json`,schema 已固化为 `v1.0`。

## 已知不足
- 批量 cancel UI 未挂(后端字段已留)
- review 页 chunk 列表对长论文(50+)未做按 section 折叠分组
