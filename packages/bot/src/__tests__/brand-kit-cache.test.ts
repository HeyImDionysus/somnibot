/**
 * Brand kit cache — TTL, invalidation, and the no-cache-on-error rule.
 *
 * resolveBrandKit caches the raw guild_config ROW per guild for 30s so busy
 * surfaces (ticket-service resolves the kit 4x per lifecycle) share one DB
 * read. These tests assert:
 *   1. TTL: within 30s the row is served from cache; after 30s it re-reads.
 *   2. invalidateBrandKitCache(guildId) / () force a re-read.
 *   3. A FAILED read is NEVER cached (mirrors games-manager getConfigChecked):
 *      neither a query error nor a thrown client error may pin the defaults.
 *   4. The ROW is cached, not the projected kit — per-call fallbackName still
 *      applies to cached reads.
 *   5. currency_name/currency_emoji ride along on the same row.
 *   6. Generation token: an invalidation landing while a resolve is awaiting
 *      the DB means the fetched row may be stale — it must NOT be cached, and
 *      a slow stale resolve must never overwrite a fresher cached row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { HOT_PINK: 0xff1493, CYAN: 0x00d4ff, ORANGE: 0xff6b00, NEAR_BLACK: 0x0d0d0d },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  resolveBrandKit,
  invalidateBrandKitCache,
  brandKitFromConfig,
  defaultBrandKit,
  BRAND_KIT_COLUMNS,
} from '../features/branding/brand-kit.js';

/** guild_config select().eq().maybeSingle() chain returning `config`. */
function configSupabase(config: unknown, opts: { error?: unknown } = {}) {
  const maybeSingle = vi.fn(async () => ({ data: config, error: opts.error ?? null }));
  const from = vi.fn(() => {
    const chain: any = {};
    for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = maybeSingle;
    return chain;
  });
  return { supabase: { from } as any, from, maybeSingle };
}

beforeEach(() => {
  invalidateBrandKitCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-26T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('brand kit cache TTL', () => {
  it('serves the second resolve within 30s from cache (one DB read)', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x112233 });

    const first = await resolveBrandKit(supabase, 'g1');
    vi.setSystemTime(Date.now() + 29_000);
    const second = await resolveBrandKit(supabase, 'g1');

    expect(from).toHaveBeenCalledTimes(1);
    expect(first.primaryColor).toBe(0x112233);
    expect(second.primaryColor).toBe(0x112233);
  });

  it('re-reads after the 30s TTL expires', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x112233 });

    await resolveBrandKit(supabase, 'g1');
    vi.setSystemTime(Date.now() + 30_001);
    await resolveBrandKit(supabase, 'g1');

    expect(from).toHaveBeenCalledTimes(2);
  });

  it('caches per guild — different guilds each read once', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x112233 });

    await resolveBrandKit(supabase, 'g1');
    await resolveBrandKit(supabase, 'g2');
    await resolveBrandKit(supabase, 'g1');
    await resolveBrandKit(supabase, 'g2');

    expect(from).toHaveBeenCalledTimes(2);
  });

  it('caches a successful "no row" read (unconfigured guild is a stable state)', async () => {
    const { supabase, from } = configSupabase(null);

    const kit1 = await resolveBrandKit(supabase, 'g1');
    const kit2 = await resolveBrandKit(supabase, 'g1');

    expect(from).toHaveBeenCalledTimes(1);
    expect(kit1).toEqual(defaultBrandKit());
    expect(kit2).toEqual(defaultBrandKit());
  });

  it('caches the ROW, not the kit — per-call fallbackName applies to cached reads', async () => {
    const { supabase, from } = configSupabase({ store_brand_name: null });

    const a = await resolveBrandKit(supabase, 'g1', { fallbackName: 'Server A' });
    const b = await resolveBrandKit(supabase, 'g1', { fallbackName: 'Server B' });

    expect(from).toHaveBeenCalledTimes(1);
    expect(a.brandName).toBe('Server A');
    expect(b.brandName).toBe('Server B');
  });
});

describe('invalidation', () => {
  it('invalidateBrandKitCache(guildId) forces a re-read for that guild only', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x112233 });

    await resolveBrandKit(supabase, 'g1');
    await resolveBrandKit(supabase, 'g2');
    invalidateBrandKitCache('g1');
    await resolveBrandKit(supabase, 'g1'); // re-read
    await resolveBrandKit(supabase, 'g2'); // still cached

    expect(from).toHaveBeenCalledTimes(3);
  });

  it('invalidateBrandKitCache() clears every guild', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x112233 });

    await resolveBrandKit(supabase, 'g1');
    await resolveBrandKit(supabase, 'g2');
    invalidateBrandKitCache();
    await resolveBrandKit(supabase, 'g1');
    await resolveBrandKit(supabase, 'g2');

    expect(from).toHaveBeenCalledTimes(4);
  });

  it('a dashboard save is visible immediately after invalidation', async () => {
    let color = 0x111111;
    const from = vi.fn(() => {
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({
        data: { brand_primary_color: color },
        error: null,
      }));
      return chain;
    });
    const supabase = { from } as any;

    expect((await resolveBrandKit(supabase, 'g1')).primaryColor).toBe(0x111111);
    color = 0x222222; // owner saves new color; config-watcher invalidates
    invalidateBrandKitCache('g1');
    expect((await resolveBrandKit(supabase, 'g1')).primaryColor).toBe(0x222222);
  });
});

describe('failed reads are never cached', () => {
  it('a query error returns defaults and the next call re-reads', async () => {
    const { supabase, from } = configSupabase(null, { error: { message: 'boom' } });

    const kit = await resolveBrandKit(supabase, 'g1', { fallbackName: 'Fallback' });
    expect(kit).toEqual(defaultBrandKit('Fallback'));

    await resolveBrandKit(supabase, 'g1');
    expect(from).toHaveBeenCalledTimes(2); // no cache entry was written
  });

  it('a thrown client error returns defaults and the next call re-reads', async () => {
    const from = vi.fn(() => {
      throw new Error('connection refused');
    });
    const supabase = { from } as any;

    const kit = await resolveBrandKit(supabase, 'g1', { fallbackName: 'Fallback' });
    expect(kit).toEqual(defaultBrandKit('Fallback'));

    await resolveBrandKit(supabase, 'g1');
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('recovery after an outage serves fresh config, not a poisoned default', async () => {
    let failing = true;
    const from = vi.fn(() => {
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () =>
        failing
          ? { data: null, error: { message: 'timeout' } }
          : { data: { brand_primary_color: 0xabcdef }, error: null },
      );
      return chain;
    });
    const supabase = { from } as any;

    expect((await resolveBrandKit(supabase, 'g1')).primaryColor).toBe(0xff1493);
    failing = false; // database recovers within the would-be TTL window
    expect((await resolveBrandKit(supabase, 'g1')).primaryColor).toBe(0xabcdef);
  });
});

describe('cache generation token — invalidation during in-flight resolves', () => {
  /**
   * Like configSupabase, but each maybeSingle() call returns a promise the
   * test settles by hand, so invalidations can be interleaved while a
   * resolve is genuinely awaiting the DB.
   */
  function manualSupabase() {
    const pending: Array<(r: { data: unknown; error: unknown }) => void> = [];
    const from = vi.fn(() => {
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(
        () =>
          new Promise<{ data: unknown; error: unknown }>((resolve) => {
            pending.push(resolve);
          }),
      );
      return chain;
    });
    return { supabase: { from } as any, from, pending };
  }

  it('invalidateBrandKitCache(guildId) during an in-flight resolve → result NOT cached', async () => {
    const { supabase, from, pending } = manualSupabase();

    const inflight = resolveBrandKit(supabase, 'g1'); // captures generation, awaits DB
    invalidateBrandKitCache('g1'); // dashboard save lands mid-read
    pending[0]!({ data: { brand_primary_color: 0x111111 }, error: null });

    // The resolve still answers from its own read...
    expect((await inflight).primaryColor).toBe(0x111111);

    // ...but the stale row must not have been pinned: the next call re-reads.
    const second = resolveBrandKit(supabase, 'g1');
    pending[1]!({ data: { brand_primary_color: 0x222222 }, error: null });
    expect((await second).primaryColor).toBe(0x222222);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('no-arg invalidateBrandKitCache() during an in-flight resolve → result NOT cached', async () => {
    const { supabase, from, pending } = manualSupabase();

    const inflight = resolveBrandKit(supabase, 'g1');
    invalidateBrandKitCache(); // global epoch bump mid-read
    pending[0]!({ data: { brand_primary_color: 0x111111 }, error: null });
    await inflight;

    const second = resolveBrandKit(supabase, 'g1');
    pending[1]!({ data: { brand_primary_color: 0x222222 }, error: null });
    expect((await second).primaryColor).toBe(0x222222);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('two overlapping resolves — the later invalidation wins over a slow stale read', async () => {
    const { supabase, from, pending } = manualSupabase();

    const slowStale = resolveBrandKit(supabase, 'g1'); // pre-save read, awaits DB
    invalidateBrandKitCache('g1'); // owner saves a new color
    const fresh = resolveBrandKit(supabase, 'g1'); // post-save read

    pending[1]!({ data: { brand_primary_color: 0x00ff00 }, error: null });
    expect((await fresh).primaryColor).toBe(0x00ff00); // fresh row cached

    pending[0]!({ data: { brand_primary_color: 0xdead00 }, error: null });
    expect((await slowStale).primaryColor).toBe(0xdead00); // its own read...

    // ...but it must NOT have clobbered the fresher cached row.
    expect((await resolveBrandKit(supabase, 'g1')).primaryColor).toBe(0x00ff00);
    expect(from).toHaveBeenCalledTimes(2); // third call served from cache
  });

  it('generation-counter eviction fails CLOSED — the in-flight result is still not cached', async () => {
    const { supabase, from, pending } = manualSupabase();

    // A VIRGIN guild (never invalidated in this file): its captured counter is
    // 0 and stays 0 after eviction rebuilds the map, so ONLY the epoch bump on
    // eviction can keep the capture stale — this pins the epoch-bump behavior
    // itself, not the targeted-counter path the other tests already cover.
    const inflight = resolveBrandKit(supabase, 'evict-virgin'); // captures generation
    // Flood the per-guild counter map past its cap; evictions must bump the epoch.
    for (let i = 0; i < 10_000; i++) invalidateBrandKitCache(`evicted-${i}`);
    pending[0]!({ data: { brand_primary_color: 0x111111 }, error: null });
    await inflight;

    const second = resolveBrandKit(supabase, 'evict-virgin');
    pending[1]!({ data: { brand_primary_color: 0x222222 }, error: null });
    expect((await second).primaryColor).toBe(0x222222);
    expect(from).toHaveBeenCalledTimes(2);
  });
});

describe('brandKitFromConfig projection + currency columns', () => {
  it('selects the currency columns as part of BRAND_KIT_COLUMNS', () => {
    expect(BRAND_KIT_COLUMNS).toContain('currency_name');
    expect(BRAND_KIT_COLUMNS).toContain('currency_emoji');
  });

  it('resolveBrandKit carries the guild currency through the same row', async () => {
    const { supabase } = configSupabase({
      currency_name: 'Gems',
      currency_emoji: '💎',
    });

    const kit = await resolveBrandKit(supabase, 'g1');
    expect(kit.currencyName).toBe('Gems');
    expect(kit.currencyEmoji).toBe('💎');
  });

  it('projects an already-loaded manager row without a DB read', () => {
    const kit = brandKitFromConfig(
      {
        store_brand_name: 'Acme',
        store_show_powered_by: false,
        brand_primary_color: 0x123456,
        brand_accent_color: 0x654321,
        brand_voice_preset: 'playful',
        currency_name: 'Credits',
        currency_emoji: '🎫',
        brand_logo_url: 'https://cdn.example.com/acme.png',
      },
      'Guild Name',
    );

    expect(kit).toEqual({
      brandName: 'Acme',
      primaryColor: 0x123456,
      accentColor: 0x654321,
      voicePreset: 'playful',
      poweredByAttribution: null,
      currencyName: 'Credits',
      currencyEmoji: '🎫',
      logoUrl: 'https://cdn.example.com/acme.png',
    });
  });

  it('projects null/blank currency columns to the economy defaults', () => {
    const kit = brandKitFromConfig({ currency_name: '  ', currency_emoji: null });
    expect(kit.currencyName).toBe('Coins');
    expect(kit.currencyEmoji).toBe('🪙');
  });

  it('a null row projects the default kit with the fallback name', () => {
    expect(brandKitFromConfig(null, 'Cool Server')).toEqual(defaultBrandKit('Cool Server'));
  });
});
