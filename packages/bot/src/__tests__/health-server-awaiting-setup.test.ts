/**
 * Health Server — "awaiting setup" state (Wave 3 setup gate).
 *
 * Starts the real HTTP server on an OS-assigned EPHEMERAL port and asserts that:
 *   - while awaiting setup, /health returns HTTP 200 with status
 *     'awaiting_setup' (NOT 503/unhealthy), even with no live Discord client;
 *   - once the awaiting-setup flag is cleared, /health resumes normal checks.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http, { type Server } from 'node:http';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  startHealthServer,
  stopHealthServer,
  setAwaitingSetup,
} from '../services/health-server.js';

// Bind an OS-assigned EPHEMERAL port (HEALTH_PORT=0) rather than a fixed one:
// under CI's full parallel run several test files start real health servers, and
// any fixed/overlapping port collides into EADDRINUSE. The failing bind only
// LOGS (does not reject), so a poll loop would silently time out with "health
// server did not start listening". Reading the real port back from
// server.address() removes all contention and makes the wait deterministic.
let boundPort = 0;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: boundPort, path }, (res) => {
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

/**
 * Start the server on an ephemeral port and resolve once it is actually
 * listening, capturing the OS-assigned port. Rejects (rather than silently
 * timing out) if the bind errors, so a real failure surfaces clearly.
 */
function startAndWait(client: any): Promise<void> {
  process.env.HEALTH_PORT = '0';
  const server: Server = startHealthServer(client);
  return new Promise((resolve, reject) => {
    const capture = () => {
      const addr = server.address();
      boundPort = addr && typeof addr === 'object' ? addr.port : 0;
      resolve();
    };
    server.once('error', reject);
    if (server.listening) capture();
    else server.once('listening', capture);
  });
}

describe('health server — awaiting setup', () => {
  afterEach(() => {
    setAwaitingSetup(null);
    stopHealthServer();
    delete process.env.HEALTH_PORT;
    boundPort = 0;
  });

  it('reports awaiting_setup with HTTP 200 and no live client', async () => {
    setAwaitingSetup({ reason: 'Setup not complete', dashboardUrl: 'http://localhost:3456' });

    // No Discord client at all in the not_started case.
    await startAndWait(null);

    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_setup');
    expect(res.body.dashboardUrl).toBe('http://localhost:3456');
  });

  it('resumes normal (unhealthy) checks once awaiting-setup is cleared', async () => {
    setAwaitingSetup({ reason: 'Setup not complete', dashboardUrl: 'http://localhost:3456' });

    // Client with a not-ready websocket and a failing valkey ping.
    const client = {
      ws: { status: 5 },
      valkey: { ping: vi.fn().mockRejectedValue(new Error('down')) },
    } as any;
    await startAndWait(client);

    const awaiting = await get('/health');
    expect(awaiting.body.status).toBe('awaiting_setup');

    setAwaitingSetup(null);
    const after = await get('/health');
    expect(after.status).toBe(503);
    expect(after.body.status).toBe('unhealthy');
  });
});
