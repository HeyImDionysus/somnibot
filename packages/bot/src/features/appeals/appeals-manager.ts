/**
 * Appeals Manager — lifecycle for moderation infraction appeals.
 *
 * A punished member submits an appeal against one of THEIR infractions; a guild
 * owner reviews it on the dashboard and approves/denies; the member is DM'd the
 * outcome. Pending appeals that are never decided auto-expire.
 *
 * State machine (see migration 20260723190000_appeals_system.sql):
 *   pending -> approved | denied   (owner decision)
 *   pending -> expired             (auto, past expires_at)
 *
 * This module is PURE persistence + validation (no Discord I/O) so it is unit
 * testable with a mocked Supabase. DM delivery lives in appeal-notifier.ts.
 *
 * Architecture doc §18 (moderation) — appeals extension.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Appeals');

/** How long a pending appeal stays open before it auto-expires. */
export const DEFAULT_APPEAL_WINDOW_DAYS = 7;

/** Max reason length accepted on submit (Discord modal/option safe). */
export const APPEAL_REASON_MAX = 1000;

export type AppealStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type AppealDecision = 'approved' | 'denied';

export interface AppealRecord {
  id: string;
  guild_id: string;
  infraction_id: string;
  appellant_discord_id: string;
  reason: string;
  status: AppealStatus;
  reviewer_id: string | null;
  decision_notified: boolean;
  decided_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface SubmitAppealInput {
  guildId: string;
  infractionId: string;
  appellantDiscordId: string;
  reason: string;
  /** Override the auto-computed expiry (defaults to now + DEFAULT_APPEAL_WINDOW_DAYS). */
  expiresAt?: string | null;
}

export type SubmitAppealError =
  | 'invalid_reason'
  | 'appeals_disabled'
  | 'infraction_not_found'
  | 'not_appellant'
  | 'cooldown'
  | 'already_pending'
  | 'db_error';

export type SubmitAppealResult =
  | { ok: true; appeal: AppealRecord; deduped: boolean }
  | { ok: false; error: SubmitAppealError };

export interface ListAppealsOptions {
  status?: AppealStatus;
  limit?: number;
  offset?: number;
}

/**
 * Compute an ISO expiry `days` in the future from now.
 */
export function calculateAppealExpiry(days: number = DEFAULT_APPEAL_WINDOW_DAYS): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export class AppealsManager {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Submit an appeal for an infraction.
   *
   * Guards:
   *  - reason must be non-empty and within APPEAL_REASON_MAX.
   *  - the infraction must exist in THIS guild.
   *  - the appellant must be the infraction's own member (no appealing on behalf
   *    of others — prevents griefing / spam against another user's record).
   *  - at most one pending appeal per infraction (partial unique index). A
   *    replayed submit dedups: we read back the existing pending row.
   */
  async submit(input: SubmitAppealInput): Promise<SubmitAppealResult> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length === 0 || reason.length > APPEAL_REASON_MAX) {
      return { ok: false, error: 'invalid_reason' };
    }

    // Configuration is optional for backwards compatibility with pre-control
    // guild rows and test doubles: a read failure keeps the safe, catalog
    // defaults (enabled, 24-hour cooldown) rather than blocking appeals.
    let appealsEnabled = true;
    let cooldownHours = 24;
    try {
      const { data } = await this.supabase
        .from('guild_config')
        .select('appeals_enabled, appeal_cooldown_hours')
        .eq('guild_id', input.guildId)
        .maybeSingle();
      appealsEnabled = data?.appeals_enabled ?? true;
      cooldownHours = data?.appeal_cooldown_hours ?? 24;
    } catch {
      // Keep defaults when the legacy schema/mock does not expose these fields.
    }
    if (!appealsEnabled) return { ok: false, error: 'appeals_disabled' };

    // Verify the infraction belongs to this guild AND to the appellant.
    const { data: infraction, error: infErr } = await this.supabase
      .from('infractions')
      .select('id, member_id')
      .eq('id', input.infractionId)
      .eq('guild_id', input.guildId)
      .maybeSingle();

    if (infErr) {
      log.error('Failed to load infraction for appeal:', infErr.message);
      return { ok: false, error: 'db_error' };
    }
    if (!infraction) {
      return { ok: false, error: 'infraction_not_found' };
    }
    if (infraction.member_id !== input.appellantDiscordId) {
      return { ok: false, error: 'not_appellant' };
    }

    // A pending appeal is covered by the partial unique index. Once decided,
    // retain a respectful per-infraction cooldown to prevent immediate spam.
    try {
      const { data: latest } = await this.supabase
        .from('appeals')
        .select('created_at, status')
        .eq('guild_id', input.guildId)
        .eq('infraction_id', input.infractionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest?.created_at && latest.status !== 'pending') {
        const cooldownMs = Math.max(1, Math.min(168, Number(cooldownHours) || 24)) * 60 * 60 * 1000;
        if (Date.now() - new Date(latest.created_at).getTime() < cooldownMs) {
          return { ok: false, error: 'cooldown' };
        }
      }
    } catch {
      // Legacy schema/test doubles: the uniqueness fence still protects pending rows.
    }

    const expiresAt =
      input.expiresAt === undefined ? calculateAppealExpiry() : input.expiresAt;

    const { data, error } = await this.supabase
      .from('appeals')
      .insert({
        guild_id: input.guildId,
        infraction_id: input.infractionId,
        appellant_discord_id: input.appellantDiscordId,
        reason,
        status: 'pending',
        decision_notified: false,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) {
      // Partial unique (guild_id, infraction_id) WHERE status='pending' — a
      // concurrent/replayed submit. Treat as a dedup no-op and read back the
      // existing open appeal instead of surfacing a raw DB error.
      if (error.code === '23505') {
        const { data: existing } = await this.supabase
          .from('appeals')
          .select('*')
          .eq('guild_id', input.guildId)
          .eq('infraction_id', input.infractionId)
          .eq('status', 'pending')
          .maybeSingle();
        if (existing) {
          return { ok: true, appeal: existing as AppealRecord, deduped: true };
        }
        return { ok: false, error: 'already_pending' };
      }
      log.error('Failed to create appeal:', error.message);
      return { ok: false, error: 'db_error' };
    }

    return { ok: true, appeal: data as AppealRecord, deduped: false };
  }

  /**
   * List appeals for a guild (dashboard review queue), newest first.
   * Returns the page plus the total matching count for pagination.
   */
  async listForGuild(
    guildId: string,
    options: ListAppealsOptions = {},
  ): Promise<{ appeals: AppealRecord[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    let query = this.supabase
      .from('appeals')
      .select('*', { count: 'exact' })
      .eq('guild_id', guildId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
      .limit(1000);

    if (options.status) {
      query = query.eq('status', options.status);
    }

    const { data, error, count } = await query;
    if (error) {
      log.error('Failed to list appeals:', error.message);
      return { appeals: [], total: 0 };
    }
    return { appeals: (data ?? []) as AppealRecord[], total: count ?? 0 };
  }

  /**
   * List a single member's appeals within a guild (for `/appeal status`).
   */
  async listForMember(
    guildId: string,
    appellantDiscordId: string,
    limit = 10,
  ): Promise<AppealRecord[]> {
    const { data, error } = await this.supabase
      .from('appeals')
      .select('*')
      .eq('guild_id', guildId)
      .eq('appellant_discord_id', appellantDiscordId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      log.error('Failed to list member appeals:', error.message);
      return [];
    }
    return (data ?? []) as AppealRecord[];
  }

  /**
   * Fetch a single appeal by id, scoped to the guild (review detail / IDOR-safe).
   */
  async review(guildId: string, appealId: string): Promise<AppealRecord | null> {
    const { data, error } = await this.supabase
      .from('appeals')
      .select('*')
      .eq('id', appealId)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (error) {
      log.error('Failed to load appeal:', error.message);
      return null;
    }
    return (data as AppealRecord) ?? null;
  }

  /**
   * Record a decision on a pending appeal.
   *
   * ATOMIC: the update matches `status = 'pending'`, so two concurrent decisions
   * cannot both win (the loser gets zero rows back) and an already-decided or
   * expired appeal cannot be re-decided. Returns the updated row, or null if the
   * appeal was not pending (or not found in this guild).
   */
  async decide(
    guildId: string,
    appealId: string,
    decision: AppealDecision,
    reviewerId: string,
  ): Promise<AppealRecord | null> {
    const { data, error } = await this.supabase
      .from('appeals')
      .update({
        status: decision,
        reviewer_id: reviewerId,
        decided_at: new Date().toISOString(),
        // Reset the delivery latch so the bot's sweep DMs the member once.
        decision_notified: false,
      })
      .eq('id', appealId)
      .eq('guild_id', guildId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) {
      log.error('Failed to decide appeal:', error.message);
      return null;
    }
    // TODO(audit): appeal.approved / appeal.denied — emit an audit event once the
    // audit wave wires appeal.* into events.ts / audit-service.ts.
    return (data as AppealRecord) ?? null;
  }

  /**
   * Expire pending appeals past their expires_at. Called on a periodic sweep.
   * Returns the number of appeals expired.
   */
  async sweepExpired(guildId: string): Promise<number> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('appeals')
      .update({ status: 'expired' })
      .eq('guild_id', guildId)
      .eq('status', 'pending')
      .not('expires_at', 'is', null)
      .lte('expires_at', now)
      .select('id')
      .limit(1000);

    if (error) {
      log.error('Failed to expire appeals:', error.message);
      return 0;
    }
    const count = data?.length ?? 0;
    if (count > 0) log.info(`Expired ${count} appeal(s)`, { guildId });
    return count;
  }

  /**
   * Fetch decided appeals whose member has NOT yet been DM'd the outcome, so the
   * bot can deliver the notification exactly once (see decision_notified latch).
   */
  async collectUndeliveredDecisions(guildId: string, limit = 100): Promise<AppealRecord[]> {
    const { data, error } = await this.supabase
      .from('appeals')
      .select('*')
      .eq('guild_id', guildId)
      .eq('decision_notified', false)
      .in('status', ['approved', 'denied'])
      .order('decided_at', { ascending: true })
      .limit(limit);

    if (error) {
      log.error('Failed to collect undelivered appeal decisions:', error.message);
      return [];
    }
    return (data ?? []) as AppealRecord[];
  }

  /**
   * Mark a decision as delivered (DM sent). Idempotent latch flip.
   */
  async markDecisionNotified(appealId: string): Promise<void> {
    const { error } = await this.supabase
      .from('appeals')
      .update({ decision_notified: true })
      .eq('id', appealId);
    if (error) {
      log.error('Failed to mark appeal decision notified:', error.message);
    }
  }
}
