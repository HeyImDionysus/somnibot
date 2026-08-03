/**
 * First-time VPS bootstrap contracts.
 *
 * The launcher is the operator's provisioning surface. A VPS does not need a
 * pre-existing SomniBot checkout: the approved SSH plan creates or updates the
 * checkout from the authoritative GitHub repository before it writes the
 * protected environment or starts Docker.
 *
 * These scripts intentionally install no OS packages and never receive
 * credentials. They fail with an actionable prerequisite message when git or
 * Docker is missing, leaving the host untouched so the operator can install
 * the provider-supported versions and retry safely.
 */

export const SOMNIBOT_REPOSITORY_URL = 'https://github.com/HeyImDionysus/somnibot.git' as const;
export const SOMNIBOT_REPOSITORY_REF = 'main' as const;

/** Read-only probe that supports both an existing checkout and a new path. */
export const VPS_PREFLIGHT_SCRIPT = `#!/bin/sh
set -eu

deploy_path="\${1:-}"
case "$deploy_path" in
  /*) ;;
  *) echo 'deployment path must be absolute' >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./:@+-]*) echo 'deployment path contains unsupported characters' >&2; exit 64 ;;
esac

parent_dir="$(dirname -- "$deploy_path")"
if [ -e "$deploy_path" ]; then
  test -d "$deploy_path" || { echo 'deployment path exists but is not a directory' >&2; exit 73; }
  test -w "$deploy_path" || { echo 'deployment directory is not writable by the SSH user' >&2; exit 73; }
else
  test -d "$parent_dir" || { echo 'parent directory does not exist; choose a path under an existing writable directory' >&2; exit 73; }
  test -w "$parent_dir" || { echo 'parent directory is not writable by the SSH user' >&2; exit 73; }
fi

command -v git >/dev/null 2>&1 || { echo 'git is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }

printf '%s\\n' 'VPS SSH preflight passed: writable target and git/Docker Compose prerequisites are available.'
`;

/**
 * Mutating bootstrap script. It is streamed over SSH stdin, never written to
 * the renderer, command arguments, logs, or the remote filesystem.
 */
export const VPS_BOOTSTRAP_SCRIPT = `#!/bin/sh
set -eu

deploy_path="\${1:-}"
repo_url="\${2:-}"
repo_ref="\${3:-}"

case "$deploy_path" in
  /*) ;;
  *) echo 'deployment path must be absolute' >&2; exit 64 ;;
esac
case "$deploy_path" in
  *[!A-Za-z0-9_./:@+-]*) echo 'deployment path contains unsupported characters' >&2; exit 64 ;;
esac
case "$repo_url" in
  ${SOMNIBOT_REPOSITORY_URL}) ;;
  *) echo 'refusing an unapproved SomniBot repository URL' >&2; exit 64 ;;
esac
case "$repo_ref" in
  ${SOMNIBOT_REPOSITORY_REF}) ;;
  *) echo 'refusing an unapproved SomniBot repository ref' >&2; exit 64 ;;
esac

command -v git >/dev/null 2>&1 || { echo 'git is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required on the VPS before SomniBot can be provisioned' >&2; exit 69; }

parent_dir="$(dirname -- "$deploy_path")"
if [ -e "$deploy_path" ]; then
  test -d "$deploy_path" || { echo 'deployment path exists but is not a directory' >&2; exit 73; }
  if [ ! -d "$deploy_path/.git" ]; then
    if [ -n "$(find "$deploy_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo 'deployment path is not empty and is not a SomniBot git checkout; refusing to overwrite it' >&2
      exit 73
    fi
    git clone --origin origin --depth 1 --branch "$repo_ref" -- "$repo_url" "$deploy_path"
  else
    actual_origin="$(git -C "$deploy_path" remote get-url origin 2>/dev/null || true)"
    test "$actual_origin" = "$repo_url" || { echo 'deployment checkout origin is not the authoritative SomniBot repository' >&2; exit 73; }
    if [ -n "$(git -C "$deploy_path" status --porcelain --untracked-files=all)" ]; then
      echo 'deployment checkout has local changes; refusing to overwrite them' >&2
      exit 73
    fi
  fi
else
  mkdir -p -- "$parent_dir"
  git clone --origin origin --depth 1 --branch "$repo_ref" -- "$repo_url" "$deploy_path"
fi

git -C "$deploy_path" fetch --prune --depth 1 origin "$repo_ref"
git -C "$deploy_path" checkout --detach --force "origin/$repo_ref"

test -f "$deploy_path/docker-compose.prod.yml" || { echo 'SomniBot production compose file is missing from the checkout' >&2; exit 78; }
test -f "$deploy_path/scripts/write-production-env.sh" || { echo 'SomniBot environment writer is missing from the checkout' >&2; exit 78; }
test -f "$deploy_path/scripts/enter-runtime-maintenance.sh" || { echo 'SomniBot runtime maintenance script is missing from the checkout' >&2; exit 78; }

printf '%s\\n' 'SomniBot VPS checkout is ready from the authoritative GitHub source.'
`;
