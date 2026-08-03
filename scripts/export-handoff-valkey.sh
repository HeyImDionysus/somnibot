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

compose_file="$deploy_path/docker-compose.prod.yml"
backup_root=${SOMNIBOT_BACKUP_DIR:-/var/backups/somnibot}
snapshot_file="$backup_root/.handoff-export-$$.rdb"
lock_file="$backup_root/valkey-backup.lock"
state_dir=/var/lib/somnibot-health-recovery
container_snapshot=/tmp/somnibot-valkey-handoff-export.rdb

[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }
mkdir -p "$backup_root" "$state_dir"
exec 8>"$state_dir/recovery.lock"
flock 8
exec 9>"$lock_file"
flock 9

container_id=$(docker compose -f "$compose_file" ps --quiet valkey)
[ -n "$container_id" ] || { echo "Valkey container is not running" >&2; exit 69; }

cleanup() {
  rm -f "$snapshot_file"
  docker compose -f "$compose_file" exec -T valkey rm -f "$container_snapshot" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -f "$compose_file" exec -T valkey valkey-cli --rdb "$container_snapshot" >/dev/null
docker compose -f "$compose_file" exec -T valkey valkey-check-rdb "$container_snapshot" >/dev/null
docker cp "$container_id:$container_snapshot" "$snapshot_file" >/dev/null
[ -s "$snapshot_file" ] || { echo "Valkey handoff snapshot is empty" >&2; exit 74; }
[ "$(dd if="$snapshot_file" bs=5 count=1 2>/dev/null || true)" = "REDIS" ] || {
  echo "Valkey handoff snapshot has an invalid RDB header" >&2
  exit 65
}

# Stdout is reserved exclusively for the binary RDB stream. The launcher writes
# it directly to a mode-0600 file and never retains it in command output/logs.
cat "$snapshot_file"
