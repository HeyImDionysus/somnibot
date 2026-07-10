/**
 * Health Server — "awaiting setup" state (Wave 3 setup gate).
 *
 * Starts the real HTTP server on an ephemeral port and asserts that:
 *   - while awaiting setup, /health returns HTTP 200 with status
 *     'awaiting_setup' (NOT 503/unhealthy), even with no live Discord client;
 *   - once the awaiting-setup flag is cleared, /health resumes normal checks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  startHealthServer,
  stopHealthServer,
  setAwaitingSetup,
} from '../services/health-server.js';

// Distinct ports per test so a not-yet-closed server from a prior test cannot
// collide (EADDRINUSE) and leave a stale handler answering requests.
let PORT = 34987;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
  });
}

async function waitForListening(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await get('/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error('health server did not start listening');
}

describe('health server — awaiting setup', () => {
  beforeEach(() => {
    PORT += 1; // fresh port each test
  });

  afterEach(() => {
    setAwaitingSetup(null);
    stopHealthServer();
    delete process.env.HEALTH_PORT;
  });

  it('reports awaiting_setup with HTTP 200 and no live client', async () => {
    process.env.HEALTH_PORT = String(PORT);
    setAwaitingSetup({ reason: 'Setup not complete', dashboardUrl: 'http://localhost:3456' });

    // No Discord client at all in the not_started case.
    startHealthServer(null);
    await waitForListening();

    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_setup');
    expect(res.body.dashboardUrl).toBe('http://localhost:3456');
  });

  it('resumes normal (unhealthy) checks once awaiting-setup is cleared', async () => {
    process.env.HEALTH_PORT = String(PORT);
    setAwaitingSetup({ reason: 'Setup not complete', dashboardUrl: 'http://localhost:3456' });

    // Client with a not-ready websocket and a failing valkey ping.
    const client = {
      ws: { status: 5 },
      valkey: { ping: vi.fn().mockRejectedValue(new Error('down')) },
    } as any;
    startHealthServer(client);
    await waitForListening();

    const awaiting = await get('/health');
    expect(awaiting.body.status).toBe('awaiting_setup');

    setAwaitingSetup(null);
    const after = await get('/health');
    expect(after.status).toBe(503);
    expect(after.body.status).toBe('unhealthy');
  });
});
