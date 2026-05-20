# SUMMARY-Q — 凭证共享(facade + 端点对齐)

> harness 拒 .md 写入,由汇总层代落。

## 背景
进入任务时,绝大多数底层在前面阶段已经落地:
- `credential_shares` 表
- share/unshare SQL
- UI 共享 section(detail.ejs + list.ejs)
- `pickCredential` 走 owner → shared 回落
- `getDecryptedForUsage` 双视角解密
- audit `credential_shared` / `credential_unshared`

无须重写,只把规格 API 表面对齐 + 补缺。

## 文件清单

**新建**:
- `services/credential-sharing.js` — facade,暴露规格命名 API,透传到既有底层 + 多加 ownership 断言

**编辑**:
- `routes/account/credentials.js` — 新增 `GET /shared-with-me.json`(JSON 端点),放 `/:id` 路由之前避免被截胡,import facade

**未动**(因已实现):
- `services/credentials.js`、`services/llm.js`
- `views/account/credentials/{list,detail}.ejs`
- `POST /:id/share`、`POST /:id/unshare/:targetUserId` 路由

## facade API

```js
shareCredential(db, { credentialId, ownerUserId, targetUserEmail, notes })
  → { ok, error?, target_user_id? }
unshareCredential(db, { credentialId, ownerUserId, targetUserId })
  → { ok, error? }
listSharesOfCredential(db, { credentialId, ownerUserId })  // ownership 断言
  → [{ target_user_id, target_email, shared_at, notes }]
listCredentialsSharedToUser(db, userId)
  → [{ credential_id, owner_user_id, owner_email, provider, auth_type, label, status, shared_at }]
listAllUsableCredentialsFor(db, userId)
  → [{ credential_id, owner_user_id, is_own: true|false, provider, auth_type, ... }]
canUserUseCredential(db, { userId, credentialId })  // 辅助
  → boolean
```

## 安全保证

- share 校验 `WHERE id=? AND user_id=ownerUserId` + 拒 self + 拒 inactive + 拒非 active 凭证
- unshare 同样 WHERE owner
- `getDecryptedForUsage` 只放行 owner 或被共享
- `usage_logs.user_id` = 调用者,`credential_id` = 被用凭证(可能跨用户)

## 测试 checklist
1. owner 共享后详情页表格出现该用户 + audit `credential_shared`
2. 被共享方 `/account/credentials` 下方"共享给我"section 显示
3. 被共享方没自绑凭证时 LLM 跑通,`usage_logs.credential_id`=owner cred、`user_id`=被共享方
4. 被共享方再绑自己凭证后,`pickCredential` 选 owner-first(自己的),`is_own:true` 在前
5. owner unshare 后 `credential_shares` 行删除 + audit `credential_unshared`
6. 越权:非 owner 调 `POST /:cred/share` → `credential_not_found_or_not_owner` flash error
7. share-self / share-inactive / share-unknown email 都有明确 flash 错误

## 不变量
- 0 npm install / 0 schema 改动
- 未改 server.js / package.json / partials / Agent P 范围
- 0 git commit
- `node --check` 双文件均通过
