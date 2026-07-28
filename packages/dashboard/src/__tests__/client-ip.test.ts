/**
 * Client IP derivation — rate limiting must not trust a client-supplied header.
 *
 * `x-forwarded-for.split(',')[0]` trusts the value the client supplied when an
 * append-only proxy preserves a forged prefix. The shipped Caddy now removes
 * that ambiguity by emitting one policy-derived address; the dashboard still
 * enforces a right-counted boundary for custom proxy stacks.
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
  it('defaults to 1 — the shipped Caddy sends one canonical client address', () => {
    expect(getTrustedProxyHops()).toBe(1);
  });

  it('honours an explicit stacked-proxy value', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    expect(getTrustedProxyHops()).toBe(2);
  });

  it('fails closed (and warns) on a nonsense value', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = 'yes-please';
    expect(getTrustedProxyHops()).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails closed on a negative value rather than treating it as an offset', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '-3';
    expect(getTrustedProxyHops()).toBe(0);
  });

  it.each(['1.5', '1e2', '0x2', '9007199254740992'])(
    'accepts only plain decimal integers, not %s',
    (value) => {
      process.env[TRUSTED_PROXY_HOPS_ENV] = value;
      expect(getTrustedProxyHops()).toBe(0);
      expect(getClientIp(req({ 'x-forwarded-for': REAL_CLIENT })))
        .toBe(UNKNOWN_CLIENT_IP);
    },
  );
});

describe('getClientIp — one trusted hop (the shipped default)', () => {
  it('accepts the one canonical address emitted by the shipped Caddy', () => {
    expect(getClientIp(req({ 'x-forwarded-for': REAL_CLIENT }))).toBe(REAL_CLIENT);
  });

  it('reads the address the proxy appended, not the one the client sent', () => {
    // Defence in depth for a custom append-only proxy. The shipped Caddy
    // canonicalises this to one address before it reaches the dashboard.
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

  it('tolerates whitespace around valid entries', () => {
    expect(getClientIp(req({ 'x-forwarded-for': ` ${SPOOFED} , ${REAL_CLIENT}  ` })))
      .toBe(REAL_CLIENT);
  });

  it('fails closed on an empty chain entry because filtering it changes hop positions', () => {
    expect(getClientIp(req({ 'x-forwarded-for': `${SPOOFED}, , ${REAL_CLIENT}` })))
      .toBe(UNKNOWN_CLIENT_IP);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails closed when the selected value is not an IP address', () => {
    expect(getClientIp(req({ 'x-forwarded-for': 'attacker-controlled' })))
      .toBe(UNKNOWN_CLIENT_IP);
    expect(warnSpy).toHaveBeenCalled();
  });

  it.each(['203.0.113.7:443', '[2001:db8::7]', 'unknown'])(
    'rejects non-canonical address syntax: %s',
    (value) => {
      expect(getClientIp(req({ 'x-forwarded-for': value })))
        .toBe(UNKNOWN_CLIENT_IP);
      expect(warnSpy).toHaveBeenCalled();
    },
  );

  it('accepts a canonical IPv6 address', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '2001:db8::7' }))).toBe('2001:db8::7');
  });
});

describe('getClientIp — stacked proxies', () => {
  it('accepts exactly the configured number of valid entries', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    expect(getClientIp(req({ 'x-forwarded-for': `${REAL_CLIENT}, 10.0.0.5` })))
      .toBe(REAL_CLIENT);
  });

  it('counts two hops from the right when configured for two', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '2';
    // client -> Cloudflare -> Caddy: `spoof, realClient, cloudflare-edge`
    expect(getClientIp(req({ 'x-forwarded-for': `${SPOOFED}, ${REAL_CLIENT}, 10.0.0.5` })))
      .toBe(REAL_CLIENT);
  });

  it('fails closed when the chain is shorter than the configured hop count', () => {
    process.env[TRUSTED_PROXY_HOPS_ENV] = '3';
    expect(getClientIp(req({ 'x-forwarded-for': REAL_CLIENT })))
      .toBe(UNKNOWN_CLIENT_IP);
    expect(warnSpy).toHaveBeenCalled();
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
