/**
 * Starter-content seeder — the content must be real (consumed by live code
 * paths), seeding must never touch a guild that has its own content, and
 * failures must SURFACE (throw) so the warmup can report degradation instead
 * of logging "complete" over missing content.
 */
import { describe, it, expect, vi } from 'vitest';
import { seedStarterContent } from '../services/content-seeder.js';

function makeSupabase(
  counts: Record<string, number>,
  dataRows: Record<string, Record<string, unknown>[]> = {},
) {
  const upserts: Record<string, Record<string, unknown>[]> = {};
  const upsertOpts: Record<string, Record<string, unknown> | undefined> = {};
  const gateNames: Record<string, string[] | undefined> = {};
  const updates: Record<string, Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown[]]> }>> = {};
  const client = {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        // The gate builder is awaitable directly (any-row gate) AND supports
        // .in() for the name-scoped starter reconcile read — mirroring
        // supabase-js's thenable query builder. Reads resolve with BOTH a
        // count (any-row gates) and data rows (the per-item reconcile).
        eq: vi.fn(() => {
          const result = { count: counts[table] ?? 0, data: dataRows[table] ?? [], error: null };
          return {
            in: vi.fn(async (_col: string, names: string[]) => {
              gateNames[table] = names;
              return result;
            }),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject),
          };
        }),
      })),
      upsert: vi.fn(async (rows: Record<string, unknown>[], opts?: Record<string, unknown>) => {
        upserts[table] = rows;
        upsertOpts[table] = opts;
        return { error: null };
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        const entry = { payload, filters: [] as Array<[string, unknown[]]> };
        (updates[table] ??= []).push(entry);
        const matchedId = () =>
          (entry.filters.find(([m, a]) => m === 'eq' && (a as unknown[])[0] === 'id')?.[1] as unknown[])?.[1];
        const chain: Record<string, unknown> = {
          // .select() after update resolves the affected rows (CAS check).
          select: () => chain,
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve({ data: [{ id: matchedId() ?? 'row' }], error: null }).then(resolve, reject),
        };
        for (const m of ['eq', 'is', 'in']) {
          chain[m] = (...args: unknown[]) => {
            entry.filters.push([m, args]);
            return chain;
          };
        }
        return chain;
      }),
    })),
  };
  return { client: client as never, upserts, upsertOpts, gateNames, updates };
}

describe('seedStarterContent', () => {
  it('seeds achievements, automod rules and shop items into an empty guild', async () => {
    const { client, upserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    expect(upserts.economy_achievement_defs?.length).toBeGreaterThanOrEqual(8);
    expect(upserts.automod_rules?.length).toBeGreaterThanOrEqual(3);
    expect(upserts.economy_items?.length).toBeGreaterThanOrEqual(4);

    for (const table of Object.keys(upserts)) {
      for (const row of upserts[table]) {
        expect(row.guild_id).toBe('g1');
      }
    }
  });

  it('writes via upsert with ignoreDuplicates so a double-seed race is a no-op', async () => {
    const { client, upsertOpts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    for (const table of ['economy_achievement_defs', 'automod_rules', 'economy_items']) {
      expect(upsertOpts[table]).toMatchObject({ ignoreDuplicates: true });
    }
  });

  it('gates the shop seed on the starter item NAMES, not any economy_items row', async () => {
    // Crafting's warmup creates recipe-output economy_items rows; an any-row
    // gate would starve the starter shop on every default install (P1).
    const { client, gateNames } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    expect(gateNames.economy_items).toEqual(['Padlock', 'Shovel', 'Pickaxe', 'Hunting Rifle']);
    // The other tables keep the any-row gate.
    expect(gateNames.economy_achievement_defs).toBeUndefined();
    expect(gateNames.automod_rules).toBeUndefined();
  });

  it('only uses achievement conditions the bot actually fires', async () => {
    const { client, upserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    // events/handler.ts fires exactly these two condition types. A def with
    // any other condition would be dead content that can never unlock.
    const FIRED = new Set(['messages_sent', 'level']);
    for (const def of upserts.economy_achievement_defs) {
      expect(FIRED.has(def.condition_type as string)).toBe(true);
      expect((def.condition_value as number) > 0).toBe(true);
    }
  });

  it('seeds automod rules the engine can evaluate, without Discord sync', async () => {
    const { client, upserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    const ENGINE_TYPES = new Set([
      'word_filter', 'link_filter', 'invite_filter', 'spam_filter',
      'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam',
    ]);
    const ACTIONS = new Set(['delete', 'warn', 'mute', 'kick', 'ban']);
    for (const rule of upserts.automod_rules) {
      expect(ENGINE_TYPES.has(rule.type as string)).toBe(true);
      expect(ACTIONS.has(rule.action as string)).toBe(true);
      // Seeding must never mutate the Discord server.
      expect(rule.sync_to_discord).toBe(false);
      if (rule.action === 'mute') {
        expect((rule.mute_duration_minutes as number) > 0).toBe(true);
      }
    }
  });

  it('seeds only shop items whose effects the bot executes, in canonical categories', async () => {
    const { client, upserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    // economy-manager looks up { type: 'padlock' }; gathering-manager resolves
    // tools by { type: 'hunting_rifle' | 'shovel' | 'pickaxe', tier }.
    const LIVE_EFFECTS = new Set(['padlock', 'hunting_rifle', 'shovel', 'pickaxe']);
    // Canonical categories (economy/commands.ts choices + dashboard shop page).
    const CANONICAL = new Set(['Tools', 'Protection', 'Farming', 'Accessories', 'Bait', 'Seeds', 'Materials', 'Consumables', 'Roles', 'Cosmetics', 'Lootboxes']);
    for (const item of upserts.economy_items) {
      const effect = item.use_effect as { type: string } | null;
      expect(effect && LIVE_EFFECTS.has(effect.type)).toBe(true);
      expect((item.price as number) > 0).toBe(true);
      expect((item.sell_price as number) < (item.price as number)).toBe(true);
      expect(item.active).toBe(true);
      expect(CANONICAL.has(item.category as string)).toBe(true);
    }
  });

  it('never writes into a table the guild already has content in', async () => {
    const { client, upserts, updates } = makeSupabase(
      {
        economy_achievement_defs: 3,
        automod_rules: 1,
        economy_items: 12,
      },
      {
        // Operator-shaped starter-name rows (priced, live effects): untouchable.
        economy_items: [
          { id: 'i1', name: 'Padlock', price: 500, use_effect: { type: 'padlock' } },
          { id: 'i2', name: 'Shovel', price: 150, use_effect: { type: 'shovel' } },
          { id: 'i3', name: 'Pickaxe', price: 150, use_effect: { type: 'pickaxe' } },
          { id: 'i4', name: 'Hunting Rifle', price: 300, use_effect: { type: 'hunting_rifle' } },
        ],
      },
    );
    await seedStarterContent(client, 'g1');
    expect(Object.keys(upserts)).toHaveLength(0);
    expect(updates.economy_items ?? []).toHaveLength(0);
  });

  it('upgrades a bare crafting output shell into the starter item, preserving its id', async () => {
    // Crafting seeded its price-0 'Padlock' output first (the F1 starvation
    // scenario) — the reconcile must upgrade THAT row in place and still
    // insert the three absent tools.
    const { client, upserts, updates } = makeSupabase(
      {},
      { economy_items: [{ id: 'shell-1', name: 'Padlock', price: 0, use_effect: null }] },
    );
    await seedStarterContent(client, 'g1');

    const insertedNames = (upserts.economy_items ?? []).map((r) => r.name);
    expect(insertedNames.sort()).toEqual(['Hunting Rifle', 'Pickaxe', 'Shovel']);

    expect(updates.economy_items).toHaveLength(1);
    const up = updates.economy_items[0];
    expect(up.payload.name).toBe('Padlock');
    expect((up.payload.price as number) > 0).toBe(true);
    expect(up.payload.use_effect).toMatchObject({ type: 'padlock' });
    // CAS filters: only the untouched shell (id + price 0 + no effect) upgrades.
    expect(up.filters).toEqual([
      ['eq', ['guild_id', 'g1']],
      ['eq', ['id', 'shell-1']],
      ['eq', ['price', 0]],
      ['is', ['use_effect', null]],
    ]);
  });

  it('a failed count check skips that table AND surfaces the failure', async () => {
    const upserts: Record<string, unknown[]> = {};
    const client = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => {
            const result = { count: null, error: { message: 'db down' } };
            return {
              in: vi.fn(async () => result),
              then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(result).then(resolve, reject),
            };
          }),
        })),
        upsert: vi.fn(async (rows: unknown[]) => {
          upserts[table] = rows;
          return { error: null };
        }),
      })),
    } as never;

    await expect(seedStarterContent(client, 'g1')).rejects.toThrow(/starter content seeding failed/);
    expect(Object.keys(upserts)).toHaveLength(0);
  });

  it('a failed write surfaces the failing table instead of logging success', async () => {
    const client = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => {
            const result = { count: 0, error: null };
            return {
              in: vi.fn(async () => result),
              then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(result).then(resolve, reject),
            };
          }),
        })),
        upsert: vi.fn(async () =>
          table === 'automod_rules' ? { error: { message: 'insert denied' } } : { error: null },
        ),
      })),
    } as never;

    await expect(seedStarterContent(client, 'g1')).rejects.toThrow(/automod_rules/);
  });
});
