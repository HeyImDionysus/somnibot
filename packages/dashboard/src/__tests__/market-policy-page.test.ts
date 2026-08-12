import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = path.resolve(__dirname, '../app/(dashboard)/economy/market/page.tsx');

describe('market anti-laundering policy surface', () => {
  it('exposes the locked catalog control as a non-configurable owner policy', () => {
    const source = readFileSync(PAGE, 'utf8');

    expect(source).toContain('data-control-id="commerce-items-market-locked"');
    expect(source).toContain('data-policy-state="locked"');
    expect(source).toContain('tradeable=false');
    expect(source).toContain('atomic database listing RPC repeats the same guard');
    expect(source).toContain('not an owner-configurable setting');
    // A locked policy must never be sent through the editable guild-config
    // PATCH path as if it were an owner toggle.
    expect(source).not.toContain('saveConfig({ commerce-items-market-locked');
  });
});
