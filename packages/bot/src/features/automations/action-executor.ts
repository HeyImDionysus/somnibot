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
import { bindSupabaseRpc } from '../../services/supabase-rpc.js';
import { AUTOMATION_LIMITS , createLogger } from '@somnibot/shared';
import { AutomationRateLimiter } from './rate-limiter.js';
import { deterministicUuidV8 } from '../../utils/deterministic-uuid.js';

const log = createLogger('ActionExecutor');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function isExactUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

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
  /** One identity shared by every action from the same engine event occurrence. */
  occurrenceId: string;
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
  actionIndexOffset = 0,
): Promise<{ executed: number; failed: number; errors: string[] }> {
  let executed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const [actionIndex, action] of actions.entries()) {
    if (executed + failed >= AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION) {
      errors.push(`Action limit reached (${AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION})`);
      break;
    }

    try {
      const result = await executeAction(action, ctx, actionIndex + actionIndexOffset);
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
  actionIndex: number,
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
      const configuredPlanId = config.plan_id;
      let planId = configuredPlanId === undefined || configuredPlanId === null
        ? null
        : configuredPlanId;
      if (
        !isExactUuid(productId)
        || (planId !== null && !isExactUuid(planId))
        || !isExactUuid(ctx.automationId)
        || !isExactUuid(ctx.occurrenceId)
        || !DISCORD_SNOWFLAKE_PATTERN.test(ctx.guildId)
        || !DISCORD_SNOWFLAKE_PATTERN.test(ctx.member.id)
      ) {
        return { success: false, error: 'Malformed automation entitlement identity' };
      }

      // Fetch product to get role/channel grants
      const { data: product, error: productError } = await ctx.supabase
        .from('products')
        .select('id, type, granted_role_ids, granted_channel_ids')
        .eq('id', productId)
        .eq('guild_id', ctx.guildId)
        .maybeSingle();

      if (productError) {
        return { success: false, error: `Product lookup failed: ${productError.message}` };
      }
      if (!product || product.id !== productId) {
        return { success: false, error: `Product ${productId} not found in this guild` };
      }
      if (product.type !== 'one_time' && product.type !== 'subscription') {
        return { success: false, error: 'Product returned an invalid entitlement type' };
      }
      if (product.type === 'one_time' && planId !== null) {
        return { success: false, error: 'A one-time product cannot use a subscription plan' };
      }
      if (product.type === 'subscription') {
        let planQuery = ctx.supabase
          .from('plans')
          .select('id')
          .eq('product_id', productId)
          .eq('guild_id', ctx.guildId)
          .eq('active', true);
        if (planId !== null) {
          planQuery = planQuery.eq('id', planId);
        }
        // Without an explicit plan, maybeSingle deliberately succeeds only
        // when the product has exactly one active plan. Zero or multiple plans
        // are ambiguous and must not manufacture an unscoped subscription.
        const { data: plan, error: planError } = await planQuery.maybeSingle();
        if (planError) {
          return { success: false, error: `Plan lookup failed: ${planError.message}` };
        }
        if (!plan || !isExactUuid(plan.id) || (planId !== null && plan.id !== planId)) {
          return {
            success: false,
            error: planId === null
              ? 'Subscription product must resolve exactly one active plan'
              : `Plan ${planId} is not active for this product`,
          };
        }
        planId = plan.id;
      }

      // Find or create customer record
      let { data: customer, error: customerError } = await ctx.supabase
        .from('customers')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();
      if (customerError) {
        return { success: false, error: `Customer lookup failed: ${customerError.message}` };
      }

      if (!customer) {
        const { data: insertedCustomer, error: insertError } = await ctx.supabase
          .from('customers')
          .insert({
            guild_id: ctx.guildId,
            discord_id: ctx.member.id,
            discord_username: ctx.member.user.username,
          })
          .select('id')
          .maybeSingle();
        // A response containing both data and an error is not authoritative.
        // Discard it and use the same exact read-back as a unique-insert race.
        customer = insertError ? null : insertedCustomer;

        // A concurrent occurrence can win the unique (guild_id, discord_id)
        // insert, and a committed insert can lose its response. Resolve both
        // outcomes through the same exact scoped read-back before failing.
        if (!customer) {
          const { data: observedCustomer, error: observeError } = await ctx.supabase
            .from('customers')
            .select('id')
            .eq('guild_id', ctx.guildId)
            .eq('discord_id', ctx.member.id)
            .maybeSingle();
          if (observeError) {
            return {
              success: false,
              error: `Customer create read-back failed: ${observeError.message}`,
            };
          }
          customer = observedCustomer;
        }

        if (!customer && insertError) {
          return { success: false, error: `Customer create failed: ${insertError.message}` };
        }
      }

      if (!customer || !isExactUuid(customer.id)) {
        return { success: false, error: 'Failed to resolve customer record' };
      }

      // One event occurrence may deliberately contain multiple grant actions.
      // The action index keeps them distinct; replaying the same occurrence
      // derives the same UUID and lets the atomic RPC return the same grant.
      const requestId = deterministicUuidV8('somnibot:automation-entitlement:v1', [
        ctx.guildId,
        ctx.automationId,
        ctx.occurrenceId,
        String(actionIndex),
        ctx.member.id,
        productId,
      ]);
      const rpc = bindSupabaseRpc(ctx.supabase) as unknown as (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data: grantRows, error: grantError } = await rpc(
        'commerce_create_noncommerce_entitlement',
        {
          p_request_id: requestId,
          p_guild_id: ctx.guildId,
          p_customer_id: customer.id,
          p_product_id: productId,
          p_source: 'automation',
          p_type: product.type,
          p_plan_id: planId,
          p_expires_at: null,
          p_granted_role_ids: product.granted_role_ids ?? [],
          p_granted_channel_ids: product.granted_channel_ids ?? [],
        },
      );
      if (grantError) {
        return { success: false, error: `Entitlement grant failed: ${grantError.message}` };
      }

      const grant = Array.isArray(grantRows) && grantRows.length === 1
        ? grantRows[0] as Record<string, unknown>
        : null;
      if (
        !grant
        || !isExactUuid(grant.entitlement_id)
        || grant.order_id !== requestId
        || grant.request_id !== requestId
      ) {
        return {
          success: false,
          error: 'Entitlement grant returned malformed replay identity evidence',
        };
      }
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
      const { data: seqVal, error: seqErr } = await ctx.supabase.rpc('nextval_ticket', { p_guild_id: ctx.guildId });
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
        // The ticket creator is mentioned on purpose; the SUBJECT comes from an
        // automation template and must not be able to ping a role.
        allowedMentions: { parse: ['users'] },
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
