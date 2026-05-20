/**
 * Manual Moderation Commands — /warn, /mute, /kick, /ban, /pardon, /infractions
 *
 * These give moderators direct slash-command access to the moderation system
 * that was previously only accessible through auto-mod or the dashboard.
 */
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { InfractionType, EscalationStep } from '@somnibot/shared';
import { SOMNI_PALETTE } from '@somnibot/shared';
import {
  createInfraction,
  getMemberInfractions,
  getActiveWarningCount,
  pardonInfraction,
  calculateExpiryDate,
} from './infraction-service.js';
import { executeEscalation, getEscalationAction } from './escalation.js';
import { postModLogEntry } from './mod-log.js';

// ── Command Builders ──────────────────────────────────────

export function buildModerationCommands() {
  const warn = new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The member to warn').setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for the warning').setRequired(true),
    );

  const mute = new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout a member (Discord timeout)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The member to mute').setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('duration')
        .setDescription('Duration in minutes')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes', value: 5 },
          { name: '10 minutes', value: 10 },
          { name: '30 minutes', value: 30 },
          { name: '1 hour', value: 60 },
          { name: '6 hours', value: 360 },
          { name: '12 hours', value: 720 },
          { name: '1 day', value: 1440 },
          { name: '3 days', value: 4320 },
          { name: '1 week', value: 10080 },
        ),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for the mute').setRequired(true),
    );

  const kick = new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The member to kick').setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for the kick').setRequired(true),
    );

  const ban = new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The member to ban').setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('delete_days')
        .setDescription('Days of message history to delete (0-7)')
        .setMinValue(0)
        .setMaxValue(7),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for the ban').setRequired(true),
    );

  const pardon = new SlashCommandBuilder()
    .setName('pardon')
    .setDescription('Pardon (remove) an active infraction')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((opt) =>
      opt.setName('infraction_id').setDescription('The infraction ID to pardon').setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for pardoning'),
    );

  const infractions = new SlashCommandBuilder()
    .setName('infractions')
    .setDescription('View infractions for a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The member to view infractions for').setRequired(true),
    )
    .addBooleanOption((opt) =>
      opt.setName('active_only').setDescription('Only show active infractions (default: true)'),
    );

  return { warn, mute, kick, ban, pardon, infractions };
}

// ── Command Handlers ──────────────────────────────────────

export async function handleWarnCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason', true);
  const guild = interaction.guild;
  if (!guild || !target || !('id' in target)) {
    await interaction.editReply('❌ Could not find the target member.');
    return;
  }

  const member = await guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply('❌ Member not found in this server.');
    return;
  }

  // Don't allow warning bots or self
  if (member.user.bot) {
    await interaction.editReply('❌ Cannot warn bots.');
    return;
  }
  if (member.id === interaction.user.id) {
    await interaction.editReply('❌ You cannot warn yourself.');
    return;
  }

  // Load mod config for escalation and expiry
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const expiryDays = config?.infraction_expiry_days ?? 30;

  // Create infraction
  const infraction = await createInfraction(client.supabase, {
    guildId: client.guildId,
    memberId: member.id,
    moderatorId: interaction.user.id,
    type: 'warn',
    reason,
    expiresAt: calculateExpiryDate(expiryDays),
  });

  if (!infraction) {
    await interaction.editReply('❌ Failed to create warning.');
    return;
  }

  // Emit event for automations
  client.eventBus.emit('moderation.action', client.guildId, {
    action: 'warn',
    discordId: member.id,
    moderatorId: interaction.user.id,
    reason,
    infractionId: infraction.id,
  });

  // Check escalation
  const activeCount = await getActiveWarningCount(client.supabase, client.guildId, member.id);
  const escalationChain = Array.isArray(config?.escalation_chain) ? config.escalation_chain : [];
  const nextAction = getEscalationAction(escalationChain, activeCount);

  // DM the user
  try {
    const dm = await member.user.createDM();
    const warnEmbed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.ORANGE)
      .setTitle('⚠️ Warning Received')
      .setDescription(`You've been warned in **${guild.name}**.\n\n**Reason:** ${reason}\n\nThis is warning #${activeCount}. Please review the server rules.`)
      .setTimestamp();
    await dm.send({ embeds: [warnEmbed] });
  } catch {
    // DMs disabled — non-fatal
  }

  // Post to mod log
  await postModLogEntry(client, {
    action: 'warn',
    member,
    moderator: interaction.user.tag,
    reason,
    activeWarnings: activeCount,
    nextEscalation: nextAction?.action ?? null,
    channelId: config?.mod_log_channel_id ?? null,
  });

  // Auto-escalate if needed
  if (nextAction && nextAction.action !== 'warn') {
    await executeEscalation(
      client,
      member,
      `Auto-escalation: ${activeCount} active warnings`,
      {
        escalationChain: escalationChain as EscalationStep[],
        infractionExpiryDays: expiryDays,
        modLogChannelId: config?.mod_log_channel_id ?? null,
      },
    );
  }

  await interaction.editReply(
    `✅ **${member.user.tag}** warned. Active warnings: **${activeCount}**.${nextAction && nextAction.action !== 'warn' ? ` Auto-escalated to **${nextAction.action}**.` : ''}`,
  );
}

export async function handleMuteCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getMember('user');
  const duration = interaction.options.getInteger('duration', true);
  const reason = interaction.options.getString('reason', true);
  const guild = interaction.guild;
  if (!guild || !target || !('id' in target)) {
    await interaction.editReply('❌ Could not find the target member.');
    return;
  }

  const member = await guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply('❌ Member not found.');
    return;
  }

  if (member.user.bot) {
    await interaction.editReply('❌ Cannot mute bots.');
    return;
  }
  if (!member.moderatable) {
    await interaction.editReply('❌ Cannot mute this member — their role may be higher than mine.');
    return;
  }

  // Apply Discord timeout
  try {
    await member.timeout(duration * 60 * 1000, `${reason} — by ${interaction.user.tag}`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to timeout member: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // Load config
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  // Create infraction
  const infraction = await createInfraction(client.supabase, {
    guildId: client.guildId,
    memberId: member.id,
    moderatorId: interaction.user.id,
    type: 'mute',
    reason,
    durationMinutes: duration,
    expiresAt: calculateExpiryDate(config?.infraction_expiry_days ?? 30),
  });

  // Emit event
  client.eventBus.emit('moderation.action', client.guildId, {
    action: 'mute',
    discordId: member.id,
    moderatorId: interaction.user.id,
    reason,
    durationMinutes: duration,
    infractionId: infraction?.id,
  });

  // DM the user
  try {
    const dm = await member.user.createDM();
    const durationText = duration >= 1440 ? `${Math.round(duration / 1440)} day(s)` : duration >= 60 ? `${Math.round(duration / 60)} hour(s)` : `${duration} minute(s)`;
    const muteEmbed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.HOT_PINK)
      .setTitle('🔇 Timed Out')
      .setDescription(`You've been timed out in **${guild.name}** for **${durationText}**.\n\n**Reason:** ${reason}`)
      .setTimestamp();
    await dm.send({ embeds: [muteEmbed] });
  } catch { /* non-fatal */ }

  // Mod log
  await postModLogEntry(client, {
    action: 'mute',
    member,
    moderator: interaction.user.tag,
    reason,
    duration,
    channelId: config?.mod_log_channel_id ?? null,
  });

  const durationText = duration >= 1440 ? `${Math.round(duration / 1440)}d` : duration >= 60 ? `${Math.round(duration / 60)}h` : `${duration}m`;
  await interaction.editReply(`✅ **${member.user.tag}** timed out for **${durationText}**. Reason: ${reason}`);
}

export async function handleKickCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason', true);
  const guild = interaction.guild;
  if (!guild || !target || !('id' in target)) {
    await interaction.editReply('❌ Could not find the target member.');
    return;
  }

  const member = await guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply('❌ Member not found.');
    return;
  }

  if (member.user.bot) {
    await interaction.editReply('❌ Cannot kick bots via this command.');
    return;
  }
  if (!member.kickable) {
    await interaction.editReply('❌ Cannot kick this member — their role may be higher than mine.');
    return;
  }

  // DM before kick
  try {
    const dm = await member.user.createDM();
    const kickEmbed = new EmbedBuilder()
      .setColor(SOMNI_PALETTE.HOT_PINK)
      .setTitle('👢 Kicked')
      .setDescription(`You've been kicked from **${guild.name}**.\n\n**Reason:** ${reason}\n\nYou may rejoin if you have an invite link.`)
      .setTimestamp();
    await dm.send({ embeds: [kickEmbed] });
  } catch { /* non-fatal */ }

  // Kick
  try {
    await member.kick(`${reason} — by ${interaction.user.tag}`);
  } catch (err) {
    await interaction.editReply(`❌ Kick failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // Load config
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  // Create infraction
  await createInfraction(client.supabase, {
    guildId: client.guildId,
    memberId: member.id,
    moderatorId: interaction.user.id,
    type: 'kick',
    reason,
    expiresAt: calculateExpiryDate(config?.infraction_expiry_days ?? 30),
  });

  // Emit event
  client.eventBus.emit('moderation.action', client.guildId, {
    action: 'kick',
    discordId: member.id,
    moderatorId: interaction.user.id,
    reason,
  });

  // Mod log
  await postModLogEntry(client, {
    action: 'kick',
    member,
    moderator: interaction.user.tag,
    reason,
    channelId: config?.mod_log_channel_id ?? null,
  });

  await interaction.editReply(`✅ **${member.user.tag}** has been kicked. Reason: ${reason}`);
}

export async function handleBanCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason', true);
  const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
  const guild = interaction.guild;
  if (!guild || !target || !('id' in target)) {
    await interaction.editReply('❌ Could not find the target member.');
    return;
  }

  const member = await guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    await interaction.editReply('❌ Member not found.');
    return;
  }

  if (member.user.bot) {
    await interaction.editReply('❌ Cannot ban bots via this command.');
    return;
  }
  if (!member.bannable) {
    await interaction.editReply('❌ Cannot ban this member — their role may be higher than mine.');
    return;
  }

  // DM before ban
  try {
    const dm = await member.user.createDM();
    const banEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🔨 Banned')
      .setDescription(`You've been banned from **${guild.name}**.\n\n**Reason:** ${reason}`)
      .setTimestamp();
    await dm.send({ embeds: [banEmbed] });
  } catch { /* non-fatal */ }

  // Ban
  try {
    await member.ban({
      deleteMessageSeconds: deleteDays * 86400,
      reason: `${reason} — by ${interaction.user.tag}`,
    });
  } catch (err) {
    await interaction.editReply(`❌ Ban failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // Load config
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  // Create infraction
  await createInfraction(client.supabase, {
    guildId: client.guildId,
    memberId: member.id,
    moderatorId: interaction.user.id,
    type: 'ban',
    reason,
    expiresAt: calculateExpiryDate(config?.infraction_expiry_days ?? 30),
  });

  // Suspend entitlements — entitlements link via customer_id, not discord_id
  // First find the customer record for this Discord user
  const { data: customer } = await client.supabase
    .from('customers')
    .select('id')
    .eq('guild_id', client.guildId)
    .eq('discord_id', member.id)
    .maybeSingle();

  if (customer) {
    const { data: entitlements } = await client.supabase
      .from('entitlements')
      .select('id')
      .eq('guild_id', client.guildId)
      .eq('customer_id', customer.id)
      .eq('status', 'active');

    if (entitlements && entitlements.length > 0) {
      for (const ent of entitlements) {
        await client.supabase
          .from('entitlements')
          .update({ status: 'suspended', updated_at: new Date().toISOString() })
          .eq('id', ent.id);
      }
      console.log(`[Moderation] Suspended ${entitlements.length} entitlement(s) for banned user ${member.id}`);
    }
  }

  // Emit event
  client.eventBus.emit('moderation.action', client.guildId, {
    action: 'ban',
    discordId: member.id,
    moderatorId: interaction.user.id,
    reason,
  });

  // Mod log
  await postModLogEntry(client, {
    action: 'ban',
    member,
    moderator: interaction.user.tag,
    reason,
    channelId: config?.mod_log_channel_id ?? null,
  });

  await interaction.editReply(`✅ **${member.user.tag}** has been banned.${deleteDays > 0 ? ` ${deleteDays} day(s) of messages deleted.` : ''} Reason: ${reason}`);
}

export async function handlePardonCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const infractionId = interaction.options.getString('infraction_id', true);
  const reason = interaction.options.getString('reason') ?? 'Pardoned by moderator';

  // Look up the infraction first so we have the member_id for the mod log
  const { data: infraction } = await client.supabase
    .from('infractions')
    .select('member_id')
    .eq('id', infractionId)
    .eq('guild_id', client.guildId)
    .maybeSingle();

  const result = await pardonInfraction(
    client.supabase,
    infractionId,
    interaction.user.id,
  );

  if (!result) {
    await interaction.editReply('❌ Infraction not found or already pardoned.');
    return;
  }

  // Load config for mod log
  const { data: config } = await client.supabase
    .from('guild_config')
    .select('mod_log_channel_id')
    .eq('guild_id', client.guildId)
    .maybeSingle();

  // Mod log
  const guild = interaction.guild;
  if (guild && infraction?.member_id) {
    const member = await guild.members.fetch(infraction.member_id).catch(() => null);
    if (member) {
      await postModLogEntry(client, {
        action: 'pardon',
        member,
        moderator: interaction.user.tag,
        reason,
        channelId: config?.mod_log_channel_id ?? null,
      });
    }
  }

  await interaction.editReply(`✅ Infraction \`${infractionId.slice(0, 8)}…\` pardoned. Reason: ${reason}`);
}

export async function handleInfractionsCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser('user', true);
  const activeOnly = interaction.options.getBoolean('active_only') ?? true;

  const infractions = await getMemberInfractions(
    client.supabase,
    client.guildId,
    target.id,
  );

  const filtered = activeOnly ? infractions.filter((i) => i.active && !i.pardoned) : infractions;

  if (filtered.length === 0) {
    await interaction.editReply(`📋 **${target.tag}** has no ${activeOnly ? 'active ' : ''}infractions.`);
    return;
  }

  const lines = filtered.slice(0, 25).map((inf, i) => {
    const type = inf.type.toUpperCase();
    const status = inf.pardoned ? '🟢 PARDONED' : inf.active ? '🔴 ACTIVE' : '⚪ EXPIRED';
    const date = new Date(inf.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `\`${i + 1}.\` **${type}** ${status} — ${date}\n   ${inf.reason}\n   ID: \`${inf.id.slice(0, 8)}…\``;
  });

  const embed = new EmbedBuilder()
    .setColor(SOMNI_PALETTE.CYAN)
    .setTitle(`📋 Infractions — ${target.tag}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `Showing ${filtered.length} of ${infractions.length} total` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
