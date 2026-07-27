/**
 * Plain-English guidance for the Diagnostics page.
 *
 * The page reports raw numbers — RSS in MB, gateway ping in ms, snapshot
 * staleness in seconds, dead-letter depth. Those mean something to a reader
 * who already knows what "good" looks like. To everyone else, "RSS 612 MB" is
 * a number with no verdict attached and no idea what to do about it.
 *
 * Each entry answers the three questions an owner actually has:
 *   what is this, what is normal, and what do I do if it isn't.
 *
 * Deliberately static content, not thresholds: the alerting numbers live in
 * `guild_config` (migration 20260727000000) and are the owner's to change. The
 * ranges quoted here describe typical healthy operation, so they are written
 * as guidance rather than as the values alerts fire on.
 */

export interface MetricGuidance {
  /** What the metric is, in one sentence, without jargon. */
  plainLanguage: string;
  /** What normal looks like. */
  healthyRange: string;
  /** What to do when it is outside that range. */
  nextStep: string;
}

export type GuidedMetric =
  | 'uptime'
  | 'memory'
  | 'wsPing'
  | 'valkey'
  | 'lavalink'
  | 'supabase'
  | 'commandLatency'
  | 'deadLetter'
  | 'snapshotStaleness';

export const DIAGNOSTICS_GUIDANCE: Record<GuidedMetric, MetricGuidance> = {
  uptime: {
    plainLanguage: 'How long the bot has been running without restarting.',
    healthyRange: 'Anything from minutes to weeks is fine — it only matters if it keeps resetting.',
    nextStep:
      'If this repeatedly drops back to a few minutes, the bot is crash-looping. '
      + 'Check the bot log for the error it prints just before restarting.',
  },
  memory: {
    plainLanguage: 'How much memory the bot is using right now.',
    healthyRange: 'Typically 150–500 MB, and roughly steady once the bot has warmed up.',
    nextStep:
      'A number that climbs and never comes back down usually means a restart is due. '
      + 'If it happens often, raise the memory alert threshold only after checking it is not still growing.',
  },
  wsPing: {
    plainLanguage: "The round-trip time to Discord's gateway — the bot's reaction speed.",
    healthyRange: 'Usually under 200 ms. Brief spikes are normal and harmless.',
    nextStep:
      'Sustained high ping is almost always Discord or your host\'s network, not the bot. '
      + 'Check Discord\'s status page before changing anything.',
  },
  valkey: {
    plainLanguage: 'The cache the bot uses for cooldowns, locks and short-lived state.',
    healthyRange: 'Connected.',
    nextStep:
      'Disconnected does not break the bot — it falls back to in-memory storage — but cooldowns '
      + 'reset when the bot restarts. Start the cache service to restore it.',
  },
  lavalink: {
    plainLanguage: 'The audio service that actually plays music.',
    healthyRange: 'At least one node connected, when music is enabled.',
    nextStep:
      'With no node connected, music commands decline politely and nothing else is affected. '
      + 'Start the audio service, or turn music off if you are not using it.',
  },
  supabase: {
    plainLanguage: 'The database holding every setting, balance and log.',
    healthyRange: 'Healthy.',
    nextStep:
      'This is the one outage that stops most features. Check the database service first — '
      + 'the bot degrades honestly rather than inventing data while it is unreachable.',
  },
  commandLatency: {
    plainLanguage: 'How long the bot takes to answer a slash command.',
    healthyRange: 'Usually under 1 second.',
    nextStep:
      'Slower responses are normally database latency. If it is consistent, check the database '
      + 'health above before suspecting the bot.',
  },
  deadLetter: {
    plainLanguage:
      'Jobs that failed every retry and were parked instead of being dropped — '
      + 'for example a receipt that could not be delivered.',
    healthyRange: 'Empty.',
    nextStep:
      'Anything parked here needs a human. Open the queue to see what failed and why; '
      + 'nothing is lost while it waits.',
  },
  snapshotStaleness: {
    plainLanguage: 'How long ago the bot last reported its health.',
    healthyRange: 'Under about two minutes — the bot reports on a one-minute cycle.',
    nextStep:
      'If this keeps growing, the numbers on this page are frozen and no longer describe reality. '
      + 'Confirm the bot is actually running before trusting anything above.',
  },
};

/** Guidance for one metric, or null when there is none. */
export function guidanceFor(metric: GuidedMetric): MetricGuidance | null {
  return DIAGNOSTICS_GUIDANCE[metric] ?? null;
}
