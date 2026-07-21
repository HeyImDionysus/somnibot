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
  ) {}

  async start(): Promise<void> {
    await this.loadSchedules();

    if (this.schedules.length === 0) {
      log.info('No active schedules');
    }

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
      log.warn(`Channel ${schedule.channel_id} not found`);
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
    // tracking (last_sent_at / current_sends) is persisted whether or not the
    // send succeeds — a failed send is not retried this window (at-most-once),
    // which is the correct trade for the "never duplicate" contract.
    await channel.send({
      content: content || undefined,
      embeds: embed ? [embed] : undefined,
    });

    log.info(`Sent "${schedule.name}" to #${channel.name}`);
  }
}
