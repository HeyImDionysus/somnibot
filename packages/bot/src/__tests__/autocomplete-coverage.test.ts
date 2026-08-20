/**
 * autocomplete — coverage tests
 *
 * Tests handleAutocomplete with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleAutocomplete } from '../features/discord-ux/autocomplete.js';

// ── Helpers ───────────────────────────────────────────────

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeInteraction(command: string, focusedValue: string) {
  return {
    commandName: command,
    options: {
      getFocused: vi.fn().mockReturnValue({ name: 'query', value: focusedValue }),
      getSubcommand: vi.fn().mockReturnValue(command === 'pet' ? 'buy' : null),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSupabase(products: unknown[] = []) {
  return {
    from: vi.fn().mockReturnValue(
      chainBuilder({ data: products, error: null }),
    ),
  };
}

function makeShoukaku(results?: { loadType: string; data: unknown[] }) {
  const node = {
    rest: {
      resolve: vi.fn().mockResolvedValue(results ?? null),
    },
  };
  return {
    nodes: new Map([['main', node]]),
  };
}

describe('handleAutocomplete', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── play autocomplete ────────────────────────────────
  it('returns empty for short play query', async () => {
    const interaction = makeInteraction('play', 'a');
    const shoukaku = makeShoukaku();
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('returns URL directly for play URL query', async () => {
    const url = 'https://youtube.com/watch?v=abc';
    const interaction = makeInteraction('play', url);
    const shoukaku = makeShoukaku();
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: url }),
    ]);
  });

  it('returns search results for play query', async () => {
    const interaction = makeInteraction('play', 'some song');
    const shoukaku = makeShoukaku({
      loadType: 'search',
      data: [
        { info: { title: 'Track 1', author: 'Artist 1', uri: 'https://yt/1' } },
        { info: { title: 'Track 2', author: 'Artist 2', uri: 'https://yt/2' } },
      ],
    });
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: 'https://yt/1' }),
      expect.objectContaining({ value: 'https://yt/2' }),
    ]);
  });

  it('returns empty when no node available', async () => {
    const interaction = makeInteraction('play', 'some song');
    const shoukaku = { nodes: new Map() };
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('returns empty when search returns no results', async () => {
    const interaction = makeInteraction('play', 'some song');
    const shoukaku = makeShoukaku({ loadType: 'empty', data: [] });
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it('handles search error gracefully', async () => {
    const interaction = makeInteraction('play', 'error query');
    const node = {
      rest: { resolve: vi.fn().mockRejectedValue(new Error('fail')) },
    };
    const shoukaku = { nodes: new Map([['main', node]]) };
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  // ── store autocomplete ───────────────────────────────
  it('returns store product suggestions', async () => {
    const products = [
      { id: 'p1', name: 'VIP Role', price_cents: 999, currency: 'USD' },
      { id: 'p2', name: 'Premium', price_cents: 1999, currency: 'USD' },
    ];
    const interaction = makeInteraction('store', 'vip');
    const supabase = makeSupabase(products);
    const shoukaku = makeShoukaku();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: 'p1' }),
      expect.objectContaining({ value: 'p2' }),
    ]);
  });

  it('uses saved pet labels while preserving stable pet type keys', async () => {
    const interaction = makeInteraction('pet', 'wolf');
    const supabase = makeSupabase([{
      economy_pet_type_config: {
        hunting: { name: 'Wolf Scout', emoji: '🐺', description: 'Scout', price: 5000 },
      },
    }]);
    const chain = chainBuilder({
      data: {
        economy_pet_type_config: {
          hunting: { name: 'Wolf Scout', emoji: '🐺', description: 'Scout', price: 5000 },
        },
      },
      error: null,
    });
    supabase.from.mockReturnValue(chain);
    await handleAutocomplete(
      interaction as unknown as Parameters<typeof handleAutocomplete>[0],
      supabase as unknown as Parameters<typeof handleAutocomplete>[1],
      makeShoukaku() as unknown as Parameters<typeof handleAutocomplete>[2],
      'g1',
    );
    expect(interaction.respond).toHaveBeenCalledWith([{ name: '🐺 Wolf Scout', value: 'hunting' }]);
  });

  // ── remove autocomplete ──────────────────────────────
  it('returns empty for remove command', async () => {
    const interaction = makeInteraction('remove', '');
    const supabase = makeSupabase();
    const shoukaku = makeShoukaku();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  // ── unknown command ──────────────────────────────────
  it('returns empty for unknown command', async () => {
    const interaction = makeInteraction('unknown', 'test');
    const supabase = makeSupabase();
    const shoukaku = makeShoukaku();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  // ── track without uri ────────────────────────────────
  it('uses ytsearch fallback when track has no uri', async () => {
    const interaction = makeInteraction('play', 'some song');
    const shoukaku = makeShoukaku({
      loadType: 'search',
      data: [
        { info: { title: 'Track', author: 'Artist', uri: undefined } },
      ],
    });
    const supabase = makeSupabase();
    await handleAutocomplete(interaction as any, supabase as any, shoukaku as any, 'g1');
    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: 'ytsearch:Track' }),
    ]);
  });
});
