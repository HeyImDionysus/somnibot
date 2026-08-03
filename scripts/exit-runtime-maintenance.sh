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

compose_file="$deploy_path/docker-compose.prod.yml"
state_dir=/var/lib/somnibot-health-recovery
[ -f "$compose_file" ] || { echo "compose file not found: $compose_file" >&2; exit 66; }

mkdir -p "$state_dir"
exec 8>"$state_dir/recovery.lock"
flock 8
rm -f "$state_dir/maintenance" "$state_dir/maintenance.partial"
logger -t somnibot-handoff -- "VPS runtime maintenance ended after verified startup"
