import { describe, expect, it } from 'vitest';
import { resolveFleetCandidateSha } from '../fleet-manifest.js';

describe('fleet manifest candidate SHA', () => {
  it('prefers the explicit candidate SHA over GitHub merge-ref metadata', () => {
    expect(resolveFleetCandidateSha({
      SOMNIBOT_CANDIDATE_SHA: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('falls back to GITHUB_SHA for non-PR runners', () => {
    expect(resolveFleetCandidateSha({
      GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('rejects proof when no exact revision is available', () => {
    expect(() => resolveFleetCandidateSha({})).toThrow(/exact 40-character candidate SHA/);
    expect(() => resolveFleetCandidateSha({ GITHUB_SHA: 'local' })).toThrow(/exact 40-character candidate SHA/);
  });
});
