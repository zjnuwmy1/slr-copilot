#!/bin/bash
# migrate-utc-to-sgt.sh — one-shot migration converting all existing UTC timestamps to SGT (+08:00).
#
# Run on prod ONCE after deploying the SGT code changes (datetime('now', '+8 hours')).
# Backs up the DB first.
#
# Pattern: every column named *_at across every user table gets `+8 hours` applied
#          only to rows where the column is non-null.
#
# Safe to re-run? NO — running twice would double-add 16 hours. Tracked via system_settings.
#
# Usage:
#   bash scripts/migrate-utc-to-sgt.sh /var/lib/slr/db/slr.db

set -euo pipefail
DB="${1:-/var/lib/slr/db/slr.db}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB file not found: $DB" >&2
  exit 1
fi

# Idempotency guard
ALREADY=$(sqlite3 "$DB" "SELECT value FROM system_settings WHERE key='tz_migration_utc_to_sgt';" 2>/dev/null || echo '')
if [ -n "$ALREADY" ]; then
  echo "Migration already run at: $ALREADY"
  echo "If you really need to re-run, manually DELETE FROM system_settings WHERE key='tz_migration_utc_to_sgt'."
  exit 0
fi

# Backup
TS=$(date -u +%Y%m%d-%H%M%S)
BACKUP="${DB}.backup-utc-to-sgt-${TS}.db"
echo "[1/3] Backing up DB to $BACKUP ..."
cp "$DB" "$BACKUP"
echo "      backup size: $(ls -lh "$BACKUP" | awk '{print $5}')"

# Build all UPDATE statements
echo "[2/3] Discovering timestamp columns and building UPDATEs ..."
SQL_FILE=$(mktemp /tmp/tz-migrate.XXXXXX.sql)
{
  echo "BEGIN;"
  # For every user table (sqlite_% are system), find every column ending in _at
  sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" | while read -r tbl; do
    [ -z "$tbl" ] && continue
    sqlite3 "$DB" "PRAGMA table_info(\"$tbl\");" | awk -F'|' -v t="$tbl" '
      $2 ~ /_at$/ && ($3 == "TEXT" || $3 == "DATETIME" || $3 == "") {
        printf "UPDATE \"%s\" SET \"%s\" = datetime(\"%s\", '\''+8 hours'\'') WHERE \"%s\" IS NOT NULL AND \"%s\" != '\'''\'' AND \"%s\" NOT LIKE '\''%%+%%'\'' AND \"%s\" NOT LIKE '\''%%Z'\'';\n", t, $2, $2, $2, $2, $2, $2
      }'
  done
  # Mark migration done
  echo "INSERT OR REPLACE INTO system_settings (key, value, updated_by_user_id, updated_at) VALUES ('tz_migration_utc_to_sgt', datetime('now', '+8 hours'), NULL, datetime('now', '+8 hours'));"
  echo "COMMIT;"
} > "$SQL_FILE"

echo "      generated $(grep -c '^UPDATE' "$SQL_FILE") UPDATE statements"
echo "      preview (first 10):"
grep '^UPDATE' "$SQL_FILE" | head -10 | sed 's/^/        /'

# Run it
echo "[3/3] Running migration ..."
sqlite3 "$DB" < "$SQL_FILE"

# Cleanup
rm -f "$SQL_FILE"

echo "DONE. Sample post-migration timestamps:"
sqlite3 "$DB" "
SELECT 'users.created_at sample' AS k, created_at FROM users LIMIT 1
UNION ALL SELECT 'batch_jobs.started_at sample', started_at FROM batch_jobs WHERE started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1
UNION ALL SELECT 'usage_logs.started_at sample', started_at FROM usage_logs ORDER BY id DESC LIMIT 1;
"
echo ""
echo "Backup retained at: $BACKUP"
echo "To roll back: systemctl stop slr && cp \"$BACKUP\" \"$DB\" && systemctl start slr"
