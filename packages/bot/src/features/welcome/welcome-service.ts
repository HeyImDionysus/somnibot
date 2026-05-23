/**
 * Welcome Service — Sends welcome messages, DMs, cards, and applies auto-roles.
 *
 * This fires when a member receives the Member role (after onboarding completion),
 * NOT on guildMemberAdd directly. Per architecture doc §17.1:
 *   "The welcome system activates when a member receives the Member role
 *    (either from onboarding completion or manual grant)."
 */

import {
  AttachmentBuilder,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';
import { generateWelcomeCard } from './welcome-card.js';
import {
  buildWelcomeVariables,
  interpolateMessage,
  type WelcomeVariables,
} from './welcome-variables.js';
import { getMemberNumber } from './member-service.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Welcome');

// ── Default Messages ──────────────────────────────────────────
const DEFAULT_WELCOME_MESSAGE =
  'Welcome to {server}, {user}! 🎉 You\'re member {memberNumber}.';
const DEFAULT_WELCOME_DM =
  'Hey {user.name}! Welcome to {server}. Check out the channels to get started.';
const DEFAULT_GOODBYE_MESSAGE =
  '{user.name} left. They were with us for {duration}. 👋';

export interface WelcomeServiceOptions {
  supabase: SupabaseClient;
  config: DbGuildConfig;
}

/**
 * Execute the full welcome flow for a verified member.
 */
export async function executeWelcomeFlow(
  member: GuildMember,
  options: WelcomeServiceOptions,
): Promise<void> {
  const { supabase, config } = options;
  const guild = member.guild;

  // Get member number
  const memberNumber = await getMemberNumber(supabase, guild.id, member.id);

  // Build template variables
  const variables = buildWelcomeVariables(member, guild, memberNumber);

  // 1. Welcome channel message (with optional card)
  if (config.welcome_enabled && config.welcome_channel_id) {
    await sendWelcomeChannelMessage(member, config, variables);
  }

  // 2. Welcome DM
  if (config.welcome_dm_enabled) {
    await sendWelcomeDM(member, config, variables);
  }

  // 3. Auto-roles
  if (config.welcome_auto_roles?.length > 0) {
    await applyAutoRoles(member, config.welcome_auto_roles);
  }
}

/**
 * Send the welcome message (and card) to the configured channel.
 */
async function sendWelcomeChannelMessage(
  member: GuildMember,
  config: DbGuildConfig,
  variables: WelcomeVariables,
): Promise<void> {
  try {
    const channel = member.guild.channels.cache.get(config.welcome_channel_id!) as TextChannel | undefined;
    if (!channel?.isTextBased()) {
      log.warn('Welcome channel not found or not text-based:', config.welcome_channel_id);
      return;
    }

    const messageText = interpolateMessage(
      config.welcome_message ?? DEFAULT_WELCOME_MESSAGE,
      variables,
    );

    const files: AttachmentBuilder[] = [];

    // Generate welcome card if enabled
    if (config.welcome_card_enabled) {
      try {
        const cardBuffer = await generateWelcomeCard({
          member,
          guild: member.guild,
          memberNumber: parseInt(variables.memberNumber.replace(/[^0-9]/g, ''), 10) || 0,
          backgroundUrl: config.welcome_card_background,
        });

        files.push(
          new AttachmentBuilder(cardBuffer, { name: 'welcome-card.png' }),
        );
      } catch (err) {
        log.error('Failed to generate welcome card:', { error: String(err) });
        // Continue without card — message still goes out
      }
    }

    await channel.send({ content: messageText, files });
    log.info(`Channel message sent for ${member.user.tag}`);
  } catch (err) {
    log.error('Failed to send channel message:', { error: String(err) });
  }
}

/**
 * Send a welcome DM to the new member.
 */
async function sendWelcomeDM(
  member: GuildMember,
  config: DbGuildConfig,
  variables: WelcomeVariables,
): Promise<void> {
  try {
    const messageText = interpolateMessage(
      config.welcome_dm_message ?? DEFAULT_WELCOME_DM,
      variables,
    );

    await member.send(messageText);
    log.info(`DM sent to ${member.user.tag}`);
  } catch (err) {
    // DMs can fail if user has them disabled — not an error
    log.warn(`Could not DM ${member.user.tag} (DMs may be disabled)`);
  }
}

/**
 * Apply additional auto-roles alongside the Member role.
 */
async function applyAutoRoles(
  member: GuildMember,
  roleIds: string[],
): Promise<void> {
  for (const roleId of roleIds) {
    try {
      const role = member.guild.roles.cache.get(roleId);
      if (!role) {
        log.warn(`Auto-role ${roleId} not found, skipping`);
        continue;
      }
      if (member.roles.cache.has(roleId)) continue; // Already has it

      await member.roles.add(role, 'SomniBot welcome auto-role');
      log.info(`Auto-role "${role.name}" granted to ${member.user.tag}`);
    } catch (err) {
      log.error(`Failed to grant auto-role ${roleId}:`, err);
    }
  }
}
