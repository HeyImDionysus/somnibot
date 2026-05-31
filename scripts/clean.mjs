#!/usr/bin/env node
/**
 * Cross-platform clean utility — replaces `rm -rf` in package scripts
 * so builds work on Windows (cmd / PowerShell) as well as macOS / Linux.
 *
 * Usage:  node scripts/clean.mjs path1 [path2 ...]
 *
 * Silently removes each target (file or directory). Exits 0 even when a
 * target does not exist, matching the behaviour of `rm -rf`.
 */
import { rmSync } from 'node:fs';

for (const target of process.argv.slice(2)) {
  rmSync(target, { recursive: true, force: true });
}
