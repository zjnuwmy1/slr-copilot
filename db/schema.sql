-- SLR Copilot — schema
-- Phase 0: users, audit_events
-- Phase 1: invite_codes, user_credentials, usage_logs

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  is_active INTEGER NOT NULL DEFAULT 1,
  invite_code_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL,
  preset_role TEXT NOT NULL DEFAULT 'user' CHECK (preset_role IN ('admin', 'user')),
  note TEXT,
  used_by_user_id TEXT,
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (used_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_invite_unused ON invite_codes(used_by_user_id);

-- 用户绑定的 LLM 凭证
-- auth_type: api_key(粘贴) | oauth(订阅 Web 化 login dance 拿到的凭证)
-- provider:  anthropic | openai
-- credential_blob_enc: AES-256-GCM 加密后的 JSON,内容因 auth_type 而异:
--   api_key: { "api_key": "sk-..." }
--   oauth:   { "home_path": "/var/lib/slr/user-homes/<user_id>/<credential_id>" }
-- (OAuth 凭证文件本身落在文件系统,blob 只存指针 + 元信息)
CREATE TABLE IF NOT EXISTS user_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('api_key', 'oauth')),
  label TEXT NOT NULL,
  credential_blob_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_validated_at TEXT,
  last_validation_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credentials_user ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON user_credentials(status);

-- 配额:admin 可在 users 行上设硬上限
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY,
  daily_call_limit INTEGER,            -- 每日 LLM 调用次数上限,NULL = 不限
  monthly_token_limit INTEGER,         -- 每月 token 上限(仅 API key 路径可统计)
  allowed_providers TEXT,              -- JSON 数组,NULL = 全允许
  allowed_auth_types TEXT,             -- JSON 数组,NULL = 全允许
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by_user_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 每次 LLM 调用一条
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  credential_id TEXT,
  project_id TEXT,
  action_type TEXT NOT NULL,           -- protocol_gen | search_strategy | screening | extraction | synthesis | drafting | test_ping | other
  provider TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL,                -- success | rate_limited | timeout | error | quota_exceeded
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (credential_id) REFERENCES user_credentials(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_started ON usage_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_usage_action ON usage_logs(action_type);

-- 审计:登录、改密、凭证操作、admin 动作等
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  user_id TEXT,
  actor_user_id TEXT,                  -- 谁执行的(可能是 admin 代用户操作)
  event_type TEXT NOT NULL,            -- login_success | login_fail | signup | invite_created | credential_bind | credential_revoke | admin_set_quota | ...
  target_user_id TEXT,
  payload TEXT,                        -- JSON
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

-- OAuth 绑定中转会话:用户点"绑定 Claude" → 服务器 spawn `claude login`,记录 pid 和 stdout 提示
-- 用户在 Web 上粘 code → 服务器找回这条会话 → pipe 到 stdin
-- 完成或 5 分钟超时后清理
CREATE TABLE IF NOT EXISTS oauth_bind_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  stage_home_path TEXT NOT NULL,       -- 临时 HOME,login 成功后 .claude / .codex 落在这里
  state TEXT NOT NULL DEFAULT 'awaiting_url' CHECK (state IN ('awaiting_url', 'awaiting_code', 'completed', 'failed', 'timeout')),
  prompt_url TEXT,                     -- 从 CLI stdout 抓到的授权 URL
  error_message TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_bind_user ON oauth_bind_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_bind_state ON oauth_bind_sessions(state);

-- ========================================
-- Phase 2: 研究项目 + 协议
-- ========================================

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  review_type TEXT,                    -- systematic_review | scoping_review | bibliometric | meta_analysis | mixed_methods
  discipline TEXT,                     -- 学科领域
  topic TEXT NOT NULL,                 -- 用户原始主题描述
  goal TEXT,                           -- 初步目标
  year_start INTEGER,
  year_end INTEGER,
  databases TEXT,                      -- JSON array: ['wos','scopus',...]
  language_limits TEXT,                -- JSON array
  document_types TEXT,                 -- JSON array
  seed_titles TEXT,                    -- JSON array of seed 文献题名
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','protocol_pending','protocol_approved','searching','screening','extracting','synthesizing','complete','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- 协议:每次 AI 生成或人工编辑都写一个新 version
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  research_questions TEXT,             -- JSON array of strings
  inclusion_criteria TEXT,             -- JSON array
  exclusion_criteria TEXT,             -- JSON array
  concept_groups TEXT,                 -- JSON: [{name, terms: []}, ...]
  recommended_review_type TEXT,
  rationale TEXT,
  clarification_questions TEXT,        -- JSON array (LLM 提的待澄清问题)
  generated_by TEXT NOT NULL CHECK (generated_by IN ('ai','user','ai_edited')),
  model TEXT,                          -- 用到的 LLM 模型
  approved_by_user INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_protocols_project ON protocols(project_id);
CREATE INDEX IF NOT EXISTS idx_protocols_version ON protocols(project_id, version);

-- ========================================
-- Phase 3: PRISMA 工作流 — 检索式 + 27 项清单
-- ========================================

-- WoS / Scopus / PubMed 等检索式;同一个 database 可有多个 query_type 版本
CREATE TABLE IF NOT EXISTS search_strategies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  database_name TEXT NOT NULL,             -- wos | scopus | pubmed | ieee | eric | acm | psycinfo | other
  query_type TEXT NOT NULL,                -- high_recall | balanced | high_precision | user
  query_text TEXT NOT NULL,
  filters TEXT,                            -- JSON: { document_type:[], language:[], year_range:[s,e] }
  rationale TEXT,
  result_count INTEGER,                    -- 用户手动回填
  search_date TEXT,                        -- 用户手动回填
  version INTEGER NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'ai' CHECK (generated_by IN ('ai','user','ai_edited')),
  model TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_project ON search_strategies(project_id);
CREATE INDEX IF NOT EXISTS idx_search_database ON search_strategies(project_id, database_name);

-- PRISMA 2020 27 项清单(42 entries with sub-items)— 每项目一份,创建项目时种入
CREATE TABLE IF NOT EXISTS prisma_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  item_number TEXT NOT NULL,               -- '1' | '5' | '10a' | '13b' | '24c' | ...
  section TEXT NOT NULL,                   -- Title | Abstract | Introduction | Methods | Results | Discussion | Other
  topic TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  workflow_step TEXT,                      -- 'protocol' | 'search' | ... — 映射到我们的 wizard step
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','done','not_applicable')),
  notes TEXT,
  evidence_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, item_number)
);

CREATE INDEX IF NOT EXISTS idx_prisma_project ON prisma_checklist(project_id);
CREATE INDEX IF NOT EXISTS idx_prisma_step ON prisma_checklist(project_id, workflow_step);

-- ========================================
-- Phase 3+: 凭证共享 — owner 把自己的 user_credentials 行授权给其他用户使用
-- 设计:
--   - 只有凭证的拥有者(user_id)能 share / unshare
--   - 被共享方在自己没有可用凭证时回落到共享凭证
--   - 配额(user_quotas)仍按"使用者"算,不是按 owner 算
--   - usage_logs 记录的是实际调用者(user_id),credential_id 指向 owner 的凭证
-- ========================================
CREATE TABLE IF NOT EXISTS credential_shares (
  credential_id TEXT NOT NULL,
  shared_with_user_id TEXT NOT NULL,
  shared_by_user_id TEXT NOT NULL,        -- 同 owner,记录冗余便于查询
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (credential_id, shared_with_user_id),
  FOREIGN KEY (credential_id) REFERENCES user_credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shared_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cred_shares_target ON credential_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_cred_shares_owner ON credential_shares(shared_by_user_id);

-- ========================================
-- Phase 4: Zotero ingest — 上传 RDF + PDF 包,解析成 records + attachments
-- ========================================

CREATE TABLE IF NOT EXISTS zotero_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('web_upload', 'admin_staging')),
  source_filename TEXT,                  -- 用户上传的 zip 文件名 / staging 子目录名
  storage_path TEXT NOT NULL,            -- 服务器解压后绝对路径
  size_bytes INTEGER,
  rdf_filename TEXT,                     -- 'robotic foundation models.rdf'
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'parsing', 'parsed', 'ingested', 'failed')),
  total_records INTEGER,
  total_with_pdf INTEGER,
  total_with_doi INTEGER,
  total_duplicates INTEGER,
  manifest TEXT,                         -- JSON dump 完整 manifest
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_at TEXT,
  ingested_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zotero_pkg_project ON zotero_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_zotero_pkg_status ON zotero_packages(status);

-- 一个 RDF 里抽出来的每条文献(176 条 for the test dataset)
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_id TEXT,                       -- 来源(可能未来支持手动添加,故允许 NULL)
  zotero_item_id TEXT,                   -- '#item_1364' (RDF 里的 internal id)
  zotero_rdf_about TEXT,                 -- rdf:about URL
  item_type TEXT,                        -- 'journalArticle' | 'conferencePaper' | 'bookSection' | 'webpage' | 'other'
  title TEXT NOT NULL,
  normalized_title TEXT,                 -- lowercase + 去标点 + 去 stopwords,用于去重
  authors_json TEXT,                     -- JSON: [{surname, givenName, full}, ...]
  authors_text TEXT,                     -- 'Wang G, Tang R, Xu M' for display + dedup
  year INTEGER,
  date_text TEXT,                        -- raw date string from RDF
  journal TEXT,                          -- 'Advanced Intelligent Systems'
  publisher TEXT,
  doi TEXT,
  url TEXT,
  abstract TEXT,
  keywords_json TEXT,                    -- JSON array of strings
  notes TEXT,                            -- 用户在 Zotero 里写的 annotation(中文笔记)
  has_pdf INTEGER NOT NULL DEFAULT 0,
  duplicate_group_id TEXT,               -- 去重后同组指同一个 group id;NULL 表示无重复
  duplicate_of_record_id TEXT,           -- 如果是被合并的副本,指向主记录
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES zotero_packages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
CREATE INDEX IF NOT EXISTS idx_records_package ON records(package_id);
CREATE INDEX IF NOT EXISTS idx_records_doi ON records(doi);
CREATE INDEX IF NOT EXISTS idx_records_norm_title ON records(normalized_title);
CREATE INDEX IF NOT EXISTS idx_records_dup_group ON records(duplicate_group_id);
CREATE INDEX IF NOT EXISTS idx_records_year ON records(year);

-- 附件:PDF / HTML snapshot / 其他
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  package_id TEXT,
  attachment_kind TEXT NOT NULL,         -- 'pdf' | 'html' | 'snapshot' | 'other'
  filename TEXT,
  storage_path TEXT NOT NULL,            -- 绝对路径(在服务器上)
  size_bytes INTEGER,
  mime_type TEXT,
  zotero_item_id TEXT,                   -- '#item_1366' 在 RDF 里的 id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES zotero_packages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments(record_id);
CREATE INDEX IF NOT EXISTS idx_attachments_kind ON attachments(attachment_kind);

-- ========================================
-- Phase 5: 筛选 + 抽取
-- ========================================

-- PDF 文本切片(Agent L pdf-parse 写入)
CREATE TABLE IF NOT EXISTS paper_chunks (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  attachment_id TEXT,
  section_type TEXT,             -- abstract | introduction | methods | results | discussion | conclusion | references | other
  heading TEXT,
  page_start INTEGER,
  page_end INTEGER,
  chunk_index INTEGER,
  text TEXT NOT NULL,
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_record ON paper_chunks(record_id);
CREATE INDEX IF NOT EXISTS idx_chunks_section ON paper_chunks(section_type);

-- 筛选决定(Agent M 写入,既有 AI 建议也有人工最终决定)
CREATE TABLE IF NOT EXISTS screening_decisions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'title_abstract' CHECK (stage IN ('title_abstract','full_text')),
  ai_suggestion TEXT CHECK (ai_suggestion IN ('include','exclude','uncertain','not_run')) DEFAULT 'not_run',
  ai_reason TEXT,
  ai_confidence REAL,
  ai_model TEXT,
  ai_matched_inclusion TEXT,    -- JSON array of criterion strings the AI thought matched
  ai_matched_exclusion TEXT,
  ai_need_full_text TEXT,       -- JSON array of fields LLM said need full-text check
  ai_ran_at TEXT,
  human_decision TEXT CHECK (human_decision IN ('include','exclude','uncertain','not_decided')) DEFAULT 'not_decided',
  human_reason TEXT,
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(record_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_screening_project ON screening_decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_screening_ai ON screening_decisions(ai_suggestion);
CREATE INDEX IF NOT EXISTS idx_screening_human ON screening_decisions(human_decision);

-- 全文结构化抽取(Agent N 写入)
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1.0',
  extracted_json TEXT,          -- 整个抽取 JSON 串
  model TEXT,
  prompt_version TEXT,
  human_verified INTEGER NOT NULL DEFAULT 0,
  human_notes TEXT,
  requires_manual_check TEXT,   -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(record_id)
);
CREATE INDEX IF NOT EXISTS idx_extractions_project ON extractions(project_id);

-- ========================================
-- Phase 6: 主题 / Evidence Matrix / 综述初稿
-- ========================================

CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  supporting_record_ids TEXT,   -- JSON array of record_id
  consistent_findings TEXT,     -- JSON array of strings
  conflicting_findings TEXT,    -- JSON array
  evidence_gaps TEXT,           -- JSON array
  evidence_strength TEXT CHECK (evidence_strength IN ('strong','moderate','weak','unclear')),
  generated_by TEXT NOT NULL DEFAULT 'ai',
  model TEXT,
  display_order INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_themes_project ON themes(project_id);

CREATE TABLE IF NOT EXISTS evidence_points (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  theme_id TEXT,
  finding TEXT NOT NULL,
  evidence_type TEXT,           -- empirical | theoretical | review | methodological
  strength TEXT CHECK (strength IN ('strong','moderate','weak','unclear')),
  section TEXT,                 -- 在论文哪一节
  page INTEGER,
  chunk_id TEXT,                -- 反向链回 paper_chunks
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL,
  FOREIGN KEY (chunk_id) REFERENCES paper_chunks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence_points(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_theme ON evidence_points(theme_id);

-- 综述初稿的各章节
CREATE TABLE IF NOT EXISTS draft_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  section_name TEXT NOT NULL,   -- title | abstract | introduction | methods | results | discussion | limitations | conclusion | references
  content_markdown TEXT,
  citation_map TEXT,            -- JSON: [{placeholder, paper_id}, ...]
  model TEXT,
  prompt_version TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, section_name, version)
);
CREATE INDEX IF NOT EXISTS idx_draft_project ON draft_sections(project_id);

-- ========================================
-- Phase 7: 系统设置(admin 配每一步模型等)
-- ========================================

-- 简单 KV 表:管理员可改的系统级配置
-- 当前用 key: step_model.<action_type>(值 = 模型名或 alias 'heavy'/'light')
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by_user_id TEXT
);
