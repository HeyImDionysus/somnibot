import type { VpsDashboardHealthPayload } from './vps-health-verification.js';

export interface VpsBotBootProof {
  bootId: string;
  heartbeatAt: number;
}

function healthUrl(publicBaseUrl: string): string {
  const parsed = new URL(publicBaseUrl.trim());
  if (parsed.protocol !== 'https:') {
    throw new Error('VPS bot readiness requires a trusted HTTPS dashboard URL.');
  }
  parsed.pathname = '/api/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export async function readVpsBotBootProof(
  publicBaseUrl: string,
  options: { fetch?: typeof fetch } = {},
): Promise<VpsBotBootProof> {
  const response = await (options.fetch ?? fetch)(healthUrl(publicBaseUrl), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as VpsDashboardHealthPayload | null;
  const bootId = body?.botRuntime?.bootId;
  const heartbeatAt = body?.botRuntime?.heartbeatAt;
  if (!response.ok || body?.status !== 'healthy' || body.services?.bot !== 'online') {
    throw new Error('The VPS dashboard did not report a healthy Discord-connected bot.');
  }
  if (typeof bootId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new Error('The VPS dashboard did not report a valid bot boot identity.');
  }
  if (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt) || heartbeatAt <= 0) {
    throw new Error('The VPS dashboard did not report a valid bot heartbeat timestamp.');
  }
  return { bootId, heartbeatAt };
}

export async function waitForFreshVpsBotReady(
  publicBaseUrl: string,
  previous: VpsBotBootProof,
  options: {
    readProof?: () => Promise<VpsBotBootProof>;
    wait?: (delayMs: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
    requireNewBoot?: boolean;
  } = {},
): Promise<VpsBotBootProof> {
  const readProof = options.readProof ?? (() => readVpsBotBootProof(publicBaseUrl));
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 90_000);
  let sameBootHeartbeat: number | undefined;

  while (true) {
    try {
      const proof = await readProof();
      const isNewBoot = proof.bootId !== previous.bootId;
      if (isNewBoot && proof.heartbeatAt > previous.heartbeatAt) {
        return proof;
      }
      if (options.requireNewBoot === false
        && !isNewBoot
        && proof.heartbeatAt > previous.heartbeatAt) {
        if (sameBootHeartbeat === undefined) {
          // A single newer value may have been written before an ambiguous
          // stop and persisted in Valkey. Require the same live process to
          // advance it again after compensation starts.
          sameBootHeartbeat = proof.heartbeatAt;
        } else if (proof.heartbeatAt > sameBootHeartbeat) {
          return proof;
        }
      }
    } catch {
      // The dashboard and bot may still be starting. Retry to the bounded deadline.
    }
    if (now() >= deadline) {
      throw new Error(options.requireNewBoot === false
        ? 'The VPS did not report a fresh Discord-ready heartbeat after recovery.'
        : 'The restarted VPS did not report a fresh Discord-ready bot boot before the recovery deadline.');
    }
    await wait(1_000);
  }
}
