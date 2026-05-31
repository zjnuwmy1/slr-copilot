#!/usr/bin/env bash
# scripts/cleanup-old-logs.sh
# ---------------------------------------------------------------------------
# 定期清理:删除 90 天前的 audit_events / usage_logs 行,控制 DB 体积。
#
# 为什么不用 SQL 触发器 / FK ON DELETE:
#   SQLite 的 ALTER TABLE 无法在已有列上加 FOREIGN KEY,只能在 CREATE TABLE
#   时加。schema.sql 已经在新建表时写了 FK,**老库**只能靠这个脚本兜底
#   (孤儿 audit_events.user_id IS NULL 之类的也会被自然带走)。
#
# 安装(在 prod 服务器上 SSH 跑):
#   sudo cp /opt/slr/scripts/cleanup-old-logs.sh /usr/local/bin/slr-cleanup-logs
#   sudo chmod +x /usr/local/bin/slr-cleanup-logs
#   sudo crontab -e
#     # 每天凌晨 03:30 清理 90 天前的日志(避开备份的 03:00)
#     30 3 * * * /usr/local/bin/slr-cleanup-logs >> /var/log/slr-cleanup.log 2>&1
#
# 手工跑一次:
#   sudo -u slr /opt/slr/scripts/cleanup-old-logs.sh
#
# Dry-run(只 SELECT 计数,不 DELETE):
#   DRY_RUN=1 /opt/slr/scripts/cleanup-old-logs.sh
#
# TODO(归档):当前直接 DELETE 删除。等数据量上 TB,或合规要求保留更久(例如
#   计费 / 审计满 1 年)时,把这里改成"先 INSERT INTO usage_logs_archive ...
#   SELECT 旧行;再 DELETE"两步,并把 archive 表放到独立 DB 文件(避免拖慢
#   主库 query plan + 减小主库 VACUUM 时长)。本批 (Batch 5) 故意没建归档表,
#   等 schema 改造批次再做。
# ---------------------------------------------------------------------------

set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/slr/db/slr.db}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[cleanup-old-logs] ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "[$(ts)] cleanup-old-logs start (DB=$DB_PATH, retention=${RETENTION_DAYS}d, dry_run=$DRY_RUN)"

# 2026-05-31:时间戳已统一 SGT(+8h),retention 比较两边都用 SGT now,语义一致
#   (90 天窗口下 8h 偏差可忽略,但保持一致)

# 先 SELECT 计数(给日志一份"将删多少")
AUDIT_COUNT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM audit_events WHERE created_at < datetime('now','+8 hours','-${RETENTION_DAYS} days');")
USAGE_COUNT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM usage_logs WHERE started_at < datetime('now','+8 hours','-${RETENTION_DAYS} days');")

echo "[$(ts)] would delete: audit_events=$AUDIT_COUNT  usage_logs=$USAGE_COUNT"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[$(ts)] DRY_RUN=1, no DELETE executed. bye."
  exit 0
fi

# 实际删除(用单个事务,避免半途崩了一半数据被删一半保留)
sqlite3 "$DB_PATH" <<SQL
BEGIN;
DELETE FROM audit_events WHERE created_at < datetime('now','+8 hours','-${RETENTION_DAYS} days');
DELETE FROM usage_logs   WHERE started_at < datetime('now','+8 hours','-${RETENTION_DAYS} days');
COMMIT;
SQL

# VACUUM:默认 NOT 跑(要 2× DB 大小磁盘 + 独占锁,会卡在线服务几秒)。
#   日常 cron 保持非阻塞;维护窗口手动跑:`RUN_VACUUM=1 /opt/slr/scripts/cleanup-old-logs.sh`
#   或直接 `sqlite3 /var/lib/slr/db/slr.db 'VACUUM;'`(建议先 systemctl stop slr)
if [[ "${RUN_VACUUM:-0}" == "1" ]]; then
  echo "[$(ts)] RUN_VACUUM=1 — running VACUUM (会独占锁,在线服务会短暂卡顿)..."
  BEFORE=$(stat -c%s "$DB_PATH" 2>/dev/null || echo 0)
  sqlite3 "$DB_PATH" 'VACUUM;'
  AFTER=$(stat -c%s "$DB_PATH" 2>/dev/null || echo 0)
  echo "[$(ts)] VACUUM done: ${BEFORE} -> ${AFTER} bytes (reclaimed $((BEFORE - AFTER)))"
fi

echo "[$(ts)] cleanup-old-logs done"
