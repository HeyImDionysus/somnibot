#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: restore-production-env.sh /absolute/path/.env" >&2
  exit 64
fi

env_path=$1
case "$env_path" in
  /*/.env) ;;
  *) echo "refusing unsafe environment path" >&2; exit 64 ;;
esac

rollback_path="${env_path}.rollback"
test -f "$rollback_path"

umask 077
temp_path="${env_path}.restore.tmp.$$"
lock_dir="${env_path}.write.lock"

if ! mkdir -- "$lock_dir" 2>/dev/null; then
  echo "another protected environment write is already active" >&2
  exit 75
fi

cleanup() {
  rm -f -- "$temp_path"
  rmdir -- "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

cp -p -- "$rollback_path" "$temp_path"
chmod 0600 "$temp_path"
mv -f -- "$temp_path" "$env_path"
cleanup
trap - EXIT HUP INT TERM
