#!/bin/sh
set -eu
umask 077

deploy_path=${1:-}
case "$deploy_path" in
  /*) ;;
  *) echo "usage: $0 /absolute/deploy/path" >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./-]*) echo "deploy path contains unsafe characters" >&2; exit 64 ;;
  */../*|*/..) echo "deploy path must not contain parent traversal" >&2; exit 64 ;;
esac

. "$deploy_path/scripts/lib/production-compose.sh"
backup_root=${SOMNIBOT_BACKUP_DIR:-/var/backups/somnibot}
backup_dir="$backup_root/valkey"
lock_file="$backup_root/valkey-backup.lock"
retention_days=${SOMNIBOT_BACKUP_RETENTION_DAYS:-14}
case "$retention_days" in ''|0|*[!0-9]*) echo "invalid backup retention" >&2; exit 64 ;; esac

[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }
mkdir -p "$backup_dir"
exec 9>"$lock_file"
flock -n 9 || exit 0

container_id=$(production_compose ps --quiet valkey)
[ -n "$container_id" ] || { echo "Valkey container is not running" >&2; exit 69; }

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
container_snapshot=/tmp/somnibot-valkey-backup.rdb
temporary_backup="$backup_dir/.valkey-$timestamp.rdb.partial"
final_backup="$backup_dir/valkey-$timestamp.rdb"

cleanup() {
  rm -f "$temporary_backup"
  production_compose exec -T valkey rm -f "$container_snapshot" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

production_compose exec -T valkey valkey-cli --rdb "$container_snapshot" >/dev/null
production_compose exec -T valkey valkey-check-rdb "$container_snapshot" >/dev/null
docker cp "$container_id:$container_snapshot" "$temporary_backup" >/dev/null
[ -s "$temporary_backup" ] || { echo "Valkey backup is empty" >&2; exit 74; }
mv "$temporary_backup" "$final_backup"
sha256sum "$final_backup" > "$final_backup.sha256"
chmod 0600 "$final_backup" "$final_backup.sha256"

find "$backup_dir" -type f -name 'valkey-*.rdb' -mtime "+$retention_days" -delete
find "$backup_dir" -type f -name 'valkey-*.rdb.sha256' -mtime "+$retention_days" -delete
logger -t somnibot-backup -- "Created validated Valkey backup $final_backup"
printf '%s\n' "$final_backup"
