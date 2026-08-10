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
import { eventBus } from '../../services/event-bus.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';

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
    await sendWelcomeChannelMessage(member, config, variables, supabase);
  }

  // 2. Welcome DM
  if (config.welcome_dm_enabled) {
    await sendWelcomeDM(member, config, variables, supabase);
  }

  // 3. Auto-roles
  if (config.welcome_auto_roles?.length > 0) {
    await applyAutoRoles(member, config.welcome_auto_roles, supabase);
  }
}

/**
 * Send the welcome message (and card) to the configured channel.
 */
async function sendWelcomeChannelMessage(
  member: GuildMember,
  config: DbGuildConfig,
  variables: WelcomeVariables,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    const channel = member.guild.channels.cache.get(config.welcome_channel_id!) as TextChannel | undefined;
    if (!channel?.isTextBased()) {
      log.warn('Welcome channel not found or not text-based:', config.welcome_channel_id);
      eventBus.emit('welcome.channel_missing', member.guild.id, {
        memberId: member.id,
        channelId: config.welcome_channel_id!,
        occurrenceId: `${member.id}:welcome:channel-missing`,
        correlationId: `welcome:${member.id}`,
      });
      await raiseWelcomeAlert(supabase, member, 'channel', 'channel_missing');
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

    // The welcome text is an OWNER-AUTHORED template. A member ping is the
    // point of it, but a template containing @everyone/@here or a role mention
    // would turn every join into a mass ping. Users-only keeps the intended
    // greeting and drops the escalation.
    await channel.send({
      content: messageText,
      files,
      allowedMentions: { parse: ['users'] },
    });
    log.info(`Channel message sent for ${member.user.tag}`);
  } catch (err) {
    log.error('Failed to send channel message:', { error: String(err) });
    await raiseWelcomeAlert(supabase, member, 'channel', 'send_failed');
  }
}

/**
 * Send a welcome DM to the new member.
 */
async function sendWelcomeDM(
  member: GuildMember,
  config: DbGuildConfig,
  variables: WelcomeVariables,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    const messageText = interpolateMessage(
      config.welcome_dm_message ?? DEFAULT_WELCOME_DM,
      variables,
    );

    await member.send(messageText);
    log.info(`DM sent to ${member.user.tag}`);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? Number((err as { code?: unknown }).code)
      : undefined;
    if (code === 50007) {
      log.warn(`Could not DM ${member.user.tag} because Discord rejected the DM`);
      eventBus.emit('welcome.dm_blocked_fallback', member.guild.id, {
        memberId: member.id,
        occurrenceId: `${member.id}:welcome:dm-blocked`,
        correlationId: `welcome:${member.id}`,
      });
      const channel = config.welcome_channel_id
        ? member.guild.channels.cache.get(config.welcome_channel_id) as TextChannel | undefined
        : undefined;
      if (channel?.isTextBased()) {
        await channel.send({
          content: `${member}, welcome! I couldn't send you a DM, so here's the welcome note instead.`,
          allowedMentions: { parse: ['users'] },
        }).catch(() => undefined);
      }
    } else {
      log.error(`Failed to send welcome DM to ${member.user.tag}:`, {
        code,
        error: String(err),
      });
    }
    if (code !== 50007) await raiseWelcomeAlert(supabase, member, 'dm', 'send_failed');
  }
}

/**
 * Apply additional auto-roles alongside the Member role.
 */
async function applyAutoRoles(
  member: GuildMember,
  roleIds: string[],
  supabase: SupabaseClient,
): Promise<void> {
  for (const roleId of roleIds) {
    try {
      const role = member.guild.roles.cache.get(roleId);
      if (!role) {
        log.warn(`Auto-role ${roleId} not found, skipping`);
        eventBus.emit('welcome.member_role_grant_failed', member.guild.id, {
          memberId: member.id, roleId, attempt: 0,
          occurrenceId: `${member.id}:welcome:role:${roleId}`,
          correlationId: `welcome:${member.id}`,
        });
        await raiseWelcomeAlert(supabase, member, 'role', `role_missing:${roleId}`);
        continue;
      }
      if (member.roles.cache.has(roleId)) continue; // Already has it

      let granted = false;
      for (let attempt = 1; attempt <= 2 && !granted; attempt++) {
        try {
          await member.roles.add(role, 'SomniBot welcome auto-role');
          granted = true;
          log.info(`Auto-role "${role.name}" granted to ${member.user.tag}`);
        } catch (err) {
          if (attempt === 2) {
            log.error(`Failed to grant auto-role ${roleId}:`, err);
            eventBus.emit('welcome.member_role_grant_failed', member.guild.id, {
              memberId: member.id, roleId, attempt,
              occurrenceId: `${member.id}:welcome:role:${roleId}`,
              correlationId: `welcome:${member.id}`,
            });
            await raiseWelcomeAlert(supabase, member, 'role', `grant_failed:${roleId}`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          }
        }
      }
    } catch (err) {
      log.error(`Failed to grant auto-role ${roleId}:`, err);
      await raiseWelcomeAlert(supabase, member, 'role', `grant_failed:${roleId}`);
    }
  }
}

async function raiseWelcomeAlert(
  member: GuildMember,
  supabase: SupabaseClient,
  surface: 'channel' | 'dm' | 'role',
  reason: string,
): Promise<void> {
  try {
    await raiseOwnerAlert(supabase, member.guild.id, {
      alertType: 'welcome_delivery_failed',
      severity: 'warning',
      title: 'Welcome delivery needs attention',
      message: `Welcome ${surface} delivery for a member failed (${reason}).`,
      metadata: { member_id: member.id, surface, reason },
      guild: member.guild,
    });
  } catch (err) {
    log.error('Failed to write welcome delivery alert:', { error: String(err) });
  }
}
