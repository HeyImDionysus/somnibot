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
import { AUTOMATION_LIMITS , createLogger } from '@somnibot/shared';
import { AutomationRateLimiter } from './rate-limiter.js';

const log = createLogger('ActionExecutor');

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
      log.error(`Error executing ${action.type}:`, err);
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
      // V5 Audit [V5-2]: Restrict allowedMentions to prevent injection via template variables.
      // Guild admins can opt-in to mentions by setting allow_mentions: true on the action config.
      const allowMentions = config.allow_mentions === true;
      await (channel as TextChannel).send({
        content: message,
        allowedMentions: allowMentions ? undefined : { parse: [] },
      });
      return { success: true };
    }

    case 'send_dm': {
      if (!ctx.member) return { success: false, error: 'No user context for DM' };
      const allowed = await ctx.rateLimiter.allowDM(ctx.guildId, ctx.automationId, ctx.member.id);
      if (!allowed) return { success: false, error: 'DM rate limited' };
      const message = resolveVars(config.message as string, ctx.variables);
      try {
        // V5 Audit [V5-2]: Restrict mentions in DMs too (consistent behavior).
        await ctx.member.send({
          content: message,
          allowedMentions: { parse: [] },
        });
      } catch {
        return { success: false, error: 'Could not DM user (DMs may be disabled)' };
      }
      return { success: true };
    }

    case 'reply_to_message': {
      if (!ctx.message) return { success: false, error: 'No message context for reply' };
      const message = resolveVars(config.message as string, ctx.variables);
      // V5 Audit [V5-2]: Restrict mentions on replies to prevent injection.
      const allowMentions = config.allow_mentions === true;
      await ctx.message.reply({
        content: message,
        allowedMentions: allowMentions ? undefined : { parse: [] },
      });
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

      // Fetch product to get role/channel grants
      const { data: product } = await ctx.supabase
        .from('products')
        .select('name, granted_role_ids, granted_channel_ids')
        .eq('id', productId)
        .single();

      if (!product) return { success: false, error: `Product ${productId} not found` };

      // Find or create customer record
      let { data: customer } = await ctx.supabase
        .from('customers')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();

      if (!customer) {
        const { data: newCustomer } = await ctx.supabase
          .from('customers')
          .insert({
            guild_id: ctx.guildId,
            discord_id: ctx.member.id,
            discord_username: ctx.member.user.username,
          })
          .select('id')
          .single();
        customer = newCustomer;
      }

      if (!customer) return { success: false, error: 'Failed to create customer record' };

      // Queue fulfillment via bot_action_queue so EntitlementService handles it
      // (roles, events, audit log — all in one atomic operation)
      const { error: queueError } = await ctx.supabase.from('bot_action_queue').insert({
        guild_id: ctx.guildId,
        action: 'fulfill_purchase',
        payload: {
          fulfillment_type: 'one_time_purchase',
          guild_id: ctx.guildId,
          customer_id: customer.id,
          discord_id: ctx.member.id,
          product_id: productId,
          product_name: product.name,
          order_id: `auto-${ctx.automationId}-${Date.now()}`,
          order_number: `AUTO-${Date.now().toString().slice(-5)}`,
          amount_cents: 0,
          currency: 'USD',
          granted_role_ids: product.granted_role_ids ?? [],
          granted_channel_ids: product.granted_channel_ids ?? [],
          entitlement_type: 'one_time',
        },
        status: 'pending',
      });

      if (queueError) return { success: false, error: `Entitlement queue failed: ${queueError.message}` };
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
      if (!ctx.member) return { success: false, error: 'No user context for ticket creation' };

      const subject = config.subject
        ? resolveVars(config.subject as string, ctx.variables)
        : 'Auto-created ticket';
      const panelId = config.panel_id as string | undefined;

      // Get ticket panel
      const panelQuery = ctx.supabase
        .from('ticket_panels')
        .select('id, open_category_id, manager_roles')
        .eq('guild_id', ctx.guildId)
        .limit(1000);

      if (panelId) panelQuery.eq('id', panelId);
      panelQuery.order('created_at', { ascending: true }).limit(1);

      const { data: panel } = await panelQuery.single();
      if (!panel) return { success: false, error: 'No ticket panel configured' };

      // Generate ticket number atomically via Postgres sequence
      let ticketNumber: number;
      const { data: seqVal, error: seqErr } = await ctx.supabase.rpc('nextval_ticket');
      if (seqErr || seqVal == null) {
        const { count } = await ctx.supabase
          .from('tickets')
          .select('id', { count: 'exact', head: true })
          .eq('guild_id', ctx.guildId);
        ticketNumber = (count ?? 0) + 1;
      } else {
        ticketNumber = Number(seqVal);
      }

      // Create the channel
      const { ChannelType: CT } = await import('discord.js');
      const ticketChannel = await ctx.guild.channels.create({
        name: `ticket-${ticketNumber.toString().padStart(4, '0')}`,
        type: CT.GuildText,
        parent: panel.open_category_id || undefined,
        topic: `Ticket #${ticketNumber} — ${subject}`,
        reason: 'Automation: auto-created ticket',
      });

      // Permissions
      await ticketChannel.permissionOverwrites.create(ctx.guild.id, { ViewChannel: false });
      await ticketChannel.permissionOverwrites.create(ctx.member.id, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
      });
      for (const roleId of (panel.manager_roles ?? [])) {
        await ticketChannel.permissionOverwrites.create(roleId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
        }).catch((e: unknown) => { log.warn('Action failed:', (e as Error)?.message ?? e); });
      }

      // Create ticket record
      const { data: ticket, error: ticketError } = await ctx.supabase
        .from('tickets')
        .insert({
          guild_id: ctx.guildId,
          ticket_number: ticketNumber,
          channel_id: ticketChannel.id,
          creator_id: ctx.member.id,
          panel_id: panel.id,
          type: 'general',
          status: 'open',
        })
        .select('id')
        .single();

      if (ticketError) {
        await ticketChannel.delete().catch(() => { /* channel may already be deleted */ });
        return { success: false, error: `Ticket DB error: ${ticketError.message}` };
      }

      // Post opening message
      await ticketChannel.send({
        content: `🎫 **Ticket #${ticketNumber}** — ${subject}\nCreated for ${ctx.member} by automation.\n\nA staff member will be with you shortly.`,
      });

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
