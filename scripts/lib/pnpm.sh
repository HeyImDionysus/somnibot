#!/usr/bin/env bash
# Resolve pnpm consistently for first-run scripts.

resolve_pnpm() {
  if command -v pnpm &>/dev/null; then
    PNPM_CMD=(pnpm)
    return 0
  fi

  if command -v corepack &>/dev/null; then
    PNPM_CMD=(corepack pnpm)
    return 0
  fi

  echo "pnpm is not available. Install Node.js 22+ and run: corepack enable" >&2
  return 1
}

pnpm_label() {
  printf '%s' "${PNPM_CMD[*]:-pnpm}"
}
