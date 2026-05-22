# SUMMARY-T — Step 2 检索式增强:用户回填命中数 → AI 推荐最佳组合

> harness 拒 .md 写入,由汇总层代落。

## 文件清单
- `services/prompts/search-recommend.js`(新建)
- `routes/projects/search.js`(扩展:import + GET 里 pop session + 新增 POST `/:id/search/recommend-best`)
- `views/projects/search.ejs`(末尾加 AI 推荐 UI 块)

## 关键点
- `normalizeRecommendOutput(raw, validIds)` 强校验 `primary_choice.strategy_id` 必须在合法集合里;secondary 最多 3 条,排除 primary 自身;workload 兼容数字/字符串(从字符串抽数字)
- POST 路由门槛 `logged.length >= 3`,不满足直接 flash error
- `runLlm`: `model:'standard'`, `maxTokens:1024`, `timeoutMs:60_000`, `actionType:'search_recommend'`
- 推荐结果存 `req.session.searchRecommendation = { projectId, version, data, durationMs, model }`,GET `/search` 渲染时按 projectId 匹配 pop 后 `delete`,刷新即丢失(纯 ephemeral,不入新表)
- audit 三事件:`search_recommend_requested` / `search_recommended` / `search_recommend_failed`(LLM 失败 + normalize 失败都走后者)
- 验证:`node` 导入两个模块均 OK;EJS 编译 OK;normalize 4 个用例(bad id 拒绝、happy path、字符串 workload 抽数字、prompt 含 id+命中数)全过

## 测试 checklist
1. 已填 < 3 条 → GET `/search` 按钮 `disabled` + title 提示;直接 POST 返 flash error "至少需要 3 条"
2. 填到 5 条 → 按钮可点 → POST 后 redirect 回 `/search`,底部出现"AI 推荐主检索"区:主选卡 + 兜底 0-2 条 + 预估工作量 + warnings;audit 多两条 `search_recommend_requested` / `search_recommended`;刷新推荐消失(session 清)
3. LLM 返回 `primary_choice.strategy_id` 不在候选 → normalize 拒绝,audit `search_recommend_failed`(status: `normalize_failed`),flash error 显示
4. SQL 验证:`SELECT event_type, payload FROM audit_events WHERE event_type LIKE 'search_recommend%' ORDER BY id DESC LIMIT 5`

## 不变量
- 不 commit / 不 npm install / 不动 schema
- 不动其他 routes / partials / server.js / 其他 prompts
- 推荐结果纯 ephemeral
