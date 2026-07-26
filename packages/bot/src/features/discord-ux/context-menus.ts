/**
 * Context Menus — Right-click actions for users and messages.
 *
 * User Context Menus:
 * - View Profile → Show XP, level, roles, purchase history, infractions
 * - Warn User → Open warn modal with pre-filled target
 * - View Purchases → Show commerce history for user
 *
 * Message Context Menus:
 * - Create Ticket → Open ticket from message context
 * - Report Message → Report to moderators with modal for reason
 */
import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  EmbedBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  type UserContextMenuCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type Guild,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyBrand, resolveBrandKit } from '../branding/index.js';

// ── Command Builders ──────────────────────────────────────

export function buildContextMenuCommands() {
  return [
    new ContextMenuCommandBuilder()
      .setName('View Profile')
      .setType(ApplicationCommandType.User),

    new ContextMenuCommandBuilder()
      .setName('Warn User')
      .setType(ApplicationCommandType.User),

    new ContextMenuCommandBuilder()
      .setName('View Purchases')
      .setType(ApplicationCommandType.User),

    new ContextMenuCommandBuilder()
      .setName('Create Ticket')
      .setType(ApplicationCommandType.Message),

    new ContextMenuCommandBuilder()
      .setName('Report Message')
      .setType(ApplicationCommandType.Message),
  ];
}

// ── User Context Menu Handlers ────────────────────────────

export async function handleViewProfile(
  interaction: UserContextMenuCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.targetUser;
  const member = interaction.guild?.members.cache.get(target.id);

  // Fetch user data in parallel
  const [levelData, infractions, purchases] = await Promise.all([
    supabase
      .from('member_levels')
      .select('level, xp, total_messages')
      .eq('guild_id', guildId)
      .eq('member_id', target.id)
      .maybeSingle(),
    supabase
      .from('infractions')
      .select('id')
      .eq('guild_id', guildId)
      .eq('member_id', target.id)
      .eq('active', true),
    supabase
      .from('customers')
      .select('total_spent_cents, first_purchase_at')
      .eq('guild_id', guildId)
      .eq('discord_id', target.id)
      .maybeSingle(),
  ]);

  const level = levelData.data?.level ?? 0;
  const totalXp = levelData.data?.xp ?? 0;
  const messages = levelData.data?.total_messages ?? 0;
  const activeInfractions = infractions.data?.length ?? 0;
  const totalSpent = purchases.data?.total_spent_cents ?? 0;

  const roles = member?.roles.cache
    .filter((r) => r.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.toString())
    .slice(0, 10)
    .join(', ') || 'None';

  const joined = member?.joinedAt
    ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`
    : 'Unknown';

  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name,
  });
  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${target.displayName}'s Profile`,
      iconURL: target.displayAvatarURL(),
    })
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '📊 Level', value: `Level **${level}** (${totalXp.toLocaleString()} XP)`, inline: true },
      { name: '💬 Messages', value: messages.toLocaleString(), inline: true },
      { name: '📅 Joined', value: joined, inline: true },
      { name: '⚠️ Active Infractions', value: activeInfractions.toString(), inline: true },
      { name: '💰 Total Spent', value: totalSpent > 0 ? `$${(totalSpent / 100).toFixed(2)}` : '$0.00', inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: `Roles (${member?.roles.cache.size ? member.roles.cache.size - 1 : 0})`, value: roles },
    )
    .setFooter({ text: `ID: ${target.id}` })
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'primary' });

  await interaction.editReply({ embeds: [embed] });
}

export async function handleWarnUser(
  interaction: UserContextMenuCommandInteraction,
): Promise<void> {
  const target = interaction.targetUser;

  // Open a modal for the warn reason
  const modal = new ModalBuilder()
    .setCustomId(`warn_modal:${target.id}`)
    .setTitle(`Warn ${target.displayName}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('warn_reason')
          .setLabel('Reason for warning')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Describe the reason for this warning...')
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleViewPurchases(
  interaction: UserContextMenuCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.targetUser;

  // Fetch customer + orders
  const { data: customer } = await supabase
    .from('customers')
    .select('id, total_spent_cents, first_purchase_at')
    .eq('guild_id', guildId)
    .eq('discord_id', target.id)
    .maybeSingle();

  if (!customer) {
    await interaction.editReply({
      content: `${target.displayName} has no purchase history.`,
    });
    return;
  }

  const { data: orders } = await supabase
    .from('orders')
    .select('order_number, status, amount_cents, currency, created_at, products(name)')
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: false })
    .limit(10);

  const orderLines = (orders ?? []).map((o) => {
    const productData = o.products as { name: string } | { name: string }[] | null;
    const product = Array.isArray(productData) ? (productData[0]?.name ?? 'Unknown') : (productData?.name ?? 'Unknown');
    const amount = `$${((o.amount_cents ?? 0) / 100).toFixed(2)}`;
    const status = o.status === 'completed' ? '✅' : o.status === 'pending' ? '⏳' : '❌';
    const date = new Date(o.created_at).toLocaleDateString();
    return `${status} **${product}** — ${amount} (${date})`;
  });

  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name,
  });
  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${target.displayName}'s Purchases`,
      iconURL: target.displayAvatarURL(),
    })
    .setDescription(
      orderLines.length > 0
        ? orderLines.join('\n')
        : 'No orders found.',
    )
    .addFields(
      {
        name: 'Lifetime Value',
        value: `$${((customer.total_spent_cents ?? 0) / 100).toFixed(2)}`,
        inline: true,
      },
      {
        name: 'First Purchase',
        value: customer.first_purchase_at
          ? new Date(customer.first_purchase_at).toLocaleDateString()
          : 'N/A',
        inline: true,
      },
    )
    .setFooter({ text: `Customer ID: ${customer.id}` })
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'info' });

  await interaction.editReply({ embeds: [embed] });
}

// ── Message Context Menu Handlers ─────────────────────────

export async function handleCreateTicketFromMessage(
  interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
  const message = interaction.targetMessage;

  // Open a modal for ticket details
  const modal = new ModalBuilder()
    .setCustomId(`ticket_from_msg:${message.id}:${message.channel.id}`)
    .setTitle('Create Support Ticket')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('ticket_subject')
          .setLabel('Subject')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Brief description of the issue...')
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('ticket_details')
          .setLabel('Details')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Provide additional context...')
          .setRequired(false)
          .setMaxLength(2000),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleReportMessage(
  interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
  const message = interaction.targetMessage;

  const modal = new ModalBuilder()
    .setCustomId(`report_msg:${message.id}:${message.channel.id}:${message.author.id}`)
    .setTitle('Report Message')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('report_reason')
          .setLabel('Why are you reporting this message?')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Describe why this message should be reviewed...')
          .setRequired(true)
          .setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('report_category')
          .setLabel('Category (spam, harassment, nsfw, other)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('spam')
          .setRequired(false)
          .setMaxLength(50),
      ),
    );

  await interaction.showModal(modal);
}
