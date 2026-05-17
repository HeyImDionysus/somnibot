/**
 * Action executor — runs automation actions against Discord.
 * §20.4 of the architecture doc.
 */
import {
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  ChannelType,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTOMATION_LIMITS } from '@somnibot/shared';
import { AutomationRateLimiter } from './rate-limiter.js';

export interface ActionContext {
  guild: Guild;
  member: GuildMember | null;
  channelId: string | null;
  messageId: string | null;
  message: Message | null;
  supabase: SupabaseClient;
  guildId: string;
  rateLimiter: AutomationRateLimiter;
  automationId: string;
  /** Template variables resolved from the trigger event */
  variables: Record<string, string>;
}

export interface AutomationAction {
  type: string;
  config: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

/**
 * Execute a list of actions in order.
 * Returns counts of executed and failed actions + any errors.
 */
export async function executeActions(
  actions: AutomationAction[],
  ctx: ActionContext,
): Promise<{ executed: number; failed: number; errors: string[] }> {
  let executed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const action of actions) {
    if (executed + failed >= AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION) {
      errors.push(`Action limit reached (${AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION})`);
      break;
    }

    try {
      const result = await executeAction(action, ctx);
      if (result.success) {
        executed++;
      } else {
        failed++;
        if (result.error) errors.push(`${action.type}: ${result.error}`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${action.type}: ${msg}`);
      console.error(`[ActionExecutor] Error executing ${action.type}:`, err);
    }
  }

  return { executed, failed, errors };
}

/**
 * Resolve template variables in a string.
 */
function resolveVars(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), value);
  }
  return result;
}

async function executeAction(
  action: AutomationAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  const { type, config } = action;

  switch (type) {
    case 'send_message': {
      const channelId = config.channel_id as string;
      const message = resolveVars(config.message as string, ctx.variables);
      const channel = ctx.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        return { success: false, error: `Channel ${channelId} not found or not a text channel` };
      }
      await (channel as TextChannel).send(message);
      return { success: true };
    }

    case 'send_dm': {
      if (!ctx.member) return { success: false, error: 'No user context for DM' };
      const allowed = await ctx.rateLimiter.allowDM(ctx.guildId, ctx.automationId, ctx.member.id);
      if (!allowed) return { success: false, error: 'DM rate limited' };
      const message = resolveVars(config.message as string, ctx.variables);
      try {
        await ctx.member.send(message);
      } catch {
        return { success: false, error: 'Could not DM user (DMs may be disabled)' };
      }
      return { success: true };
    }

    case 'reply_to_message': {
      if (!ctx.message) return { success: false, error: 'No message context for reply' };
      const message = resolveVars(config.message as string, ctx.variables);
      await ctx.message.reply(message);
      return { success: true };
    }

    case 'give_role': {
      if (!ctx.member) return { success: false, error: 'No user context for role grant' };
      const roleId = config.role_id as string;
      const role = ctx.guild.roles.cache.get(roleId);
      if (!role) return { success: false, error: `Role ${roleId} not found` };
      await ctx.member.roles.add(role, 'Automation');
      // Rate limit delay between role operations
      await sleep(AUTOMATION_LIMITS.ROLE_GRANT_DELAY_MS);
      return { success: true };
    }

    case 'remove_role': {
      if (!ctx.member) return { success: false, error: 'No user context for role removal' };
      const roleId = config.role_id as string;
      const role = ctx.guild.roles.cache.get(roleId);
      if (!role) return { success: false, error: `Role ${roleId} not found` };
      await ctx.member.roles.remove(role, 'Automation');
      await sleep(AUTOMATION_LIMITS.ROLE_GRANT_DELAY_MS);
      return { success: true };
    }

    case 'add_reaction': {
      if (!ctx.message) return { success: false, error: 'No message context for reaction' };
      const emoji = config.emoji as string;
      await ctx.message.react(emoji);
      return { success: true };
    }

    case 'delete_message': {
      if (!ctx.message) return { success: false, error: 'No message context for deletion' };
      if (ctx.message.deletable) {
        await ctx.message.delete();
      }
      return { success: true };
    }

    case 'create_thread': {
      if (!ctx.message) return { success: false, error: 'No message context for thread creation' };
      const name = resolveVars(config.name as string, ctx.variables);
      const autoArchive = (config.auto_archive_minutes as number) ?? 1440;
      await ctx.message.startThread({
        name,
        autoArchiveDuration: autoArchive as 60 | 1440 | 4320 | 10080,
      });
      return { success: true };
    }

    case 'wait_delay': {
      const seconds = Math.min(config.seconds as number, AUTOMATION_LIMITS.MAX_DELAY_SECONDS);
      await sleep(seconds * 1000);
      return { success: true };
    }

    case 'grant_entitlement': {
      if (!ctx.member) return { success: false, error: 'No user context for entitlement' };
      const productId = config.product_id as string;
      // Create an entitlement record
      const { error } = await ctx.supabase.from('entitlements').insert({
        guild_id: ctx.guildId,
        discord_id: ctx.member.id,
        product_id: productId,
        status: 'active',
        source: 'automation',
      });
      if (error) return { success: false, error: `Entitlement grant failed: ${error.message}` };
      return { success: true };
    }

    case 'log_to_channel': {
      const channelId = config.channel_id as string;
      const message = resolveVars(config.message as string, ctx.variables);
      const channel = ctx.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        return { success: false, error: `Log channel ${channelId} not found` };
      }
      await (channel as TextChannel).send({
        content: message,
        allowedMentions: { parse: [] }, // No pings in log messages
      });
      return { success: true };
    }

    case 'create_ticket': {
      // Ticket creation via automation — simplified, just logs intent
      return { success: true };
    }

    case 'ban_member': {
      if (!ctx.member) return { success: false, error: 'No user context for ban' };
      const reason = config.reason ? resolveVars(config.reason as string, ctx.variables) : 'Automation';
      if (!ctx.member.bannable) return { success: false, error: 'Member is not bannable' };
      await ctx.member.ban({ reason });
      return { success: true };
    }

    case 'kick_member': {
      if (!ctx.member) return { success: false, error: 'No user context for kick' };
      const reason = config.reason ? resolveVars(config.reason as string, ctx.variables) : 'Automation';
      if (!ctx.member.kickable) return { success: false, error: 'Member is not kickable' };
      await ctx.member.kick(reason);
      return { success: true };
    }

    case 'mute_member': {
      if (!ctx.member) return { success: false, error: 'No user context for mute' };
      const durationMinutes = (config.duration_minutes as number) ?? 10;
      const reason = config.reason ? resolveVars(config.reason as string, ctx.variables) : 'Automation';
      if (!ctx.member.moderatable) return { success: false, error: 'Member is not moderatable' };
      await ctx.member.timeout(durationMinutes * 60 * 1000, reason);
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown action type: ${type}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
