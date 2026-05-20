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
