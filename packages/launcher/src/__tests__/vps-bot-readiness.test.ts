import { describe, expect, it, vi } from 'vitest';
import { readVpsBotBootProof, waitForFreshVpsBotReady } from '../main/vps-bot-readiness.js';

function health(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('VPS bot boot readiness', () => {
  it('reads monitor-safe boot proof only from a healthy HTTPS VPS', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(health({
      status: 'healthy',
      services: { bot: 'online' },
      botRuntime: {
        bootId: '11111111-1111-4111-8111-111111111111',
        heartbeatAt: 2_000,
      },
    }));
    await expect(readVpsBotBootProof('https://bot.example.com', { fetch: fetchImpl })).resolves.toEqual({
      bootId: '11111111-1111-4111-8111-111111111111',
      heartbeatAt: 2_000,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://bot.example.com/api/health');
  });

  it('rejects stale health without a boot identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(health({
      status: 'healthy',
      services: { bot: 'online' },
      botRuntime: { heartbeatAt: 2_000 },
    }));
    await expect(readVpsBotBootProof('https://bot.example.com', { fetch: fetchImpl }))
      .rejects.toThrow('boot identity');
  });

  it('waits for a different boot identity and newer heartbeat', async () => {
    let now = 0;
    const proofs = [
      { bootId: '11111111-1111-4111-8111-111111111111', heartbeatAt: 2_000 },
      { bootId: '22222222-2222-4222-8222-222222222222', heartbeatAt: 2_000 },
      { bootId: '22222222-2222-4222-8222-222222222222', heartbeatAt: 2_001 },
    ];
    let index = 0;
    await expect(waitForFreshVpsBotReady('https://bot.example.com', proofs[0]!, {
      readProof: async () => proofs[Math.min(index++, proofs.length - 1)]!,
      now: () => now,
      wait: async () => { now += 1_000; },
    })).resolves.toEqual(proofs[2]);
    expect(index).toBe(3);
  });

  it('requires two advancing same-boot heartbeats for ambiguous-stop recovery', async () => {
    const previous = {
      bootId: '11111111-1111-4111-8111-111111111111',
      heartbeatAt: 2_000,
    };
    const proofs = [
      { ...previous, heartbeatAt: 2_001 },
      { ...previous, heartbeatAt: 2_001 },
      { ...previous, heartbeatAt: 2_002 },
    ];
    let index = 0;
    await expect(waitForFreshVpsBotReady('https://bot.example.com', previous, {
      readProof: async () => proofs[Math.min(index++, proofs.length - 1)]!,
      wait: async () => undefined,
      requireNewBoot: false,
    })).resolves.toEqual({ ...previous, heartbeatAt: 2_002 });
    expect(index).toBe(3);
  });
});
