# SUMMARY-S — Admin 配置每一步 LLM 模型的 UI

> harness 拒 .md 写入,由汇总层代落。

## 文件清单

**新建**:
- `routes/admin/settings.js`
- `views/admin/settings.ejs`

**修改**:
- `views/admin/dashboard.ejs`(加 1 张"步骤模型配置"卡)

## server.js 接入

```js
import adminSettingsRouter from './routes/admin/settings.js'
app.use('/admin/settings', requireAdmin, adminSettingsRouter)  // 在 /admin 之前
```

挂在 `/admin/usage` / `/admin/audit` / `/admin/projects` 之后、`/admin` 之前。

## 路由表

| Method | Path | 行为 |
|---|---|---|
| GET  | `/admin/settings`       | 渲染 6 step 配置表 |
| POST | `/admin/settings`       | 白名单校验 + 事务批量写 + 审计 `admin_settings_updated`(payload `{changes:[{key, old_value, new_value}]}`) |
| POST | `/admin/settings/reset` | 清空所有 `step_model.*` + 审计 `admin_settings_reset` |

## UI 设计
- 顶部"已配置 N / 6"卡
- 表格 6 行,每行:step label + description + `<select>` 含 `<optgroup>` 分组:
  - 空(用默认)
  - alias(heavy / standard / light)
  - Anthropic 模型
  - OpenAI 模型
- 底部"保存所有"+ 红色"重置全部"(confirm)

## 校验
- key 必须 ∈ `STEP_KEYS`
- value ∈ { 空 / alias / `AVAILABLE_MODELS.*.id` }
- 任一不合法 → flash error,不写库不审计
- `requireAdmin` 守护

## 测试 checklist
1. `/admin` 看到"步骤模型配置"卡
2. `/admin/settings` 显示 6 step,初始全空
3. screening→claude-haiku-4-5 + extraction→claude-opus-4 保存 → audit 含 2 changes
4. 刷新值持久化,头部"已配置 2 / 6"
5. 重置全部 → 全空 + audit `admin_settings_reset`
6. POST 非白名单 → flash error
7. 非 admin → 403
