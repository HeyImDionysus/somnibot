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
    .order('sort_order', { ascending: true });

  if (error) {
    await interaction.editReply({ content: '❌ Failed to load store. Please try again later.' });
    return;
  }

  if (!products || products.length === 0) {
    await interaction.editReply({ content: '🏪 The store is empty right now. Check back later!' });
    return;
  }

  // Build product embeds (max 10 per message)
  const embeds: EmbedBuilder[] = [];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Header embed
  embeds.push(
    new EmbedBuilder()
      .setColor(HOT_PINK)
      .setTitle('🏪 Server Store')
      .setDescription('Browse our products below. Click "Buy" to purchase!'),
  );

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
