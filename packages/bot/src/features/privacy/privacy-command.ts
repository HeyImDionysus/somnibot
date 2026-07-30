/**
 * /privacy — Link to the privacy policy.
 *
 * Audit V2 Finding 13.2 — Data Collection Transparency
 *
 * Simple slash command that provides an ephemeral link to the privacy
 * policy page and mentions /forgetme and /mydata for data management.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import { applyBrand, resolveBrandKit } from '../branding/index.js';

// ── Command builder ───────────────────────────────────────

export function buildPrivacyCommand() {
  return new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('View our privacy policy and data management options');
}

// ── Handler ───────────────────────────────────────────────

export async function handlePrivacyCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client as SomniClient;
  const dashboardUrl = process.env.NEXT_PUBLIC_DASHBOARD_URL ?? process.env.DASHBOARD_URL ?? '';

  const privacyUrl = dashboardUrl ? `${dashboardUrl}/privacy` : null;

  const embed = new EmbedBuilder()
    .setTitle('🔒 Privacy & Your Data')
    .setDescription(
      (privacyUrl
        ? `Read our full privacy policy: **[Privacy Policy](${privacyUrl})**\n\n`
        : '**Privacy Policy**\nContact the server owner for a link to our privacy policy.\n\n') +
      '**Your Data Rights:**\n' +
      '• `/mydata` — Export all your data as a JSON file\n' +
      '• `/forgetme` — Erase or anonymize your account data from this server\n\n' +
      '**What we collect:**\n' +
      '• Discord ID & username (for identification)\n' +
      '• Message counts & voice minutes (for XP, not message content)\n' +
      '• Economy data (wallet, inventory, transactions)\n' +
      '• Moderation records (infractions)\n' +
      '• Purchase records (if applicable)\n\n' +
      '**Questions?** Contact us at `heyimdionysus@gmail.com`',
    )
    .setFooter({ text: 'We never sell your data. /forgetme explains the limited security records retained.' });
  const kit = await resolveBrandKit(client.supabase, interaction.guildId!, {
    fallbackName: interaction.guild?.name,
  });
  applyBrand(embed, kit, { intent: 'info' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
