# SLR Copilot · Systematic Literature Review Workbench

> [中文](./README.md) · **🇺🇸 English**

AI-assisted Systematic Literature Review platform. From a research topic to a PRISMA 2020 compliant, submission-ready draft, in 8 closed-loop steps.

🌐 **Live**: https://slr.yourai.asia · single-node deploy · < 100 MB resident memory

---

## Workflow (8 steps)

```
Clarify questions  →  Build search  →  Import refs  →  Build matrix  →
RoB (optional)     →  Synthesise    →  GRADE        →  Write submission
```

| Step | What you do | What the LLM does |
|---|---|---|
| **1** Protocol | Input topic, criteria, concept groups | Flagship model drafts research questions, inclusion/exclusion criteria, PICO concept groups |
| **2** Search | Auto-generate queries for the databases you ticked → execute them → log hits → lock the final plan | Generates 3 versions × N selected databases (WoS/Scopus/PubMed) + 1 AI-optimised main search (shared concept set across databases — only syntax differs) |
| **3** Import CSV / XLSX | Drag multiple exports from different databases at once | — |
| **4** Literature matrix | Fill cells inline / download XLSX template / let AI extract | Optional per-column copy-prompt for external AI assistance |
| **5** RoB | (Built-in tool not yet shipped — grade through GRADE's `risk_of_bias` axis or run external RoB 2) | — |
| **6** Synthesis | Cross-paper theme clustering, Evidence Matrix, consistent/conflicting findings | Flagship model proactively clusters themes and surfaces evidence gaps |
| **7** GRADE | Five-domain certainty rating (RoB / inconsistency / indirectness / imprecision / publication bias) + Summary of Findings table | — |
| **8** Drafting | One-click 9-section draft + PRISMA flow + 27-item appendix + Markdown export | Flagship model renders PRISMA 2020-compliant **English** prose (Chinese in → English out), every fact auto-linked back to source records |

**🔄 Iteration at any stage** — A persistent "Review & Iterate Protocol" button lets the user trigger AI to look back: ingest all upstream data (protocol + searches + imports + screening + per-record AI decisions + exclusion reasons + themes + GRADE), reverse-diagnose the misalignment, and propose an optimised v_next protocol for review and approval.

---

## Core features

### 🔐 Three-tier user model + platform-shared credentials
- **Super Admin** (single) — Configures the platform's Claude / Codex tokens; all other users share them. `zjnuwmy1@gmail.com` is auto-promoted at bootstrap.
- **Admin** — Can manage users, view usage logs and storage; cannot create new admins, cannot edit platform credentials.
- **User** — Calls LLMs through platform credentials; never has to bind their own.

### 🤝 Closed-loop protocol → search → screening → optimisation
- After protocol approval, queries are generated using the protocol's year range, document types, and language **verbatim** (code-level guardrails — LLM cannot drift).
- Every `query_text` includes 4 filter classes (concept groups + year + document-type NOT exclusions + language); all databases share the same concept set.
- AI main-search can be tuned to the user's expected hit count range, adjusting concept-set breadth accordingly.
- CSV upload is gated on the user formally locking the final search plan.

### 🔍 Review & iterate mechanism (v2.0 protocol)
- Project header has a persistent **🔄 Review & Iterate** button.
- Screening page auto-shows a callout when inclusion rate drops below 10%.
- The LLM receives: user free-text feedback + protocol + all search strategies + hit counts + locked plan + **every record's AI ↔ human decision** (bucketed by signal value: disagree / uncertain / agree / ai_only, up to 2 000 records) + top exclusion reasons + themes + GRADE.
- Runs on **flagship + high reasoning** (Claude Opus 4.7 *ultrathink* or GPT-5.5 *high*).
- Output: diagnosis (confidence-coded), typed proposed changes, full new protocol, next-step suggestions.
- User approves → writes a new protocol version, with full audit chain preserved in `iteration_metadata`.

### 📚 Multi-source reference management
- Upload several files at once (WoS xlsx + Scopus csv + PubMed csv).
- Cross-database dedup: papers indexed in multiple databases get merged with `source_databases: ["wos", "scopus"]`.
- Records list shows colour-coded source badges (blue / amber / green).
- WoS Export-to-Excel (`.xlsx`) can be dragged in directly — auto `sheet_to_csv` into the same detection pipeline.

### 🌏 Bilingual flow
- Working surfaces use Chinese (protocol, themes, notes, feedback).
- Final manuscript export is forced English (SLR academic convention); PRISMA flow / SoF table / 27-item appendix all in English.

### 🤖 LLM routing
- Anthropic OAuth (Claude Code CLI) + Anthropic API + OpenAI OAuth (Codex CLI device-auth) + OpenAI API — four channels behind one provider abstraction.
- Per-step model **and reasoning level** are independently configurable (Claude: think / think hard / ultrathink; Codex: minimal / low / medium / high).
- Cross-provider translation: setting "ultrathink" while the active platform credential is OpenAI auto-maps to "high".
- Protocol-compliance guard: if the LLM tampers with year range / document types / language, server auto-reverts and warns.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Web framework | Node 18+ / Express / EJS | partial-include pattern, no build step |
| Database | SQLite (better-sqlite3) | ~28 tables, WAL, single file |
| Frontend | Tailwind via CDN + Inter / JetBrains Mono | No build step, served straight to prod |
| LLM | Anthropic + OpenAI (API + CLI, 4 channels) | Provider abstraction layer |
| Credential crypto | AES-256-GCM with 32-byte `ENCRYPTION_KEY` | OAuth tokens and API keys all encrypted at rest |
| PDF | pdf-parse + heuristic section splitter | Section split + chunking |
| Excel | xlsx (community) | Direct WoS Export-to-Excel + matrix templates |
| Zotero | fast-xml-parser + adm-zip | RDF zip + PDF attachments |
| Deploy | systemd + Nginx + Certbot | `proxy_buffer_size 64K`, `proxy_read_timeout 1h` |

---

## Data model

Main tables (28 in total):

```
users  ─ invite_codes ─ user_credentials ─ user_quotas ─ credential_shares
       └ projects ─ protocols ─ search_strategies ─ final_search_records
                  ├ records ─ attachments
                  ├ paper_chunks ─ screening_decisions ─ extractions
                  ├ literature_matrix ─ matrix_columns
                  ├ themes ─ evidence_points ─ grade_assessments
                  ├ draft_sections
                  ├ prisma_checklist
                  ├ target_journal_templates
                  └ pending_iterations
audit_events / usage_logs / system_settings / oauth_bind_sessions
zotero_packages
```

Idempotent migrations: `db/index.js` runs `ALTER TABLE ADD COLUMN` for incremental fields at startup (`is_super_admin`, `search_locked_at`, `search_concept_set_json`, `source_databases`, `iteration_metadata`, etc.).

---

## Deployment

```bash
# Server prep
adduser --system --group --home /opt/slr --shell /bin/bash slr
mkdir -p /opt/slr /var/lib/slr/{uploads,pdfs,db,claude-home}
chown -R slr:slr /opt/slr /var/lib/slr

# Install Claude / Codex CLIs system-wide
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
sudo -u slr -H bash -c 'HOME=/var/lib/slr/claude-home claude login'

# Deploy code
cd /opt/slr && npm install --omit=dev
cp deploy/slr.env /etc/slr.env  # edit SESSION_SECRET / ENCRYPTION_KEY
cp deploy/slr.service /etc/systemd/system/
cp deploy/nginx.conf /etc/nginx/sites-available/slr
ln -sf /etc/nginx/sites-available/slr /etc/nginx/sites-enabled/
systemctl enable --now slr
certbot --nginx -d slr.yourai.asia --redirect
```

Key `.env` variables: `PORT=3001` / `DB_PATH=/var/lib/slr/db/slr.db` / `SESSION_SECRET=...` / `ENCRYPTION_KEY=...` (64-hex) / `BOOTSTRAP_ADMIN_EMAIL=zjnuwmy1@gmail.com` / `BOOTSTRAP_ADMIN_PASSWORD=...`

---

## Notable stability fixes (known sharp edges)

| Symptom | Root cause | Fix |
|---|---|---|
| `502 Bad Gateway` on iteration | LLM output (several KB) stuffed into `cookie-session`; `Set-Cookie` exceeded nginx's default `proxy_buffer_size 8K` | Switched to a `pending_iterations` table; session only stores a trigger flag; nginx buffer bumped to 64K |
| Pasted "locked" query produced unfiltered WoS results | EJS `<%= %>` + a stray manual `.replace(/"/g, '&quot;')` caused double-escape; `LA=(&quot;English&quot;)` was silently dropped by WoS | Removed the extra `.replace`; one-shot DB cleanup decoded `&quot;` → `"` |
| Chinese LLM outputs broke `JSON.parse` on inner unescaped quotes | `"summary": "the protocol's "design thinking" criterion ..."` ends the string on the first inner `"` | `tryParseLenient` gains `repairInnerDoubleQuotes` heuristic; benefits all LLM calls (protocol gen, search recommend, extraction, drafting, GRADE, iteration) |
| Recommend `normalize` was rejecting valid outputs | Different models wrap the envelope and rename fields | BFS recursive descent under `PRIMARY_KEY_RE`, 11 aliases accepted (`primary` / `best` / `chosen` / `top_choice` / etc.) |

---

## License

Released under the [MIT License](./LICENSE). © 2026 Mingyu

---

## Contact

File issues and change requests through this repository.
