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

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_helper="$deploy_path/scripts/lib/production-compose.sh"
if [ -f "$script_dir/production-compose.sh" ]; then
  compose_helper="$script_dir/production-compose.sh"
fi
. "$compose_helper"
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
  production_compose stop bot dashboard
else
  production_compose stop
fi
