/**
 * ScheduledMessageRunner — cron-based message scheduling.
 *
 * Loads schedules from Supabase, evaluates cron expressions with timezone support,
 * sends messages to designated channels, and tracks send counts.
 */
import {
  EmbedBuilder,
  type Guild,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventBus as defaultEventBus, type PlatformEventBus } from '../../services/event-bus.js';
import { raiseOwnerAlert } from '../../services/alert-service.js';
import { createLogger } from '@somnibot/shared';
import {
  claimDiscordOccurrence,
  completeDiscordOccurrence,
  failDiscordOccurrence,
} from '../../services/occurrence-fence.js';

const log = createLogger('ScheduledRunner');

/**
 * How old a `claimed` scheduled-message occurrence must be before a losing
 * claimant may CAS-reclaim it as a crashed holder's leftovers. A healthy send
 * completes in seconds (trySend's entire bounded backoff is under a minute), so
 * five minutes cannot race a live holder — it can only recover a claim whose
 * process died between the claim insert and the completion write.
 */
const STALE_SCHEDULE_CLAIM_MS = 5 * 60_000;

/**
 * How far back stale-claim recovery reaches. Crash recovery must
 * survive any realistic outage, but a schedule exhausted months ago with a
 * cleanly completed occurrence must not pay a probe query every minute forever.
 */
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;

interface ScheduledMessage {
  id: string;
  guild_id: string;
  name: string;
  channel_id: string;
  message: string | null;
  embed_config_id: string | null;
  cron_expression: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  max_sends: number | null;
  current_sends: number;
  active: boolean;
  last_sent_at: string | null;
  status: string | null;
  last_error: string | null;
  failed_at: string | null;
  missed_run_policy: string | null;
}

interface EmbedConfig {
  title: string | null;
  description: string | null;
  color: number | null;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  author_name: string | null;
  author_url: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
}

/**
 * Simple cron matcher that supports:
 *   - Standard 5-field cron: minute hour dayOfMonth month dayOfWeek
 *   - Wildcards, specific values, lists (1,3,5), ranges (1-5), steps (star/5)
 */
function matchesCron(expression: string, now: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1; // 1-based
  const dayOfWeek = now.getDay(); // 0 = Sunday

  const values = [minute, hour, dayOfMonth, month, dayOfWeek];
  const maxValues = [59, 23, 31, 12, 7];

  for (let i = 0; i < 5; i++) {
    if (!matchesCronField(parts[i]!, values[i]!, maxValues[i]!)) {
      return false;
    }
  }
  return true;
}

function matchesCronField(field: string, value: number, _max: number): boolean {
  if (field === '*') return true;

  // Handle lists: "1,3,5"
  const parts = field.split(',');
  for (const part of parts) {
    // Handle step: "*/5" or "1-10/2"
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const range = stepMatch[1]!;
      const step = parseInt(stepMatch[2]!, 10);
      if (range === '*') {
        if (value % step === 0) return true;
      } else {
        const [start, end] = range.split('-').map(Number);
        if (start != null && end != null && value >= start && value <= end && (value - start) % step === 0) {
          return true;
        }
      }
      continue;
    }

    // Handle range: "1-5"
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (value >= start && value <= end) return true;
      continue;
    }

    // Direct value
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

/**
 * Convert a Date to a different timezone and return the components.
 */
function dateInTimezone(date: Date, timezone: string): Date {
  try {
    const str = date.toLocaleString('en-US', { timeZone: timezone });
    return new Date(str);
  } catch {
    return date; // Fallback to UTC
  }
}

/**
 * Replace variables in text content.
 */
function replaceVariables(text: string, guild: Guild): string {
  return text
    .replace(/\{server\}/g, guild.name)
    .replace(/\{server\.name\}/g, guild.name)
    .replace(/\{members\}/g, String(guild.memberCount))
    .replace(/\{memberCount\}/g, String(guild.memberCount))
    .replace(/\{date\}/g, new Date().toLocaleDateString())
    .replace(/\{time\}/g, new Date().toLocaleTimeString())
    .replace(/\{timestamp\}/g, String(Math.floor(Date.now() / 1000)));
}

export class ScheduledMessageRunner {
  private schedules: ScheduledMessage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private eventBus: PlatformEventBus = defaultEventBus,
  ) {}

  async start(): Promise<void> {
    await this.loadSchedules();

    if (this.schedules.length === 0) {
      log.info('No active schedules');
    }

    // Apply the missed-run policy for occurrences that were due while the stack
    // was down (before wiring the regular minute tick so a send-latest catch-up
    // and the first tick cannot race the same occurrence).
    await this.handleMissedRuns();

    // Check every 60 seconds (aligned to minute boundary)
    const now = Date.now();
    const msToNextMinute = 60_000 - (now % 60_000);

    // Initial alignment
    setTimeout(() => {
      this.tick().catch((err) => log.error('Tick error:', { error: String(err) }));
      this.timer = setInterval(() => {
        this.tick().catch((err) => log.error('Tick error:', { error: String(err) }));
      }, 60_000);
    }, msToNextMinute);

    log.info(`Started with ${this.schedules.length} schedules`);
  }

  async reload(): Promise<void> {
    await this.loadSchedules();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether the last schedule load actually answered. A failed load leaves
   * `schedules` empty, which is indistinguishable from "every schedule was
   * deleted" — and the stale-claim scan must never terminalize claims on that
   * ambiguity.
   */
  private schedulesLoadAuthoritative = false;

  private async loadSchedules(): Promise<void> {
    const { data, error } = await this.supabase
      .from('scheduled_messages')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .eq('status', 'active')
      .limit(1000);

    this.schedulesLoadAuthoritative = !error;
    this.schedules = (data ?? []) as ScheduledMessage[];
  }

  private async tick(): Promise<void> {
    // Reload schedules periodically (every tick for fresh data)
    await this.loadSchedules();

    const now = new Date();

    // Recover EVERY stale claimed occurrence before the per-schedule guards
    // can skip anything. Deriving a single key from last_sent_at was not
    // enough: on a schedule firing faster than the stale threshold, a crashed
    // minute T is hidden the moment T+1 delivers and advances last_sent_at —
    // T stays claimed and undelivered forever while still consuming a send
    // count. The scan reads the occurrence table itself, so no counted-but-
    // unconfirmed minute can hide behind a later delivery, an exhausted
    // max_sends, or a closed date window (recovering an already-counted
    // minute is legitimate after the window closes; NEW sends stay bounded by
    // the guards below).
    await this.scanStaleScheduledClaims().catch((err) => {
      log.error('Stale scheduled-claim scan failed:', { error: String(err) });
    });

    for (const schedule of this.schedules) {
      try {
        // Check date bounds
        if (schedule.start_date && new Date(schedule.start_date) > now) continue;
        if (schedule.end_date && new Date(schedule.end_date) < now) continue;

        // Check max sends
        if (schedule.max_sends != null && schedule.current_sends >= schedule.max_sends) continue;

        // Convert now to schedule's timezone
        const localNow = dateInTimezone(now, schedule.timezone || 'UTC');

        // Check if cron matches
        if (!matchesCron(schedule.cron_expression, localNow)) continue;

        // Prevent double-send: check if we already sent this minute
        if (schedule.last_sent_at) {
          const lastSent = new Date(schedule.last_sent_at);
          const diffMs = now.getTime() - lastSent.getTime();
          if (diffMs < 55_000) continue; // Skip if sent less than 55s ago
        }

        const occurrenceAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
        await this.sendMessage(schedule, occurrenceAt);
      } catch (err) {
        log.error(`Error for schedule ${schedule.id}:`, err);
      }
    }
  }

  /**
   * Find and recover every stale `claimed` scheduled-message occurrence for
   * this guild. Bounded to 25 oldest per tick (a tick runs every minute, so a
   * backlog drains quickly) and to the recovery window — a claim stranded for
   * longer than a week is left for manual review rather than surprise-posting
   * ancient announcements. Status and staleness are re-verified per row so a
   * lagging read can never race a live holder; the actual reclaim is the CAS
   * inside sendMessage().
   */
  private async scanStaleScheduledClaims(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_SCHEDULE_CLAIM_MS);
    const windowFloor = new Date(Date.now() - RECOVERY_WINDOW_MS);
    const { data, error } = await this.supabase
      .from('discord_operation_occurrences')
      .select('id, occurrence_key, status, claimed_at')
      .eq('guild_id', this.guild.id)
      .eq('operation_kind', 'scheduled_message')
      .eq('status', 'claimed')
      .lt('claimed_at', staleBefore.toISOString())
      .gt('claimed_at', windowFloor.toISOString())
      .order('claimed_at', { ascending: true })
      .limit(25);
    if (error) {
      log.error('Could not scan stale scheduled-message claims:', { error: error.message });
      return;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (row.status !== 'claimed') continue;
      const claimedAtMs = Date.parse(String(row.claimed_at ?? ''));
      if (!Number.isFinite(claimedAtMs) || Date.now() - claimedAtMs < STALE_SCHEDULE_CLAIM_MS) {
        continue;
      }
      // occurrence_key is `${schedule.id}:${dueMinuteISO}`; schedule ids are
      // UUIDs (no colon), so the first colon splits identity from due minute.
      const key = String(row.occurrence_key ?? '');
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const scheduleId = key.slice(0, sep);
      const dueAtMs = Date.parse(key.slice(sep + 1));
      if (!Number.isFinite(dueAtMs)) continue;
      const schedule = this.schedules.find((candidate) => candidate.id === scheduleId);
      if (!schedule) {
        // A claim whose schedule is deleted/disabled/failed can never be
        // delivered — sendMessage needs live schedule config, and a days-old
        // announcement resurrecting on re-enable would be wrong anyway. But
        // silently skipping PINNED the 25-oldest batch: enough dead-schedule
        // claims and newer stale claims for ACTIVE schedules were never
        // reached until the blockers aged past the 7-day window. Terminalize
        // them — with one guard: only when the schedule load actually
        // answered, because a failed load leaves `schedules` empty and every
        // valid claim would be executed on that ambiguity.
        if (this.schedulesLoadAuthoritative) {
          await failDiscordOccurrence(
            this.supabase,
            String(row.id),
            'schedule inactive or deleted; counted send cannot be delivered',
          ).catch((err) => {
            log.error('Could not terminalize dead-schedule claim:', { error: String(err) });
          });
        }
        continue;
      }
      log.warn(
        `Schedule "${schedule.name}" has an unconfirmed counted send `
        + `(due ${new Date(dueAtMs).toISOString()}); attempting stale-claim recovery.`,
      );
      await this.sendMessage(schedule, new Date(dueAtMs)).catch((err) => {
        log.error(`Stale-claim recovery failed for schedule ${schedule.id}:`, {
          error: String(err),
        });
      });
    }
  }

  private async sendMessage(schedule: ScheduledMessage, occurrenceAt: Date): Promise<void> {
    const channel = this.guild.channels.cache.get(schedule.channel_id) as TextChannel | undefined;
    if (!channel || !channel.isTextBased()) {
      // The target channel is gone/non-text. Mark the schedule failed, alert the
      // owner once, and stop it re-firing every minute (loadSchedules filters on
      // status='active'). Previously this only log.warn()'d forever, silently.
      log.warn(`Channel ${schedule.channel_id} not found`);
      await this.markFailed(schedule, `channel_missing:${schedule.channel_id}`);
      return;
    }

    // The due-minute is the occurrence identity. A unique insert is a durable
    // fence across shards, restarts, tick replay, and the crash boundary around
    // Discord's send API.
    let occurrenceId: string;
    let reclaimedStaleClaim = false;
    let reclaimedResult: Record<string, unknown> = {};
    // The claim-generation snapshot the counter RPC verifies: a stalled
    // worker resuming after recovery reclaimed this minute must be told it
    // no longer owns the send.
    let occurrenceClaimUpdatedAt: string | null = null;
    try {
      const claim = await claimDiscordOccurrence(
        this.supabase,
        this.guild.id,
        'scheduled_message',
        `${schedule.id}:${occurrenceAt.toISOString()}`,
      );
      if (!claim.won) {
        // A lost claim usually means another shard/tick owns this due minute —
        // but a claim whose holder CRASHED between the insert and the send
        // stays `claimed` forever, and every retry used to return here
        // silently. With max_sends the crashed claim may even have consumed
        // the schedule's only send without anything reaching Discord. Reclaim
        // via CAS when the claim is demonstrably stale: no healthy send holds
        // a claim for minutes (trySend's whole backoff is seconds).
        //
        // Chosen trade-off, stated: re-sending after a reclaim is
        // at-least-once. If the crash happened in the tiny window AFTER
        // channel.send resolved but BEFORE the completion write, the reclaimed
        // retry duplicates the message. A rare duplicate announcement beats a
        // schedule that silently exhausted itself delivering nothing.
        const existing = claim.occurrence;
        const claimedAtMs = Date.parse(String(existing.claimed_at ?? ''));
        const staleBefore = new Date(Date.now() - STALE_SCHEDULE_CLAIM_MS);
        const isStale = existing.status === 'claimed'
          && Number.isFinite(claimedAtMs)
          && claimedAtMs < staleBefore.getTime();
        if (!isStale) return;

        const { data: reclaimed, error: reclaimError } = await this.supabase.rpc(
          'reclaim_stale_discord_occurrence',
          {
            p_occurrence_id: existing.id,
            p_guild_id: this.guild.id,
            p_operation_kind: 'scheduled_message',
            p_expected_updated_at: existing.updated_at,
            p_stale_before: staleBefore.toISOString(),
          },
        );
        if (reclaimError || reclaimed !== true) {
          // Lost the CAS (a concurrent reclaimer won, or the row moved on).
          // Whoever won owns the delivery; nothing to do here.
          if (reclaimError) {
            log.error(`Failed to reclaim stale claim for schedule ${schedule.id}:`, {
              error: reclaimError.message,
            });
          }
          return;
        }
        log.warn(
          `Reclaimed stale scheduled-message claim for "${schedule.name}" `
          + `(due ${occurrenceAt.toISOString()}); the previous holder crashed before completing.`,
        );
        reclaimedStaleClaim = true;
        reclaimedResult =
          existing.result && typeof existing.result === 'object' && !Array.isArray(existing.result)
            ? existing.result as Record<string, unknown>
            : {};
        occurrenceId = existing.id;
        // The reclaim bumped updated_at; re-read the authoritative snapshot
        // so OUR counter claim passes the generation check. An unreadable
        // snapshot means ownership cannot be proven — do not send.
        const { data: freshOccurrence, error: freshError } = await this.supabase
          .from('discord_operation_occurrences')
          .select('updated_at')
          .eq('id', existing.id)
          .maybeSingle();
        if (freshError || typeof freshOccurrence?.updated_at !== 'string') {
          log.error(`Could not confirm reclaimed occurrence ownership for schedule ${schedule.id}:`, {
            error: freshError?.message ?? 'updated_at missing',
          });
          return;
        }
        occurrenceClaimUpdatedAt = freshOccurrence.updated_at;
      } else {
        occurrenceId = claim.occurrence.id;
        occurrenceClaimUpdatedAt = typeof claim.occurrence.updated_at === 'string'
          ? claim.occurrence.updated_at
          : null;
      }
    } catch (err) {
      log.error(`Failed to claim schedule ${schedule.id} occurrence:`, { error: String(err) });
      return;
    }

    // On a reclaimed stale claim, the crashed holder may have already committed
    // its counter increment (`last_sent_at` = this exact due minute). Re-running
    // the counter RPC would then consume a SECOND max_sends slot for one due
    // minute, so reconcile from the authoritative row first and only claim a
    // counter when this minute has not already been counted.
    let claimedSendCount: number | null | undefined;
    let counterAlreadyClaimed = false;
    if (reclaimedStaleClaim) {
      const { data: priorCounter, error: priorCounterError } = await this.supabase
        .from('scheduled_messages')
        .select('current_sends,last_sent_at')
        .eq('id', schedule.id)
        .eq('guild_id', this.guild.id)
        .maybeSingle();
      if (priorCounterError || !priorCounter) {
        // The read must AUTHORITATIVELY establish whether this minute was
        // already counted before any counter action. On a transient failure,
        // "never committed" and "read failed" are indistinguishable — running
        // the counter RPC on that guess double-counts a minute with capacity,
        // or terminally completes an exhausted one as max_sends_reached
        // without delivering. Leave the reclaimed claim in place: it goes
        // stale again and is retried on a later tick.
        log.error(
          `Could not reconcile reclaimed counter for schedule ${schedule.id}; retaining claim for retry:`,
          { error: priorCounterError?.message ?? 'schedule row missing' },
        );
        return;
      }
      const lastCountedMs = new Date(priorCounter.last_sent_at ?? 0).getTime();
      if (lastCountedMs === occurrenceAt.getTime()) {
        // The authoritative row names this exact minute: its slot is paid.
        counterAlreadyClaimed = true;
        claimedSendCount = priorCounter.current_sends;
      } else if (lastCountedMs > occurrenceAt.getTime()) {
        // A LATER minute is on the counter, which proves nothing about THIS
        // one: the crashed holder may have died before its counter call while
        // later minutes advanced last_sent_at past it. Only the occurrence's
        // own durable counterReserved flag (written after a successful
        // claim_scheduled_message_send) proves the slot was paid. Without it,
        // fall through to a normal counter claim — an exhausted schedule then
        // completes the occurrence as skipped, respecting max_sends instead
        // of delivering past the cap on a guess.
        if (reclaimedResult.counterReserved === true) {
          counterAlreadyClaimed = true;
          claimedSendCount = priorCounter.current_sends;
        }
      }
    }

    let counterError: { message: string } | null = null;
    if (!counterAlreadyClaimed) {
      const counterResult = await this.supabase.rpc(
        'claim_scheduled_message_send',
        {
          p_schedule_id: schedule.id,
          p_guild_id: this.guild.id,
          p_occurrence_at: occurrenceAt.toISOString(),
          // Atomic with the counter: the occurrence's counterReserved marker
          // commits in the SAME transaction as the slot, so a crash between
          // the two can no longer make a paid minute look unreserved.
          p_occurrence_id: occurrenceId,
          // Ownership: -1 comes back when this occurrence was reclaimed (or
          // settled) while we stalled — the minute is no longer ours.
          p_expected_updated_at: occurrenceClaimUpdatedAt,
        },
      );
      claimedSendCount = counterResult.data;
      counterError = counterResult.error;
    }
    if (claimedSendCount === -1) {
      log.warn(
        `Lost ownership of schedule ${schedule.id} occurrence ${occurrenceAt.toISOString()} `
        + 'before reserving its counter; the reclaiming worker owns the delivery.',
      );
      return;
    }
    if (counterError) {
      // The RPC may have committed before its response was lost. Reconcile the
      // authoritative schedule row; never release an ambiguous occurrence and
      // risk double-reserving or double-sending the due minute.
      const { data: reconciled, error: reconcileError } = await this.supabase
        .from('scheduled_messages')
        .select('current_sends,last_sent_at')
        .eq('id', schedule.id)
        .eq('guild_id', this.guild.id)
        .maybeSingle();
      log.error(`Failed to update schedule ${schedule.id} counters:`, counterError.message);
      if (
        reconcileError
        || !reconciled
        || new Date(reconciled.last_sent_at ?? 0).getTime() !== occurrenceAt.getTime()
      ) {
        log.error(`Could not reconcile schedule ${schedule.id} counter claim; retaining occurrence fence`, {
          error: reconcileError?.message ?? 'counter commit not confirmed',
        });
        return;
      }
      claimedSendCount = reconciled.current_sends;
    }
    if (typeof claimedSendCount !== 'number') {
      // Another occurrence consumed the final max_sends slot while this
      // occurrence was being claimed. Nothing reached Discord, but the fence
      // is terminal so this due minute does not churn forever.
      await completeDiscordOccurrence(
        this.supabase,
        occurrenceId,
        null,
        { skipped: 'max_sends_reached', dueAt: occurrenceAt.toISOString() },
      ).catch((err) => log.error('Failed to complete skipped scheduled occurrence:', {
        error: String(err),
      }));
      return;
    }

    // The reservation stamp bumped the occurrence generation; refresh the
    // baseline so the send-boundary recheck below compares against OUR
    // current claim, not the pre-reserve snapshot.
    {
      const { data: baseline, error: baselineError } = await this.supabase
        .from('discord_operation_occurrences')
        .select('status, updated_at')
        .eq('id', occurrenceId)
        .maybeSingle();
      if (
        baselineError
        || !baseline
        || baseline.status !== 'claimed'
        || typeof baseline.updated_at !== 'string'
      ) {
        log.warn(`Could not confirm occurrence ownership for schedule ${schedule.id} after reserving; skipping send`, {
          error: baselineError?.message ?? `status=${baseline?.status ?? 'missing'}`,
        });
        return;
      }
      occurrenceClaimUpdatedAt = baseline.updated_at;
    }

    let embed: EmbedBuilder | null = null;

    // Load embed config if referenced
    if (schedule.embed_config_id) {
      const { data } = await this.supabase
        .from('embed_configs')
        .select('*')
        .eq('id', schedule.embed_config_id)
        .eq('guild_id', this.guild.id)
        .maybeSingle();

      if (data) {
        const cfg = data as EmbedConfig;
        embed = new EmbedBuilder();
        if (cfg.title) embed.setTitle(replaceVariables(cfg.title, this.guild));
        if (cfg.description) embed.setDescription(replaceVariables(cfg.description, this.guild));
        if (cfg.color != null) embed.setColor(cfg.color);
        if (cfg.image_url) embed.setImage(cfg.image_url);
        if (cfg.thumbnail_url) embed.setThumbnail(cfg.thumbnail_url);
        if (cfg.footer_text) embed.setFooter({ text: replaceVariables(cfg.footer_text, this.guild), iconURL: cfg.footer_icon_url ?? undefined });
        if (cfg.author_name) embed.setAuthor({ name: replaceVariables(cfg.author_name, this.guild), url: cfg.author_url ?? undefined, iconURL: cfg.author_icon_url ?? undefined });
        if (cfg.include_timestamp) embed.setTimestamp();
        if (cfg.fields?.length) {
          for (const field of cfg.fields) {
            embed.addFields({
              name: replaceVariables(field.name, this.guild),
              value: replaceVariables(field.value, this.guild),
              inline: field.inline ?? false,
            });
          }
        }
      }
    }

    const content = schedule.message ? replaceVariables(schedule.message, this.guild) : undefined;

    // Send-boundary ownership recheck: reserving can predate the send by an
    // arbitrary stall (the embed-config query above, an event-loop pause).
    // If the stall crossed the stale threshold, recovery may have reclaimed
    // AND delivered this very minute — any generation movement or non-claimed
    // status means we no longer own the send. (A reclaim strictly between
    // this check and channel.send remains the documented at-least-once
    // corner, now nanoscopic instead of minutes wide.)
    {
      const { data: sendGate, error: sendGateError } = await this.supabase
        .from('discord_operation_occurrences')
        .select('status, updated_at')
        .eq('id', occurrenceId)
        .maybeSingle();
      if (
        sendGateError
        || !sendGate
        || sendGate.status !== 'claimed'
        || sendGate.updated_at !== occurrenceClaimUpdatedAt
      ) {
        log.warn(
          `Occurrence ownership moved before the send for schedule ${schedule.id} `
          + `(${occurrenceAt.toISOString()}); the current holder owns the delivery.`,
          { error: sendGateError?.message ?? null },
        );
        return;
      }
    }

    // Send the message. The occurrence was already claimed atomically above, so
    // the "never duplicate" contract holds regardless of send outcome. A single
    // transient Discord blip should not drop the occurrence, so retry with
    // bounded backoff; only after retries are exhausted do we mark the schedule
    // failed and alert the owner (matching the delivery-failed contract).
    const sent = await this.trySend(channel, {
      content: content || undefined,
      embeds: embed ? [embed] : undefined,
    });
    if (!sent.ok) {
      log.error(`Failed to send "${schedule.name}" after retries:`, sent.error);
      await failDiscordOccurrence(this.supabase, occurrenceId, sent.error).catch(() => {});
      await this.markFailed(schedule, `send_failed:${sent.error}`);
      return;
    }
    await completeDiscordOccurrence(
      this.supabase,
      occurrenceId,
      sent.messageId,
      { channelId: schedule.channel_id, dueAt: occurrenceAt.toISOString() },
    ).catch((err) => log.error('Failed to complete scheduled occurrence:', { error: String(err) }));

    this.eventBus.emit('scheduled_message.sent', this.guild.id, {
      scheduleId: schedule.id,
      name: schedule.name,
      channelId: schedule.channel_id,
      currentSends: claimedSendCount,
    });

    log.info(`Sent "${schedule.name}" to #${channel.name}`);
  }

  /**
   * Send with bounded exponential backoff. Returns ok:false with the last error
   * once all attempts are exhausted rather than throwing.
   */
  private async trySend(
    channel: TextChannel,
    payload: { content?: string; embeds?: EmbedBuilder[] },
  ): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const message = await channel.send(payload);
        return { ok: true, messageId: message.id };
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          const backoffMs = 500 * 2 ** (attempt - 1);
          log.warn(`Send attempt ${attempt} failed, retrying in ${backoffMs}ms:`, { error: String(err) });
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    return { ok: false, error: String(lastErr) };
  }

  /**
   * Mark a schedule failed, raise exactly one owner alert, and stop it firing.
   * The status transition is conditional (only from 'active') so concurrent
   * runner instances do not double-alert for the same failure.
   */
  private async markFailed(schedule: ScheduledMessage, reason: string): Promise<void> {
    const { data: transitioned, error } = await this.supabase
      .from('scheduled_messages')
      .update({ status: 'failed', last_error: reason, failed_at: new Date().toISOString() })
      .eq('id', schedule.id)
      .eq('status', 'active')
      .select('id');
    if (error) {
      log.error(`Failed to mark schedule ${schedule.id} failed:`, error.message);
      return;
    }
    if (!transitioned || transitioned.length === 0) {
      // Another instance already recorded the failure — do not double-alert.
      return;
    }

    this.eventBus.emit('scheduled_message.delivery_failed', this.guild.id, {
      scheduleId: schedule.id,
      name: schedule.name,
      channelId: schedule.channel_id,
      reason,
    });

    const channel = this.guild.channels.cache.get(schedule.channel_id);
    const channelName =
      channel && 'name' in channel ? `#${(channel as TextChannel).name}` : `channel ${schedule.channel_id}`;
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'scheduled_message_delivery_failed',
        severity: 'warning',
        title: `Scheduled message "${schedule.name}" could not be delivered`,
        message:
          `Scheduled message "${schedule.name}" could not post to ${channelName}: ${reason}. ` +
          `It has been paused; re-enable it after fixing the issue. Other schedules are unaffected.`,
        metadata: { schedule_id: schedule.id, channel_id: schedule.channel_id, reason },
        guild: this.guild,
      });
    } catch (alertErr) {
      log.error(
        'Failed to write scheduled-message delivery alert:',
        alertErr instanceof Error ? alertErr.message : alertErr,
      );
    }
  }

  /**
   * On startup, apply the per-schedule missed-run policy for occurrences that
   * were due while the stack was down. Only schedules with a baseline
   * (last_sent_at or start_date) can have a "missed" occurrence, so a brand-new
   * schedule never triggers a spurious catch-up.
   */
  private async handleMissedRuns(): Promise<void> {
    const now = new Date();
    for (const schedule of this.schedules) {
      try {
        const baselineStr = schedule.last_sent_at ?? schedule.start_date;
        if (!baselineStr) continue;
        const baseline = new Date(baselineStr);
        if (Number.isNaN(baseline.getTime())) continue;

        if (schedule.end_date && new Date(schedule.end_date) < now) continue;
        if (schedule.max_sends != null && schedule.current_sends >= schedule.max_sends) continue;

        const lastOcc = this.lastOccurrenceBefore(schedule, now);
        if (!lastOcc || lastOcc.getTime() <= baseline.getTime()) continue;

        if (schedule.missed_run_policy === 'send-latest') {
          // Fire exactly one catch-up now; sendMessage's atomic claim prevents a
          // double-post if another instance also recovers.
          await this.sendMessage(schedule, lastOcc);
        } else {
          // skip-missed (default): drop the occurrences but notify the owner once.
          await this.noticeMissed(schedule, baseline, lastOcc, now);
        }
      } catch (err) {
        log.error(`Missed-run handling failed for schedule ${schedule.id}:`, err);
      }
    }
  }

  /**
   * Notify the owner once that occurrences were dropped, then advance
   * last_sent_at so a later restart does not re-notify for the same miss. The
   * conditional update makes the notice single-winner across instances.
   */
  private async noticeMissed(
    schedule: ScheduledMessage,
    baseline: Date,
    lastOcc: Date,
    now: Date,
  ): Promise<void> {
    // Advance to the last MISSED occurrence, not the recovery time: stamping
    // "now" made the next legitimate tick look like a duplicate to the
    // ordinary send guard (a minutely schedule recovered at :30 lost its :00
    // of the following minute). lastOcc still prevents repeat notices.
    const { data: won, error } = await this.supabase
      .from('scheduled_messages')
      .update({ last_sent_at: lastOcc.toISOString() })
      .eq('id', schedule.id)
      .or(`last_sent_at.is.null,last_sent_at.lt.${lastOcc.toISOString()}`)
      .select('id');
    if (error || !won || won.length === 0) return;

    const missedCount = this.countOccurrences(schedule, baseline, now);
    try {
      const noticeResult = await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'scheduled_message_missed_occurrence',
        severity: 'info',
        title: `Scheduled message "${schedule.name}" missed ${missedCount} occurrence(s)`,
        message:
          `While I was offline, "${schedule.name}" missed ${missedCount} occurrence(s). ` +
          `Per your missed-run policy (skip-missed) nothing was sent late.`,
        metadata: { schedule_id: schedule.id, missed_count: missedCount },
        guild: this.guild,
      });
      if (
        !noticeResult.inserted
        && noticeResult.insertErrorCode !== '23505'
        && !noticeResult.delivered
      ) {
        // Neither delivery leg landed (raiseOwnerAlert reports, never
        // throws). The baseline advance above already won the single-winner
        // race, so ROLL IT BACK to the pre-advance value: a transient alert
        // outage must not permanently consume the missed notice — the next
        // restart re-detects the gap and retries.
        for (let attempt = 1; attempt <= 3; attempt++) {
          const { error: rollbackError } = await this.supabase
            .from('scheduled_messages')
            .update({ last_sent_at: baseline.toISOString() })
            .eq('id', schedule.id)
            .eq('last_sent_at', lastOcc.toISOString());
          if (!rollbackError) break;
          if (attempt === 3) {
            // The advanced baseline is durable and the notice never landed:
            // say so LOUDLY — this occurrence's notice is lost until an
            // operator intervenes, and silence here was the original bug.
            log.error('Missed-run notice failed AND its baseline rollback failed; the miss will not be re-announced:', {
              scheduleId: schedule.id,
              error: rollbackError.message,
            });
          } else {
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          }
        }
      }

    } catch (alertErr) {
      log.error(
        'Failed to write missed-occurrence notice:',
        alertErr instanceof Error ? alertErr.message : alertErr,
      );
    }
  }

  /**
   * Most recent fully-past cron occurrence strictly before `upto`, scanning back
   * a bounded window (2 days) to keep the startup cost constant.
   */
  private lastOccurrenceBefore(schedule: ScheduledMessage, upto: Date): Date | null {
    const maxLookbackMin = 2 * 24 * 60;
    const start = new Date(upto);
    start.setSeconds(0, 0);
    for (let i = 1; i <= maxLookbackMin; i++) {
      const cand = new Date(start.getTime() - i * 60_000);
      const local = dateInTimezone(cand, schedule.timezone || 'UTC');
      if (matchesCron(schedule.cron_expression, local)) return cand;
    }
    return null;
  }

  /**
   * Count cron occurrences strictly after `after` and at/before `until`,
   * capped at the same 2-day window.
   */
  private countOccurrences(schedule: ScheduledMessage, after: Date, until: Date): number {
    const maxLookbackMin = 2 * 24 * 60;
    const start = new Date(until);
    start.setSeconds(0, 0);
    let count = 0;
    for (let i = 1; i <= maxLookbackMin; i++) {
      const cand = new Date(start.getTime() - i * 60_000);
      if (cand.getTime() <= after.getTime()) break;
      const local = dateInTimezone(cand, schedule.timezone || 'UTC');
      if (matchesCron(schedule.cron_expression, local)) count++;
    }
    return count;
  }
}
