import { describe, expect, it } from 'vitest';
import { shouldOpenDevTools } from '../main/devtools-policy.js';

describe('shouldOpenDevTools', () => {
  it('keeps DevTools closed for normal development startup', () => {
    expect(shouldOpenDevTools(false, undefined)).toBe(false);
    expect(shouldOpenDevTools(false, '0')).toBe(false);
  });

  it('allows explicit development diagnostics', () => {
    expect(shouldOpenDevTools(false, '1')).toBe(true);
  });

  it('never opens DevTools in packaged builds', () => {
    expect(shouldOpenDevTools(true, '1')).toBe(false);
  });
});
