/**
 * Storefront white-label branding — handleStoreCommand header embed.
 *
 * The catalog contracts that the storefront header carries the owner brand name
 * plus a subtle powered-by-SomniBot attribution instead of hardcoded vendor
 * branding. These tests assert the header embed title resolves to the owner
 * brand (falling back to the guild name) and that the footer attribution is
 * present unless the owner disabled it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const embedInstances: any[] = [];

vi.mock('discord.js', () => {
  class EmbedBuilder {
    data: any = { fields: [] };
    constructor() { embedInstances.push(this); }
    setColor(c: number) { this.data.color = c; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    addFields(...a: any[]) { this.data.fields.push(...a); return this; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setEmoji() { return this; }
  }
  class SlashCommandBuilder { setName() { return this; } setDescription() { return this; } }
  return { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle: { Primary: 1 }, SlashCommandBuilder };
});

import { handleStoreCommand } from '../features/commerce/store-command.js';
import { invalidateBrandKitCache } from '../features/branding/brand-kit.js';

const sampleProduct = {
  id: 'prod-1',
  name: 'Cool Thing',
  description: 'A cool thing',
  price_cents: 500,
  currency: 'USD',
  type: 'one_time',
  sort_order: 0,
};

function makeSupabase(products: any[], guildConfig: any) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'products') {
        const chain: any = {};
        for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.then = (resolve: any) => resolve({ data: products, error: null });
        return chain;
      }
      // guild_config
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: guildConfig, error: null }));
      return chain;
    }),
  } as any;
}

function makeInteraction(guildName?: string) {
  return {
    guild: guildName ? { name: guildName } : null,
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('handleStoreCommand — white-label branding', () => {
  beforeEach(() => {
    embedInstances.length = 0;
    // Every case below resolves guild 'g1' with a DIFFERENT brand row. The kit
    // resolver caches per guild (30s TTL), so without this the first case's kit
    // would answer the rest.
    invalidateBrandKitCache();
  });

  it('uses the owner store brand as the header title with powered-by footer', async () => {
    const interaction = makeInteraction('Guild Name');
    const supabase = makeSupabase([sampleProduct], {
      store_brand_name: 'Acme Emporium',
      store_show_powered_by: true,
    });

    await handleStoreCommand(interaction, supabase, 'g1', 'https://api.paypal.example');

    expect(interaction.editReply).toHaveBeenCalled();
    const header = embedInstances[0];
    expect(header.data.title).toBe('Acme Emporium');
    expect(header.data.footer?.text).toContain('Powered by SomniBot');
  });

  it('falls back to the guild name when no owner brand is configured', async () => {
    const interaction = makeInteraction('Cool Server');
    const supabase = makeSupabase([sampleProduct], { store_brand_name: null, store_show_powered_by: true });

    await handleStoreCommand(interaction, supabase, 'g1', 'https://api.paypal.example');

    const header = embedInstances[0];
    expect(header.data.title).toBe('Cool Server');
  });

  it('omits the powered-by footer when the owner disables it', async () => {
    const interaction = makeInteraction('Cool Server');
    const supabase = makeSupabase([sampleProduct], {
      store_brand_name: 'Acme Emporium',
      store_show_powered_by: false,
    });

    await handleStoreCommand(interaction, supabase, 'g1', 'https://api.paypal.example');

    const header = embedInstances[0];
    expect(header.data.title).toBe('Acme Emporium');
    expect(header.data.footer).toBeUndefined();
  });
});
