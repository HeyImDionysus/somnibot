/**
 * Health Check HTTP Server — Exposes a minimal HTTP endpoint for Docker health checks.
 *
 * V5 Deep Dive Audit Remediation (Finding 9.1 — P2)
 *
 * Replaces the old no-op container health check with a real endpoint that
 * verifies Discord gateway connectivity and Valkey reachability.
 *
 * Port priority: HEALTH_PORT → PORT (hosted platform) → 3001 (default).
 * GET /health → 200 if healthy, 503 if unhealthy.
 *
 * Wave 3 setup gate: when the bot is idling because owner setup has not been
 * completed, it reports `status: 'awaiting_setup'` with HTTP 200 instead of
 * `unhealthy`/503. The process is intentionally alive and waiting — not
 * broken — so the launcher/process-manager can surface a clean waiting state
 * (and its health watcher will not treat the bot as failed and restart it).
 */
import { createServer, type Server } from 'node:http';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';

const log = createLogger('HealthServer');

let server: Server | null = null;

/**
 * When non-null, the bot is idling awaiting setup completion. The health
 * endpoint reports this state (HTTP 200) instead of running the Discord/Valkey
 * checks, so a bot that has not logged in (no token yet) is not reported as
 * unhealthy. `reason` is a short human-readable line for diagnostics.
 */
let awaitingSetup: { reason: string; dashboardUrl: string } | null = null;

/**
 * Mark the bot as idling in an "awaiting setup" health state. The next
 * /health request returns `{ status: 'awaiting_setup', ... }` with HTTP 200.
 * Pass null to clear (used once setup completes / normal boot resumes).
 */
export function setAwaitingSetup(state: { reason: string; dashboardUrl: string } | null): void {
  awaitingSetup = state;
}

/**
 * Start the health check HTTP server.
 *
 * Checks:
 * 1. Discord WebSocket is open (client.ws.status === 0)
 * 2. Valkey is reachable (PING → PONG)
 *
 * Returns the created Server so callers/tests can read the actually-bound port
 * via server.address() — set HEALTH_PORT=0 to request an OS-assigned ephemeral
 * port and avoid fixed-port contention between parallel tests. Production
 * callers ignore the return value.
 */
export function startHealthServer(client: SomniClient | null): Server {
  // HEALTH_PORT takes priority (explicit override), then PORT (some hosted
  // platforms inject this), then 3001 as a safe local default. A value of 0
  // requests an OS-assigned ephemeral port (read back via server.address()).
  const port = parseInt(process.env.HEALTH_PORT ?? process.env.PORT ?? '3001', 10);

  server = createServer(async (req, res) => {
    if (req.url !== '/health' || req.method !== 'GET') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // ── Awaiting setup: intentionally idle, not unhealthy ──
    // Reported first so a bot that never logged in (no token) is not judged
    // unhealthy for its Discord WS being closed. HTTP 200 keeps the launcher's
    // health watcher from treating the process as failed.
    if (awaitingSetup) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'awaiting_setup',
          reason: awaitingSetup.reason,
          dashboardUrl: awaitingSetup.dashboardUrl,
        }),
      );
      return;
    }

    const checks: Record<string, boolean> = {
      discord: false,
      valkey: false,
    };

    try {
      // Check Discord WebSocket status (0 = READY)
      checks.discord = client?.ws.status === 0;
    } catch {
      checks.discord = false;
    }

    try {
      // Check Valkey connectivity
      const pong = await client?.valkey.ping();
      checks.valkey = pong === 'PONG';
    } catch {
      checks.valkey = false;
    }

    const healthy = checks.discord && checks.valkey;

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', checks }));
  });

  // V11 Audit L-2: Set timeouts to prevent slow clients from holding
  // connections open indefinitely (slowloris-style resource exhaustion).
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  server.listen(port, '0.0.0.0', () => {
    // Log the ACTUAL bound port. With HEALTH_PORT=0 the requested port is 0 but
    // the OS assigns a real ephemeral port, which server.address() reports.
    const addr = server?.address();
    const boundPort = addr && typeof addr === 'object' ? addr.port : port;
    log.info(`Listening on :${boundPort}/health`);
  });

  server.on('error', (err) => {
    log.warn(`Failed to start health server: ${err.message}`);
  });

  return server;
}

/**
 * Stop the health check server (called during graceful shutdown).
 */
export function stopHealthServer(): void {
  if (server) {
    server.close();
    server = null;
    log.info('Stopped');
  }
}
