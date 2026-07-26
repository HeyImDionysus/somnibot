/**
 * Brand Kit — white-label resolution + one embed that consumes it.
 *
 * resolveBrandKit is the single source of truth for a guild's owner brand
 * (name, colors, voice, powered-by attribution). These tests assert:
 *   1. It resolves owner config and falls back to the SomniBot palette safely.
 *   2. A real member-facing embed (the ticket panel) renders the resolved brand
 *      primary color instead of the hardcoded SOMNI_PALETTE.HOT_PINK.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured embed colors from the discord.js mock (declared before vi.mock so the
// hoisted factory can safely reference it — mirrors store-command-branding.test).
const embedColors: number[] = [];

// Mock @somnibot/shared with the REAL default palette values (brand.ts) so the
// fallback assertions below match the shipped defaults.
vi.mock('@somnibot/shared', () => ({
  SOMNI_PALETTE: { HOT_PINK: 0xff1493, CYAN: 0x00d4ff, ORANGE: 0xff6b00, NEAR_BLACK: 0x0d0d0d },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = {};
    setColor(c: number) { this.data.color = c; embedColors.push(c); return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder { setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; } setEmoji() { return this; } }
  class StringSelectMenuBuilder { setCustomId() { return this; } setPlaceholder() { return this; } addOptions() { return this; } }
  return {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    StringSelectMenuBuilder,
  };
});

import {
  resolveBrandKit,
  defaultBrandKit,
  invalidateBrandKitCache,
} from '../features/branding/brand-kit.js';
import { postPanel } from '../features/tickets/panel-manager.js';

const DEFAULT_PRIMARY = 0xff1493;
const DEFAULT_ACCENT = 0x00d4ff;

// resolveBrandKit caches the guild_config row per guild (30s TTL); every test
// here uses guild 'g1' with a fresh supabase mock, so clear between tests.
beforeEach(() => {
  invalidateBrandKitCache();
});

// ── resolveBrandKit ─────────────────────────────────────────────────────────

/** guild_config select().eq().maybeSingle() chain returning `config`. */
function configSupabase(config: unknown, opts: { error?: unknown } = {}) {
  return {
    from: vi.fn(() => {
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: config, error: opts.error ?? null }));
      return chain;
    }),
  } as any;
}

describe('resolveBrandKit', () => {
  it('returns the SomniBot default kit when no config row exists', async () => {
    const kit = await resolveBrandKit(configSupabase(null), 'g1');
    expect(kit).toEqual({
      brandName: 'SomniBot',
      primaryColor: DEFAULT_PRIMARY,
      accentColor: DEFAULT_ACCENT,
      voicePreset: 'default',
      poweredByAttribution: 'Powered by SomniBot',
      currencyName: 'Coins',
      currencyEmoji: '🪙',
    });
  });

  it('falls back to the guild name when no owner brand name is set', async () => {
    const kit = await resolveBrandKit(
      configSupabase({ store_brand_name: null, store_show_powered_by: true }),
      'g1',
      { fallbackName: 'Cool Server' },
    );
    expect(kit.brandName).toBe('Cool Server');
  });

  it('resolves the full owner-configured brand kit', async () => {
    const kit = await resolveBrandKit(
      configSupabase({
        store_brand_name: '  Acme Support  ',
        store_show_powered_by: true,
        brand_primary_color: 0x112233,
        brand_accent_color: 0x445566,
        brand_voice_preset: 'professional',
      }),
      'g1',
      { fallbackName: 'Guild Name' },
    );
    expect(kit).toEqual({
      brandName: 'Acme Support', // trimmed, wins over fallback
      primaryColor: 0x112233,
      accentColor: 0x445566,
      voicePreset: 'professional',
      poweredByAttribution: 'Powered by SomniBot',
      currencyName: 'Coins',
      currencyEmoji: '🪙',
    });
  });

  it('omits the powered-by attribution when the owner disables it', async () => {
    const kit = await resolveBrandKit(
      configSupabase({ store_brand_name: 'Acme', store_show_powered_by: false }),
      'g1',
    );
    expect(kit.poweredByAttribution).toBeNull();
  });

  it('coerces out-of-range colors and unknown voice presets to defaults', async () => {
    const kit = await resolveBrandKit(
      configSupabase({
        brand_primary_color: 0x1000000, // > 0xFFFFFF → invalid
        brand_accent_color: -1, // negative → invalid
        brand_voice_preset: 'sarcastic', // not an allowed preset
      }),
      'g1',
    );
    expect(kit.primaryColor).toBe(DEFAULT_PRIMARY);
    expect(kit.accentColor).toBe(DEFAULT_ACCENT);
    expect(kit.voicePreset).toBe('default');
  });

  it('returns defaults on a query error instead of throwing', async () => {
    const kit = await resolveBrandKit(configSupabase(null, { error: { message: 'boom' } }), 'g1', {
      fallbackName: 'Fallback',
    });
    expect(kit).toEqual(defaultBrandKit('Fallback'));
  });

  it('returns defaults when the supabase call throws', async () => {
    const throwing = {
      from: vi.fn(() => {
        throw new Error('connection refused');
      }),
    } as any;
    const kit = await resolveBrandKit(throwing, 'g1', { fallbackName: 'Fallback' });
    expect(kit).toEqual(defaultBrandKit('Fallback'));
  });
});

// ── Embed consuming the brand kit ───────────────────────────────────────────
// The ticket panel embed (panel-manager.postPanel → buildPanelEmbed) must render
// the resolved brand primary color, proving the white-label wiring end-to-end.

function panelSupabase(guildConfig: unknown) {
  return {
    from: vi.fn((table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'update']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({
        data: table === 'guild_config' ? guildConfig : null,
        error: null,
      }));
      chain.then = (res: any) => Promise.resolve({ data: null, error: null }).then(res);
      return chain;
    }),
  } as any;
}

function makeGuild(channel: any) {
  return {
    id: 'g1',
    name: 'Test Guild',
    channels: { cache: new Map([['ch1', channel]]) },
  } as any;
}

const panel = {
  id: 'panel1',
  name: 'Support',
  channel_id: 'ch1',
  message_id: null,
  input_mode: 'buttons',
  panel_message: { title: 'Support', description: 'Open a ticket', footer: null, thumbnail: null },
  ticket_types: [{ id: 'general', label: 'General', color: 'blue', emoji: null, description: 'Help' }],
} as any;

describe('ticket panel embed consumes the brand kit', () => {
  beforeEach(() => { embedColors.length = 0; });

  it('renders the owner brand primary color, not the hardcoded palette', async () => {
    const channel = { name: 'tickets', send: vi.fn().mockResolvedValue({ id: 'm1' }), messages: { fetch: vi.fn() } };
    const supabase = panelSupabase({ brand_primary_color: 0xabcdef, store_show_powered_by: true });

    const result = await postPanel(makeGuild(channel), panel, supabase);

    expect(result.success).toBe(true);
    expect(channel.send).toHaveBeenCalled();
    expect(embedColors).toContain(0xabcdef);
    expect(embedColors).not.toContain(DEFAULT_PRIMARY);
  });

  it('falls back to the SomniBot primary color when unconfigured', async () => {
    const channel = { name: 'tickets', send: vi.fn().mockResolvedValue({ id: 'm1' }), messages: { fetch: vi.fn() } };
    const supabase = panelSupabase(null);

    const result = await postPanel(makeGuild(channel), panel, supabase);

    expect(result.success).toBe(true);
    expect(embedColors).toContain(DEFAULT_PRIMARY);
  });
});
