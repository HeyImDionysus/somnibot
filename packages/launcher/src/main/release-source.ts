import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The packaged launcher receives this file from build-launcher.mjs. Keeping
 * the approved source ref beside the compiled main process means a VPS plan
 * can approve and deploy one immutable commit rather than whatever `main`
 * happens to point at later.
 */
function readPackagedReleaseSha(): string {
  try {
    const raw = fs.readFileSync(path.join(MODULE_DIR, 'release-source.json'), 'utf8');
    const value = (JSON.parse(raw) as { repositoryRef?: unknown }).repositoryRef;
    return typeof value === 'string' && SHA_RE.test(value.trim()) ? value.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Unit tests exercise the plan without a packaged release resource. The
 * test-only fallback keeps those tests deterministic; production code blocks
 * any VPS plan when the build did not embed an exact commit SHA.
 */
export const SOMNIBOT_REPOSITORY_REF = process.env.NODE_ENV === 'test'
  ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  : readPackagedReleaseSha();

export function isImmutableRepositoryRef(value: string): boolean {
  return SHA_RE.test(value.trim());
}
