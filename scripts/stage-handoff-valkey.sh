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

handoff_dir="$deploy_path/.runtime-handoff"
partial_file="$handoff_dir/valkey.rdb.partial"
snapshot_file="$handoff_dir/valkey.rdb"
checksum_file="$snapshot_file.sha256"

mkdir -p "$handoff_dir"
chmod 0700 "$handoff_dir"
cleanup() {
  rm -f "$partial_file"
}
trap cleanup EXIT INT TERM

cat > "$partial_file"
if [ ! -s "$partial_file" ]; then
  rm -f "$partial_file" "$snapshot_file" "$checksum_file"
  rmdir "$handoff_dir" 2>/dev/null || true
  trap - EXIT INT TERM
  exit 0
fi
header=$(dd if="$partial_file" bs=5 count=1 2>/dev/null || true)
[ "$header" = "REDIS" ] || { echo "staged file is not a Valkey RDB snapshot" >&2; exit 65; }

mv "$partial_file" "$snapshot_file"
(cd "$handoff_dir" && sha256sum "$(basename "$snapshot_file")" > "$(basename "$checksum_file")")
chmod 0600 "$snapshot_file" "$checksum_file"
trap - EXIT INT TERM
printf '%s\n' "$snapshot_file"
