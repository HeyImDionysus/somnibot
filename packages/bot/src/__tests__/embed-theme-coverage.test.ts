/**
 * embed-theme — coverage tests
 *
 * Tests themedEmbed and invalidateThemeCache with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(function () {
    const data: any = {};
    return {
      data,
      setColor(c: number) { data.color = c; return this; },
      setFooter(f: any) { data.footer = f; return this; },
      setThumbnail(t: string) { data.thumbnail = t; return this; },
      setAuthor(a: any) { data.author = a; return this; },
    };
  }),
}));

import { themedEmbed, invalidateThemeCache } from '../services/embed-theme.js';

function makeValkey() {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve('OK');
    }),
    del: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    _store: store,
  };
}

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(overrideData: any = null) {
  return {
    from: vi.fn().mockReturnValue(chainBuilder({ data: overrideData, error: null })),
  };
}

describe('themedEmbed', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns embed with default color when no override', async () => {
    const supabase = makeSupabase(null);
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');

    expect((embed as any).data.color).toBe(0x5865f2); // default economy color
  });

  it('applies color override from DB', async () => {
    const supabase = makeSupabase({
      guild_id: 'g1',
      feature_key: 'economy',
      color: '#FF0000',
      footer_text: null,
      footer_icon_url: null,
      thumbnail_url: null,
      author_name: null,
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');

    expect((embed as any).data.color).toBe(0xFF0000);
  });

  it('applies footer override', async () => {
    const supabase = makeSupabase({
      color: null,
      footer_text: 'My Footer',
      footer_icon_url: 'https://example.com/icon.png',
      thumbnail_url: null,
      author_name: null,
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'welcome');

    expect((embed as any).data.footer).toEqual({
      text: 'My Footer',
      iconURL: 'https://example.com/icon.png',
    });
  });

  it('applies thumbnail override', async () => {
    const supabase = makeSupabase({
      color: null,
      footer_text: null,
      thumbnail_url: 'https://example.com/thumb.png',
      author_name: null,
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'music');

    expect((embed as any).data.thumbnail).toBe('https://example.com/thumb.png');
  });

  it('applies author name override', async () => {
    const supabase = makeSupabase({
      color: null,
      footer_text: null,
      thumbnail_url: null,
      author_name: 'Custom Author',
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'moderation');

    expect((embed as any).data.author).toEqual({ name: 'Custom Author' });
  });

  it('uses cached override on second call', async () => {
    const supabase = makeSupabase({
      color: '#AABBCC',
      footer_text: null,
      thumbnail_url: null,
      author_name: null,
    });
    const valkey = makeValkey();

    // First call - populates cache
    await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');
    expect(valkey.set).toHaveBeenCalled();

    // Second call - should hit cache
    await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');
  });

  it('handles invalid hex color gracefully', async () => {
    const supabase = makeSupabase({
      color: 'not-a-color',
      footer_text: null,
      thumbnail_url: null,
      author_name: null,
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');

    // Should fall back to default
    expect((embed as any).data.color).toBe(0x5865f2);
  });

  it('handles cached "null" value (no override in DB)', async () => {
    const supabase = makeSupabase(null);
    const valkey = makeValkey();
    valkey._store.set('embed_theme:g1:economy', 'null');

    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');
    expect((embed as any).data.color).toBe(0x5865f2); // default
  });

  it('handles corrupted cache gracefully', async () => {
    const supabase = makeSupabase(null);
    const valkey = makeValkey();
    valkey._store.set('embed_theme:g1:economy', '{invalid json');

    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'economy');
    expect((embed as any).data.color).toBe(0x5865f2);
  });

  it('applies footer without icon', async () => {
    const supabase = makeSupabase({
      color: null,
      footer_text: 'Footer Only',
      footer_icon_url: null,
      thumbnail_url: null,
      author_name: null,
    });
    const valkey = makeValkey();
    const embed = await themedEmbed(supabase as any, valkey as any, 'g1', 'tickets');

    expect((embed as any).data.footer).toEqual({
      text: 'Footer Only',
      iconURL: undefined,
    });
  });
});

describe('invalidateThemeCache', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('invalidates specific feature cache', async () => {
    const valkey = makeValkey();
    await invalidateThemeCache(valkey as any, 'g1', 'economy');
    expect(valkey.del).toHaveBeenCalledWith('embed_theme:g1:economy');
  });

  it('invalidates all guild caches via scan', async () => {
    const valkey = makeValkey();
    valkey.scan.mockResolvedValueOnce(['0', ['embed_theme:g1:economy', 'embed_theme:g1:music']]);

    await invalidateThemeCache(valkey as any, 'g1');
    expect(valkey.scan).toHaveBeenCalled();
  });

  it('handles empty scan results', async () => {
    const valkey = makeValkey();
    valkey.scan.mockResolvedValueOnce(['0', []]);

    await invalidateThemeCache(valkey as any, 'g1');
    // del should not be called for empty batch
    expect(valkey.del).not.toHaveBeenCalled();
  });
});
