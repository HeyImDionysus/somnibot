/**
 * /store command — Browse products in Discord.
 *
 * Shows active products with purchase buttons that generate PayPal checkout URLs.
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyBrand, resolveBrandKit } from '../branding/index.js';

export function buildStoreCommand() {
  return new SlashCommandBuilder()
    .setName('store')
    .setDescription('Browse the server store');
}

function productMatchesEnabledType(product: Record<string, unknown>, enabled: Set<string>): boolean {
  const price = Number(product.price_cents ?? 0);
  const delivery = String(product.delivery_type ?? '');
  const productType = String(product.type ?? '');
  if (enabled.has('subscription') && productType === 'subscription') return true;
  if (enabled.has('free') && productType === 'free' && price === 0) return true;
  if (enabled.has('downloadable') && ['file', 'link', 'mixed'].includes(delivery)) return true;
  if (enabled.has('license-key') && delivery === 'license_key') return true;
  if (enabled.has('discord-perk') && Array.isArray(product.granted_role_ids) && product.granted_role_ids.length > 0) return true;
  if (enabled.has('virtual-good') && delivery === 'access_pass') return true;
  if (enabled.has('ticket-service') && delivery === 'ticket_service') return true;
  return false;
}

export async function handleStoreCommand(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
  paypalApiBase: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Fetch active products
  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .eq('guild_id', guildId)
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .limit(1000);

  if (error) {
    // A failed READ is not an empty store — and not a raw vendor error either:
    // during a database outage the catalog may be full, so degrade honestly
    // with the branded store-unavailable notice. The brand read is itself
    // outage-safe (resolveBrandKit never throws; the guild name is the
    // fallback), so this reply renders even while the database is down.
    const brandKit = await resolveBrandKit(supabase, guildId, { fallbackName: interaction.guild?.name }).catch(() => null);
    const name = brandKit?.brandName ?? interaction.guild?.name ?? 'This server';
    await interaction.editReply({
      content: `⚠️ ${name}'s store is temporarily unavailable — please try again in a moment.`,
    });
    return;
  }

  const { data: config } = await supabase
    .from('guild_config')
    .select('product_types_enabled, max_storefront_products, gifting_enabled')
    .eq('guild_id', guildId)
    .maybeSingle();
  const enabledTypes = new Set<string>(
    Array.isArray(config?.product_types_enabled)
      ? config.product_types_enabled.filter((value: unknown): value is string => typeof value === 'string')
      : ['downloadable', 'license-key', 'discord-perk', 'subscription', 'virtual-good', 'ticket-service', 'free'],
  );
  const maxProducts = Number(config?.max_storefront_products);
  const storefrontLimit = Number.isInteger(maxProducts) && maxProducts >= 1 && maxProducts <= 9 ? maxProducts : 9;
  const giftingEnabled = config?.gifting_enabled === true;
  const visibleProducts = (products ?? []).filter((product) => productMatchesEnabledType(product as Record<string, unknown>, enabledTypes));

  if (visibleProducts.length === 0) {
    await interaction.editReply({ content: '🏪 The store is empty right now. Check back later!' });
    return;
  }

  // White-label branding: the storefront header carries the owner's brand kit
  // (name falling back to the guild name, brand colors, powered-by attribution)
  // instead of hardcoded vendor branding. One cached kit read covers it all.
  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name ?? 'Server Store',
  });

  // Build product embeds (max 10 per message)
  const embeds: EmbedBuilder[] = [];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Header embed — the attribution footer is handled by applyBrand per the
  // owner's powered-by toggle.
  const headerEmbed = new EmbedBuilder()
    .setTitle(kit.brandName)
    .setDescription('Browse our products below. Click "Buy" to purchase!');
  applyBrand(headerEmbed, kit, { intent: 'primary' });
  embeds.push(headerEmbed);

  for (const product of visibleProducts.slice(0, storefrontLimit)) {
    const price = (product.price_cents / 100).toFixed(2);
    const typeLabel = product.type === 'subscription' ? '🔄 Subscription' : product.type === 'free' ? '🆓 Free' : '🎁 One-Time';

    // Product cards keep attribution off — the header already carries it.
    embeds.push(
      applyBrand(
        new EmbedBuilder()
          .setTitle(product.name)
          .setDescription(product.description || 'No description')
          .addFields(
            { name: 'Price', value: `$${price} ${product.currency}`, inline: true },
            { name: 'Type', value: typeLabel, inline: true },
          ),
        kit,
        { intent: 'info', attribution: false },
      ),
    );

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(product.type === 'free' && product.price_cents === 0 ? `store:claim:${product.id}` : `store:buy:${product.id}`)
        .setLabel(product.type === 'free' && product.price_cents === 0 ? `Claim ${product.name}` : `Buy ${product.name} — $${price}`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(product.type === 'free' ? '🎁' : '🛒'),
    );
    if (giftingEnabled && product.type === 'one_time' && product.price_cents > 0) {
      actionRow.addComponents(
        new ButtonBuilder().setCustomId(`store:gift:${product.id}`).setLabel('Gift').setStyle(ButtonStyle.Secondary).setEmoji('🎁'),
      );
    }
    rows.push(actionRow);
  }

  // Discord limits: 10 embeds, 5 action rows
  await interaction.editReply({
    embeds: embeds.slice(0, 10),
    components: rows.slice(0, 5),
  });
}
