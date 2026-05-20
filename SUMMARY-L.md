# SUMMARY-L — Phase 5 Agent L(PDF 解析服务)

> harness 拒 .md 写入,由汇总层代落。

## 文件清单
```
services/pdf-parse.js
services/__tests__/pdf-parse.test.js
```

## API
```js
parsePdfAttachment(db, { attachmentId, recordId })
  → { record_id, attachment_id, page_count, total_chunks,
      sections: {abstract:N, methods:M, ...}, errors }
parseProjectPdfs(db, { projectId, onProgress, force=false })
  → { total, parsed, skipped, ocr_required, failed, ... }
getChunksForRecord(db, recordId) → chunks[]
getSectionText(db, recordId, sectionType) → string
```

## 关键设计
- `pdf-parse` 是 CommonJS,用 `createRequire` 包
- 8 种 section 启发式正则识别(含 inline `Abstract—...` / `1. Introduction ...`)
- chunk ≤ 1500 字符,优先段落边界
- token_count = `Math.ceil(len/4)`
- Idempotent:每次 parse 同一 attachment,事务里 DELETE WHERE record_id+attachment_id 然后批量插
- "已解析"标志 = `paper_chunks` 行数 > 0(不动 schema)
- 扫描版(抽出 <100 字符) → `requires_ocr: true`,不写 chunks
- 损坏 PDF → 写 errors 数组,不中断批量
- 路径优先用 `attachments.storage_path`(已绝对),回落 `process.env.SLR_UPLOAD_ROOT || '/var/lib/slr/uploads'`

## 实测(27 个 robotic foundation models PDF)
- 单篇 Awais 2024:20 页,96 chunks,sections={other:1, abstract:3, introduction:92}
- Idempotent:重跑 96→96 不变
- 批量 27 篇:total:27, parsed:27, skipped:0, ocr_required:0, failed:0
- 全语料 chunks 分布:introduction 624 / references 199 / methods 97 / results 47 / abstract 33 / other 29 / conclusion 15 / discussion 4
- force=false 重跑:全部 27 skipped

## 已知不足
- pdf-parse 输出无格式,两栏 IEEE 论文里 `II. METHODS` 这种小节常被并到上一行 → introduction chunks 偏多
- M/N 用 `getSectionText` 拿对应章节文本即可,LLM 自行复判
