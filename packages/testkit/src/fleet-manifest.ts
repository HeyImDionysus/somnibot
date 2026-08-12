/**
 * Resolve the immutable source revision recorded in a fleet manifest.
 *
 * Pull-request workflows expose GITHUB_SHA as the temporary merge ref. The
 * release proof must identify the actual PR head instead, so CI supplies
 * SOMNIBOT_CANDIDATE_SHA explicitly. GITHUB_SHA remains a fallback for other
 * exact-commit runners, but arbitrary/local labels are never valid proof.
 */
export function resolveFleetCandidateSha(env: NodeJS.ProcessEnv = process.env): string {
  const candidateSha = env.SOMNIBOT_CANDIDATE_SHA?.trim()
    || env.GITHUB_SHA?.trim();
  if (!candidateSha || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error('Fleet proof requires an exact 40-character candidate SHA.');
  }
  return candidateSha.toLowerCase();
}
