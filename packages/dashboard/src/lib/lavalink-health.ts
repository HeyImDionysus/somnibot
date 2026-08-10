export type LavalinkHealth =
  | { readonly state: 'connected' }
  | { readonly state: 'disconnected' }
  | { readonly state: 'unavailable' }
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

export function lavalinkHealthFromDiagnostics(diagnostics: unknown): LavalinkHealth {
  if (!isRecord(diagnostics) || diagnostics.success !== true || !isRecord(diagnostics.data)) {
    return UNKNOWN_LAVALINK_HEALTH;
  }

  const { lavalink } = diagnostics.data;
  if (!isRecord(lavalink) || !Array.isArray(lavalink.nodes)) {
    return UNKNOWN_LAVALINK_HEALTH;
  }

  if (lavalink.nodes.length === 0) {
    return { state: 'unavailable' };
  }

  for (const node of lavalink.nodes) {
    if (!isDiagnosticsLavalinkNode(node)) {
      return UNKNOWN_LAVALINK_HEALTH;
    }
    if (node.connected) {
      return { state: 'connected' };
    }
  }

  return { state: 'disconnected' };
}
