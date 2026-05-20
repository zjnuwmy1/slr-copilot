-- SLR Copilot — Phase 0 schema
-- 后续 phase 在此追加表(projects / protocols / records / papers / ...)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  invite_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_events(event_type);
