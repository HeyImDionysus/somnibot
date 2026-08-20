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
const buttonCustomIds: string[] = [];

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
    setCustomId(id: string) { buttonCustomIds.push(id); return this; }
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
  // One-time products are surfaced through the enabled delivery facet. A
  // downloadable delivery matches the default storefront type allow-list.
  delivery_type: 'file',
  sort_order: 0,
};

function makeSupabase(products: any[], guildConfig: any, productError: { code: string; message: string } | null = null) {
  const auditRows: Record<string, unknown>[] = [];
  return {
    auditRows,
    from: vi.fn((table: string) => {
      if (table === 'products') {
        const chain: any = {};
        for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.then = (resolve: any) => resolve({ data: productError ? null : products, error: productError });
        return chain;
      }
      if (table === 'audit_logs') {
        return {
          upsert: vi.fn(async (rows: Record<string, unknown>[]) => {
            auditRows.push(...rows);
            return { error: null };
          }),
        };
      }
      // guild_config
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: guildConfig, error: null }));
      return chain;
    }),
  } as any;
}

function makeInteraction(guildName?: string, coupon?: string) {
  return {
    id: 'interaction-1',
    user: { id: 'member-1' },
    guild: guildName ? { name: guildName } : null,
    options: { getString: vi.fn(() => coupon ?? null) },
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
  } as any;
}

describe('handleStoreCommand — white-label branding', () => {
  beforeEach(() => {
    embedInstances.length = 0;
    buttonCustomIds.length = 0;
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

  it('carries a normalized coupon into one-time checkout buttons', async () => {
    const interaction = makeInteraction('Cool Server', 'save_25');
    const supabase = makeSupabase([sampleProduct], { store_brand_name: null, store_show_powered_by: true });

    await handleStoreCommand(interaction, supabase, 'g1', 'https://api.paypal.example');

    expect(buttonCustomIds).toContain('store:buy:prod-1:SAVE_25');
    expect(embedInstances[0].data.description).toContain('SAVE_25');
  });

  it('audits an actual products-query failure once without calling an empty store a failure', async () => {
    const failedInteraction = makeInteraction('Cool Server');
    const failed = makeSupabase([], null, { code: '08006', message: 'connection failure' });

    await handleStoreCommand(failedInteraction, failed, 'g1', 'https://api.paypal.example');

    expect(failed.auditRows).toEqual([expect.objectContaining({
      action: 'commerce.store.load_failed',
      actor_id: 'member-1',
      occurrence_key: 'commerce.store.load_failed:interaction-1',
      success: false,
    })]);

    const emptyInteraction = makeInteraction('Cool Server');
    const empty = makeSupabase([], null);
    await handleStoreCommand(emptyInteraction, empty, 'g1', 'https://api.paypal.example');
    expect(empty.auditRows).toEqual([]);
    expect(emptyInteraction.editReply).toHaveBeenCalledWith({
      content: '🏪 The store is empty right now. Check back later!',
    });
  });
});
