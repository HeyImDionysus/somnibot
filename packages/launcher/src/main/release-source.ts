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
type ReleaseSource = {
  readonly repositoryRef: string;
  readonly migrationHead: string;
  readonly configurationGeneration: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPackagedReleaseSource(): ReleaseSource | null {
  try {
    const raw = fs.readFileSync(path.join(MODULE_DIR, 'release-source.json'), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const repositoryRef = value.repositoryRef;
    const migrationHead = value.migrationHead;
    const configurationGeneration = value.configurationGeneration;
    if (typeof repositoryRef !== 'string' || !SHA_RE.test(repositoryRef.trim())) return null;
    if (typeof migrationHead !== 'string' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(migrationHead)) return null;
    if (!Number.isSafeInteger(configurationGeneration) || Number(configurationGeneration) < 0) return null;
    return {
      repositoryRef: repositoryRef.trim().toLowerCase(),
      migrationHead,
      configurationGeneration: Number(configurationGeneration),
    };
  } catch {
    return null;
  }
}

/**
 * Unit tests exercise the plan without a packaged release resource. The
 * test-only fallback keeps those tests deterministic; production code blocks
 * any VPS plan when the build did not embed an exact commit SHA.
 */
const releaseSource = process.env.NODE_ENV === 'test'
  ? {
      repositoryRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      migrationHead: '20260823173000_experience_runtime_controls.sql',
      configurationGeneration: 20260823173000,
    }
  : readPackagedReleaseSource();

export const SOMNIBOT_REPOSITORY_REF = releaseSource?.repositoryRef ?? '';
export const SOMNIBOT_MIGRATION_HEAD = releaseSource?.migrationHead ?? '';
export const SOMNIBOT_CONFIGURATION_GENERATION = releaseSource?.configurationGeneration ?? -1;

export function isImmutableRepositoryRef(value: string): boolean {
  return SHA_RE.test(value.trim());
}
