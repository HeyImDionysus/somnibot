/**
 * Farming — the seeded catalogue must not advertise a return it cannot make.
 *
 * THE DEFECT THIS PINS: DEFAULT_CROPS shipped `seeds_returned` values (Potato
 * 1, Corn 2, Tomato 1, Pumpkin 1) and the dashboard rendered "Seeds back: N"
 * from them — but `seedDefaultCrops` inserts every default with
 * `seed_item_id: null`, and harvest only returns seeds when BOTH are set:
 *
 *     if (crop.seeds_returned > 0 && crop.seed_item_id) { ... }
 *
 * So the promised seeds were never returned. Nobody was short-changed —
 * planting a crop with no seed item is free — but the catalogue stated
 * something that never happened, which is exactly the class of quiet
 * dishonesty this codebase treats as a defect.
 *
 * The invariant: a default crop may not promise seeds it has no item to
 * return. An owner who links a real seed item can set the number themselves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(here, '..', 'features', 'farming', 'farming-manager.ts'),
  'utf8',
);

/** Pull the DEFAULT_CROPS literal rows out of the source. */
function defaultCropRows(): Array<{ name: string; seedsReturned: number }> {
  const block = source.slice(
    source.indexOf('const DEFAULT_CROPS'),
    source.indexOf('];', source.indexOf('const DEFAULT_CROPS')),
  );
  expect(block.length, 'DEFAULT_CROPS block should be findable').toBeGreaterThan(0);

  return [...block.matchAll(/name: '([^']+)'[^\n]*seeds_returned: (\d+)/g)].map((m) => ({
    name: m[1]!,
    seedsReturned: Number(m[2]),
  }));
}

describe('default crop catalogue', () => {
  it('ships the five documented crops', () => {
    const rows = defaultCropRows();
    expect(rows.map((r) => r.name)).toEqual(
      ['Potato', 'Corn', 'Tomato', 'Pumpkin', 'Golden Apple'],
    );
  });

  it('promises no seed return, because the defaults link no seed item', () => {
    for (const row of defaultCropRows()) {
      expect(row.seedsReturned, `${row.name} advertises seeds it cannot return`).toBe(0);
    }
  });

  it('still seeds defaults with a null seed item (the reason the promise cannot be kept)', () => {
    // If this ever changes — a default crop gaining a real seed item — the
    // rule above should be revisited rather than silently kept at zero.
    expect(source).toContain('seed_item_id: null');
  });

  it('keeps harvest gated on BOTH fields', () => {
    // The guard is what makes the advertised number meaningless without an
    // item; removing it would pay out seeds that do not exist.
    expect(source).toMatch(/crop\.seeds_returned > 0 && crop\.seed_item_id/);
  });
});
