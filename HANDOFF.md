# SLR Copilot — Handoff for Incoming Engineer / AI

**Last updated:** 2026-05-30
**Production URL:** https://slr.yourai.asia
**Production IP:** `47.236.207.143`

This document is the single-page brief for the next maintainer. Read top-to-bottom once; everything else (the 23 `SUMMARY-*.md` files at repo root) is historical phase notes.

---

## 0. What this is

AI-assisted **Systematic Literature Review** platform. Project owner uploads protocol + papers (Zotero RDF / WoS / Scopus / PubMed CSV / manual), platform runs **9 wizard steps** end-to-end with LLMs:

1. Protocol (PICO / inclusion / exclusion / concept groups)
2. Search strategy generation (3 dbs × 3 versions)
3. Records ingest + dedup
4. Title/abstract screening (AI + human override)
5. Literature matrix extraction (full-text → structured rows)
6. Risk-of-Bias assessment (RoB2 / ROBINS-I / NOS / JBI / MMAT, 5 tools)
7. Theme synthesis + evidence matrix
8. GRADE / CERQual certainty (theme-level)
9. Manuscript drafting + LaTeX render → PDF + submission zip

Stack: **Node.js 18+ ESM / Express 4 / EJS / better-sqlite3 / Tailwind via CDN.** No bundler, no React. LLM calls go through **Claude CLI** (OAuth) or **Codex CLI** (OpenAI OAuth) — see `services/providers/`.

---

## 1. Server access

**SSH key file (on Mingyu's macOS):**
```
/Users/mingyu/Desktop/workspace/知识分享/test.pem
```

**SSH command:**
```bash
ssh -i /Users/mingyu/Desktop/workspace/知识分享/test.pem \
    -o StrictHostKeyChecking=no \
    root@slr.yourai.asia
# or
ssh -i /Users/mingyu/Desktop/workspace/知识分享/test.pem root@47.236.207.143
```

**Critical paths on prod:**
| What | Path |
|---|---|
| App code | `/opt/slr/` |
| SQLite DB | `/var/lib/slr/db/slr.db` |
| Systemd unit | `/etc/systemd/system/slr.service` |
| Env file | `/etc/slr.env` |
| Nginx site | `/etc/nginx/sites-available/slr` ⚠️ **never rsync overwrite** |
| User OAuth homes | `/var/lib/slr/user-homes/<user_id>/<cred_id>/.claude/` |
| Platform credential home | `/var/lib/slr/claude-home/.claude/` |
| Uploads | `/var/lib/slr/uploads/` |
| Latex renders | `/var/lib/slr/uploads/latex-renders/<projectId>/<renderId>/` |
| Zotero ingest staging | `/var/lib/slr/uploads/zotero/...` |
| Single-PDF补传 | `/var/lib/slr/pdfs/<recordId>.pdf` |

**Service:**
```bash
systemctl restart slr
systemctl status slr
journalctl -u slr -f                  # live tail
journalctl -u slr -n 200 --no-pager   # last 200 lines
```

---

## 2. Local development

```bash
cd /Users/mingyu/Desktop/workspace/slr-copilot
nvm use 18                  # or any node >= 18
npm install
cp .env.example .env        # if not present
node server.js              # listens on 127.0.0.1:3001 by default
# or
node --watch server.js      # auto-restart on file changes
```

DB auto-creates at `./data/dev.db` from `db/schema.sql` on first boot (see `db/index.js`).

---

## 3. Deploy flow

**There is no CI.** Deploy = rsync source files → restart systemd. Always:

```bash
# 1) Syntax check locally
node --check routes/projects/<file>.js
node --check services/<file>.js

# 2) Check no in-flight LLM work on prod (CRITICAL — restart kills bg jobs)
ssh ... "sqlite3 /var/lib/slr/db/slr.db \"
  SELECT 'latex_renders' AS k, COUNT(*) AS v FROM latex_renders WHERE status='running'
  UNION ALL SELECT 'batch_jobs', COUNT(*) FROM batch_jobs WHERE status='running';\""

# 3) rsync (always include --exclude='.data', never use --delete to /opt/slr/)
rsync -avz --exclude='.data' \
  -e "ssh -i /Users/mingyu/Desktop/workspace/知识分享/test.pem -o StrictHostKeyChecking=no" \
  --files-from=- \
  /Users/mingyu/Desktop/workspace/slr-copilot/ root@slr.yourai.asia:/opt/slr/ <<'EOF'
routes/projects/rob.js
services/rob.js
views/projects/rob.ejs
EOF

# 4) Restart + smoke
ssh ... "systemctl restart slr && sleep 2 && systemctl is-active slr && \
         curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' https://slr.yourai.asia/"
```

**NEVER rsync** `/etc/nginx/sites-available/slr` (production-tuned, has SSE buffering off + proxy timeouts). **NEVER rsync** `.data/` (would overwrite prod DB).

---

## 4. Repo layout (where to find what)

```
slr-copilot/
├── server.js                       # Express app boot; mounts routers, sessions, error handlers
├── db/
│   ├── schema.sql                  # ALL table definitions + migrations — read this first
│   └── index.js                    # DB connector + idempotent migrator (runs every boot)
├── middleware/
│   └── auth.js                     # requireUser / requireAdmin / requireAdvancedExtraction gates
├── routes/
│   ├── auth.js                     # login / signup / invite codes / password reset
│   ├── account/                    # /account/credentials, /account/quota
│   ├── admin/                      # /admin/users, /admin/usage, /admin/step-presets
│   └── projects/                   # ★ THE MAIN MEAT (one file per wizard step)
│       ├── index.js                # GET /projects, project create wizard
│       ├── search.js               # Step 2: WoS/Scopus/PubMed query generation
│       ├── records.js              # ingested papers list + detail + PDF upload/delete
│       ├── import-csv.js           # CSV/RIS/Excel ingest
│       ├── zotero.js               # Zotero RDF .zip ingest + dedup
│       ├── screening.js            # Step 4: AI screening + human override
│       ├── extraction.js           # Step 4 legacy structured extraction (mostly superseded by matrix.js)
│       ├── matrix.js               # Step 4 NEW: AI batch matrix extraction
│       ├── rob.js                  # Step 5: Fast/Deep RoB batches + Deep verify + overlay
│       ├── synthesis.js            # Step 6: theme clustering + evidence matrix
│       ├── certainty.js            # Step 7: GRADE / CERQual / hybrid theme-level
│       ├── report.js               # Step 8 + 9: section drafting, figures, tables, LaTeX (9043 LOC — the giant)
│       ├── iterate.js              # Iteration / protocol revision after step N
│       ├── journal-template.js     # Step 9: target journal PDF → structured prompts
│       └── prisma.js               # PRISMA 2020 27-item validator + flow diagram
├── services/                       # ★ business logic, prompts, providers
│   ├── llm.js                      # runLlm() main router + runFileOpsLlm()
│   ├── providers/
│   │   ├── anthropic-cli.js        # Claude CLI standard mode (-p --output-format json)
│   │   ├── anthropic-cli-fileops.js # Claude CLI file-ops mode (Read/Write/Edit tools) — for LaTeX fill
│   │   ├── anthropic-api.js        # Direct API (mostly unused, kept for parity)
│   │   ├── openai-cli.js           # Codex CLI
│   │   └── openai-api.js           # OpenAI API
│   ├── prompts/                    # ★ all LLM system prompts live here, version-pinned
│   │   ├── protocol.js / search.js / screening.js
│   │   ├── extraction.js / latex-fill.js / latex-overlay.js
│   │   ├── drafting.js (3628 LOC — section-by-section systems + COMMON_RULES + COVERAGE GATE)
│   │   ├── synthesis.js / certainty.js / grade.js
│   │   ├── search-recommend.js     # Step 2 "AI-optimized main query"
│   │   ├── prisma-validator.js     # Step 9 PRISMA 27 audit
│   │   ├── table-recommend.js / table-polish.js
│   │   └── _taxonomy.js            # shared concept-group spec helpers
│   ├── step-presets.js             # ★ which model + reasoning each step uses, per user preset
│   ├── settings.js                 # AVAILABLE_MODELS list + tier→model resolution
│   ├── credentials.js              # OAuth bridge to Claude CLI + Codex CLI
│   ├── platform-credentials.js     # super-admin platform-wide creds (used by all users)
│   ├── credential-sharing.js       # owner→user creds share
│   ├── quota.js                    # per-user LLM call budget + storage quota
│   ├── audit.js                    # writes to audit_events table
│   ├── batch-jobs.js               # ★ resumable background jobs (PRISMA / RoB / matrix / drafting)
│   ├── pdf-parse.js                # PDF → text → section-tagged chunks
│   ├── dedup.js                    # Levenshtein + DOI dedup
│   ├── zotero-ingest.js / zotero-merge.js / zotero-reconcile.js
│   ├── csv-ingest.js               # WoS / Scopus / PubMed / Excel parser
│   ├── crossref.js                 # DOI metadata enrichment
│   ├── literature-matrix.js        # Step 4 matrix col definitions + LLM batch runner
│   ├── rob.js                      # ★ Fast/Deep RoB engines, 5 tools, parser + upsert
│   ├── rob-helpers.js              # tool config, signaling questions
│   ├── synthesis-helpers.js        # Step 6 input packing, fitsSingleCall check
│   ├── drafting-helpers.js         # Step 8 input packing, plan + overlay loaders
│   ├── certainty-helpers.js        # Step 7 SoF + theme rollup
│   ├── grade.js                    # GRADE 8-domain logic
│   ├── methodology-capabilities.js # capability flags (qual / quant / mixed → which RoB tool)
│   ├── figures.js / figure-assets.js
│   ├── review-tables.js / table-registry.js # 14 derived tables for results section
│   ├── citation-format.js / reference-export.js # APA / IEEE / Chicago / MLA / GB/T 7714
│   ├── citation-validator.js       # detects hallucinated rec_xxx ids in draft
│   ├── manuscript-assembler.js     # joins draft sections → unified markdown
│   ├── latex-render.js             # latexmk wrapper (120s) + placeholder sanitizer
│   ├── journal-template.js         # target journal PDF analysis
│   ├── prisma.js / prisma-flow.js
│   ├── search-lock.js              # lock final query before CSV upload
│   ├── storage.js / storage-quota.js # disk usage tracking
│   ├── project-delete.js           # GDPR-style full project tombstone
│   ├── reset-on-protocol-change.js # cascade clear downstream when protocol re-approved
│   └── crypto.js                   # randomId, hash, bcrypt wrappers
├── views/projects/                 # EJS templates, one per wizard step
│   ├── partials/                   # nav, flash, stepper
│   ├── extraction/                 # legacy extraction sub-views
│   └── records/                    # records list + detail + edit
├── public/                         # static assets (CSS overrides, JS helpers)
├── deploy/
│   ├── install-server.sh           # one-shot prod setup (apt installs, certbot, nginx, systemd)
│   ├── slr.service                 # systemd unit
│   └── nginx.conf                  # ★ reference only — actually edit /etc/nginx/sites-available/slr in place
├── scripts/                        # one-off ops scripts
│   ├── backup-db.sh                # crontab nightly
│   ├── cleanup-old-logs.sh
│   ├── sweep-orphan-files.js       # find PDFs without records
│   └── backfill-attachment-sizes.js
├── SUMMARY-*.md                    # historical phase notes (23 files) — skip on first read
├── DEPLOY.md                       # original deploy walkthrough
└── README.md / README.en.md
```

---

## 5. DB schema highlights

Run `sqlite3 /var/lib/slr/db/slr.db '.schema'` for the full picture. Key tables:

| Table | Note |
|---|---|
| `users` | role: 'user' / 'admin', is_super_admin flag, `advanced_extraction_enabled` toggle gates PDF upload + matrix batch + RoB batch |
| `projects` | one per SR; ~110 columns covering all 9 step states + cached counts + overlay JSONs |
| `protocols` | versioned per project; `approved_by_user=1` rows are the "current" |
| `search_strategies` | one per (project, version, db, query_type); query_text + result_count |
| `records` | one paper; `duplicate_of_record_id` non-null = dup (filter `IS NULL OR = ''` in queries) |
| `screening_decisions` | one row per (record, stage); stage='title_abstract' for Step 4 |
| `attachments` | PDF / HTML / RDF tied to record |
| `paper_chunks` | parsed PDF segments; section_type-tagged; **FK ON DELETE CASCADE to attachments** |
| `literature_matrix` | one per record; `fields` is JSON of column→value; `filled_by` = 'ai' \| 'user' |
| `rob_assessments` | one per (record, tool, rater_pass); `rater_pass=1` Fast, `=2` Deep verify |
| `themes` + `theme_records` + `theme_methodology` | Step 6 |
| `theme_certainty` + `grade_assessments` | Step 7 |
| `draft_sections` | one per (project, section_name, version); markdown |
| `figure_assets` + `figure_prompts` | Step 8 figures |
| `latex_renders` | one per render attempt; pdf_path, log_path, error |
| `usage_logs` | EVERY LLM call: user, project, action_type, model, duration_ms, status, error_message |
| `audit_events` | not "audit_logs" — common typo. Event type + JSON payload |
| `batch_jobs` | resumable bg work (matrix / rob / drafting / latex) with progress_json, status, can_retry |
| `system_settings` | key-value KV; `step_model.<step>` / `step_reasoning.<step>` / user step presets |
| `user_credentials` | OAuth tokens (encrypted via `services/crypto.js`) |
| `user_quotas` | LLM call budget + storage budget |

---

## 6. LLM routing model

Single entry point: **`services/llm.js`** → `runLlm(db, { userId, actionType, projectId, system, prompt, expectJson, model, maxTokens, timeoutMs, ... })`.

Resolution order for the model name:
1. `model` argument literal (e.g. `'claude-opus-4-8'`)
2. Tier alias: `'heavy'` → `flagship` → `services/settings.js` `DEFAULT_BY_PROVIDER_AND_TIER`
3. `system_settings` row `step_model.<actionType>` (per-user override)
4. `step-presets.js` 3 presets (performance / balanced / economy) — user picks one via `users.step_model_preset` or super-admin sets default

Reasoning depth (`step_reasoning.<actionType>`): `off` / `think` / `think_hard` / `think_harder` / `ultrathink`. Mapped to Claude CLI extended-thinking keywords prepended to prompt. Codex CLI uses `reasoning_effort` flag.

**File-ops mode** (`runFileOpsLlm`): Claude CLI with `--allowed-tools Read,Write,Edit,Glob,Grep` operating in a sandbox `cwd`. Used by LaTeX fill (v6 in `routes/projects/report.js` ~line 7670) — gives Claude a workdir with `template/`, `sections/`, `tables/`, `figures/` and it produces `out/main.tex` via multiple small Edit ops. Avoids 50K-char single-stream timeout.

---

## 7. Background jobs (`batch-jobs.js`)

Any long-running work that survives restart should use `batchJobsSvc.startJob` / `updateJobProgress` / `finishJob`. Kinds in use:
- `matrix_extraction` — per-paper LLM call, ~30-90s each
- `matrix_parse_pdfs` — PDF→chunks
- `rob_assessment` — Fast or Deep RoB batches
- `rob_deep_verify` — Deep re-evaluation of Fast moderates/highs
- `drafting_section` / `drafting_plan` / `drafting_overlay`
- `synthesis_clustering` / `certainty_rollup`
- `latex_render` (tracked via its own `latex_renders` table)
- `figure_prompts_optimize`

`pid` column = the Node process owner. On restart, `aborted_by_restart` is auto-applied to running jobs. **Critical:** before `systemctl restart slr`, check `batch_jobs WHERE status='running'` and `latex_renders WHERE status='running'` — restarting interrupts users mid-work.

---

## 8. Auth + permissions

- **Cookie-session** (signed). Session cookie carries only `userId`. Middleware in `middleware/auth.js`:
  - `requireUser` — any logged-in user
  - `requireAdmin` — `role='admin'` OR `is_super_admin`
  - `requireAdvancedExtraction` — `advanced_extraction_enabled=1` OR `is_super_admin`. Gates PDF upload + matrix batch + RoB batch + Deep verify
- **Project ownership:** `ownProjectOr404(db, projectId, userId)` checks `projects.user_id = ?`. Admin can see any project via `/admin/users/:id/projects` (sets a session flag).
- **Invite codes:** `invite_codes` table; bootstrap admin via env `SLR_BOOTSTRAP_ADMIN_EMAIL` + auto-generated code printed in journalctl.

---

## 9. Common ops cookbook

```bash
# Open a sql shell
ssh ... "sqlite3 /var/lib/slr/db/slr.db"

# Find a user
sqlite3 /var/lib/slr/db/slr.db "SELECT id, email, role, advanced_extraction_enabled FROM users WHERE email LIKE '%example%';"

# Toggle advanced extraction for a user (when they hit Forbidden on PDF upload)
sqlite3 /var/lib/slr/db/slr.db "UPDATE users SET advanced_extraction_enabled=1 WHERE email='user@example.com';"

# Find a project + owner
sqlite3 /var/lib/slr/db/slr.db "SELECT p.id, p.title, p.status, u.email FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id LIKE 'proj_%';"

# Recent LLM failures for a project
sqlite3 /var/lib/slr/db/slr.db "SELECT id, action_type, status, duration_ms, model, substr(error_message,1,200), started_at FROM usage_logs WHERE project_id='<id>' AND status != 'success' ORDER BY started_at DESC LIMIT 10;"

# Find all stuck running batch jobs
sqlite3 /var/lib/slr/db/slr.db "SELECT id, project_id, kind, started_at, done, total FROM batch_jobs WHERE status='running' ORDER BY started_at;"

# Abort a stuck job (won't kill child claude CLI process — use pkill for that too)
sqlite3 /var/lib/slr/db/slr.db "UPDATE batch_jobs SET status='aborted_by_user', finished_at=datetime('now') WHERE id='bj_xxx';"

# Find Claude CLI children of slr (e.g. before forced restart)
ps -ef | grep claude | grep -v grep

# Smoke test Claude CLI with a specific user's OAuth
HOME=/var/lib/slr/user-homes/<user_id>/<cred_id> claude -p --model claude-opus-4-8 --no-session-persistence 'hello'

# Merge two duplicate records (lower-cased title vs Title Case dupe)
sqlite3 /var/lib/slr/db/slr.db "UPDATE records SET duplicate_of_record_id='<kept_id>', duplicate_group_id='dup_$(openssl rand -hex 8)' WHERE id='<dup_id>';"

# Backup DB (nightly cron also does this)
ssh ... "bash /opt/slr/scripts/backup-db.sh"
```

---

## 10. Recent known fixes (last 14 days, in `git log` order)

| Symptom | Fix |
|---|---|
| `search_strategy` timeout 480s | `routes/projects/search.js` bump to 900s, maxTokens 12K |
| `rob_assess_batch` timeout 480s same pattern | `services/rob.js:~1387` bump to 900s, maxTokens 24K |
| Deep RoB 1-sec 126 failed (0 chunks) | `routes/projects/rob.js` pre-check `paper_chunks` count → reject early |
| LaTeX render result section timeout (v4/v5 streaming) | Switched to v6 **file-ops mode** in `routes/projects/report.js` ~7670; Claude operates in `workDir/fill/` and writes `out/main.tex` via Edit |
| LaTeX `../figures/foo.png` path bug | Defensive regex post-process strips `(../)+(figures\|tables\|template)/` |
| LaTeX longtable overflows margin | `routes/projects/report.js` parse `p{Xcm}` colspec, rescale if sum > 15.5 cm |
| Wide table overflow | Auto-wrap 5+ col tabulars in `\resizebox{\textwidth}{!}{...}` |
| CJK chars in references.bib crash pdflatex | `services/prompts/latex-fill.js` `bibSanitize` strips CJK runs, keeps English half of bilingual titles |
| RoB Fast batch parser `papers array empty` | `services/rob.js:parseRobFastBatchOutput` accept alt keys (assessments / results / judgments_per_paper / raw-as-array / single-paper auto-wrap) + diagnostic dump |
| `Opus 4.7 → 4.8` model bump | sed replace across `services/step-presets.js`, `services/settings.js`, route files, EJS UI text. Plus DB `UPDATE system_settings SET value='claude-opus-4-8' WHERE value='claude-opus-4-7';` |
| Record dup leaked into matrix as 0% row | DB-level: `UPDATE records SET duplicate_of_record_id='<kept>' WHERE id='<dup>';` — downstream queries filter on `duplicate_of_record_id IS NULL OR = ''` |
| Record PDF traerror rollback ("传错回滚") | `routes/projects/records.js` new route `POST /:id/records/:rid/delete-pdf` + UI button on `views/projects/records/detail.ejs` |

See `git log --oneline` for the complete trail. The `SUMMARY-*.md` files at repo root capture earlier major phases.

---

## 11. Models + presets (as of 2026-05-30)

**Anthropic (Claude CLI / OAuth):**
- `claude-opus-4-8` — flagship, 1M context, 64K output, ~30-90s typical, used everywhere a step needs reasoning
- `claude-opus-4-7` — kept in `settings.js` as legacy fallback
- `claude-sonnet-4-6` — standard, 600K context, ~5-15min on dense batch tasks (踩 cap risk — see search_strategy / rob_assess_batch timeout fixes)
- `claude-haiku-4-5` — light, for screening / column suggest / single-shot lookups

**OpenAI (Codex CLI / OAuth):**
- `gpt-5.5` flagship, `gpt-5.4` standard, `gpt-5.4-mini` light
- `gpt-5.3-codex` / `gpt-5.3-codex-spark` — code-specialized variants

**3 user presets** (`services/step-presets.js`):
- `performance` — Opus + ultrathink for everything heavy
- `balanced` — Opus for synthesis/iteration, Sonnet for matrix/RoB, Haiku for screening
- `economy` — Sonnet/Haiku where possible, Opus only for "once-and-done" meta steps (overlay, plan, template extraction)

**File-ops mode** (latex_fill_fileops) always uses Opus + `fallbackModel: claude-sonnet-4-6` (Anthropic auto-degrades when Opus is overloaded).

---

## 12. Cultural / methodological constraints

- **Taiwan / Hong Kong / Macau are uniformly归入 China** in all project geographic categorizations. Do NOT let LLM output "Taiwan, China" etc. as separate regions.
- **不让 LLM 自动生成"两位独立审查者"方法学表述** — only emit the dual-reviewer claim if the user has explicitly stated this in protocol. Otherwise generic "review process" phrasing.
- **English-only** in LaTeX output. Chinese fragments in protocol must be translated before drafting; references.bib CJK chars are stripped (see latex-fill.js bibSanitize).
- **Citation cap per section** is configured per journal in `target_journal_templates` and enforced in `services/prompts/drafting.js` SECTION_SYSTEMS via COVERAGE GATE blocks. Especially `in_abstract_citation_count` for abstract section.

---

## 13. Bootstrapping a new admin to talk to me / DB

```bash
# Get the bootstrap invite code (auto-generated on first boot if no users)
ssh ... "journalctl -u slr --since '1 hour ago' | grep -i 'bootstrap\|invite'"

# Or query existing super admin
sqlite3 /var/lib/slr/db/slr.db "SELECT email FROM users WHERE is_super_admin=1;"
```

The current super admin: `1210026069@qq.com` (user_id `user_935d5ecf4fc979d8130a230da06c442c`). Their OAuth credential `cred_dc9c72798c56e08abe2beb1d0eb5d96a` is the most-used "platform credential" — many users share it via `services/credential-sharing.js`.

---

## 14. Gotchas to NOT repeat

1. **Never restart slr while batch_jobs / latex_renders are running** — interrupts user. Check first.
2. **Never rsync `--delete`** to `/opt/slr/` — would clobber `.data/` and node_modules.
3. **Never rsync `/etc/nginx/sites-available/slr`** — production-tuned settings differ from `deploy/nginx.conf`.
4. **Never overwrite `users.is_super_admin = 0` on the bootstrap admin** — there's a fail-safe in middleware that lets super admin override `advanced_extraction_enabled=0`, but if you nuke `is_super_admin` you can lock everyone out.
5. **Claude CLI extracts text from envelope JSON** — `services/providers/anthropic-cli.js` dumps suspicious stdout to `/tmp/claude_cli_dump_*.txt`. When debugging "0 byte response" / "papers array empty", check that file.
6. **The dedup regex/match** is fragile — Title case differences + missing DOI can pass through. Manual `duplicate_of_record_id` merges happen.
7. **`audit_events` not `audit_logs`** — easy typo when writing SQL.
8. **Batch jobs snapshot targets at start** — papers added to "include" AFTER batch starts will silently be missed. Run again with `skipAlreadyExtracted=true` (default) to catch them.
9. **`step_model_preset` and `advanced_extraction_enabled` are independent.** A user can be on the "performance" preset but still see "Forbidden" if their toggle is off. The preset only picks the model/reasoning; the toggle gates whether they can spawn expensive batches at all.
10. **Process groups + claude CLI** — Claude CLI spawns child processes for tool calls. When killing a batch, `proc.kill()` only hits the parent; use `process.kill(-proc.pid, 'SIGTERM')` (detached: true + negative pid) to kill the whole group. See `services/providers/anthropic-cli.js` for the pattern.

---

## 15. Where to start when first onboarding

1. Read `db/schema.sql` (~600 lines) — gives you the data model fast.
2. Read `services/llm.js` — single LLM entry point, ~700 lines.
3. Read `services/step-presets.js` — see how model selection cascades.
4. Read `routes/projects/screening.js` for a "normal-sized" wizard step (1279 LOC) — understand the AJAX decide flow, batch_jobs integration, audit logging.
5. Then dip into `routes/projects/report.js` (9043 LOC — the big one) only when you need to touch Step 8 or 9.

If the user reports something broken, the muscle memory is:
1. `journalctl -u slr -n 200 --no-pager | tail -30` to see recent errors
2. `sqlite3 .../slr.db "SELECT ... FROM usage_logs WHERE project_id='<id>' ORDER BY started_at DESC LIMIT 10"` to see LLM call outcomes
3. `sqlite3 .../slr.db "SELECT ... FROM batch_jobs WHERE project_id='<id>' ..."` for bg job state
4. `ls /var/lib/slr/uploads/latex-renders/<projectId>/` for LaTeX render artifacts

Good luck. The repo is well-commented; the `// 2026-xx-xx vN:...` comments are migration markers I leave when bumping a prompt or fixing a class of bug. Search those if archaeological context is needed.
