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
case "$env_path" in
  *[!A-Za-z0-9_./:@+-]*) echo "refusing unsafe environment path" >&2; exit 64 ;;
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
lock_path="${env_path}.write.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for crash-recoverable protected environment writes" >&2
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
# A killed writer cannot run its EXIT trap. Once the lock is held, remove only
# transaction files owned by this environment path before starting a new write.
rm -f -- "${env_path}.tmp."* "${env_path}.rollback.tmp."*

cleanup() {
  rm -f -- "$temp_path" "$backup_temp"
  flock -u 9 2>/dev/null || true
  exec 9>&-
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
