/**
 * branded-embed — intent colors, footer attribution rule, derived intents.
 *
 * Covers:
 *   1. Intent → color mapping (primary/info from the kit, warning/danger
 *      derived) and the default-kit fallbacks (ORANGE / 0xED4245).
 *   2. Derived warning/danger stability: deterministic, in-range, and distinct
 *      from the primary for chromatic brand colors.
 *   3. The footer rule: append ' • {attribution}' to an existing semantic
 *      footer (never clobber), set it alone when absent, suppress it with
 *      attribution:false or when the owner turned powered-by off.
 *   4. brandedEmbedFor resolves the (cached) kit and applies title/description.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @somnibot/shared with the REAL default palette values (brand.ts) so the
// fallback assertions below match the shipped defaults.
vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { HOT_PINK: 0xff1493, CYAN: 0x00d4ff, ORANGE: 0xff6b00, NEAR_BLACK: 0x0d0d0d },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setFooter(f: { text: string; iconURL?: string }) {
      this.data.footer = { text: f.text, icon_url: f.iconURL };
      return this;
    }
  }
  return { EmbedBuilder };
});

import { EmbedBuilder } from 'discord.js';
import {
  applyBrand,
  brandedEmbed,
  brandedEmbedFor,
  intentColor,
} from '../features/branding/branded-embed.js';
import {
  type BrandKit,
  defaultBrandKit,
  invalidateBrandKitCache,
} from '../features/branding/brand-kit.js';

const DEFAULT_PRIMARY = 0xff1493;
const DEFAULT_ACCENT = 0x00d4ff;
const ORANGE = 0xff6b00;
const DISCORD_RED = 0xed4245;

function customKit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    brandName: 'Acme',
    primaryColor: 0x1e90ff,
    accentColor: 0x00ced1,
    voicePreset: 'default',
    poweredByAttribution: 'Powered by SomniBot',
    currencyName: 'Coins',
    currencyEmoji: '🪙',
    logoUrl: null,
    ...overrides,
  };
}

beforeEach(() => {
  invalidateBrandKitCache();
});

// ── Intent colors ───────────────────────────────────────────

describe('intent colors', () => {
  it('primary/info map straight to the kit colors', () => {
    const kit = customKit();
    expect(brandedEmbed(kit).data.color).toBe(0x1e90ff); // default intent = primary
    expect(brandedEmbed(kit, { intent: 'primary' }).data.color).toBe(0x1e90ff);
    expect(brandedEmbed(kit, { intent: 'info' }).data.color).toBe(0x00ced1);
  });

  it('default (unbranded) kit falls back to ORANGE for warning and Discord red for danger', () => {
    const kit = defaultBrandKit('Some Guild');
    expect(brandedEmbed(kit, { intent: 'warning' }).data.color).toBe(ORANGE);
    expect(brandedEmbed(kit, { intent: 'danger' }).data.color).toBe(DISCORD_RED);
  });

  it('keepColor preserves a SEMANTIC color while still branding the footer', () => {
    // Fish/gathering rarity tiers: the hue IS the rarity, so the brand must not
    // overwrite it — but the embed still carries the attribution.
    const rarityGold = 0xffd700;
    const embed = new EmbedBuilder().setColor(rarityGold).setFooter({ text: 'Using Iron Rod' });

    applyBrand(embed, customKit(), { keepColor: true });

    expect(embed.data.color).toBe(rarityGold);
    expect(embed.data.footer?.text).toBe('Using Iron Rod • Powered by SomniBot');
  });

  it('without keepColor the intent color overwrites a semantic color', () => {
    const embed = new EmbedBuilder().setColor(0xffd700);
    applyBrand(embed, customKit(), { intent: 'info' });
    expect(embed.data.color).toBe(0x00ced1);
  });

  it('sets title and description verbatim', () => {
    const embed = brandedEmbed(customKit(), {
      title: '🎉 Winner!',
      description: 'You won the draw.',
      attribution: false,
    });
    expect(embed.data.title).toBe('🎉 Winner!');
    expect(embed.data.description).toBe('You won the draw.');
  });
});

describe('derived warning/danger stability', () => {
  it('is deterministic — the same primary always derives the same colors', () => {
    const kit = customKit();
    const w1 = intentColor(kit, 'warning');
    const w2 = intentColor(customKit(), 'warning');
    const d1 = intentColor(kit, 'danger');
    const d2 = intentColor(customKit(), 'danger');
    expect(w1).toBe(w2);
    expect(d1).toBe(d2);
  });

  it('stays a valid 24-bit color and differs from the primary for chromatic brands', () => {
    for (const primary of [0x1e90ff, 0x22aa55, 0x8b0000, 0xffcc00]) {
      const kit = customKit({ primaryColor: primary });
      for (const intent of ['warning', 'danger'] as const) {
        const derived = intentColor(kit, intent);
        expect(derived).toBeGreaterThanOrEqual(0);
        expect(derived).toBeLessThanOrEqual(0xffffff);
        expect(derived).not.toBe(primary);
      }
    }
  });

  it('warning and danger rotate in opposite directions (distinct from each other)', () => {
    const kit = customKit();
    expect(intentColor(kit, 'warning')).not.toBe(intentColor(kit, 'danger'));
  });

  it('an achromatic primary derives itself (hue rotation is a no-op on grey)', () => {
    const kit = customKit({ primaryColor: 0x808080 });
    expect(intentColor(kit, 'warning')).toBe(0x808080);
    expect(intentColor(kit, 'danger')).toBe(0x808080);
  });
});

// ── Footer / attribution rule ───────────────────────────────

describe('footer attribution rule', () => {
  it('sets the attribution as the footer when the embed has none', () => {
    const embed = brandedEmbed(customKit());
    expect(embed.data.footer?.text).toBe('Powered by SomniBot');
  });

  it('APPENDS " • {attribution}" to an existing semantic footer — never clobbers', () => {
    const embed = new EmbedBuilder().setFooter({ text: 'Ticket created by user#1234' });
    applyBrand(embed, customKit());
    expect(embed.data.footer?.text).toBe('Ticket created by user#1234 • Powered by SomniBot');
  });

  it('preserves the existing footer icon when appending', () => {
    const embed = new EmbedBuilder();
    embed.data.footer = { text: 'Achievement unlocked', icon_url: 'https://cdn/icon.png' };
    applyBrand(embed, customKit());
    expect(embed.data.footer?.text).toBe('Achievement unlocked • Powered by SomniBot');
    expect(embed.data.footer?.icon_url).toBe('https://cdn/icon.png');
  });

  it('does not double-append when the footer already carries the attribution', () => {
    const embed = new EmbedBuilder().setFooter({ text: 'Ticket #1 • Powered by SomniBot' });
    applyBrand(embed, customKit());
    expect(embed.data.footer?.text).toBe('Ticket #1 • Powered by SomniBot');
  });

  it('attribution:false suppresses the attribution and leaves the footer untouched', () => {
    const bare = brandedEmbed(customKit(), { attribution: false });
    expect(bare.data.footer).toBeUndefined();

    const semantic = new EmbedBuilder().setFooter({ text: 'Case #42' });
    applyBrand(semantic, customKit(), { attribution: false });
    expect(semantic.data.footer?.text).toBe('Case #42');
  });

  it('owner powered-by opt-out (poweredByAttribution null) also suppresses it', () => {
    const kit = customKit({ poweredByAttribution: null });
    expect(brandedEmbed(kit).data.footer).toBeUndefined();

    const semantic = new EmbedBuilder().setFooter({ text: 'Case #42' });
    applyBrand(semantic, kit);
    expect(semantic.data.footer?.text).toBe('Case #42');
  });
});

// ── brandedEmbedFor ─────────────────────────────────────────

/** guild_config select().eq().maybeSingle() chain returning `config`. */
function configSupabase(config: unknown, opts: { error?: unknown } = {}) {
  const from = vi.fn(() => {
    const chain: any = {};
    for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: config, error: opts.error ?? null }));
    return chain;
  });
  return { supabase: { from } as any, from };
}

describe('brandedEmbedFor', () => {
  it('resolves the guild kit and renders the branded embed', async () => {
    const { supabase } = configSupabase({
      store_brand_name: 'Acme Support',
      store_show_powered_by: true,
      brand_primary_color: 0xabcdef,
    });

    const embed = await brandedEmbedFor(supabase, 'g-embed-1', {
      title: 'Hello',
      description: 'World',
    });

    expect(embed.data.color).toBe(0xabcdef);
    expect(embed.data.title).toBe('Hello');
    expect(embed.data.description).toBe('World');
    expect(embed.data.footer?.text).toBe('Powered by SomniBot');
  });

  it('uses the cached row on subsequent calls (one DB read)', async () => {
    const { supabase, from } = configSupabase({ brand_primary_color: 0x123456 });

    await brandedEmbedFor(supabase, 'g-embed-2');
    await brandedEmbedFor(supabase, 'g-embed-2', { intent: 'info' });

    expect(from).toHaveBeenCalledTimes(1);
  });

  it('renders the default kit (with fallbackName) when resolution fails', async () => {
    const { supabase } = configSupabase(null, { error: { message: 'boom' } });

    const embed = await brandedEmbedFor(supabase, 'g-embed-3', { fallbackName: 'Cool Server' });

    expect(embed.data.color).toBe(DEFAULT_PRIMARY);
    expect(embed.data.footer?.text).toBe('Powered by SomniBot');
  });

  it('default kit + info intent renders the default accent', async () => {
    const { supabase } = configSupabase(null);
    const embed = await brandedEmbedFor(supabase, 'g-embed-4', { intent: 'info' });
    expect(embed.data.color).toBe(DEFAULT_ACCENT);
  });
});
