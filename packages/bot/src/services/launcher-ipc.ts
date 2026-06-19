import type { Client } from 'discord.js';

const LAUNCHER_IPC_INTERVAL_MS = 30_000;

type LauncherIpcProcess = Pick<NodeJS.Process, 'connected'> & {
  send?: (message: unknown) => boolean;
};

type LauncherIpcMessageType = 'ready' | 'heartbeat';

let launcherIpcTimer: ReturnType<typeof setInterval> | null = null;

export function buildLauncherIpcMessage(
  type: LauncherIpcMessageType,
  client: Pick<Client, 'guilds'>,
): Record<string, unknown> {
  return {
    type,
    timestamp: Date.now(),
    guildCount: client.guilds.cache.size,
  };
}

export function sendLauncherIpcMessage(
  type: LauncherIpcMessageType,
  client: Pick<Client, 'guilds'>,
  proc: LauncherIpcProcess = process,
): boolean {
  if (typeof proc.send !== 'function' || proc.connected === false) {
    return false;
  }

  try {
    proc.send(buildLauncherIpcMessage(type, client));
    return true;
  } catch {
    return false;
  }
}

export function startLauncherIpcHeartbeat(client: Pick<Client, 'guilds'>): void {
  if (!sendLauncherIpcMessage('ready', client)) {
    return;
  }

  stopLauncherIpcHeartbeat();
  launcherIpcTimer = setInterval(() => {
    sendLauncherIpcMessage('heartbeat', client);
  }, LAUNCHER_IPC_INTERVAL_MS);
  launcherIpcTimer.unref?.();
}

export function stopLauncherIpcHeartbeat(): void {
  if (launcherIpcTimer) {
    clearInterval(launcherIpcTimer);
    launcherIpcTimer = null;
  }
}
