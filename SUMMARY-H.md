# SUMMARY-H — Phase 4 Agent H · Zotero 上传 + ingest 触发(UI / 路由层)

## 范围

实现学员侧"上传 Zotero RDF 包 → 触发 ingest → 看 manifest"的 UI 与路由,以及管理员从服务器
staging 目录一键导入的快捷入口。**实际解析逻辑由 Agent G 的 `services/zotero-ingest.js`
完成**;本路由仅负责落盘 / 写表 / 触发 / 状态轮询,不做 RDF 解析。

## 1. 文件清单

新增(全部受任务约束允许):

| 路径 | 说明 |
|---|---|
| `routes/projects/zotero.js` | Express Router(`mergeParams: true`)。所有 6 个路由。 |
| `views/projects/zotero.ejs` | 入口页:已有包列表 + 上传 dropzone + admin staging 折叠区。 |
| `views/projects/zotero/manifest.ejs` | 单个包的状态 / manifest 详情,客户端 2s 轮询 `state.json`。 |
| `SUMMARY-H.md` | 本文档。 |

未动:
- `server.js`(由本 SUMMARY 指引你手动加 import + mount)
- `db/schema.sql` / `db/index.js` / `package.json` / `package-lock.json`
- 任何已有 services(包括 `services/zotero-ingest.js`,如果 G 已经写好,我只 `await import()` 它)
- 任何 partials(`views/partials/*` / `views/projects/partials/*`)
- 其他 phase 的 routes 与 views

注:`views/projects/screening.ejs` 我**没有改**。Step 3 的入口现在走 `/projects/:id/zotero`,
来自 stepper.ejs 的"筛选"链接仍然是 `/screening`(旧占位页)。汇总层只要不改 stepper 即可让两者共存。
如果后续要让"筛选"按钮直接跳到 `/zotero`,在 stepper.ejs 改 `href` 即可(那是 partial,需要 D 同意)。

## 2. 加到 `server.js` 的代码

在 import 区(其他 project 子路由附近):

```js
import projectZoteroRouter from './routes/projects/zotero.js'
```

在路由挂载区(具体到通用的顺序;放在 `projectPrismaRouter` 旁边即可):

```js
// Agent H:Zotero RDF 包上传 + ingest 触发(/projects/:id/zotero/*)
app.use('/projects/:id/zotero', requireUser, projectZoteroRouter)
```

挂载顺序:本路由用 `mergeParams: true`,挂在 `/projects/:id/zotero` 前缀下;放在
`projectSearchRouter` / `projectsRouter` 之前(更具体优先,跟 prisma 同样的考虑)。
推荐位置:

```js
app.use('/projects/:id/prisma',  requireUser, projectPrismaRouter)
app.use('/projects/:id/zotero',  requireUser, projectZoteroRouter)   // ← 新增此行
app.use('/projects',             requireUser, projectSearchRouter)
app.use('/projects',             requireUser, projectsRouter)
```

## 3. 路由表

挂载在 `/projects/:id/zotero`。全局 `requireUser`;`/admin-staging` 两条路由在 handler 内部
再 `req.user.role === 'admin'` 校验。所有访问都先 `ownProjectOr404`,跟现有 routes 一致。

| Method | Path | 说明 |
|---|---|---|
| GET  | `/` | 入口页。列出该 project 下的所有 `zotero_packages`,展示上传 dropzone。admin 还会拿到 staging 目录列表。 |
| POST | `/upload` | `multipart/form-data` 上传(字段名 `package_file`)。multer 落盘到 `<UPLOAD_ROOT>/<package_id>/upload.zip`,adm-zip 解压到 `extracted/`。插一行 `zotero_packages`(status `'uploaded'`,source_kind `'web_upload'`)。`setImmediate` 后台 `await ingestPackage(...)`。重定向到 `/:packageId`。 |
| GET  | `/admin-staging` | (admin)JSON:列出 staging 子目录,每条带 dirname / rdf_filename / file_count / size_bytes。 |
| POST | `/admin-staging` | (admin)body `staging_dirname=...` → 校验目录在 STAGING_DIR 内 + 含 .rdf → 插一行 `zotero_packages`(source_kind `'admin_staging'`,storage_path 直接是 staging 子目录绝对路径,不复制)→ 触发 ingest → 重定向。 |
| GET  | `/:packageId` | manifest 页(html)。前端 2s 一次 fetch `state.json` 滚动状态。 |
| GET  | `/:packageId/state.json` | 状态 JSON:`{ id, status, total_records, total_with_pdf, total_with_doi, total_duplicates, error_message, parsed_at, ingested_at }`。 |

## 4. multer 配置摘要

```js
const UPLOAD_ROOT = path.resolve(process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads')
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const packageId = req._packageId || (req._packageId = randomId('pkg'))
      const dir = path.join(UPLOAD_ROOT, packageId)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, ext === '.rdf' ? 'upload.rdf' : 'upload.zip')
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase()
    if (name.endsWith('.zip') || name.endsWith('.rdf')) return cb(null, true)
    cb(new Error('只接受 .zip 或 .rdf 文件'))
  },
})
```

要点:
- `package_id` 在 multer destination 里就分配,挂在 `req._packageId`,这样上传完后 handler 取它直接知道目录。
- `.zip` 走 adm-zip 解压到 `<root>/<package_id>/extracted/`;`.rdf` 直接重命名到同位置。
- 上传成功才插 `zotero_packages`;ZIP 解压失败也插一行(status='failed'),便于 UI 排查。
- 上传**前**就 `ownProjectOr404`,防止任意人往 UPLOAD_ROOT 写。

环境变量:`SLR_UPLOAD_ROOT`(可选,默认 `/var/lib/slr/uploads`)。dev 环境若无 `/var/lib/...`
权限,设 `SLR_UPLOAD_ROOT=/tmp/slr-uploads` 即可。

## 5. UI 描述(文字版"截图")

### `/projects/:id/zotero`(入口页)

```
[← 项目列表]
=== 项目标题 ===                              [状态徽章]

┌──────── stepper ───────┐  ┌────────── 主区 ────────────────────────┐
│ PRISMA 12/42 ·  29%   │  │ ▌Step 3 of 8 · 3. 筛选 — Zotero 数据准备  │
│ 1 协议       已完成    │  │                                          │
│ 2 检索式     已完成    │  │ [若已有包] 已导入的包 (2)                │
│ 3 筛选 ← 蓝色边        │  │   pkg_abc · lib.zip · [已入库]            │
│ 4 抽取                 │  │   • 199 条 · 27 含 PDF · 3 重复 · 200MB  │
│ 5 偏倚风险             │  │   [查看详情] →                            │
│ 6 综合                 │  │                                          │
│ 7 证据强度             │  │ ┌── 上传 Zotero RDF 包 ────────────────┐ │
│ 8 报告                 │  │ │   [大 dropzone,虚线边,云上传图标]   │ │
└────────────────────────┘  │ │   "拖入 .zip(Zotero RDF with files   │ │
                            │ │    and notes 导出)"                  │ │
                            │ │   或 点击此处选择文件                 │ │
                            │ │                                       │ │
                            │ │   [▼ 怎样从 Zotero 导出 RDF 包?]    │ │
                            │ │   [开始上传] (置灰直到选了文件)     │ │
                            │ │                                       │ │
                            │ │   [进度条 0% — 上传时显示]            │ │
                            │ └───────────────────────────────────────┘ │
                            │                                          │
                            │ [若 admin] ▼ [管理员快捷] 从服务器       │
                            │   staging 目录导入                       │
                            │ ┌──────────────────────────────────────┐ │
                            │ │ rfm-20260520-164350                  │ │
                            │ │  RDF: robotic foundation models.rdf  │ │
                            │ │  29 个文件 · 199 MB     [导入]      │ │
                            │ └──────────────────────────────────────┘ │
                            └──────────────────────────────────────────┘
```

### `/projects/:id/zotero/:packageId`(manifest 页)

```
Zotero 导入 / pkg_abc
=== lib.zip ===                              [staging] · RDF: lib.rdf

┌─ 当前状态 ───────────────────────── 包大小 ────┐
│ ⟳ 解析 RDF 中…                       200 MB    │
│                                                 │
│ ① 上传完成 ── ② 解析 RDF(蓝)── ③ ── ④      │
│  (绿)            ↑ 蓝高亮                      │
└─────────────────────────────────────────────────┘

[失败时显示:错误信息红色框]

┌─ Manifest 摘要 (status=parsed/ingested 后才显示) ─┐
│  [199 总记录]  [27 含 PDF]  [180 含 DOI]  [3 重复] │
│                                                    │
│  按文献类型分布:                                  │
│   journalArticle:142   conferencePaper:48          │
│   bookSection:7        webpage:2                   │
│                                                    │
│  [返回上传页]    [进入 records 列表 →]            │
└────────────────────────────────────────────────────┘
```

页面 2 秒轮询 `state.json`,根据 `status` 渲染:
- `uploaded` → spinner + 阶段①蓝
- `parsing` → spinner + 阶段②蓝
- `parsed` → 阶段③蓝,显示 manifest
- `ingested` → 阶段④绿,显示 "进入 records 列表 →" CTA
- `failed` → 红色错误框,所有阶段灰色

## 6. 测试 checklist(即使 Agent G 还没合)

### 基本可用性
- [x] `node --check routes/projects/zotero.js` 通过
- [x] 两个 EJS 模板 `ejs.compile()` 通过
- [x] 两个模板 `ejs.renderFile()` 用 mock locals 通过

### 手动测试(Agent G 没合时)

加 mount 后启动 `npm start`,以管理员身份登录,创建一个项目,然后:

1. **入口页** `GET /projects/<id>/zotero`
   - 期望:渲染 stepper + 上传 dropzone + (admin) staging 折叠区
   - 没包时:dropzone 显眼,staging 区默认展开

2. **上传一个 zip**
   - 拖入或选一个 `*.zip`(任意 Zotero RDF 导出的 zip),点"开始上传"
   - XHR 进度条工作,完成后重定向到 manifest 页
   - 在 manifest 页可以看到 "解析 RDF 中…",阶段进度条点亮到 ②
   - 因为 G 还没合,2-3 秒后 status 会被 catch 块写成 `'failed'`,error_message 是
     "zotero-ingest service not available yet: Cannot find module ..."
   - 这是预期 — 证明你的路由把任务正确地交给了 G,并且失败时正确入库 status='failed'

3. **检查盘上文件**:`<UPLOAD_ROOT>/<package_id>/upload.zip` + `<UPLOAD_ROOT>/<package_id>/extracted/<rdf>` 都在

4. **admin staging**(需要 admin):
   - 先 `mkdir -p $SLR_UPLOAD_ROOT/staging/test1 && cp some.rdf $SLR_UPLOAD_ROOT/staging/test1/`
   - 刷新入口页,折叠区里能看到 `test1`,显示 RDF 文件名 + 文件数 + 大小
   - 点"导入" → 重定向到 manifest 页,storage_path 是 staging 原目录,**没有复制**

5. **路径越权**(确认安全)
   - 试 `POST /admin-staging` body `staging_dirname=../../etc` 应该被拒(`非法目录名` 或 `目录越权`)

6. **state.json**:`GET /:packageId/state.json` 返回 200 + JSON

### Agent G 合并后

替换 `services/zotero-ingest.js` 占位 → 实际服务后:
- [ ] 重新上传同一个 zip,manifest 页应该在 1-3 分钟内推进到 ④ 绿色
- [ ] 计数:total_records / with_pdf / with_doi / duplicates 都显示出来
- [ ] CTA "进入 records 列表" 跳到 `/projects/<id>/records`(Agent I 范围)

## 安全要点

- 所有读写都先 `ownProjectOr404(db, projectId, userId)`,且 SQL 全部带 `project_id = ? AND user_id = ?`
- `/admin-staging` 双重校验:`req.user.role === 'admin'` + path 必须在 `STAGING_DIR` 内(`isInside()`),并拒绝包含 `/`、`\`、`..`、`.` 开头的 dirname
- multer fileFilter 只放 `.zip` 和 `.rdf`;`limits.fileSize` 500MB,`files: 1`
- 上传前先校验 project 归属,multer destination 才执行(防止陌生人往 UPLOAD_ROOT 写垃圾)
- 后台 ingest 失败会被 catch 并写回 `status='failed'` + `error_message`(最长 1000 字符)

## 已知 / 待办

- stepper.ejs 里的"筛选"按钮目前还是跳 `/screening`(占位)。要让它跳到 `/zotero` 需要改
  partial,**不在 H 范围**。汇总层(Agent J?)统一改即可。
- manifest.ejs 里展示了 `manifest.by_item_type`(或 `byItemType`)分布;具体字段以 G 写的为准,
  我做了 best-effort 兼容(snake / camel 都认)。如果 G 用别的字段名,view 会忽略而不报错。
- 上传同一个文件第二次会创建新的 `package_id`(同样目录、不同记录)。**没有做 dedup**,
  因为 Agent G 在 ingest 期会做 record 级别去重,而包级别用户自己能从入口页看到一堆并删。
  目前路由没提供"删除 package"端点(不在任务范围)。

## 不变量复核

- [x] 没改 `server.js`
- [x] 没改 `db/schema.sql` / `db/index.js` / `package.json` / `package-lock.json`
- [x] 没改任何已有 service(含 `services/zotero-ingest.js`,后者尚不存在,我用 `await import()` 延迟加载)
- [x] 没改任何 partial(`views/partials/*` / `views/projects/partials/*`)
- [x] 没改其他 phase 的 routes / views
- [x] 没改 Agent I 范围(`routes/projects/records.js` / `views/projects/records/*`)
- [x] 没 `npm install`,没 `git commit`
