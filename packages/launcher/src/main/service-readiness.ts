import { createConnection } from 'node:net';

export function probeValkeyReady(
  host = '127.0.0.1',
  port = 6379,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.on('data', (data) => finish(data.toString('utf8').startsWith('+PONG')));
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
  });
}

export async function probeLavalinkReady(
  url = 'http://127.0.0.1:2333/version',
  timeoutMs = 1_000,
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return [200, 401, 403].includes(response.status);
  } catch {
    return false;
  }
}

export async function waitForServiceReady(
  probe: () => Promise<boolean>,
  isCurrent: () => boolean,
  timeoutMs: number,
  pollIntervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isCurrent() && Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}
