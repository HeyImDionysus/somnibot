#!/bin/sh
set -eu

deploy_path=${1:-}
case "$deploy_path" in
  /*) ;;
  *) echo "usage: $0 /absolute/deploy/path" >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./-]*) echo "deploy path contains unsafe characters" >&2; exit 64 ;;
  */../*|*/..) echo "deploy path must not contain parent traversal" >&2; exit 64 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_helper="$deploy_path/scripts/lib/production-compose.sh"
if [ -f "$script_dir/production-compose.sh" ]; then
  compose_helper="$script_dir/production-compose.sh"
fi
. "$compose_helper"
handoff_dir="$deploy_path/.runtime-handoff"
snapshot_file="$handoff_dir/valkey.rdb"
checksum_file="$snapshot_file.sha256"
[ -f "$snapshot_file" ] || exit 0
[ -f "$checksum_file" ] || { echo "staged Valkey checksum is missing" >&2; exit 66; }
[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }
(cd "$handoff_dir" && sha256sum -c "$(basename "$checksum_file")")

backup_root=/var/backups/somnibot
backup_dir="$backup_root/valkey"
mkdir -p /var/lib/somnibot-health-recovery "$backup_dir"
exec 8>/var/lib/somnibot-health-recovery/recovery.lock
flock 8
exec 9>"$backup_root/valkey-backup.lock"
flock 9

container_id=$(production_compose ps --quiet valkey)
[ -n "$container_id" ] || { echo "Valkey container must be running before handoff restore" >&2; exit 69; }

validation_file=/tmp/somnibot-handoff-validation.rdb
recovery_container_file=/tmp/somnibot-handoff-recovery.rdb
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
recovery_partial="$backup_dir/.valkey-pre-handoff-$timestamp-$$.rdb.partial"
recovery_backup="$backup_dir/valkey-pre-handoff-$timestamp-$$.rdb"
cleanup_files() {
  rm -f "$recovery_partial"
  production_compose exec -T valkey rm -f "$validation_file" "$recovery_container_file" >/dev/null 2>&1 || true
}
trap cleanup_files EXIT INT TERM

docker cp "$snapshot_file" "$container_id:$validation_file" >/dev/null
production_compose exec -T valkey valkey-check-rdb "$validation_file" >/dev/null
production_compose exec -T valkey valkey-cli --rdb "$recovery_container_file" >/dev/null
production_compose exec -T valkey valkey-check-rdb "$recovery_container_file" >/dev/null
docker cp "$container_id:$recovery_container_file" "$recovery_partial" >/dev/null
[ -s "$recovery_partial" ] || { echo "Current VPS Valkey rollback snapshot is empty" >&2; exit 74; }
mv "$recovery_partial" "$recovery_backup"
sha256sum "$recovery_backup" > "$recovery_backup.sha256"
chmod 0600 "$recovery_backup" "$recovery_backup.sha256"
production_compose exec -T valkey rm -f "$validation_file" "$recovery_container_file"

production_compose stop valkey
restore_failed=true
restore_cleanup() {
  if [ "$restore_failed" = true ]; then
    production_compose stop valkey >/dev/null 2>&1 || true
    docker cp "$recovery_backup" "$container_id:/data/dump.rdb" >/dev/null 2>&1 || true
    production_compose start valkey >/dev/null 2>&1 || true
  fi
  cleanup_files
}
trap restore_cleanup EXIT INT TERM

docker cp "$snapshot_file" "$container_id:/data/dump.rdb" >/dev/null
production_compose start valkey

attempt=0
while [ "$attempt" -lt 30 ]; do
  if production_compose exec -T valkey valkey-cli ping 2>/dev/null | grep -q '^PONG$'; then
    restore_failed=false
    trap - EXIT INT TERM
    rm -f "$snapshot_file" "$checksum_file"
    rmdir "$handoff_dir" 2>/dev/null || true
    logger -t somnibot-handoff -- "Restored transferred Valkey state before VPS bot startup; rollback snapshot: $recovery_backup"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Valkey did not become healthy after handoff restore" >&2
exit 70
