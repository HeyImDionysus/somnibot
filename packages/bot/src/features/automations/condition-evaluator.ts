/**
 * Condition evaluator — checks all condition types against event context.
 * §20.3 of the architecture doc.
 */
import type { Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ConditionEval');

export interface ConditionContext {
  guild: Guild;
  member: GuildMember | null;
  channelId: string | null;
  messageContent: string | null;
  supabase: SupabaseClient;
  guildId: string;
}

export interface AutomationCondition {
  type: string;
  config: Record<string, unknown>;
}

/**
 * Evaluate all conditions (AND logic). Returns true if all pass.
 */
export async function evaluateConditions(
  conditions: AutomationCondition[],
  ctx: ConditionContext,
): Promise<boolean> {
  for (const condition of conditions) {
    const passed = await evaluateCondition(condition, ctx);
    if (!passed) return false;
  }
  return true;
}

async function evaluateCondition(
  condition: AutomationCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  const { type, config } = condition;

  switch (type) {
    case 'has_role': {
      if (!ctx.member) return false;
      const roleId = config.value as string;
      return ctx.member.roles.cache.has(roleId);
    }

    case 'missing_role': {
      if (!ctx.member) return false;
      const roleId = config.value as string;
      return !ctx.member.roles.cache.has(roleId);
    }

    case 'min_level': {
      if (!ctx.member) return false;
      const minLevel = config.value as number;
      const { data } = await ctx.supabase
        .from('member_levels')
        .select('level')
        .eq('guild_id', ctx.guildId)
        .eq('member_id', ctx.member.id)
        .maybeSingle();
      return (data?.level ?? 0) >= minLevel;
    }

    case 'max_level': {
      if (!ctx.member) return false;
      const maxLevel = config.value as number;
      const { data } = await ctx.supabase
        .from('member_levels')
        .select('level')
        .eq('guild_id', ctx.guildId)
        .eq('member_id', ctx.member.id)
        .maybeSingle();
      return (data?.level ?? 0) < maxLevel;
    }

    case 'in_channel': {
      const channelId = config.value as string;
      return ctx.channelId === channelId;
    }

    case 'not_in_channel': {
      const channelId = config.value as string;
      return ctx.channelId !== channelId;
    }

    case 'has_entitlement': {
      if (!ctx.member) return false;
      const productId = config.value as string;
      // Entitlements link via customer_id, not discord_id.
      // Look up the customer first, then check entitlements.
      const { data: customer } = await ctx.supabase
        .from('customers')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();
      if (!customer) return false;
      const { data } = await ctx.supabase
        .from('entitlements')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('customer_id', customer.id)
        .eq('product_id', productId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      return !!data;
    }

    case 'missing_entitlement': {
      if (!ctx.member) return false;
      const productId = config.value as string;
      // Entitlements link via customer_id, not discord_id.
      const { data: customer } = await ctx.supabase
        .from('customers')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();
      if (!customer) return true; // No customer record → no entitlements
      const { data } = await ctx.supabase
        .from('entitlements')
        .select('id')
        .eq('guild_id', ctx.guildId)
        .eq('customer_id', customer.id)
        .eq('product_id', productId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      return !data;
    }

    case 'message_contains': {
      if (!ctx.messageContent) return false;
      const text = (config.value as string).toLowerCase();
      return ctx.messageContent.toLowerCase().includes(text);
    }

    case 'message_matches_regex': {
      if (!ctx.messageContent) return false;
      try {
        const raw = config.value as string;
        // Limit pattern length to prevent catastrophic backtracking
        if (raw.length > 200) return false;
        const pattern = new RegExp(raw, 'i');
        // Run with a short input slice to bound execution time
        return pattern.test(ctx.messageContent.slice(0, 2000));
      } catch {
        return false;
      }
    }

    case 'is_returning_member': {
      if (!ctx.member) return false;
      const { data } = await ctx.supabase
        .from('members')
        .select('is_returning')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();
      return data?.is_returning === true;
    }

    case 'is_new_member': {
      if (!ctx.member) return false;
      const { data } = await ctx.supabase
        .from('members')
        .select('is_returning')
        .eq('guild_id', ctx.guildId)
        .eq('discord_id', ctx.member.id)
        .maybeSingle();
      return data?.is_returning === false;
    }

    case 'time_window': {
      const { start_hour, end_hour, days } = config as {
        start_hour?: number;
        end_hour?: number;
        days?: number[];
      };
      const now = new Date();
      const currentHour = now.getUTCHours();
      const currentDay = now.getUTCDay();

      if (days && days.length > 0 && !days.includes(currentDay)) {
        return false;
      }
      if (start_hour !== undefined && end_hour !== undefined) {
        if (start_hour <= end_hour) {
          return currentHour >= start_hour && currentHour < end_hour;
        }
        // Wraps around midnight
        return currentHour >= start_hour || currentHour < end_hour;
      }
      return true;
    }

    case 'user_is': {
      if (!ctx.member) return false;
      const userId = config.value as string;
      return ctx.member.id === userId;
    }

    default:
      log.warn(`Unknown condition type: ${type}`);
      return true;
  }
}
