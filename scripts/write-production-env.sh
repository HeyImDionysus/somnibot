#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: write-production-env.sh /absolute/path/.env" >&2
  exit 64
fi

env_path=$1
case "$env_path" in
  /*/.env) ;;
  *) echo "refusing unsafe environment path" >&2; exit 64 ;;
esac

deploy_dir=$(dirname -- "$env_path")
test -d "$deploy_dir"
if [ -d "$env_path" ] || [ -L "$env_path" ]; then
  echo "refusing non-regular environment target" >&2
  exit 64
fi

umask 077
temp_path="${env_path}.tmp.$$"
backup_temp="${env_path}.rollback.tmp.$$"
lock_dir="${env_path}.write.lock"

if ! mkdir -- "$lock_dir" 2>/dev/null; then
  echo "another protected environment write is already active" >&2
  exit 75
fi

cleanup() {
  rm -f -- "$temp_path" "$backup_temp"
  rmdir -- "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

cat > "$temp_path"
chmod 0600 "$temp_path"

if [ -f "$env_path" ]; then
  cp -p -- "$env_path" "$backup_temp"
  chmod 0600 "$backup_temp"
  mv -f -- "$backup_temp" "${env_path}.rollback"
fi

mv -f -- "$temp_path" "$env_path"
cleanup
trap - EXIT HUP INT TERM
