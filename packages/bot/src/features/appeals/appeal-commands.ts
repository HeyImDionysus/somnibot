/**
 * /appeal — member-facing infraction appeals.
 *
 *   /appeal submit infraction_id:<id> reason:<text>   file an appeal
 *   /appeal status                                     view your appeals
 *
 * Members may only appeal THEIR OWN infractions (enforced in AppealsManager.submit).
 * Owners review/approve/deny on the dashboard; the bot DMs the outcome.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { createLogger } from '@somnibot/shared';
import { applyBrand, resolveBrandKit } from '../branding/index.js';
import {
  AppealsManager,
  APPEAL_REASON_MAX,
  type AppealRecord,
  type SubmitAppealError,
} from './appeals-manager.js';

const log = createLogger('AppealCmd');

const STATUS_BADGE: Record<AppealRecord['status'], string> = {
  pending: '🕓 Pending',
  approved: '✅ Approved',
  denied: '❌ Denied',
  expired: '⚪ Expired',
};

// ── Command Definition ───────────────────────────────────

export const appealCommand = new SlashCommandBuilder()
  .setName('appeal')
  .setDescription('Appeal a moderation action taken against you')
  .addSubcommand((sub) =>
    sub
      .setName('submit')
      .setDescription('Submit an appeal for one of your infractions')
      .addStringOption((opt) =>
        opt
          .setName('infraction_id')
          .setDescription('The infraction ID (from /appeal status or your DM notice)')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Why should this action be reconsidered?')
          .setRequired(true)
          .setMaxLength(APPEAL_REASON_MAX),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('View the status of your appeals'),
  )
  .toJSON();

// ── Friendly error copy ──────────────────────────────────

const SUBMIT_ERROR_COPY: Record<SubmitAppealError, string> = {
  invalid_reason: '❌ Please provide a reason (up to 1000 characters).',
  appeals_disabled: '❌ Appeals are currently disabled for this server.',
  infraction_not_found: '❌ No infraction with that ID exists in this server.',
  not_appellant: '❌ You can only appeal infractions issued against your own account.',
  cooldown: '⏳ Please wait for the appeal cooldown before submitting another appeal for this infraction.',
  already_pending: '⏳ You already have a pending appeal for that infraction.',
  db_error: '❌ Something went wrong filing your appeal. Please try again later.',
};

// ── Command Handler ──────────────────────────────────────

export async function handleAppealCommand(
  interaction: ChatInputCommandInteraction,
  client: SomniClient,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: '❌ Appeals can only be filed from within a server.',
      ephemeral: true,
    });
    return;
  }

  const manager = new AppealsManager(client.supabase);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'submit') {
    await interaction.deferReply({ ephemeral: true });

    const infractionId = interaction.options.getString('infraction_id', true).trim();
    const reason = interaction.options.getString('reason', true);

    const result = await manager.submit({
      guildId,
      infractionId,
      appellantDiscordId: interaction.user.id,
      reason,
    });

    if (!result.ok) {
      await interaction.editReply(SUBMIT_ERROR_COPY[result.error]);
      return;
    }

    // TODO(audit): appeal.submitted — emit an audit event once the audit wave
    // wires appeal.* into events.ts / audit-service.ts.

    if (result.deduped) {
      await interaction.editReply('⏳ You already have a pending appeal for that infraction.');
      return;
    }

    log.info('Appeal submitted', { guildId, infractionId, appellant: interaction.user.id });
    // Route the review copy to the owner-selected channel, falling back to the
    // moderation log so an appeal is never invisible when no dedicated channel
    // has been configured.
    try {
      const { data: settings } = await client.supabase
        .from('guild_config')
        .select('appeal_review_channel_id, mod_log_channel_id')
        .eq('guild_id', guildId)
        .maybeSingle();
      const channelId = settings?.appeal_review_channel_id || settings?.mod_log_channel_id;
      const channel = channelId ? interaction.guild?.channels.cache.get(channelId) : null;
      if (channel && 'send' in channel) {
        const reviewEmbed = new EmbedBuilder()
          .setTitle('📬 New moderation appeal')
          .setDescription(`A member has submitted an appeal for infraction \`${infractionId}\`.`)
          .addFields({ name: 'Member', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Reason', value: reason.slice(0, 1024) })
          .setTimestamp();
        await (channel as { send: (payload: unknown) => Promise<unknown> }).send({ embeds: [reviewEmbed] });
      }
    } catch (err) {
      log.warn('Could not post appeal to review channel', { guildId, error: String(err) });
    }
    const expiresLine = result.appeal.expires_at
      ? `\nIf it isn’t reviewed, it will expire <t:${Math.floor(new Date(result.appeal.expires_at).getTime() / 1000)}:R>.`
      : '';
    await interaction.editReply(
      `✅ Your appeal has been submitted and is now **pending** review.${expiresLine}\n` +
        `Reference: \`${result.appeal.id.slice(0, 8)}…\``,
    );
    return;
  }

  if (subcommand === 'status') {
    await interaction.deferReply({ ephemeral: true });

    const appeals = await manager.listForMember(guildId, interaction.user.id);
    if (appeals.length === 0) {
      await interaction.editReply('📭 You have not filed any appeals in this server.');
      return;
    }

    const lines = appeals.map((a) => {
      const date = new Date(a.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const reason = a.reason.length > 80 ? `${a.reason.slice(0, 79)}…` : a.reason;
      return `${STATUS_BADGE[a.status]} — ${date}\n   Infraction: \`${a.infraction_id.slice(0, 8)}…\`\n   “${reason}”`;
    });

    const kit = await resolveBrandKit(client.supabase, guildId, {
      fallbackName: interaction.guild?.name,
    });
    const embed = new EmbedBuilder()
      .setTitle('📋 Your Appeals')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${appeals.length} appeal(s)` })
      .setTimestamp();
    applyBrand(embed, kit, { intent: 'info' });

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
