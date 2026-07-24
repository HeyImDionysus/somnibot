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
import { resolveBrandKit } from '../branding/brand-kit.js';

const HOT_PINK = 0xFF1493;
const CYAN = 0x00E5FF;

export function buildStoreCommand() {
  return new SlashCommandBuilder()
    .setName('store')
    .setDescription('Browse the server store');
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

  if (!products || products.length === 0) {
    await interaction.editReply({ content: '🏪 The store is empty right now. Check back later!' });
    return;
  }

  // White-label branding: the storefront header carries the owner's brand name
  // (falling back to the guild name, then a neutral default) plus a subtle
  // powered-by-SomniBot attribution, instead of hardcoded vendor branding.
  const { data: storeConfig } = await supabase
    .from('guild_config')
    .select('store_brand_name, store_show_powered_by')
    .eq('guild_id', guildId)
    .maybeSingle();
  const brandName =
    (typeof storeConfig?.store_brand_name === 'string' && storeConfig.store_brand_name.trim().length > 0
      ? storeConfig.store_brand_name.trim()
      : undefined)
    ?? interaction.guild?.name
    ?? 'Server Store';
  const showPoweredBy = storeConfig?.store_show_powered_by ?? true;

  // Build product embeds (max 10 per message)
  const embeds: EmbedBuilder[] = [];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Header embed
  const headerEmbed = new EmbedBuilder()
    .setColor(HOT_PINK)
    .setTitle(brandName)
    .setDescription('Browse our products below. Click "Buy" to purchase!');
  if (showPoweredBy) {
    headerEmbed.setFooter({ text: 'Powered by SomniBot' });
  }
  embeds.push(headerEmbed);

  for (const product of products.slice(0, 9)) {
    const price = (product.price_cents / 100).toFixed(2);
    const typeLabel = product.type === 'subscription' ? '🔄 Subscription' : '🎁 One-Time';

    embeds.push(
      new EmbedBuilder()
        .setColor(CYAN)
        .setTitle(product.name)
        .setDescription(product.description || 'No description')
        .addFields(
          { name: 'Price', value: `$${price} ${product.currency}`, inline: true },
          { name: 'Type', value: typeLabel, inline: true },
        ),
    );

    // Buy button
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`store:buy:${product.id}`)
          .setLabel(`Buy ${product.name} — $${price}`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🛒'),
      ),
    );
  }

  // Discord limits: 10 embeds, 5 action rows
  await interaction.editReply({
    embeds: embeds.slice(0, 10),
    components: rows.slice(0, 5),
  });
}
