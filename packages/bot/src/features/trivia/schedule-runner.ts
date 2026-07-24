/**
 * TriviaScheduleRunner — owner-scheduled ("hosted") trivia cadence.
 *
 * The catalog contracts a hosted cadence: with a schedule channel configured,
 * trivia rounds post automatically on a fixed interval and resolve/pay exactly
 * like a `/trivia start` round — and this piece toggles independently of
 * on-command trivia. Before this module there were no schedule columns and no
 * scheduler, so the whole hosted cadence was GATED in the domain proof.
 *
 * The runner mirrors the scheduled-messages runner: a minute-aligned tick reads
 * the live guild_config, and when the interval has elapsed it ATOMICALLY claims
 * the occurrence (a conditional UPDATE of economy_trivia_schedule_last_run_at)
 * before opening the round. The claim makes "exactly one hosted round per
 * interval" hold across ticks, restarts, and multiple shards — a replayed tick
 * or a second instance that reads the same stale last-run loses the claim and
 * never double-posts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Guild, TextChannel } from 'discord.js';
import { createLogger } from '@somnibot/shared';
import type { TriviaDifficulty } from '@somnibot/shared';
import type { TriviaManager } from './trivia-manager.js';

const log = createLogger('TriviaSchedule');

const TICK_MS = 60_000;

interface TriviaScheduleConfig {
  economy_trivia_enabled: boolean;
  economy_trivia_schedule_enabled: boolean;
  economy_trivia_schedule_interval_minutes: number;
  economy_trivia_schedule_channel_id: string | null;
  economy_trivia_schedule_category: string | null;
  economy_trivia_schedule_difficulty: string | null;
  economy_trivia_schedule_last_run_at: string | null;
}

const SCHEDULE_COLUMNS =
  'economy_trivia_enabled, ' +
  'economy_trivia_schedule_enabled, ' +
  'economy_trivia_schedule_interval_minutes, ' +
  'economy_trivia_schedule_channel_id, ' +
  'economy_trivia_schedule_category, ' +
  'economy_trivia_schedule_difficulty, ' +
  'economy_trivia_schedule_last_run_at';

export class TriviaScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private aligner: NodeJS.Timeout | null = null;
  private stopped = false;
  /** One owner alert per process while the configured channel is unresolved. */
  private channelMissingAlerted = false;

  constructor(
    private guild: Guild,
    private supabase: SupabaseClient,
    private trivia: TriviaManager,
  ) {}

  start(): void {
    this.stopped = false;
    // Align the first tick to the next minute boundary, then run every minute —
    // identical cadence to the scheduled-messages runner so the two schedulers
    // evaluate on the same wall-clock rhythm.
    const msToNextMinute = TICK_MS - (Date.now() % TICK_MS);
    this.aligner = setTimeout(() => {
      if (this.stopped) return;
      this.tick().catch((err) => log.error('Tick error:', { error: String(err) }));
      this.timer = setInterval(() => {
        this.tick().catch((err) => log.error('Tick error:', { error: String(err) }));
      }, TICK_MS);
    }, msToNextMinute);
    log.info(`Started for guild ${this.guild.id}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.aligner) {
      clearTimeout(this.aligner);
      this.aligner = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loadConfig(): Promise<TriviaScheduleConfig | null> {
    const { data, error } = await this.supabase
      .from('guild_config')
      .select(SCHEDULE_COLUMNS)
      .eq('guild_id', this.guild.id)
      .maybeSingle();
    if (error) {
      log.warn('schedule config read failed:', error.message);
      return null;
    }
    return (data as unknown as TriviaScheduleConfig | null) ?? null;
  }

  /**
   * One evaluation of the hosted cadence. Reads the live config (so a dashboard
   * toggle takes effect on the next minute with no restart), skips unless BOTH
   * the trivia master switch and the schedule switch are on and a channel is set,
   * then seeds the baseline (first observation) or claims-and-posts a due round.
   */
  async tick(): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg) return;

    // Independent toggles: the master trivia switch gates ALL trivia; the schedule
    // switch gates ONLY the hosted cadence, so disabling the schedule leaves
    // on-command /trivia untouched (and vice-versa).
    if (!cfg.economy_trivia_enabled || !cfg.economy_trivia_schedule_enabled) return;

    const channelId = cfg.economy_trivia_schedule_channel_id;
    if (!channelId) return;

    const intervalMin = this.normalizeInterval(cfg.economy_trivia_schedule_interval_minutes);
    const now = new Date();

    // First observation of an enabled schedule (or right after the column was
    // added): seed the baseline WITHOUT posting so neither enabling the schedule
    // nor a bot restart immediately fires a round — the first hosted round posts
    // one full interval later. Conditional on last_run still being null so two
    // instances cannot both seed.
    if (!cfg.economy_trivia_schedule_last_run_at) {
      await this.claimSeed(now);
      return;
    }

    const last = new Date(cfg.economy_trivia_schedule_last_run_at);
    if (Number.isNaN(last.getTime())) {
      // Corrupt baseline — reseed rather than spin.
      await this.claimSeed(now);
      return;
    }

    const dueAt = last.getTime() + intervalMin * 60_000;
    if (now.getTime() < dueAt) return; // not due yet — cheap pre-filter

    // Atomically claim the occurrence: advance last_run_at only while it is still
    // at/behind the interval threshold. Postgres serializes concurrent writers on
    // the row, so exactly one tick/instance advances it and the losers update zero
    // rows and MUST NOT post.
    const claimed = await this.claimDue(now, intervalMin);
    if (!claimed) return;

    const channel = this.resolveChannel(channelId);
    if (!channel) {
      await this.alertChannelMissing(channelId);
      return;
    }
    this.channelMissingAlerted = false;

    const category = cfg.economy_trivia_schedule_category ?? undefined;
    const difficulty = this.normalizeDifficulty(cfg.economy_trivia_schedule_difficulty);

    const result = await this.trivia.startScheduledRound(this.guild, channel, category, difficulty);
    if (result.started) {
      log.info(`Hosted trivia round posted to #${channel.name} in guild ${this.guild.id}`);
    } else {
      // An expected skip (a round is already live, or the breather is open). The
      // occurrence was already claimed, so the next round fires on the next
      // interval — no retry storm.
      log.info(`Hosted trivia round skipped (${result.reason}) in guild ${this.guild.id}`);
    }
  }

  private normalizeInterval(value: number | null | undefined): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 5) return 60;
    if (n > 10080) return 10080;
    return Math.floor(n);
  }

  private normalizeDifficulty(value: string | null | undefined): TriviaDifficulty | undefined {
    return value === 'easy' || value === 'medium' || value === 'hard' ? value : undefined;
  }

  private resolveChannel(channelId: string): TextChannel | null {
    const channel = this.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return channel as TextChannel;
  }

  /** Seed the cadence baseline; conditional on last_run still null (single-winner). */
  private async claimSeed(now: Date): Promise<void> {
    const { error } = await this.supabase
      .from('guild_config')
      .update({ economy_trivia_schedule_last_run_at: now.toISOString() })
      .eq('guild_id', this.guild.id)
      .is('economy_trivia_schedule_last_run_at', null)
      .select('guild_id');
    if (error) log.warn('schedule baseline seed failed:', error.message);
  }

  /**
   * Claim a due occurrence: set last_run_at = now only while it is still at/behind
   * the interval threshold. Returns true iff THIS caller won the claim (updated a
   * row) — the caller must only post when this is true.
   */
  private async claimDue(now: Date, intervalMin: number): Promise<boolean> {
    const threshold = new Date(now.getTime() - intervalMin * 60_000).toISOString();
    const { data, error } = await this.supabase
      .from('guild_config')
      .update({ economy_trivia_schedule_last_run_at: now.toISOString() })
      .eq('guild_id', this.guild.id)
      .lte('economy_trivia_schedule_last_run_at', threshold)
      .select('guild_id');
    if (error) {
      log.warn('schedule occurrence claim failed:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Raise exactly one owner alert (per process) when the configured schedule
   * channel is missing/non-text, so a mis-set channel is surfaced instead of
   * silently dropping every hosted round. Re-arms once the channel resolves again.
   */
  private async alertChannelMissing(channelId: string): Promise<void> {
    log.warn(`Hosted trivia channel ${channelId} not found in guild ${this.guild.id}`);
    if (this.channelMissingAlerted) return;
    this.channelMissingAlerted = true;
    try {
      await this.supabase.from('alerts').insert({
        guild_id: this.guild.id,
        alert_type: 'trivia_schedule_channel_missing',
        severity: 'warning',
        title: 'Hosted trivia channel is unavailable',
        message:
          `The channel configured for hosted (scheduled) trivia (${channelId}) is missing or is not a text ` +
          `channel, so automatic rounds cannot post. Pick a valid channel on the trivia settings page; ` +
          `on-command /trivia is unaffected.`,
        metadata: { channel_id: channelId },
      });
    } catch (alertErr) {
      log.error(
        'Failed to write hosted-trivia channel-missing alert:',
        alertErr instanceof Error ? alertErr.message : alertErr,
      );
    }
  }
}
