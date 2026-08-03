import { describe, expect, it } from 'vitest';
import { resolveFleetCandidateSha } from '../fleet-manifest.js';

describe('fleet manifest candidate SHA', () => {
  it('prefers the explicit candidate SHA over GitHub merge-ref metadata', () => {
    expect(resolveFleetCandidateSha({
      SOMNIBOT_CANDIDATE_SHA: 'head-sha',
      GITHUB_SHA: 'synthetic-merge-sha',
    })).toBe('head-sha');
  });

  it('falls back to GITHUB_SHA for non-PR runners', () => {
    expect(resolveFleetCandidateSha({ GITHUB_SHA: 'main-sha' })).toBe('main-sha');
  });

  it('uses a deterministic local marker when no runner SHA exists', () => {
    expect(resolveFleetCandidateSha({})).toBe('local');
  });
});
