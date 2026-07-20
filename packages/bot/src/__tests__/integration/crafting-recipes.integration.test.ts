/**
 * Integration test: crafting recipe seeding + render against real Supabase.
 *
 * Regression guard for the bug where seedDefaultRecipes wrote
 * `inputs: JSON.stringify(r.inputs)` into the jsonb `inputs` column, so the array
 * landed as a jsonb STRING scalar. getRecipes() then read back a JS string and
 * listRecipes()'s `r.inputs.map(...)` threw, so the '📖 Recipe Book' embed never
 * rendered and /craft was broken from first use. The fix passes the array
 * directly (jsonb_typeof = 'array').
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Guild } from 'discord.js';
import type Valkey from 'iovalkey';
import { requireSupabase } from './helpers.js';
import { CraftingManager } from '../../features/crafting/crafting-manager.js';

let supa!: SupabaseClient;
const GUILD_ID = `test-crafting-guild-${Date.now()}`;

const valkeyStub = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 0,
  ttl: async () => -2,
} as unknown as Valkey;

beforeAll(async () => {
  supa = await requireSupabase();
  await supa.from('guild').insert({ id: GUILD_ID, name: 'Crafting Test Guild', owner_discord_id: '424242' });
  await supa.from('guild_config').insert({ guild_id: GUILD_ID, economy_crafting_enabled: true });
});

afterAll(async () => {
  await supa.from('economy_recipes').delete().eq('guild_id', GUILD_ID);
  await supa.from('economy_items').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild_config').delete().eq('guild_id', GUILD_ID);
  await supa.from('guild').delete().eq('id', GUILD_ID);
});

describe('Crafting recipe seeding + render', () => {
  it('seeds default recipes as jsonb arrays and renders the Recipe Book (no double-encode)', async () => {
    const manager = new CraftingManager({ id: GUILD_ID } as unknown as Guild, supa, valkeyStub);

    // listRecipes() seeds the default recipe book on an empty guild, then renders
    // it via r.inputs.map(...) — which throws if inputs is a double-encoded string.
    const { embed } = await manager.listRecipes();

    expect(embed.data.title).toBe('📖 Recipe Book');
    // A rendered book has category fields; a throw (or empty seed) would not.
    expect(embed.data.fields?.length ?? 0).toBeGreaterThan(0);
    const rendered = JSON.stringify(embed.data.fields);
    expect(rendered).toMatch(/Iron Bar/); // the canonical default recipe rendered

    // The persisted rows are real jsonb arrays: a jsonb array deserializes to a JS
    // array, a double-encoded jsonb string would deserialize to a JS string.
    const { data: rows } = await supa
      .from('economy_recipes')
      .select('name, inputs')
      .eq('guild_id', GUILD_ID);
    expect((rows ?? []).length).toBeGreaterThan(0);
    for (const row of rows ?? []) {
      expect(Array.isArray(row.inputs)).toBe(true); // pre-fix: was a string
      for (const input of row.inputs as Array<{ item_name?: string; qty?: number }>) {
        expect(typeof input.item_name).toBe('string');
        expect(typeof input.qty).toBe('number');
      }
    }
  });
});
