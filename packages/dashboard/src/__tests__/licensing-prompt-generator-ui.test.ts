import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(import.meta.dirname, '..', 'components', 'licensing', 'licensing-prompt-generator.tsx'),
  'utf8',
);

describe('SDK prompt generator UI contract', () => {
  it('makes structured capabilities and independent integration rails primary controls', () => {
    expect(source).toContain('Add capability');
    expect(source).toContain('Capability key');
    expect(source).toContain('Behavioral meaning');
    expect(source).toContain('Controlled functionality');
    expect(source).toContain('Granting plans');
    expect(source).toContain('Unavailable behavior');
    expect(source).toContain('Dependency keys');
    expect(source).toContain('Integration rails');
    expect(source).toContain('Runtime licensing');
    expect(source).toContain('Protected downloads');
    expect(source).toContain('Hosted access');
    expect(source).toContain('Discord roles');
    expect(source).toContain('Signed updates');
  });

  it('exposes private-context guidance and four-file copy/download inspection', () => {
    expect(source).toContain('Private integration context');
    expect(source).toContain('Do not include license keys, customer data, or provider secrets');
    expect(source).toContain('Copy selected file');
    expect(source).toContain('Download selected file');
    expect(source).toContain('Download SDK bundle');
    for (const fileName of [
      'AGENT.md',
      'CONFORMANCE.md',
      'license-api.openapi.json',
      'somnibot-sdk.json',
    ]) {
      expect(source).toContain(fileName);
    }
  });

  it('keeps wide generated content contained on a 375px viewport', () => {
    expect(source).toMatch(/className="[^"]*min-w-0[^"]*"/);
    expect(source).toMatch(/className="[^"]*max-w-full[^"]*overflow-auto[^"]*"/);
    expect(source).toContain('grid-cols-1');
    expect(source).not.toContain('min-w-max');
  });
});
