/**
 * Client IP derivation — rate limiting must not trust a client-supplied header.
 *
 * `x-forwarded-for.split(',')[0]` reads the value the CLIENT sent. The header is
 * append-only: a client that sends `X-Forwarded-For: 9.9.9.9` and connects to
 * Caddy produces `9.9.9.9, <real ip>`, so index 0 is the attacker's own string.
 * Rotating it defeated `licenseValidate` (30/min) and `licenseFailedAttempt`
 * (5/min) outright and poisoned the `ip_address` column the IP-mismatch fraud
 * signal reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getClientIp,
  getTrustedProxyHops,
  resetClientIpWarnings,
  TRUSTED_PROXY_HOPS_ENV,
  UNKNOWN_CLIENT_IP,
} from '@/lib/api/client-ip';

function req(headers: Record<string, string>) {
  return new Request('http://localhost/api/license/validate', { headers });
}

const REAL_CLIENT = '203.0.113.7';
const SPOOFED = '9.9.9.9';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env[TRUSTED_PROXY_HOPS_ENV];
  resetClientIpWarnings();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[TRUSTED_PROXY_HOPS_ENV];
  warnSpy.mockRestore();
});

describe('getTrustedProxyHops', () => {
  it('defaults to 1 — Caddy on the VPS, or the public tunnel locally', () => {
    expect(getTrustedProxyHops()).toBe(1);
  });

  it('honours an explicit stacked-proxy value', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    expect(getTrustedProxyHops()).toBe(2);
  });

  it('falls back to the default (and warns) on a nonsense value', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = 'yes-please';
    expect(getTrustedProxyHops()).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects a negative value rather than treating it as an offset', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '-3';
    expect(getTrustedProxyHops()).toBe(1);
  });
});

describe('getClientIp — one trusted hop (the shipped default)', () => {
  it('reads the address the proxy appended, not the one the client sent', () => {
    // Exactly what Caddy produces for a spoofing client.
    expect(getClientIp(req({ 'x-forwarded-for': `${SPOOFED}, ${REAL_CLIENT}` })))
      .toBe(REAL_CLIENT);
  });

  it('is not fooled by a long forged chain', () => {
    const forged = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'].join(', ');
    expect(getClientIp(req({ 'x-forwarded-for': `${forged}, ${REAL_CLIENT}` })))
      .toBe(REAL_CLIENT);
  });

  it('gives every rotation of the header the SAME bucket', () => {
    // The whole point: rotating the client-supplied part must not produce a
    // fresh rate-limit bucket.
    const buckets = new Set(
      ['a.a.a.a', 'b.b.b.b', 'c.c.c.c'].map((forged) =>
        getClientIp(req({ 'x-forwarded-for': `${forged}, ${REAL_CLIENT}` })),
      ),
    );
    expect(buckets).toEqual(new Set([REAL_CLIENT]));
  });

  it('handles the honest single-entry case', () => {
    expect(getClientIp(req({ 'x-forwarded-for': REAL_CLIENT }))).toBe(REAL_CLIENT);
  });

  it('tolerates whitespace and empty entries', () => {
    expect(getClientIp(req({ 'x-forwarded-for': ` ${SPOOFED} , , ${REAL_CLIENT}  ` })))
      .toBe(REAL_CLIENT);
  });
});

describe('getClientIp — stacked proxies', () => {
  it('counts two hops from the right when configured for two', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    // client -> Cloudflare -> Caddy: `spoof, realClient, cloudflare-edge`
    expect(getClientIp(req({ 'x-forwarded-for': `${SPOOFED}, ${REAL_CLIENT}, 10.0.0.5` })))
      .toBe(REAL_CLIENT);
  });

  it('falls back to the leftmost entry when the chain is shorter than the hop count', () => {
    // Every entry came from a trusted proxy, so the leftmost is trustworthy.
    process.env[TRUSTED_PROXY_HOPS_ENV] = '3';
    expect(getClientIp(req({ 'x-forwarded-for': REAL_CLIENT }))).toBe(REAL_CLIENT);
  });
});

describe('getClientIp — nothing trustworthy available', () => {
  it('does not trust any header when configured for zero hops', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '0';
    expect(getClientIp(req({ 'x-forwarded-for': SPOOFED }))).toBe(UNKNOWN_CLIENT_IP);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns unknown, and warns, when the proxy sends no X-Forwarded-For', () => {
    expect(getClientIp(req({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ignores x-real-ip — a proxy that does not set it lets a client value through', () => {
    expect(getClientIp(req({ 'x-real-ip': SPOOFED }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it('warns at most once per reason — this runs on every request', () => {
    getClientIp(req({}));
    getClientIp(req({}));
    getClientIp(req({}));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
