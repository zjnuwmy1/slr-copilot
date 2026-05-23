#!/usr/bin/env bash
# scripts/backup-db.sh
# ---------------------------------------------------------------------------
# DB 在线快照 + gzip + 30 天滚动保留。
#
# 为什么用 sqlite3 .backup 而不是 cp:
#   cp 在写入并发下会拷出半坏文件(WAL + 主库不一致),
#   .backup 命令使用 SQLite 的 Online Backup API,无锁,业务无感。
#
# 安装(在 prod 服务器上 SSH 跑一次):
#   sudo cp /opt/slr/scripts/backup-db.sh /usr/local/bin/slr-backup-db
#   sudo chmod +x /usr/local/bin/slr-backup-db
#   sudo mkdir -p /backup && sudo chown slr:slr /backup
#   sudo crontab -e
#     # 每天凌晨 03:00 做 DB 备份(避开 03:30 的日志清理,先备份再清理更安全)
#     0 3 * * * /usr/local/bin/slr-backup-db >> /var/log/slr-backup.log 2>&1
#
# 手工跑一次:
#   sudo -u slr /opt/slr/scripts/backup-db.sh
#
# 验证备份没坏:
#   gunzip -c /backup/slr-YYYYMMDD.db.gz > /tmp/restore-test.db
#   sqlite3 /tmp/restore-test.db 'PRAGMA integrity_check; SELECT COUNT(*) FROM users;'
#
# 异地备份(可选,后续接 OSS):
#   rclone copy /backup/ oss:slr-backup/ --include 'slr-*.db.gz' --max-age 25h
# ---------------------------------------------------------------------------

set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/slr/db/slr.db}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TMP_DIR="${TMP_DIR:-/tmp}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup-db] ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
DATE_STAMP=$(date '+%Y%m%d')

SNAPSHOT_PATH="${TMP_DIR}/slr-${DATE_STAMP}.db"
FINAL_PATH="${BACKUP_DIR}/slr-${DATE_STAMP}.db.gz"

echo "[$(ts)] backup-db start (DB=$DB_PATH → $FINAL_PATH)"

# 1) 在线快照到 /tmp(避免在 /backup 留半成品)
sqlite3 "$DB_PATH" ".backup '${SNAPSHOT_PATH}'"
SNAPSHOT_BYTES=$(stat -c%s "$SNAPSHOT_PATH" 2>/dev/null || stat -f%z "$SNAPSHOT_PATH")
echo "[$(ts)] snapshot ok, ${SNAPSHOT_BYTES} bytes"

# 2) integrity_check 防止快照本身坏了(避免每天备出来的全是坏的)
INTEGRITY=$(sqlite3 "$SNAPSHOT_PATH" 'PRAGMA integrity_check;' | head -1)
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "[$(ts)] ERROR: snapshot integrity_check failed: $INTEGRITY" >&2
  rm -f "$SNAPSHOT_PATH"
  exit 2
fi

# 3) gzip 后挪到 /backup
gzip -f "$SNAPSHOT_PATH"          # 会生成 ${SNAPSHOT_PATH}.gz
mv "${SNAPSHOT_PATH}.gz" "$FINAL_PATH"
GZ_BYTES=$(stat -c%s "$FINAL_PATH" 2>/dev/null || stat -f%z "$FINAL_PATH")
echo "[$(ts)] gzipped → $FINAL_PATH (${GZ_BYTES} bytes)"

# 4) 滚动保留 30 天(注意 -name pattern 只匹配自己产生的,避免误删)
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'slr-*.db.gz' -mtime "+${RETENTION_DAYS}" -print -delete

echo "[$(ts)] backup-db done"
