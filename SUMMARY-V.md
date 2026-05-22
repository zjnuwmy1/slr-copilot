# SUMMARY-V — Phase 9 · Step 4 文献矩阵(Excel 模板 + 在线填 + 复制 prompt)

> harness 拒 .md 写入,由汇总层代落。

## 文件清单
- `services/literature-matrix.js`(新建)— 13 个默认列 + 全部辅助函数
- `routes/projects/matrix.js`(新建)— 6 个路由,multer memoryStorage 10MB
- `views/projects/matrix.ejs`(新建)— 网格 + inline 编辑 + 📋 prompt 弹层 + 加列表单
- `views/projects/extraction.ejs`(仅加 5 行链接卡 — 入口)

## server.js 接入
```js
import projectMatrixRouter from './routes/projects/matrix.js'
// 加在 projectExtractionRouter 之后,projectsRouter 之前:
app.use('/projects', requireUser, projectMatrixRouter)
```

## 6 个路由
| Method | Path | 功能 |
|---|---|---|
| GET  | `/:id/matrix`                       | 网格视图 + inline 编辑 |
| GET  | `/:id/matrix/template.xlsx`         | 下载 XLSX 模板(含 metadata + 现有 fields) |
| POST | `/:id/matrix/upload-xlsx`           | 上传填好的 XLSX(multer 10MB)→ 回灌 upsert |
| POST | `/:id/matrix/:recordId/save`        | inline 单条单字段保存(浅合并 fields JSON) |
| POST | `/:id/matrix/columns/add`           | 加自定义列(key 强制 `[a-z0-9_]`) |
| POST | `/:id/matrix/columns/:colId/delete` | 删自定义列(默认列 is_default=1 拒删) |

## 13 个默认列
study_design / population / country_region / sample_size_total / sample_size_per_group / recruitment / intervention / comparator / outcomes / measurement_tools / key_findings / quantitative_results / limitations。每列带 `ai_prompt_template`(100-200 字中文,带 `{{title}}` `{{abstract}}` `{{doi}}` 占位符),用户复制后用自己的 AI 整理。

## 关键设计
- **懒 seed**:首访 `/matrix` 时 `INSERT OR IGNORE` 13 列,避免动 projects 创建流程
- **inline 保存**:blur → fetch `/save` 浅合并,emerald/blue/rose ring 视觉反馈,实时更新完成度进度条
- **prompt 弹层**:`navigator.clipboard.writeText` + 选中文本 fallback;prompt 文本藏在 `<template>` 里
- **XLSX**:模板含 metadata + 现有 fields;导入时第二行 label 跳过、按 record_id 回填,非纳入 record 整行 skip
- **安全**:fields 值 `slice(0, 2000)`、自定义列 key 强制正则、删默认列拒绝、record 归属与纳入双校验

## stepper / extraction 关系
- stepper 第 4 步保持指向 `/extraction`(N 的页面)
- extraction.ejs 顶部加 5 行"→ 改用文献矩阵"链接卡,作为入口
- 之后由汇总层决定是否切默认

## 测试(in-memory SQLite e2e,全 ✅)
- seed 幂等
- upsert 浅合并
- 加 + 删自定义列
- 默认列拒删
- completeness 3/13=0.231
- buildXlsx 19KB
- importXlsx 回环 processed:2
- EJS + JS syntax check 过

## 不变量
- 0 npm install / 0 git commit
- 不动 server.js / schema / package.json / partials / Agent N 核心逻辑
- extraction.ejs 仅 5 行链接卡
