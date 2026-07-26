/**
 * Alert Service — Track automation failures and surface alerts to the owner.
 *
 * V53 Phase 2 (Finding 2.2 — M-5)
 *
 * Tracks consecutive failures per automation in Valkey.
 * After N failures (configurable, default 3):
 *   - Posts alert to owner's configured alert channel
 *   - Writes alert to the `alerts` table for dashboard badge
 *
 * Also provides generic alert posting for DLQ, heartbeat, etc.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Valkey from 'iovalkey';
import type { Client, Guild, TextChannel } from 'discord.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AlertService');

const FAILURE_COUNT_PREFIX = 'somnibot:auto_fail:';
const FAILURE_COUNT_TTL = 3600; // Reset after 1h of no failures
const DEFAULT_FAILURE_THRESHOLD = 3;

// ── Owner alerts (module-level) ─────────────────────────────
//
// X1/M2: every feature used to bare-insert into the `alerts` table, which made
// alerts dashboard-only — no Discord notice ever reached the owner because
// AlertService.postAlert (the only channel-delivery path) had zero callers.
// raiseOwnerAlert is the single shared path: it writes the alerts row AND
// posts to guild_config.alert_channel_id. Call sites that only have a
// SupabaseClient still work (row-only, debug-logged); every site with a Guild
// or Client in scope passes it so the owner actually gets pinged.

export type OwnerAlertSeverity = 'info' | 'warning' | 'critical';

export interface OwnerAlertDelivery {
  /** Guild to deliver the Discord notice to. Preferred when in scope. */
  guild?: Guild | null;
  /** Fallback: resolve the guild from the client cache by guildId. */
  client?: Client | null;
}

export interface OwnerAlertInput extends OwnerAlertDelivery {
  alertType: string;
  severity: OwnerAlertSeverity;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface OwnerAlertResult {
  /** The alerts row was written. */
  inserted: boolean;
  /**
   * Postgres error code when the insert failed. '23505' means a partial
   * unique index deduped this alert (an unresolved row of this type already
   * exists) — callers preserving refresh-on-dupe semantics branch on it.
   */
  insertErrorCode?: string;
  /** The Discord notice was posted to the configured alert channel. */
  delivered: boolean;
}

// Small TTL cache so hot paths (message-log, action-queue sweeps) don't
// re-read guild_config.alert_channel_id on every alert.
const ALERT_CHANNEL_CACHE_TTL_MS = 60_000;
const _alertChannelCache = new Map<string, { channelId: string | null; time: number }>();

/** Test hook — clears the alert-channel config cache. */
export function clearAlertChannelCache(): void {
  _alertChannelCache.clear();
}

async function getAlertChannelId(
  supabase: SupabaseClient,
  guildId: string,
): Promise<string | null> {
  const cached = _alertChannelCache.get(guildId);
  const now = Date.now();
  if (cached && now - cached.time < ALERT_CHANNEL_CACHE_TTL_MS) return cached.channelId;
  try {
    const { data } = await supabase
      .from('guild_config')
      .select('alert_channel_id')
      .eq('guild_id', guildId)
      .maybeSingle();
    const channelId = data?.alert_channel_id ?? null;
    _alertChannelCache.set(guildId, { channelId, time: now });
    return channelId;
  } catch {
    // Config unreadable — deliverability is best-effort, never throw.
    return null;
  }
}

function resolveDeliveryGuild(
  guildId: string,
  delivery: OwnerAlertDelivery | undefined,
): Guild | null {
  if (delivery?.guild) return delivery.guild;
  if (delivery?.client) return delivery.client.guilds.cache.get(guildId) ?? null;
  return null;
}

/**
 * Post an embed to the owner's configured alert channel. Best effort — every
 * failure is logged and swallowed so alert delivery never breaks a feature path.
 * Returns true when the message was actually sent.
 */
async function postOwnerNotice(
  supabase: SupabaseClient,
  guild: Guild,
  severity: OwnerAlertSeverity,
  title: string,
  message: string,
): Promise<boolean> {
  const alertChannelId = await getAlertChannelId(supabase, guild.id);
  if (!alertChannelId) return false;

  try {
    const channel = guild.channels.cache.get(alertChannelId);
    if (!channel || !('send' in channel)) return false;

    const emoji = severity === 'critical' ? '🛑' : severity === 'warning' ? '⚠️' : 'ℹ️';
    await (channel as TextChannel).send({
      embeds: [
        {
          title: `${emoji} ${title}`,
          description: message,
          color:
            severity === 'critical'
              ? 0xff0000
              : severity === 'warning'
                ? 0xffcc00
                : 0x3498db,
          timestamp: new Date().toISOString(),
          footer: { text: 'SomniBot Alert Service' },
        },
      ],
    });
    return true;
  } catch (err) {
    log.error('Failed to post to alert channel:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Raise an owner alert: write the `alerts` row (dashboard badge) AND post to
 * the guild's configured alert channel (Discord notice).
 *
 * - Pass `guild` (or `client`) whenever one is in scope — without it the alert
 *   is row-only and a debug line records the undeliverable notice.
 * - A 23505 insert error is dedupe (an unresolved alert of this type already
 *   exists behind a partial unique index): no duplicate row, no repeat Discord
 *   ping. The code is surfaced in the result for callers that refresh in place.
 * - Never throws: both legs are best-effort and independently logged.
 */
export async function raiseOwnerAlert(
  supabase: SupabaseClient,
  guildId: string,
  input: OwnerAlertInput,
): Promise<OwnerAlertResult> {
  let inserted = false;
  let insertErrorCode: string | undefined;
  try {
    const { error } = await supabase.from('alerts').insert({
      guild_id: guildId,
      alert_type: input.alertType,
      severity: input.severity,
      title: input.title,
      message: input.message,
      metadata: input.metadata ?? {},
      resolved: false,
    });
    if (error) {
      insertErrorCode = (error as { code?: string }).code;
      if (insertErrorCode !== '23505') {
        log.error(`Failed to write ${input.alertType} alert to DB:`, error.message);
      }
    } else {
      inserted = true;
    }
  } catch (err) {
    log.error(
      `Failed to write ${input.alertType} alert to DB:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Deduped alert — the owner was already notified when the unresolved row
  // was first raised; do not ping again.
  if (insertErrorCode === '23505') {
    return { inserted: false, insertErrorCode, delivered: false };
  }

  const guild = resolveDeliveryGuild(guildId, input);
  if (!guild) {
    log.debug(
      `No Discord context for ${input.alertType} alert in guild ${guildId} — row-only delivery`,
    );
    return { inserted, insertErrorCode, delivered: false };
  }

  const delivered = await postOwnerNotice(
    supabase,
    guild,
    input.severity,
    input.title,
    input.message,
  );
  return { inserted, insertErrorCode, delivered };
}

/**
 * Resolve open owner alerts of a type (optionally narrowed by a metadata
 * subset match) and post a short recovery notice to the alert channel — the
 * #51 fix: feature degradations used to clear their throttles silently while
 * the alerts rows stayed resolved=false forever and the owner never heard the
 * all-clear. Returns the number of rows resolved (0 = nothing was open, no
 * notice posted). Never throws.
 */
export async function resolveOwnerAlert(
  supabase: SupabaseClient,
  guildId: string,
  alertType: string,
  metadataMatch?: Record<string, unknown>,
  delivery?: OwnerAlertDelivery & { notice?: string },
): Promise<number> {
  let resolvedCount = 0;
  try {
    const now = new Date().toISOString();
    let query = supabase
      .from('alerts')
      .update({ resolved: true, resolved_at: now, updated_at: now })
      .eq('guild_id', guildId)
      .eq('alert_type', alertType)
      .eq('resolved', false);
    if (metadataMatch && Object.keys(metadataMatch).length > 0) {
      query = query.contains('metadata', metadataMatch);
    }
    const { data, error } = await query.select('id');
    if (error) {
      log.error(`Failed to resolve ${alertType} alert(s):`, error.message);
      return 0;
    }
    resolvedCount = data?.length ?? 0;
  } catch (err) {
    log.error(
      `Failed to resolve ${alertType} alert(s):`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  if (resolvedCount === 0) return 0;

  const guild = resolveDeliveryGuild(guildId, delivery);
  if (guild) {
    await postOwnerNotice(
      supabase,
      guild,
      'info',
      'Alert recovered',
      delivery?.notice ?? `The \`${alertType}\` alert has recovered.`,
    );
  } else {
    log.debug(
      `No Discord context for ${alertType} recovery notice in guild ${guildId} — rows resolved only`,
    );
  }
  return resolvedCount;
}

export interface AlertServiceConfig {
  /** Number of consecutive failures before alerting (default: 3) */
  failureThreshold?: number;
}

export class AlertService {
  private valkey: Valkey;
  private supabase: SupabaseClient;
  private guild: Guild;
  private failureThreshold: number;
  private alertChannelId: string | null = null;

  constructor(
    valkey: Valkey,
    supabase: SupabaseClient,
    guild: Guild,
    config?: AlertServiceConfig,
  ) {
    this.valkey = valkey;
    this.supabase = supabase;
    this.guild = guild;
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  /**
   * Initialize — load alert channel from guild config.
   */
  async init(): Promise<void> {
    try {
      const { data } = await this.supabase
        .from('guild_config')
        .select('alert_channel_id')
        .eq('guild_id', this.guild.id)
        .maybeSingle();
      this.alertChannelId = data?.alert_channel_id ?? null;
    } catch {
      // Non-fatal
    }
    log.info(
      `[AlertService] ✅ Initialized — threshold: ${this.failureThreshold}, ` +
        `alert channel: ${this.alertChannelId ?? 'not configured'}`,
    );
  }

  /**
   * Record a successful automation execution — resets the failure counter.
   */
  async recordSuccess(automationId: string): Promise<void> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      await this.valkey.del(key);
    } catch {
      // Non-critical
    }
  }

  /**
   * Record a failed automation execution — increments counter and fires alert if threshold hit.
   */
  async recordFailure(
    automationId: string,
    automationName: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      const count = await this.valkey.incr(key);
      await this.valkey.expire(key, FAILURE_COUNT_TTL);

      if (count === this.failureThreshold) {
        await this.fireAutomationAlert(automationId, automationName, errorMessage, count);
      }
    } catch (err) {
      log.error('Failed to record failure:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Get the current failure count for an automation.
   */
  async getFailureCount(automationId: string): Promise<number> {
    try {
      const key = `${FAILURE_COUNT_PREFIX}${this.guild.id}:${automationId}`;
      const val = await this.valkey.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get all automation IDs with failures at or above threshold.
   * Used by the dashboard to show badge count.
   */
  async getFailingAutomationCount(): Promise<number> {
    try {
      const pattern = `${FAILURE_COUNT_PREFIX}${this.guild.id}:*`;
      let cursor = '0';
      let count = 0;

      do {
        const [nextCursor, keys] = await this.valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          const values = await this.valkey.mget(...keys);
          for (const val of values) {
            if (val && parseInt(val, 10) >= this.failureThreshold) {
              count++;
            }
          }
        }
      } while (cursor !== '0');

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Post a generic alert to the owner's alert channel + alerts table.
   * Thin wrapper over the module-level raiseOwnerAlert (the guild is bound).
   */
  async postAlert(
    alertType: string,
    severity: 'info' | 'warning' | 'critical',
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType,
      severity,
      title,
      message,
      metadata,
      guild: this.guild,
    });
  }

  // ── Private ───────────────────────────────────────────────

  private async fireAutomationAlert(
    automationId: string,
    automationName: string,
    errorMessage: string,
    failureCount: number,
  ): Promise<void> {
    const title = `Automation "${automationName}" failing`;
    const message =
      `Automation \`${automationName}\` (${automationId}) has failed ` +
      `${failureCount} time(s) in a row.\n\nLatest error: ${errorMessage}`;

    await raiseOwnerAlert(this.supabase, this.guild.id, {
      alertType: 'automation_failure',
      severity: 'warning',
      title,
      message,
      metadata: { automationId, automationName, failureCount, lastError: errorMessage },
      guild: this.guild,
    });
  }
}
