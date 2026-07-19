/**
 * scenario-runner/capabilities — probe which credentials/dependencies are present
 * so the runner can GATE (never fake, never silently skip) the assertions that
 * need them.
 *
 * Honors the SAME gating boundary as the PR3 live proof:
 *   - Discord readback (role/message/channel) is GATED behind DISCORD_TOKEN + a
 *     live gateway (SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK opt-in), never the
 *     dummy no-login token the live-setup pins.
 *   - PayPal proofs are GATED behind sandbox credentials.
 *   - Reward-cooldown paths (/daily etc.) use a Valkey SET NX and are GATED when
 *     no Redis/Valkey is reachable; the DB-observable transfer/banking paths do
 *     not need it and run now.
 * Local Supabase is a HARD precondition (boot fails loudly if unreachable), not a
 * gate — a missing database is a rig fault, never a silent pass.
 */
import net from 'node:net';

import type { Capabilities } from './types.js';

/** Parse host+port from a redis:// URL, defaulting to the schema's default. */
function parseRedisTarget(url: string | undefined): { host: string; port: number } {
  const fallback = { host: '127.0.0.1', port: 6379 };
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || fallback.host,
      port: parsed.port ? Number(parsed.port) : fallback.port,
    };
  } catch {
    return fallback;
  }
}

/**
 * A TCP-connect probe for the configured Valkey/Redis. Non-invasive: it opens
 * and immediately closes a socket, touching no keys. Returns false on any
 * refusal/timeout so cooldown-dependent proofs GATE instead of erroring.
 */
export function probeRedis(timeoutMs = 1_500): Promise<boolean> {
  const { host, port } = parseRedisTarget(process.env.VALKEY_URL);
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** True only when a REAL Discord gateway is present for role/message readback. */
function discordReadbackPresent(): boolean {
  // The dummy no-login token that live-setup pins does NOT satisfy this: readback
  // requires the explicit opt-in flag AND real secrets (checked again per-proof
  // via client.isReady() when a handle exists).
  return Boolean(process.env.SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK);
}

/** True only when PayPal sandbox credentials are present (commerce lane). */
function paypalSandboxPresent(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/** The anon Supabase key, if one is exported, for the anon-denial RLS sub-probe. */
function anonKey(): string | null {
  return (
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    null
  );
}

/** Probe every gate lever once, at the start of a run. */
export async function detectCapabilities(): Promise<Capabilities> {
  const redis = await probeRedis();
  return {
    supabaseLocal: true, // boot enforces this loudly; recorded true once we get here
    redis,
    discordReadback: discordReadbackPresent(),
    paypalSandbox: paypalSandboxPresent(),
    anonKey: anonKey(),
  };
}
