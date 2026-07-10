/**
 * Condition evaluator — checks all condition types against event context.
 * §20.3 of the architecture doc.
 */
import type { Guild, GuildMember } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
// Module-level import (matches moderation/automod-engine.ts). The regex
// evaluation path must stay fully synchronous so the budget check-and-reserve
// below is atomic — do NOT convert back to a dynamic `await import`.
import { runInNewContext } from 'node:vm';
import { createLogger } from '@somnibot/shared';

const log = createLogger('ConditionEval');

/**
 * Hard timeout for a single regex vm evaluation. Calibrated in PR #269 (the
 * original 50ms misclassified legit patterns as timeouts under CPU
 * contention). Keep in sync with moderation/automod-engine.ts. Also used as
 * the worst-case slice reserved against the per-event budget before each
 * evaluation (see message_matches_regex below).
 */
const REGEX_VM_TIMEOUT_MS = 250;

/**
 * PR #269 review (P2): Aggregate regex-evaluation budget per platform event.
 *
 * Each `message_matches_regex` condition may synchronously block the event
 * loop for up to 250ms (the vm timeout below). Automation limits allow up to
 * 100 automations per guild with up to 50 conditions each, and the engine
 * starts EVERY matching automation for an event — so without an aggregate
 * cap, a handful of pathological owner-configured patterns could block the
 * event loop for many seconds per message.
 *
 * The budget is spend-accounted with pessimistic reservation: before each
 * evaluation the worst-case slice (REGEX_VM_TIMEOUT_MS) is synchronously
 * reserved against the shared budget, and afterwards the difference between
 * the reservation and the measured wall-clock spend is refunded. Because the
 * engine starts automations for one event in parallel, check-and-reserve must
 * be atomic (no await between them) — a plain check-then-charge would let N
 * interleaved evaluations all pass the check before any charged spend.
 * Once exhausted, remaining regex conditions evaluate as non-match —
 * fail-closed for triggering, a budget bail never fires an automation — with
 * a single warning per event.
 *
 * 500ms matches the automod per-message budget (MESSAGE_RULE_BUDGET_MS in
 * moderation/automod-engine.ts). An in-flight evaluation is never cut short
 * (each keeps its full calibrated 250ms so legitimate patterns don't flake
 * under load), so worst-case overshoot is one vm-timeout slice (~250ms)
 * beyond the budget — even under concurrency, since admission requires
 * remaining budget and immediately reserves the full slice.
 */
export const EVENT_REGEX_BUDGET_MS = 500;

export interface RegexBudget {
  /** Milliseconds left for regex evaluation across the current event. */
  remainingMs: number;
  /** Ensures the budget-exhausted warning is logged once per event. */
  exhaustedLogged: boolean;
}

/** Create a fresh regex budget (the engine creates one per platform event). */
export function createRegexBudget(): RegexBudget {
  return { remainingMs: EVENT_REGEX_BUDGET_MS, exhaustedLogged: false };
}

export interface ConditionContext {
  guild: Guild;
  member: GuildMember | null;
  channelId: string | null;
  messageContent: string | null;
  supabase: SupabaseClient;
  guildId: string;
  /**
   * Shared per-event regex budget (see EVENT_REGEX_BUDGET_MS). The automation
   * engine supplies one instance per platform event so all automations
   * triggered by that event share it. When absent (direct callers, tests) a
   * fresh per-call budget is used internally — the caller's context is never
   * mutated, so a reused context does not accumulate budget state.
   */
  regexBudget?: RegexBudget;
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
  // PR #269 review: guarantee a regex budget exists even for direct callers
  // so a single evaluateConditions call is always bounded. Kept in a LOCAL —
  // assigning onto ctx would mutate the caller's context and leak spent /
  // exhausted budget state into unrelated later evaluations that reuse it
  // (PR #269 follow-up review, P3).
  const regexBudget = ctx.regexBudget ?? createRegexBudget();
  for (const condition of conditions) {
    const passed = await evaluateCondition(condition, ctx, regexBudget);
    if (!passed) return false;
  }
  return true;
}

async function evaluateCondition(
  condition: AutomationCondition,
  ctx: ConditionContext,
  regexBudget: RegexBudget,
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
      // PR #269 review (P2): enforce the shared per-event regex budget.
      // Exhausted → remaining regex conditions are non-matches (fail-closed
      // for triggering; never throws), logged once per event.
      if (regexBudget.remainingMs <= 0) {
        if (!regexBudget.exhaustedLogged) {
          regexBudget.exhaustedLogged = true;
          log.warn(
            `Regex evaluation budget exhausted (${EVENT_REGEX_BUDGET_MS}ms) for guild ${ctx.guildId} — ` +
            'remaining message_matches_regex conditions evaluate as non-match for this event',
          );
        }
        return false;
      }
      // PR #269 follow-up review (P2): the engine starts automations for one
      // event IN PARALLEL, so check-and-charge must be atomic. Synchronously
      // reserve the worst-case slice (the vm timeout) before evaluating; the
      // finally block below refunds the difference between the reservation
      // and the measured spend (or charges the excess if the vm overshot its
      // timeout). No await may sit between the check above and this
      // reservation — that is also why node:vm is imported at module level
      // rather than via a dynamic `await import`.
      regexBudget.remainingMs -= REGEX_VM_TIMEOUT_MS;
      const startedAt = Date.now();
      try {
        const raw = config.value as string;
        // Limit pattern length to prevent catastrophic backtracking
        if (raw.length > 200) return false;
        const pattern = new RegExp(raw, 'i');
        // V5 Audit [V5-3]: Guard against catastrophic backtracking.
        // Run regex in a bounded context with a timeout.
        // SECURITY: node:vm is NOT a security sandbox. We only use it for
        // timeout enforcement — the evaluated expression is a hardcoded
        // string, never user input. microtaskMode prevents timeout bypass
        // via microtask scheduling.
        // TIMEOUT: REGEX_VM_TIMEOUT_MS (250ms). The original 50ms (V5 audit)
        // was an uncalibrated bound: under heavy CPU contention (parallel
        // test workers, busy host) vm context setup + scheduling alone can
        // exceed 50ms, so even trivial patterns misclassified as timeouts
        // (observed as flaky test failures under full-suite load). Patterns
        // are guild-owner configured (dashboard writes are
        // requireGuildOwner-gated) and length-capped, and input is sliced, so
        // 250ms still firmly bounds catastrophic backtracking while
        // tolerating scheduling jitter.
        // Keep in sync with moderation/automod-engine.ts.
        const input = ctx.messageContent.slice(0, 2000);
        const result = runInNewContext(
          'pattern.test(input)',
          { pattern, input },
          { timeout: REGEX_VM_TIMEOUT_MS, microtaskMode: 'afterEvaluate' },
        );
        return Boolean(result);
      } catch {
        // Timeout, invalid regex, or other error — treat as non-match
        return false;
      } finally {
        // Refund reservation minus actual elapsed time — the net charge is
        // the measured spend (including vm timeouts and overshoot).
        regexBudget.remainingMs += REGEX_VM_TIMEOUT_MS - (Date.now() - startedAt);
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
