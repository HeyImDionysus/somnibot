/**
 * Resolve the immutable source revision recorded in a fleet manifest.
 *
 * Pull-request workflows expose GITHUB_SHA as the temporary merge ref. The
 * release proof must identify the actual PR head instead, so CI supplies
 * SOMNIBOT_CANDIDATE_SHA explicitly and this helper keeps GITHUB_SHA only as
 * a backwards-compatible fallback for other runners.
 */
export function resolveFleetCandidateSha(env: NodeJS.ProcessEnv = process.env): string {
  return env.SOMNIBOT_CANDIDATE_SHA?.trim()
    || env.GITHUB_SHA?.trim()
    || 'local';
}
