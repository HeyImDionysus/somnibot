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
lock_file="$state_dir/recovery.lock"
max_attempts=5
attempt_window_seconds=900

if [ ! -f "$compose_file" ]; then
  echo "SomniBot recovery: compose file not found at $compose_file" >&2
  exit 66
fi

mkdir -p "$state_dir"
exec 9>"$lock_file"
if ! flock -n 9; then
  exit 0
fi

log() {
  logger -t somnibot-health-recovery -- "$*"
  printf '%s\n' "$*"
}

containers=$(docker compose -f "$compose_file" ps --all --quiet)
if [ -z "$containers" ]; then
  stack_state="$state_dir/_stack.state"
  now=$(date +%s)
  attempts=0
  first_attempt=$now
  if [ -f "$stack_state" ]; then
    IFS='|' read -r attempts first_attempt < "$stack_state" || true
    case "$attempts" in ''|*[!0-9]*) attempts=0 ;; esac
    case "$first_attempt" in ''|*[!0-9]*) first_attempt=$now ;; esac
  fi
  if [ $((now - first_attempt)) -ge "$attempt_window_seconds" ]; then
    attempts=0
    first_attempt=$now
  fi
  if [ "$attempts" -ge "$max_attempts" ]; then
    log "No production containers exist; automatic stack recovery is exhausted after $max_attempts attempts in 15 minutes."
    exit 1
  fi
  attempts=$((attempts + 1))
  printf '%s|%s\n' "$attempts" "$first_attempt" > "$stack_state"
  log "No production containers exist; starting the exact Compose project (attempt $attempts/$max_attempts)."
  docker compose -f "$compose_file" up -d
  exit $?
fi
rm -f "$state_dir/_stack.state"

now=$(date +%s)
for container_id in $containers; do
  record=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")
  status=${record%%|*}
  remainder=${record#*|}
  health=${remainder%%|*}
  service=${remainder#*|}

  case "$service" in
    ''|*[!A-Za-z0-9_-]*)
      log "Ignoring container $container_id with an unsafe or missing Compose service label."
      continue
      ;;
  esac

  state_file="$state_dir/$service.state"
  if [ "$status" = running ] && [ "$health" = starting ]; then
    continue
  fi
  if [ "$status" = running ] && { [ "$health" = healthy ] || [ "$health" = none ]; }; then
    rm -f "$state_file"
    continue
  fi

  attempts=0
  first_attempt=$now
  if [ -f "$state_file" ]; then
    IFS='|' read -r attempts first_attempt < "$state_file" || true
    case "$attempts" in ''|*[!0-9]*) attempts=0 ;; esac
    case "$first_attempt" in ''|*[!0-9]*) first_attempt=$now ;; esac
  fi
  if [ $((now - first_attempt)) -ge "$attempt_window_seconds" ]; then
    attempts=0
    first_attempt=$now
  fi
  if [ "$attempts" -ge "$max_attempts" ]; then
    log "$service remains $status/$health; automatic recovery is exhausted after $max_attempts attempts in 15 minutes."
    continue
  fi

  attempts=$((attempts + 1))
  printf '%s|%s\n' "$attempts" "$first_attempt" > "$state_file"
  log "Recovering $service from $status/$health (attempt $attempts/$max_attempts)."
  if [ "$status" = running ]; then
    docker compose -f "$compose_file" restart "$service"
  else
    docker compose -f "$compose_file" up -d --no-deps "$service"
  fi
done
