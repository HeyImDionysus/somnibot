#!/bin/sh
set -eu

deploy_path=${1:-}
backup_file=${2:-}
case "$deploy_path" in
  /*) ;;
  *) echo "usage: $0 /absolute/deploy/path /var/backups/somnibot/valkey/valkey-TIMESTAMP.rdb" >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./-]*) echo "deploy path contains unsafe characters" >&2; exit 64 ;;
  */../*|*/..) echo "deploy path must not contain parent traversal" >&2; exit 64 ;;
esac

. "$deploy_path/scripts/lib/production-compose.sh"
backup_root=${SOMNIBOT_BACKUP_DIR:-/var/backups/somnibot}
backup_dir="$backup_root/valkey"
if [ "$(dirname "$backup_file")" != "$backup_dir" ]; then
  echo "backup must be directly under $backup_dir" >&2
  exit 64
fi
case "$(basename "$backup_file")" in
  valkey-[0-9]*T[0-9]*Z.rdb) ;;
  *) echo "backup filename is not a SomniBot Valkey snapshot" >&2; exit 64 ;;
esac
[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }
[ -f "$backup_file" ] || { echo "backup file not found: $backup_file" >&2; exit 66; }
[ -f "$backup_file.sha256" ] || { echo "backup checksum not found: $backup_file.sha256" >&2; exit 66; }
(cd "$(dirname "$backup_file")" && sha256sum -c "$(basename "$backup_file").sha256")

# Exclude the automatic health repair and scheduled backup while the manual
# restore owns the Valkey lifecycle.
mkdir -p /var/lib/somnibot-health-recovery /var/backups/somnibot
exec 8>/var/lib/somnibot-health-recovery/recovery.lock
flock 8
exec 9>/var/backups/somnibot/valkey-backup.lock
flock 9

container_id=$(production_compose ps --quiet valkey)
[ -n "$container_id" ] || { echo "Valkey container must be running before restore" >&2; exit 69; }

validation_file=/tmp/somnibot-valkey-restore-validation.rdb
docker cp "$backup_file" "$container_id:$validation_file" >/dev/null
production_compose exec -T valkey valkey-check-rdb "$validation_file" >/dev/null
production_compose exec -T valkey rm -f "$validation_file"

production_compose stop valkey
restore_failed=true
restore_cleanup() {
  if [ "$restore_failed" = true ]; then
    production_compose start valkey >/dev/null 2>&1 || true
  fi
}
trap restore_cleanup EXIT INT TERM

docker cp "$backup_file" "$container_id:/data/dump.rdb" >/dev/null
production_compose start valkey

attempt=0
while [ "$attempt" -lt 30 ]; do
  if production_compose exec -T valkey valkey-cli ping 2>/dev/null | grep -q '^PONG$'; then
    restore_failed=false
    trap - EXIT INT TERM
    logger -t somnibot-backup -- "Restored Valkey from $(basename "$backup_file")"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Valkey did not become healthy after restore" >&2
exit 70
