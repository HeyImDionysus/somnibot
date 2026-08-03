/**
 * First-time VPS bootstrap contracts.
 *
 * The launcher is the operator's provisioning surface. A VPS does not need a
 * pre-existing SomniBot checkout: the approved SSH plan creates or updates the
 * checkout from the authoritative GitHub repository before it writes the
 * protected environment or starts Docker.
 *
 * The runtime script installs only fixed distro packages on supported
 * Ubuntu/Debian hosts; the checkout and preflight scripts never receive
 * application credentials. Unsupported hosts and unsafe targets fail with an
 * actionable message before any unrelated files are overwritten.
 */

import { SOMNIBOT_REPOSITORY_REF } from './release-source.js';

export const SOMNIBOT_REPOSITORY_URL = 'https://github.com/HeyImDionysus/somnibot.git' as const;
export { SOMNIBOT_REPOSITORY_REF } from './release-source.js';

// Keep the generated shell syntactically valid when a non-packaged build has
// no release resource. The deployment-plan layer blocks that build before any
// command can be approved or receive credentials.
const APPROVED_REPOSITORY_REF = SOMNIBOT_REPOSITORY_REF || '__missing_release_sha__';

/**
 * Idempotent host-runtime bootstrap for supported Ubuntu/Debian VPS hosts.
 *
 * The script is streamed over the approved SSH command and never receives
 * application credentials. It installs only distro packages when Docker or
 * Compose is missing, enables the Docker service, and leaves unsupported
 * operating systems untouched.
 */
export const VPS_RUNTIME_BOOTSTRAP_SCRIPT = `#!/bin/sh
set -eu

operator_user="\${1:-}"
case "$operator_user" in
  [a-z_][a-z0-9_-]*|[a-z_][a-z0-9_-]*$) ;;
  *) echo 'SSH user is not a supported Linux account name' >&2; exit 64 ;;
esac

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || { echo 'root or passwordless sudo is required to install the VPS runtime' >&2; exit 77; }
    sudo -n "$@"
  fi
}

if [ ! -r /etc/os-release ]; then
  echo 'VPS runtime bootstrap requires /etc/os-release' >&2
  exit 69
fi
. /etc/os-release
case "\${ID:-}" in
  ubuntu|debian) ;;
  *) echo "unsupported VPS operating system: \${ID:-unknown}; supported systems are Ubuntu and Debian" >&2; exit 69 ;;
esac

command -v apt-get >/dev/null 2>&1 || { echo 'apt-get is required on Ubuntu/Debian VPS hosts' >&2; exit 69; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required to manage the Docker service' >&2; exit 69; }

docker_ready=0
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker_ready=1
fi
git_ready=0
if command -v git >/dev/null 2>&1; then
  git_ready=1
fi

if [ "$docker_ready" -eq 0 ] || [ "$git_ready" -eq 0 ]; then
  run_privileged apt-get update
  runtime_packages='ca-certificates'
  if ! command -v docker >/dev/null 2>&1; then
    runtime_packages="$runtime_packages docker.io"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    runtime_packages="$runtime_packages docker-compose-v2"
  fi
  if ! command -v git >/dev/null 2>&1; then
    runtime_packages="$runtime_packages git"
  fi
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $runtime_packages
fi

run_privileged systemctl enable --now docker

if [ "$(id -u)" -ne 0 ]; then
  if ! id -nG "$operator_user" 2>/dev/null | tr ' ' '\\n' | grep -qx docker; then
    run_privileged usermod -aG docker "$operator_user"
    echo 'Docker access was granted to the SSH user; subsequent SSH commands will use the new group membership.'
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is still unavailable after runtime bootstrap' >&2; exit 69; }
else
  if id -nG | tr ' ' '\\n' | grep -qx docker; then
    docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is still unavailable after runtime bootstrap' >&2; exit 69; }
  else
    sudo -n docker compose version >/dev/null 2>&1 || { echo 'Docker was installed, but the SSH user needs a new login before Docker access is available' >&2; exit 75; }
  fi
fi

printf '%s\\n' 'VPS runtime is ready: Docker service enabled and Docker Compose v2 available.'
`;

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
  ${APPROVED_REPOSITORY_REF}) ;;
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
