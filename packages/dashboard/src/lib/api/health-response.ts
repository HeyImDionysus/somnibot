import { NextResponse } from 'next/server';
import { RuntimeIdentitySchema, type RuntimeIdentity } from '@somnibot/shared';

const BOT_HEARTBEAT_KEY = 'somnibot:heartbeat:bot';
const BOT_HEARTBEAT_STALE_MS = 120_000; // 2 minutes — matches bot TTL

export interface HealthProbe {
  checkValkeyHealth: () => Promise<boolean>;
  readValkeyKey: (key: string) => Promise<string | null>;
}

type ConfigStatus = 'valid' | 'invalid' | 'unknown';

function getConfigStatus(): ConfigStatus {
  if (process.env.DASHBOARD_ENV_VALID === 'true') return 'valid';
  if (process.env.DASHBOARD_ENV_VALID === 'false') return 'invalid';
  return 'unknown';
}

async function getValkeyHealth(probe: HealthProbe | null): Promise<boolean> {
  if (!probe) return false;

  try {
    return await probe.checkValkeyHealth();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function buildHealthResponse(probe: HealthProbe | null = null) {
  const valkeyUp = await getValkeyHealth(probe);
  const configStatus = getConfigStatus();

  let botStatus: 'online' | 'offline' | 'unknown' = 'unknown';
  let botBootId: string | null = null;
  let botHeartbeatAt: number | null = null;
  let runtimeIdentity: RuntimeIdentity | null = null;
  if (valkeyUp) {
    try {
      const heartbeatRaw = await probe?.readValkeyKey(BOT_HEARTBEAT_KEY);
      if (heartbeatRaw) {
        const parsedHeartbeat: unknown = JSON.parse(heartbeatRaw);
        const heartbeat = isRecord(parsedHeartbeat) ? parsedHeartbeat : {};
        const timestamp = typeof heartbeat.timestamp === 'number' ? heartbeat.timestamp : 0;
        const age = Date.now() - timestamp;
        botStatus = age < BOT_HEARTBEAT_STALE_MS ? 'online' : 'offline';
        botBootId = typeof heartbeat.bootId === 'string' ? heartbeat.bootId : null;
        botHeartbeatAt = typeof heartbeat.timestamp === 'number' ? heartbeat.timestamp : null;
        const systemState = isRecord(heartbeat.systemState) ? heartbeat.systemState : null;
        const identity = RuntimeIdentitySchema.safeParse(systemState?.identity);
        runtimeIdentity = identity.success ? identity.data : null;
      } else {
        botStatus = 'offline';
      }
    } catch {
      botStatus = 'unknown';
    }
  }

  const isHealthy = valkeyUp && botStatus === 'online' && configStatus !== 'invalid';

  return NextResponse.json(
    {
      status: isHealthy ? 'healthy' : 'degraded',
      services: {
        config: configStatus,
        valkey: valkeyUp ? 'connected' : 'fallback',
        bot: botStatus,
      },
      botRuntime: {
        bootId: botBootId,
        heartbeatAt: botHeartbeatAt,
      },
      runtimeIdentity,
      timestamp: new Date().toISOString(),
    },
    { status: isHealthy ? 200 : 503 },
  );
}
