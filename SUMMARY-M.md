# SUMMARY-M — 标题/摘要 AI 初筛(Phase 5 Agent M)

> harness 拒 .md 写入,由汇总层代落。

Phase 5 第一个 AI 功能:对每条 record 的 title + abstract + keywords 跑 haiku 4.5,给出
include / exclude / uncertain 三态建议;人工再做最终决定;最后导出 PRISMA 风格筛选 log。

## 1. 文件清单
```
services/prompts/screening.js  (新建)
routes/projects/screening.js   (新建)
views/projects/screening.ejs   (替换 Agent D 占位)
```

## 2. server.js 挂载
```js
import projectScreeningRouter from './routes/projects/screening.js'

// 必须在 projectsRouter 之前(占位 /:id/screening 会先匹配)
app.use('/projects', requireUser, projectScreeningRouter)
```

## 3. 路由清单

| Method | Path | 说明 |
|---|---|---|
| GET  | `/projects/:id/screening`                   | 列表 + 统计(query: `ai=` / `human=`),上限 500 行 |
| POST | `/projects/:id/screening/run-one/:recordId` | 同步单条 AI(~20s) |
| POST | `/projects/:id/screening/run-batch`         | 后台串行跑所有 `ai_suggestion='not_run'` |
| GET  | `/projects/:id/screening/progress.json`     | 批量进度 JSON,前端 3s 轮询 |
| POST | `/projects/:id/screening/decide/:recordId`  | 人工 include/exclude/uncertain + reason |
| GET  | `/projects/:id/screening/export.csv`        | PRISMA 筛选 log(BOM + UTF-8) |

## 4. AI 调用参数
`runLlm`: `actionType: 'screening'`, model `'light'`(haiku-4-5), maxTokens 1024, timeoutMs 60_000, expectJson true。

Prompt 强制只看 title/abstract/keywords/authors/year/journal;摘要缺失必须 uncertain;
reason 用简体中文 ≤30 字,禁"赋能/范式"八股;confidence 0..1。

normalize 容错:剥 `result/data/output/response` wrapper 两层;verdict→decision、
rationale→reason、yes/no/maybe→include/exclude/uncertain;confidence 0..100 自动 /100。

## 5. 批量任务
in-memory Map + `runningBatches: Set<projectId>` 互斥锁 + `setImmediate` 后台串行 await。
不引入 Redis/Celery。176 × ~20s ≈ 60 分钟可接受。
Node 重启 → 进度丢,但 `screening_decisions` 持久化,重启任务自动跳过已跑的。

## 6. UI
- 顶部 4 张统计卡:总数 / AI 已建议 / 人工已决 / 待决定
- 协议未审批 → 黄色提醒 + 前往按钮,不显示批量
- 批量按钮 + 进度条(运行中显)+ 当前标题滚动
- 过滤栏:AI 4 chip + 人工 4 chip,可 deselect
- 每行 inline:AI 建议 / confidence / 理由 / 命中标准 / need_full_text;
  下方 3 radio + reason + 保存(无单独详情页)
- 重复条目默认隐藏
- 人工 include 行底色绿;exclude 行底色红

## 7. CSV 13 列
```
record_id, title, year, journal, doi,
ai_suggestion, ai_confidence, ai_model, ai_reason, ai_ran_at,
human_decision, human_reason, decided_at
```

## 8. 审计事件
| event_type | 触发 |
|---|---|
| `screening_ai_ran` | 每次 AI 跑(成败都记) |
| `screening_batch_started/finished` | 批量边界 |
| `screening_decided` | 人工决定 |
| `screening_exported_csv` | 下载 CSV |

## 9. 不变量
1. 没 approved protocol → run-one/run-batch 都 flash error
2. `runLlm` 永远 resolve;批量循环逐条 try/catch,**不卡死**
3. JSON parse 失败 → uncertain + 标记
4. 进程重启丢进度,已 UI 明示;持久化数据无损
5. 重复条目不进列表 / 批量 / CSV
6. SQL 全参数化;decision / filter 走白名单

## 10. 后续 Agent 衔接点
- Agent N 抽取入口:`SELECT record_id FROM screening_decisions WHERE project_id=? AND human_decision='include' AND stage='title_abstract'`
- PRISMA flow:用 `screening_ai_ran` / `screening_decided` 事件 + statsQuery 直接 SELECT
