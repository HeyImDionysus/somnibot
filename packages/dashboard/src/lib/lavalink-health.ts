export const LAVALINK_SNAPSHOT_STALE_SECONDS = 120;

type ObservedLavalinkHealth = {
  readonly snapshotAt: string;
};

export type LavalinkHealth =
  | ({ readonly state: 'connected' } & ObservedLavalinkHealth)
  | ({ readonly state: 'disconnected' } & ObservedLavalinkHealth)
  | ({ readonly state: 'unavailable' } & ObservedLavalinkHealth)
  | ({ readonly state: 'stale' } & ObservedLavalinkHealth)
  | { readonly state: 'unknown' };

export const UNKNOWN_LAVALINK_HEALTH = { state: 'unknown' } as const satisfies LavalinkHealth;

interface DiagnosticsLavalinkNode {
  readonly connected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnosticsLavalinkNode(value: unknown): value is DiagnosticsLavalinkNode {
  return isRecord(value) && typeof value.connected === 'boolean';
}

function healthSnapshotIsStale(bot: Record<string, unknown>, snapshotAt: string, nowMs: number): boolean | null {
  const { staleSecs } = bot;
  const snapshotMs = Date.parse(snapshotAt);
  if (typeof staleSecs !== 'number' || !Number.isFinite(staleSecs) || staleSecs < 0 || !Number.isFinite(snapshotMs)) {
    return null;
  }
  const snapshotAgeSeconds = (nowMs - snapshotMs) / 1000;
  if (snapshotAgeSeconds < -30) return null;
  return staleSecs >= LAVALINK_SNAPSHOT_STALE_SECONDS
    || snapshotAgeSeconds >= LAVALINK_SNAPSHOT_STALE_SECONDS;
}

export function lavalinkHealthFromDiagnostics(diagnostics: unknown, nowMs = Date.now()): LavalinkHealth {
  if (!isRecord(diagnostics) || diagnostics.success !== true || !isRecord(diagnostics.data)) {
    return UNKNOWN_LAVALINK_HEALTH;
  }

  const { bot, lavalink } = diagnostics.data;
  if (!isRecord(bot) || typeof bot.snapshotAt !== 'string' || !isRecord(lavalink) || !Array.isArray(lavalink.nodes)) {
    return UNKNOWN_LAVALINK_HEALTH;
  }

  const stale = healthSnapshotIsStale(bot, bot.snapshotAt, nowMs);
  if (stale === null) return UNKNOWN_LAVALINK_HEALTH;
  if (stale) return { state: 'stale', snapshotAt: bot.snapshotAt };
  if (lavalink.nodes.length === 0) return { state: 'unavailable', snapshotAt: bot.snapshotAt };

  for (const node of lavalink.nodes) {
    if (!isDiagnosticsLavalinkNode(node)) return UNKNOWN_LAVALINK_HEALTH;
    if (node.connected) return { state: 'connected', snapshotAt: bot.snapshotAt };
  }

  return { state: 'disconnected', snapshotAt: bot.snapshotAt };
}
