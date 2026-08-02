import { NextResponse } from 'next/server';

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

export async function buildHealthResponse(probe: HealthProbe | null = null) {
  const valkeyUp = await getValkeyHealth(probe);
  const configStatus = getConfigStatus();

  let botStatus: 'online' | 'offline' | 'unknown' = 'unknown';
  if (valkeyUp) {
    try {
      const heartbeatRaw = await probe?.readValkeyKey(BOT_HEARTBEAT_KEY);
      if (heartbeatRaw) {
        const heartbeat = JSON.parse(heartbeatRaw);
        const age = Date.now() - (heartbeat.timestamp ?? 0);
        botStatus = age < BOT_HEARTBEAT_STALE_MS ? 'online' : 'offline';
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
      timestamp: new Date().toISOString(),
    },
    { status: isHealthy ? 200 : 503 },
  );
}
