/**
 * Rate limiter for public API endpoints (license validation, etc.).
 *
 * Phase B: Prevents brute-force and abuse on public license endpoints.
 * Uses a sliding window approach with configurable window size and max hits.
 *
 * Uses Valkey/Redis when available (shared state across restarts and instances)
 * via raw RESP protocol over TCP — zero external dependencies.
 * Falls back to in-memory store if Valkey is unavailable.
 */

import { createConnection, type Socket } from 'node:net';

// ── Lightweight Valkey client (raw RESP, zero deps) ─────────

let valkeySocket: Socket | null = null;
let valkeyReady = false;
let valkeyFailed = false;
let pendingCallbacks: Array<(reply: string | number | null) => void> = [];

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

function ensureValkey(): boolean {
  if (valkeyFailed) return false;
  if (valkeyReady) return true;
  if (valkeySocket) return false; // connecting

  const url = process.env.VALKEY_URL || process.env.REDIS_URL;
  if (!url) {
    valkeyFailed = true;
    return false;
  }

  const { host, port } = parseRedisUrl(url);

  try {
    const sock = createConnection({ host, port, timeout: 2000 });
    valkeySocket = sock;

    let buffer = '';

    sock.on('connect', () => {
      valkeyReady = true;
    });

    sock.on('data', (data) => {
      buffer += data.toString();
      // Process complete RESP replies (each ends with \r\n)
      while (buffer.includes('\r\n')) {
        const lineEnd = buffer.indexOf('\r\n');
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);

        const cb = pendingCallbacks.shift();
        if (!cb) continue;

        const prefix = line[0];
        const payload = line.slice(1);

        if (prefix === ':') {
          cb(Number(payload));
        } else if (prefix === '+') {
          cb(payload);
        } else if (prefix === '-') {
          cb(null);
        } else if (prefix === '$') {
          const len = Number(payload);
          if (len === -1) {
            cb(null);
          } else {
            // Bulk string: next chunk is the data + \r\n
            if (buffer.length >= len + 2) {
              const val = buffer.slice(0, len);
              buffer = buffer.slice(len + 2);
              cb(val);
            } else {
              // Incomplete bulk string — put the $<len> line and callback back
              // so they're re-processed when more TCP data arrives
              buffer = `$${payload}\r\n${buffer}`;
              pendingCallbacks.unshift(cb);
              break; // wait for more data
            }
          }
        } else {
          cb(null);
        }
      }
    });

    sock.on('error', () => {
      valkeyFailed = true;
      valkeyReady = false;
      valkeySocket = null;
      // Reject all pending
      for (const cb of pendingCallbacks) cb(null);
      pendingCallbacks = [];
    });

    sock.on('close', () => {
      valkeyReady = false;
      valkeySocket = null;
    });

    sock.on('timeout', () => {
      valkeyFailed = true;
      sock.destroy();
    });
  } catch {
    valkeyFailed = true;
  }

  return false;
}

function sendCommand(...args: (string | number)[]): Promise<string | number | null> {
  return new Promise((resolve) => {
    if (!valkeySocket || !valkeyReady) {
      resolve(null);
      return;
    }

    // Build RESP array
    let cmd = `*${args.length}\r\n`;
    for (const arg of args) {
      const s = String(arg);
      cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
    }

    pendingCallbacks.push(resolve);
    valkeySocket.write(cmd);

    // Safety timeout per command
    setTimeout(() => {
      const idx = pendingCallbacks.indexOf(resolve as never);
      if (idx !== -1) {
        pendingCallbacks.splice(idx, 1);
        resolve(null);
      }
    }, 1000);
  });
}

// ── In-memory fallback ──────────────────────────────────────

interface RateLimitEntry {
  hits: number;
  windowStart: number;
}

const memStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  for (const [key, entry] of memStore) {
    if (now - entry.windowStart > windowMs * 2) {
      memStore.delete(key);
    }
  }
}

function checkRateLimitMemory(
  key: string,
  maxHits: number,
  windowMs: number,
): { limited: boolean; remaining: number; retryAfterMs: number } {
  cleanup(windowMs);

  const now = Date.now();
  const entry = memStore.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    memStore.set(key, { hits: 1, windowStart: now });
    return { limited: false, remaining: maxHits - 1, retryAfterMs: 0 };
  }

  entry.hits++;

  if (entry.hits > maxHits) {
    const retryAfterMs = windowMs - (now - entry.windowStart);
    return { limited: true, remaining: 0, retryAfterMs };
  }

  return { limited: false, remaining: maxHits - entry.hits, retryAfterMs: 0 };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Check if a request should be rate-limited.
 *
 * @param key - Unique identifier (e.g., IP address, key hash, or combination)
 * @param maxHits - Maximum requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns { limited: boolean, remaining: number, retryAfterMs: number }
 */
export async function checkRateLimit(
  key: string,
  maxHits: number,
  windowMs: number,
): Promise<{ limited: boolean; remaining: number; retryAfterMs: number }> {
  // Try Valkey first
  if (ensureValkey() && valkeyReady) {
    try {
      const valkeyKey = `ratelimit:${key}`;
      const windowSec = Math.ceil(windowMs / 1000);

      const hits = await sendCommand('INCR', valkeyKey);
      if (typeof hits === 'number') {
        if (hits === 1) {
          await sendCommand('EXPIRE', valkeyKey, windowSec);
        }

        if (hits > maxHits) {
          const ttl = await sendCommand('TTL', valkeyKey);
          const retryMs = typeof ttl === 'number' && ttl > 0 ? ttl * 1000 : windowMs;
          return { limited: true, remaining: 0, retryAfterMs: retryMs };
        }

        return { limited: false, remaining: maxHits - hits, retryAfterMs: 0 };
      }
    } catch {
      // Fall through to memory
    }
  }

  // V5 Audit [14.1]: In multi-instance deployments (Vercel, multiple Railway
  // replicas), in-memory fallback means each instance has its own counter —
  // an attacker can bypass limits by distributing requests. Log a critical
  // warning and use a stricter in-memory budget (halved) to partially
  // compensate. For truly critical endpoints (license, portal auth), the
  // per-key and per-IP secondary checks still apply.
  if (!valkeyReady && !valkeyFailed) {
    console.warn('[RateLimit] CRITICAL: Valkey not ready — using in-memory fallback with reduced limits (not shared across instances)');
  } else if (valkeyFailed) {
    console.warn('[RateLimit] CRITICAL: Valkey connection failed — using in-memory fallback with reduced limits (not shared across instances)');
  }
  // Halve the budget when running in degraded mode to reduce blast radius
  const degradedMaxHits = Math.max(1, Math.floor(maxHits / 2));
  return checkRateLimitMemory(key, degradedMaxHits, windowMs);
}

/**
 * Pre-configured rate limits for different endpoint types.
 */
export const rateLimits = {
  /** License validation: 30 requests per minute per IP */
  licenseValidate: (ip: string) =>
    checkRateLimit(`license:validate:${ip}`, 30, 60_000),

  /** License heartbeat: 20 per minute per IP */
  licenseHeartbeat: (ip: string) =>
    checkRateLimit(`license:heartbeat:${ip}`, 20, 60_000),

  /** License deactivation: 10 per minute per IP */
  licenseDeactivate: (ip: string) =>
    checkRateLimit(`license:deactivate:${ip}`, 10, 60_000),

  /** Failed key attempts: 5 per minute per IP (stricter) */
  licenseFailedAttempt: (ip: string) =>
    checkRateLimit(`license:failed:${ip}`, 5, 60_000),

  /** Per-key rate limit: 60 requests per minute per key hash */
  licensePerKey: (keyHash: string) =>
    checkRateLimit(`license:key:${keyHash}`, 60, 60_000),

  /** Portal auth: 10 login attempts per 5 minutes per IP */
  portalAuth: (ip: string) =>
    checkRateLimit(`portal:auth:${ip}`, 10, 300_000),
} as const;
