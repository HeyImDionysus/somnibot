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
import { applyBrand, brandedEmbed, resolveBrandKit } from '../branding/index.js';

const log = createLogger('LicenseCmd');

/**
 * Branded degradation for license surfaces during a database outage. A failed
 * license/entitlement READ must never be presented as "invalid key" or "no
 * purchases" — that is a data-shaped lie to a PAYING customer about state the
 * bot could not read. The brand read is itself outage-safe: resolveBrandKit
 * never throws and the guild name is the fallback.
 */
async function replyLicenseServiceUnavailable(
  interaction: ChatInputCommandInteraction,
  supabase: SupabaseClient,
  guildId: string,
): Promise<void> {
  const brandKit = await resolveBrandKit(supabase, guildId, { fallbackName: interaction.guild?.name }).catch(() => null);
  const name = brandKit?.brandName ?? interaction.guild?.name ?? 'this server';
  await interaction.editReply({
    content: `⚠️ ${name}'s license service is temporarily unavailable — please try again in a moment.`,
  });
}

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

  // Buyer-facing surface: kit resolved once per handler (cached).
  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name,
  });

  // Hash the key for lookup
  const keyHash = hashLicenseKey(rawKey);

  // Find the license key. A failed READ is not an invalid key: during a
  // database outage the key may be perfectly valid, so check the error FIRST
  // and degrade honestly instead of lying to the buyer.
  const { data: licenseKey, error: keyLookupError } = await supabase
    .from('license_keys')
    .select('*, products(name, granted_role_ids, granted_channel_ids)')
    .eq('key_hash', keyHash)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (keyLookupError) {
    await replyLicenseServiceUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!licenseKey) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'danger',
          title: '❌ Invalid Key',
          description: 'That license key was not found. Please check the key and try again.',
        }),
      ],
    });
    return;
  }

  // Check if key is bound to this user
  if (licenseKey.bound_discord_id !== discordId) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'danger',
          title: '❌ Key Bound to Another User',
          description: 'This license key is bound to a different Discord account and cannot be activated here.',
        }),
      ],
    });
    return;
  }

  // Check if already activated
  if (licenseKey.status === 'active') {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'warning',
          title: '⚠️ Already Activated',
          description: 'This license key is already active.',
        }),
      ],
    });
    return;
  }

  // Check if key is in a valid state for activation
  if (licenseKey.status !== 'pending_activation') {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'danger',
          title: '❌ Cannot Activate',
          description: `This key is currently **${licenseKey.status}** and cannot be activated.`,
        }),
      ],
    });
    return;
  }

  // Activate the key atomically. The JS status checks above are a check-then-act
  // that two concurrent /license activate calls can both pass, so guard the flip
  // on the current status: only the writer that actually transitions a
  // `pending_activation` row wins. A lost race updates zero rows and must NOT
  // re-grant the entitlement/roles or write a second key.activated audit entry.
  const now = new Date().toISOString();
  const { data: activatedRows, error: activateError } = await supabase
    .from('license_keys')
    .update({ status: 'active', activated_at: now, updated_at: now })
    .eq('id', licenseKey.id)
    .eq('status', 'pending_activation')
    .select('id');

  // A FAILED write is not a lost race: replying "Already Activated" on a
  // database error would tell the buyer their still-pending key is active.
  // Nothing was applied (the guarded UPDATE errored before matching), so
  // degrade honestly and let the buyer retry.
  if (activateError) {
    await replyLicenseServiceUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!activatedRows || activatedRows.length === 0) {
    // Another concurrent activation already flipped the key. Report success
    // (the key is active) without double-granting.
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'warning',
          title: '⚠️ Already Activated',
          description: 'This license key is already active.',
        }),
      ],
    });
    return;
  }

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
      log.error('Failed to grant roles on activation:', { error: String(err) });
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
      applyBrand(
        new EmbedBuilder()
          .setTitle('✅ License Activated!')
          .setDescription(
            `Your license for **${licenseKey.products?.name ?? 'Unknown Product'}** has been activated.`,
          )
          .addFields(
            roleIds.length > 0
              ? { name: 'Roles Granted', value: roleIds.map((r: string) => `<@&${r}>`).join(', ') }
              : { name: 'Status', value: 'Active' },
          ),
        kit,
        { intent: 'primary' },
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

  // Buyer-facing surface: kit resolved once per handler (cached).
  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name,
  });

  // Find customer. Error ≠ "no purchases": a failed read during an outage must
  // degrade, never tell a paying customer their purchases don't exist.
  const { data: customer, error: customerLookupError } = await supabase
    .from('customers')
    .select('id')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (customerLookupError) {
    await replyLicenseServiceUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!customer) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'primary',
          title: '📋 Your Entitlements',
          description: 'You have no purchases in this server.',
        }),
      ],
    });
    return;
  }

  // Fetch entitlements — same rule: a failed read is NOT an empty entitlement
  // list, so degrade honestly instead of fabricating "no active entitlements".
  const { data: entitlements, error: entitlementsError } = await supabase
    .from('entitlements')
    .select('*, products(name)')
    .eq('customer_id', customer.id)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(1000);

  if (entitlementsError) {
    await replyLicenseServiceUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!entitlements || entitlements.length === 0) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(kit, {
          intent: 'primary',
          title: '📋 Your Entitlements',
          description: 'You have no active entitlements.',
        }),
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
      brandedEmbed(kit, {
        intent: 'primary',
        title: '📋 Your Entitlements',
        description: lines.join('\n'),
      }),
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

  // Error ≠ "not found": a failed admin lookup during an outage must degrade
  // rather than misreport a real key as missing.
  const { data: licenseKey, error: infoLookupError } = await supabase
    .from('license_keys')
    .select('*, products(name), customers(discord_username, discord_id)')
    .eq('key_hash', keyHash)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (infoLookupError) {
    await replyLicenseServiceUnavailable(interaction, supabase, guildId);
    return;
  }

  if (!licenseKey) {
    await interaction.editReply({ content: '❌ License key not found.' });
    return;
  }

  const kit = await resolveBrandKit(supabase, guildId, {
    fallbackName: interaction.guild?.name,
  });
  const embed = new EmbedBuilder()
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
    .eq('active', true)
    .limit(1000);

  if (sessions && sessions.length > 0) {
    const sessionLines = sessions.map((s) => {
      const lastSeen = `<t:${Math.floor(new Date(s.last_seen_at).getTime() / 1000)}:R>`;
      return `• ${s.device_name ?? s.device_fingerprint.slice(0, 8)} — ${lastSeen}`;
    });
    embed.addFields({ name: `Active Sessions (${sessions.length})`, value: sessionLines.join('\n') });
  }

  applyBrand(embed, kit, { intent: 'primary' });
  await interaction.editReply({ embeds: [embed] });
}
