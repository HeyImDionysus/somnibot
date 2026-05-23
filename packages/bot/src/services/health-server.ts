/**
 * Health Check HTTP Server — Exposes a minimal HTTP endpoint for Docker health checks.
 *
 * V5 Deep Dive Audit Remediation (Finding 9.1 — P2)
 *
 * Replaces the no-op `bun -e "process.exit(0)"` health check with a real
 * endpoint that verifies Discord gateway connectivity and Valkey reachability.
 *
 * Listens on port 3001 (configurable via HEALTH_PORT env var).
 * GET /health → 200 if healthy, 503 if unhealthy.
 */
import { createServer, type Server } from 'node:http';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';

const log = createLogger('HealthServer');

let server: Server | null = null;

/**
 * Start the health check HTTP server.
 *
 * Checks:
 * 1. Discord WebSocket is open (client.ws.status === 0)
 * 2. Valkey is reachable (PING → PONG)
 */
export function startHealthServer(client: SomniClient): void {
  const port = parseInt(process.env.HEALTH_PORT ?? '3001', 10);

  server = createServer(async (req, res) => {
    if (req.url !== '/health' || req.method !== 'GET') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const checks: Record<string, boolean> = {
      discord: false,
      valkey: false,
    };

    try {
      // Check Discord WebSocket status (0 = READY)
      checks.discord = client.ws.status === 0;
    } catch {
      checks.discord = false;
    }

    try {
      // Check Valkey connectivity
      const pong = await client.valkey.ping();
      checks.valkey = pong === 'PONG';
    } catch {
      checks.valkey = false;
    }

    const healthy = checks.discord && checks.valkey;

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', checks }));
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`Listening on :${port}/health`);
  });

  server.on('error', (err) => {
    log.warn(`Failed to start health server: ${err.message}`);
  });
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
