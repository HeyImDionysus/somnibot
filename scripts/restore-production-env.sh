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
case "$env_path" in
  *[!A-Za-z0-9_./:@+-]*) echo "refusing unsafe environment path" >&2; exit 64 ;;
esac

rollback_path="${env_path}.rollback"
test -f "$rollback_path"

umask 077
temp_path="${env_path}.restore.tmp.$$"
lock_path="${env_path}.write.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for crash-recoverable protected environment restores" >&2
  exit 69
fi
if ! exec 9>"$lock_path" 2>/dev/null; then
  echo "could not open protected environment lock file" >&2
  exit 75
fi
if ! flock -n 9; then
  echo "another protected environment write is already active" >&2
  exit 75
fi
rm -f -- "${env_path}.restore.tmp."*

cleanup() {
  rm -f -- "$temp_path"
  flock -u 9 2>/dev/null || true
  exec 9>&-
}
trap cleanup EXIT HUP INT TERM

cp -p -- "$rollback_path" "$temp_path"
chmod 0600 "$temp_path"
mv -f -- "$temp_path" "$env_path"
cleanup
trap - EXIT HUP INT TERM
