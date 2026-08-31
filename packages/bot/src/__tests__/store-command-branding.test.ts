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
  class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addBooleanOption(callback: (option: SlashCommandBuilder) => unknown) { callback(this); return this; }
    addStringOption(callback: (option: SlashCommandBuilder) => unknown) { callback(this); return this; }
    setMinLength() { return this; }
    setMaxLength() { return this; }
  }
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

type StoreRow = Record<string, unknown>;
type ProductQueryError = { readonly code: string; readonly message: string } | null;

type ProductQueryChain = {
  readonly select: () => ProductQueryChain;
  readonly eq: () => ProductQueryChain;
  readonly in: () => ProductQueryChain;
  readonly order: () => ProductQueryChain;
  readonly limit: () => ProductQueryChain;
  readonly then: PromiseLike<{ readonly data: readonly StoreRow[] | null; readonly error: ProductQueryError }>['then'];
};

function makeProductQueryChain(data: readonly StoreRow[], error: ProductQueryError): ProductQueryChain {
  const result = { data: error ? null : data, error };
  const chain: ProductQueryChain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

function makeSupabase(
  products: readonly StoreRow[],
  guildConfig: StoreRow | null,
  productError: ProductQueryError = null,
  launchRuns: readonly StoreRow[] = [],
) {
  const auditRows: Record<string, unknown>[] = [];
  return {
    auditRows,
    from: vi.fn((table: string) => {
      if (table === 'products') {
        const chain: any = {};
        for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = vi.fn(() => chain);
        chain.then = (resolve: any) => resolve({ data: productError ? null : products, error: productError });
        return chain;
      }
      if (table === 'commerce_product_launch_runs') {
        return makeProductQueryChain(launchRuns, null);
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

function makeInteraction(guildName?: string, coupon?: string, testLaunch = false) {
  return {
    id: 'interaction-1',
    user: { id: 'member-1' },
    guild: guildName ? { name: guildName, ownerId: 'member-1' } : null,
    options: {
      getString: vi.fn(() => coupon ?? null),
      getBoolean: vi.fn(() => testLaunch),
    },
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

  it('gives only the owner a launch-scoped Sandbox button for an inactive product', async () => {
    const runId = '00000000-0000-4000-8000-000000000101';
    const productId = '00000000-0000-4000-8000-000000000102';
    const interaction = makeInteraction('Cool Server', undefined, true);
    const supabase = makeSupabase(
      [{ ...sampleProduct, id: productId }],
      { store_brand_name: null, store_show_powered_by: true },
      null,
      [{ id: runId, product_id: productId }],
    );

    await handleStoreCommand(interaction, supabase, 'g1', 'https://api-m.sandbox.paypal.com');

    expect(buttonCustomIds).toContain(`store:launch-buy:${runId}:${productId}`);
    expect(embedInstances[0].data.description).toContain('Sandbox launch test');
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
