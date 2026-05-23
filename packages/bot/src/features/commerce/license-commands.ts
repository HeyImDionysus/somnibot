/**
 * /license commands — activate, check, info.
 *
 * - /license activate <key> — Activate a purchased license
 * - /license check — Check your active entitlements
 * - /license info <key> — View license details (admin only)
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashLicenseKey } from './key-generator.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('LicenseCmd');

const HOT_PINK = 0xFF1493;
const GREEN = 0x57F287;
const RED = 0xED4245;

export function buildLicenseCommand() {
  return new SlashCommandBuilder()
    .setName('license')
    .setDescription('Manage your licenses')
    .addSubcommand((sub) =>
      sub
        .setName('activate')
        .setDescription('Activate a license key')
        .addStringOption((opt) =>
          opt.setName('key').setDescription('Your license key (SMNI-XXXX-XXXX-XXXX-XXXX)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('check').setDescription('Check your active entitlements'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('info')
        .setDescription('View license details (admin)')
        .addStringOption((opt) =>
          opt.setName('key').setDescription('License key to look up').setRequired(true),
        ),
    );
}

export async function handleLicenseCommand(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'activate':
      await handleActivate(interaction, supabase, guildId);
      break;
    case 'check':
      await handleCheck(interaction, supabase, guildId);
      break;
    case 'info':
      await handleInfo(interaction, supabase, guildId);
      break;
    default:
      await interaction.reply({ content: '❌ Unknown subcommand', ephemeral: true });
  }
}

async function handleActivate(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const rawKey = interaction.options.getString('key', true).trim().toUpperCase();
  const discordId = interaction.user.id;

  // Hash the key for lookup
  const keyHash = hashLicenseKey(rawKey);

  // Find the license key
  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('*, products(name, granted_role_ids, granted_channel_ids)')
    .eq('key_hash', keyHash)
    .eq('guild_id', guildId)
    .single();

  if (!licenseKey) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(RED)
          .setTitle('❌ Invalid Key')
          .setDescription('That license key was not found. Please check the key and try again.'),
      ],
    });
    return;
  }

  // Check if key is bound to this user
  if (licenseKey.bound_discord_id !== discordId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(RED)
          .setTitle('❌ Key Bound to Another User')
          .setDescription('This license key is bound to a different Discord account and cannot be activated here.'),
      ],
    });
    return;
  }

  // Check if already activated
  if (licenseKey.status === 'active') {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFEE75C)
          .setTitle('⚠️ Already Activated')
          .setDescription('This license key is already active.'),
      ],
    });
    return;
  }

  // Check if key is in a valid state for activation
  if (licenseKey.status !== 'pending_activation') {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(RED)
          .setTitle('❌ Cannot Activate')
          .setDescription(`This key is currently **${licenseKey.status}** and cannot be activated.`),
      ],
    });
    return;
  }

  // Activate the key
  const now = new Date().toISOString();
  await supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: now, updated_at: now })
    .eq('id', licenseKey.id);

  // Update entitlement to active
  await supabase
    .from('entitlements')
    .update({ status: 'active', updated_at: now })
    .eq('license_key_id', licenseKey.id)
    .eq('guild_id', guildId);

  // Grant Discord roles
  const roleIds = licenseKey.products?.granted_role_ids ?? [];
  if (roleIds.length > 0 && interaction.guild) {
    try {
      const member = await interaction.guild.members.fetch(discordId);
      for (const roleId of roleIds) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, 'Commerce: license activated');
        }
      }
    } catch (err) {
      log.error('Failed to grant roles on activation:', err);
    }
  }

  // Audit log
  await supabase.from('audit_logs').insert({
    guild_id: guildId,
    actor_type: 'user',
    actor_id: discordId,
    action: 'key.activated',
    target_type: 'license_key',
    target_id: licenseKey.id,
    details: { productId: licenseKey.product_id, roleIds },
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(GREEN)
        .setTitle('✅ License Activated!')
        .setDescription(
          `Your license for **${licenseKey.products?.name ?? 'Unknown Product'}** has been activated.`,
        )
        .addFields(
          roleIds.length > 0
            ? { name: 'Roles Granted', value: roleIds.map((r: string) => `<@&${r}>`).join(', ') }
            : { name: 'Status', value: 'Active' },
        ),
    ],
  });
}

async function handleCheck(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const discordId = interaction.user.id;

  // Find customer
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .single();

  if (!customer) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(HOT_PINK)
          .setTitle('📋 Your Entitlements')
          .setDescription('You have no purchases in this server.'),
      ],
    });
    return;
  }

  // Fetch entitlements
  const { data: entitlements } = await supabase
    .from('entitlements')
    .select('*, products(name)')
    .eq('customer_id', customer.id)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false });

  if (!entitlements || entitlements.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(HOT_PINK)
          .setTitle('📋 Your Entitlements')
          .setDescription('You have no active entitlements.'),
      ],
    });
    return;
  }

  const statusEmoji: Record<string, string> = {
    active: '✅',
    pending: '⏳',
    expired: '⏰',
    cancelled: '🚫',
    suspended: '⚠️',
    grace_period: '⚠️',
  };

  const lines = entitlements.map((e) => {
    const emoji = statusEmoji[e.status] ?? '❓';
    const expiry = e.expires_at
      ? ` (expires <t:${Math.floor(new Date(e.expires_at).getTime() / 1000)}:R>)`
      : '';
    return `${emoji} **${e.products?.name ?? 'Unknown'}** — ${e.status}${expiry}`;
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(HOT_PINK)
        .setTitle('📋 Your Entitlements')
        .setDescription(lines.join('\n')),
    ],
  });
}

async function handleInfo(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  // Admin only
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ This command is admin-only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const rawKey = interaction.options.getString('key', true).trim().toUpperCase();
  const keyHash = hashLicenseKey(rawKey);

  const { data: licenseKey } = await supabase
    .from('license_keys')
    .select('*, products(name), customers(discord_username, discord_id)')
    .eq('key_hash', keyHash)
    .eq('guild_id', guildId)
    .single();

  if (!licenseKey) {
    await interaction.editReply({ content: '❌ License key not found.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(HOT_PINK)
    .setTitle('🔑 License Key Info')
    .addFields(
      { name: 'Key', value: `${licenseKey.key_prefix}-****-****-****-${licenseKey.key_suffix}`, inline: true },
      { name: 'Status', value: licenseKey.status, inline: true },
      { name: 'Product', value: licenseKey.products?.name ?? 'Unknown', inline: true },
      { name: 'Bound To', value: licenseKey.customers?.discord_username ?? licenseKey.bound_discord_id, inline: true },
      { name: 'Created', value: `<t:${Math.floor(new Date(licenseKey.created_at).getTime() / 1000)}:f>`, inline: true },
    );

  if (licenseKey.activated_at) {
    embed.addFields({ name: 'Activated', value: `<t:${Math.floor(new Date(licenseKey.activated_at).getTime() / 1000)}:f>`, inline: true });
  }

  // Fetch active sessions
  const { data: sessions } = await supabase
    .from('license_sessions')
    .select('*')
    .eq('license_key_id', licenseKey.id)
    .eq('active', true);

  if (sessions && sessions.length > 0) {
    const sessionLines = sessions.map((s) => {
      const lastSeen = `<t:${Math.floor(new Date(s.last_seen_at).getTime() / 1000)}:R>`;
      return `• ${s.device_name ?? s.device_fingerprint.slice(0, 8)} — ${lastSeen}`;
    });
    embed.addFields({ name: `Active Sessions (${sessions.length})`, value: sessionLines.join('\n') });
  }

  await interaction.editReply({ embeds: [embed] });
}
