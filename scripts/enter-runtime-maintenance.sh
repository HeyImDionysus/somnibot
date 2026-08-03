#!/bin/sh
set -eu

deploy_path=${1:-}
scope=${2:-all}
case "$deploy_path" in
  /*) ;;
  *) echo "usage: $0 /absolute/deploy/path [consumers|all]" >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./-]*) echo "deploy path contains unsafe characters" >&2; exit 64 ;;
  */../*|*/..) echo "deploy path must not contain parent traversal" >&2; exit 64 ;;
esac
case "$scope" in consumers|all) ;; *) echo "invalid maintenance scope" >&2; exit 64 ;; esac

compose_file="$deploy_path/docker-compose.prod.yml"
state_dir=/var/lib/somnibot-health-recovery
maintenance_file="$state_dir/maintenance"
[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }

mkdir -p "$state_dir"
exec 8>"$state_dir/recovery.lock"
flock 8
umask 077
printf '%s\n' "runtime-handoff:$scope" > "$maintenance_file.partial"
mv "$maintenance_file.partial" "$maintenance_file"

if [ "$scope" = consumers ]; then
  docker compose -f "$compose_file" stop bot dashboard
else
  docker compose -f "$compose_file" stop
fi
