import { describe, it, expect } from 'vitest';
import { mintCapabilityToken, tokensMatch } from '../capability.js';

describe('capability token', () => {
  it('mints a 64-hex-char random token', () => {
    const t = mintCapabilityToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints distinct tokens', () => {
    const a = mintCapabilityToken();
    const b = mintCapabilityToken();
    expect(a).not.toBe(b);
  });

  it('matches a token against itself and rejects any other', () => {
    const a = mintCapabilityToken();
    const b = mintCapabilityToken();
    expect(tokensMatch(a, a)).toBe(true);
    expect(tokensMatch(a, b)).toBe(false);
  });
});
