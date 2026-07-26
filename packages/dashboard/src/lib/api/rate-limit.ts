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
let lastValkeyFailureAt = 0;
// V5 Audit §14.P2a: Ensure degradation warning logs once per degraded state,
// not on every request.
let _degradedWarningLogged = false;
const VALKEY_RETRY_AFTER_MS = 5_000;
let pendingCallbacks: Array<(reply: string | number | null) => void> = [];
let connectionWaiters: Array<(ready: boolean) => void> = [];

function markValkeyReady(): void {
  valkeyFailed = false;
  lastValkeyFailureAt = 0;
  _degradedWarningLogged = false;
}

function markValkeyFailed(): void {
  valkeyFailed = true;
  lastValkeyFailureAt = Date.now();
}

function parseRedisUrl(url: string): { host: string; port: number; username: string; password: string } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port) || 6379,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch {
    return { host: '127.0.0.1', port: 6379, username: '', password: '' };
  }
}

function encodeCommand(...args: (string | number)[]): string {
  let cmd = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    cmd += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return cmd;
}

function resolveConnectionWaiters(ready: boolean): void {
  for (const waiter of connectionWaiters) waiter(ready);
  connectionWaiters = [];
}

function rejectPendingCallbacks(): void {
  for (const cb of pendingCallbacks) cb(null);
  pendingCallbacks = [];
}

function failValkeySocket(sock: Socket | null): void {
  if (sock && valkeySocket !== sock) return;

  markValkeyFailed();
  valkeyReady = false;
  valkeySocket = null;
  resolveConnectionWaiters(false);
  rejectPendingCallbacks();
  sock?.destroy();
}

function waitForValkeyReady(timeoutMs = 1000): Promise<boolean> {
  if (valkeyReady) return Promise.resolve(true);
  if (!valkeySocket || valkeyFailed) return Promise.resolve(false);

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const waiter = (ready: boolean) => {
      clearTimeout(timeout);
      resolve(ready);
    };
    timeout = setTimeout(() => {
      const idx = connectionWaiters.indexOf(waiter);
      if (idx !== -1) connectionWaiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);

    connectionWaiters.push(waiter);
  });
}

async function ensureValkeyReady(): Promise<boolean> {
  if (ensureValkey() && valkeyReady) return true;
  if (valkeySocket && !valkeyReady) {
    return waitForValkeyReady();
  }
  return false;
}

function ensureValkey(): boolean {
  if (valkeyFailed) {
    if (Date.now() - lastValkeyFailureAt < VALKEY_RETRY_AFTER_MS) return false;
    valkeyFailed = false;
    valkeySocket = null;
  }
  if (valkeyReady) return true;
  if (valkeySocket) return false; // connecting

  const url = process.env.VALKEY_URL || process.env.REDIS_URL;
  if (!url) {
    markValkeyFailed();
    valkeyReady = false;
    valkeySocket = null;
    return false;
  }

  // Same rule as the bot's client (packages/bot/src/services/valkey.ts): a
  // password embedded in the URL wins, otherwise VALKEY_PASSWORD applies.
  // docker-compose starts Valkey with --requirepass from VALKEY_PASSWORD, so
  // reading only the URL meant the server had auth on and this client did not
  // — every command failed NOAUTH and rate limiting ran DEGRADED (per-instance,
  // limits halved) on any install with a generated password, i.e. all of them.
  const parsed = parseRedisUrl(url);
  const { host, port, username } = parsed;
  const password = parsed.password || process.env.VALKEY_PASSWORD || '';

  try {
    const sock = createConnection({ host, port, timeout: 2000 });
    valkeySocket = sock;

    let buffer = '';

    sock.on('connect', () => {
      if (!password) {
        sock.setTimeout(0);
        valkeyReady = true;
        markValkeyReady();
        resolveConnectionWaiters(true);
        return;
      }

      pendingCallbacks.push((reply) => {
        if (reply === 'OK') {
          sock.setTimeout(0);
          valkeyReady = true;
          markValkeyReady();
          resolveConnectionWaiters(true);
          return;
        }

        failValkeySocket(sock);
      });
      sock.write(username ? encodeCommand('AUTH', username, password) : encodeCommand('AUTH', password));
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
      failValkeySocket(sock);
    });

    sock.on('close', () => {
      if (valkeySocket !== sock) return;
      valkeyReady = false;
      valkeySocket = null;
      resolveConnectionWaiters(false);
      rejectPendingCallbacks();
    });

    sock.on('timeout', () => {
      failValkeySocket(sock);
    });
  } catch {
    failValkeySocket(valkeySocket);
  }

  return false;
}

function sendCommand(...args: (string | number)[]): Promise<string | number | null> {
  return new Promise((resolve) => {
    const socket = valkeySocket;
    if (!socket || !valkeyReady) {
      resolve(null);
      return;
    }

    const callback = resolve as (reply: string | number | null) => void;
    pendingCallbacks.push(callback);

    try {
      socket.write(encodeCommand(...args));
    } catch {
      failValkeySocket(socket);
      return;
    }

    // Safety timeout per command
    setTimeout(() => {
      const idx = pendingCallbacks.indexOf(callback);
      if (idx !== -1) {
        failValkeySocket(socket);
      }
    }, 1000);
  });
}

// ── In-memory fallback ──────────────────────────────────────

interface RateLimitEntry {
  hits: number;
  windowStart: number;
}

/**
 * V5 Audit §7.P3a — LRU cache for in-memory rate-limit fallback.
 *
 * Uses Map insertion-order semantics: accessing a key deletes and re-inserts
 * it so the least-recently-used entry is always first in iteration order.
 * Eviction removes the LRU entry (front of Map) instead of FIFO.
 */
class LRURateLimitStore {
  private map = new Map<string, RateLimitEntry>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): RateLimitEntry | undefined {
    const entry = this.map.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: RateLimitEntry): void {
    // If updating existing key, delete first to refresh position
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least-recently-used (first entry in Map)
      const lruKey = this.map.keys().next().value;
      if (lruKey !== undefined) this.map.delete(lruKey);
    }
    this.map.set(key, entry);
  }

  /** Iterate entries for cleanup (oldest first) */
  entries(): IterableIterator<[string, RateLimitEntry]> {
    return this.map.entries();
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

/**
 * V7 Audit §1.P3b — Maximum entries in the in-memory rate-limit store.
 * Prevents unbounded memory growth during Valkey outage under heavy load.
 */
const MEM_STORE_MAX_ENTRIES = 50_000;
const memStore = new LRURateLimitStore(MEM_STORE_MAX_ENTRIES);

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;

  // Evict expired entries (iterate oldest-first)
  for (const [key, entry] of memStore.entries()) {
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

  // V5 Audit [14.1]: In multi-instance deployments (serverless, hosted, or
  // multiple VPS replicas), in-memory fallback means each instance has its
  // own counter —
  // an attacker can bypass limits by distributing requests. Log a critical
  // warning and use a stricter in-memory budget (halved) to partially
  // compensate. For truly critical endpoints (license, portal auth), the
  // per-key and per-IP secondary checks still apply.
  // V5 Audit §14.P2a: Rate-limited degradation warning — log once per state change,
  // not on every single request (which would flood logs under load).
  if (!valkeyReady && !_degradedWarningLogged) {
    _degradedWarningLogged = true;
    const reason = valkeyFailed ? 'connection failed' : 'not ready';
    console.error(
      `[RateLimit] ⚠ DEGRADED: Valkey ${reason} — rate limiting is per-instance only. ` +
      'An attacker can bypass limits by distributing requests across instances. ' +
      'Limits halved as mitigation. Restore Valkey connectivity to resolve.',
    );
  }
  // Halve the budget when running in degraded mode to reduce blast radius
  const degradedMaxHits = Math.max(1, Math.floor(maxHits / 2));
  return checkRateLimitMemory(key, degradedMaxHits, windowMs);
}

/**
 * V5 Audit P3-3: Lightweight Valkey health probe.
 * Uses PING instead of consuming a rate-limit counter.
 * Returns true if Valkey is connected and responds to PING.
 */
export async function checkValkeyHealth(): Promise<boolean> {
  if (!await ensureValkeyReady()) return false;
  try {
    const reply = await sendCommand('PING');
    return reply === 'PONG';
  } catch {
    return false;
  }
}

/**
 * V10 Audit §7: Read a raw Valkey key value. Used by the health endpoint
 * to check bot heartbeat without exposing the internal sendCommand.
 */
export async function readValkeyKey(key: string): Promise<string | null> {
  if (!await ensureValkeyReady()) return null;
  try {
    const reply = await sendCommand('GET', key);
    return typeof reply === 'string' ? reply : null;
  } catch {
    return null;
  }
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

  /** Portal data: 30 reads per minute per token hash (V6 Audit §7.1) */
  portalData: (tokenHash: string) =>
    checkRateLimit(`portal:data:${tokenHash}`, 30, 60_000),

  /** V5 Audit P2-1: File downloads — 30 per 5 min per customer */
  portalDownload: (customerId: string) =>
    checkRateLimit(`portal:download:${customerId}`, 30, 300_000),

  /** V5 Audit P3-1: PayPal webhook — 60 per minute per IP */
  paypalWebhook: (ip: string) =>
    checkRateLimit(`paypal:webhook:${ip}`, 60, 60_000),

  /** V5 Audit P3-2: Auth callback — 10 per minute per IP */
  authCallback: (ip: string) =>
    checkRateLimit(`auth:callback:${ip}`, 10, 60_000),
} as const;
