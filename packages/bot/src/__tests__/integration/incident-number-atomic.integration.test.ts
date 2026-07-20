/**
 * Integration test: nextval_incident() draws atomic, strictly-increasing numbers.
 *
 * Regression guard for the v42 regression where nextval_incident() became
 * `SELECT COALESCE(MAX(incident_number),0)+1 FROM incidents` — a draw that did no
 * insert, so back-to-back / concurrent draws returned the SAME number and two
 * racing fraud incidents could share an incident_number. Restored to an atomic
 * sequence draw (incident_number_seq).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabase } from './helpers.js';

let supa!: SupabaseClient;

beforeAll(async () => {
  supa = await requireSupabase();
});

async function draw(): Promise<number> {
  const { data, error } = await supa.rpc('nextval_incident');
  expect(error).toBeNull();
  return Number(data);
}

describe('nextval_incident atomic sequence', () => {
  it('returns a distinct, strictly-increasing number on every draw (no insert needed)', async () => {
    const a = await draw();
    const b = await draw();
    const c = await draw();
    expect(b).toBeGreaterThan(a); // pre-fix: b === a
    expect(c).toBeGreaterThan(b);
  });

  it('gives every concurrent draw a distinct number', async () => {
    const drawn = await Promise.all(Array.from({ length: 5 }, () => draw()));
    expect(new Set(drawn).size).toBe(drawn.length); // pre-fix: collisions
  });
});
