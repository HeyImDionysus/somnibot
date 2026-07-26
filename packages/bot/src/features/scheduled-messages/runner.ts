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

const log = createLogger('ScheduledRunner');

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

  private async loadSchedules(): Promise<void> {
    const { data } = await this.supabase
      .from('scheduled_messages')
      .select('*')
      .eq('guild_id', this.guild.id)
      .eq('active', true)
      .eq('status', 'active')
      .limit(1000);

    this.schedules = (data ?? []) as ScheduledMessage[];
  }

  private async tick(): Promise<void> {
    // Reload schedules periodically (every tick for fresh data)
    await this.loadSchedules();

    const now = new Date();

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

        await this.sendMessage(schedule);
      } catch (err) {
        log.error(`Error for schedule ${schedule.id}:`, err);
      }
    }
  }

  private async sendMessage(schedule: ScheduledMessage): Promise<void> {
    const channel = this.guild.channels.cache.get(schedule.channel_id) as TextChannel | undefined;
    if (!channel || !channel.isTextBased()) {
      // The target channel is gone/non-text. Mark the schedule failed, alert the
      // owner once, and stop it re-firing every minute (loadSchedules filters on
      // status='active'). Previously this only log.warn()'d forever, silently.
      log.warn(`Channel ${schedule.channel_id} not found`);
      await this.markFailed(schedule, `channel_missing:${schedule.channel_id}`);
      return;
    }

    // Atomically CLAIM this occurrence before sending. The in-memory 55s check in
    // tick() is only a cheap pre-filter; two runner instances (multi-shard) or a
    // replayed tick can both pass it against the same stale last_sent_at and
    // double-post. The conditional UPDATE advances last_sent_at only when it is
    // still null or older than the 55s window, and Postgres serializes concurrent
    // writers on the row — so exactly one claim succeeds per occurrence. A writer
    // that updates zero rows lost the claim and must NOT send.
    const claimBefore = new Date(Date.now() - 55_000).toISOString();
    const { data: claimed, error: claimErr } = await this.supabase
      .from('scheduled_messages')
      .update({
        last_sent_at: new Date().toISOString(),
        current_sends: schedule.current_sends + 1,
      })
      .eq('id', schedule.id)
      .or(`last_sent_at.is.null,last_sent_at.lt.${claimBefore}`)
      .select('id');
    if (claimErr) {
      log.error(`Failed to claim schedule ${schedule.id}:`, claimErr.message);
      return;
    }
    if (!claimed || claimed.length === 0) {
      // Another instance/tick already claimed this occurrence — skip (no double-post).
      return;
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
      await this.markFailed(schedule, `send_failed:${sent.error}`);
      return;
    }

    this.eventBus.emit('scheduled_message.sent', this.guild.id, {
      scheduleId: schedule.id,
      name: schedule.name,
      channelId: schedule.channel_id,
      currentSends: schedule.current_sends + 1,
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
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await channel.send(payload);
        return { ok: true };
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
          await this.sendMessage(schedule);
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
    const { data: won, error } = await this.supabase
      .from('scheduled_messages')
      .update({ last_sent_at: now.toISOString() })
      .eq('id', schedule.id)
      .or(`last_sent_at.is.null,last_sent_at.lt.${lastOcc.toISOString()}`)
      .select('id');
    if (error || !won || won.length === 0) return;

    const missedCount = this.countOccurrences(schedule, baseline, now);
    try {
      await raiseOwnerAlert(this.supabase, this.guild.id, {
        alertType: 'scheduled_message_missed_occurrence',
        severity: 'info',
        title: `Scheduled message "${schedule.name}" missed ${missedCount} occurrence(s)`,
        message:
          `While I was offline, "${schedule.name}" missed ${missedCount} occurrence(s). ` +
          `Per your missed-run policy (skip-missed) nothing was sent late.`,
        metadata: { schedule_id: schedule.id, missed_count: missedCount },
        guild: this.guild,
      });
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
