/**
 * Starter-content seeder — the content must be real (consumed by live code
 * paths), and seeding must never touch a guild that has its own content.
 */
import { describe, it, expect, vi } from 'vitest';
import { seedStarterContent } from '../services/content-seeder.js';

function makeSupabase(counts: Record<string, number>) {
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const client = {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ count: counts[table] ?? 0, error: null })),
      })),
      insert: vi.fn(async (rows: Record<string, unknown>[]) => {
        inserts[table] = rows;
        return { error: null };
      }),
    })),
  };
  return { client: client as never, inserts };
}

describe('seedStarterContent', () => {
  it('seeds achievements, automod rules and shop items into an empty guild', async () => {
    const { client, inserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    expect(inserts.economy_achievement_defs?.length).toBeGreaterThanOrEqual(8);
    expect(inserts.automod_rules?.length).toBeGreaterThanOrEqual(3);
    expect(inserts.economy_items?.length).toBeGreaterThanOrEqual(4);

    for (const table of Object.keys(inserts)) {
      for (const row of inserts[table]) {
        expect(row.guild_id).toBe('g1');
      }
    }
  });

  it('only uses achievement conditions the bot actually fires', async () => {
    const { client, inserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    // events/handler.ts fires exactly these two condition types. A def with
    // any other condition would be dead content that can never unlock.
    const FIRED = new Set(['messages_sent', 'level']);
    for (const def of inserts.economy_achievement_defs) {
      expect(FIRED.has(def.condition_type as string)).toBe(true);
      expect((def.condition_value as number) > 0).toBe(true);
    }
  });

  it('seeds automod rules the engine can evaluate, without Discord sync', async () => {
    const { client, inserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    const ENGINE_TYPES = new Set([
      'word_filter', 'link_filter', 'invite_filter', 'spam_filter',
      'duplicate_filter', 'caps_filter', 'mention_spam', 'newline_spam',
    ]);
    const ACTIONS = new Set(['delete', 'warn', 'mute', 'kick', 'ban']);
    for (const rule of inserts.automod_rules) {
      expect(ENGINE_TYPES.has(rule.type as string)).toBe(true);
      expect(ACTIONS.has(rule.action as string)).toBe(true);
      // Seeding must never mutate the Discord server.
      expect(rule.sync_to_discord).toBe(false);
      if (rule.action === 'mute') {
        expect((rule.mute_duration_minutes as number) > 0).toBe(true);
      }
    }
  });

  it('seeds only shop items whose effects the bot executes', async () => {
    const { client, inserts } = makeSupabase({});
    await seedStarterContent(client, 'g1');

    // economy-manager looks up { type: 'padlock' }; gathering-manager resolves
    // tools by { type: 'hunting_rifle' | 'shovel' | 'pickaxe', tier }.
    const LIVE_EFFECTS = new Set(['padlock', 'hunting_rifle', 'shovel', 'pickaxe']);
    for (const item of inserts.economy_items) {
      const effect = item.use_effect as { type: string } | null;
      expect(effect && LIVE_EFFECTS.has(effect.type)).toBe(true);
      expect((item.price as number) > 0).toBe(true);
      expect((item.sell_price as number) < (item.price as number)).toBe(true);
      expect(item.active).toBe(true);
    }
  });

  it('never writes into a table the guild already has content in', async () => {
    const { client, inserts } = makeSupabase({
      economy_achievement_defs: 3,
      automod_rules: 1,
      economy_items: 12,
    });
    await seedStarterContent(client, 'g1');
    expect(Object.keys(inserts)).toHaveLength(0);
  });

  it('a failed count check skips that table rather than risking overwrite', async () => {
    const inserts: Record<string, unknown[]> = {};
    const client = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({ count: null, error: { message: 'db down' } })),
        })),
        insert: vi.fn(async (rows: unknown[]) => {
          inserts[table] = rows;
          return { error: null };
        }),
      })),
    } as never;

    await seedStarterContent(client, 'g1');
    expect(Object.keys(inserts)).toHaveLength(0);
  });
});
