import { isIP } from 'node:net';

/**
 * Client IP derivation for rate limiting and forensic logging.
 *
 * The shipped Caddy applies an explicit trusted-proxy policy, derives
 * `{client_ip}`, and overwrites `X-Forwarded-For` with that one canonical
 * address. Production Compose explicitly configures one trusted hop.
 * Unconfigured deployments trust no forwarding headers.
 *
 * Custom append-only proxy stacks remain supported: with `N` trusted proxies,
 * the client IP is the `N`-th comma-separated value counted from the right.
 * Values to its left are attacker-controlled. Invalid configuration, empty
 * entries, a chain shorter than `N`, or a selected value that is not IPv4/IPv6
 * all fail closed to the shared `unknown` bucket.
 */

/** Env var naming the number of reverse-proxy hops in front of the dashboard. */
export const TRUSTED_PROXY_HOPS_ENV = 'SOMNIBOT_TRUSTED_PROXY_HOPS';

/** Fail closed unless a verified proxy deployment explicitly opts in. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/** Bucket used when no trustworthy client address can be derived. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/** Warn at most once per process per reason — this runs on every request. */
const warned = new Set<string>();
function warnOnce(reason: string, message: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(`[client-ip] ${message}`);
}

/** Reset the warn-once memo. Tests only. */
export function resetClientIpWarnings(): void {
  warned.clear();
}

/**
 * Number of proxy hops to trust, from `SOMNIBOT_TRUSTED_PROXY_HOPS`.
 *
 * `0` means no forwarding header can be trusted, so every caller shares one
 * bucket. This is the safe default for direct or unverified deployments and is
 * warned about loudly when a caller needs an address.
 */
export function getTrustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;

  const normalized = raw.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    warnOnce(
      'bad-hops',
      `${TRUSTED_PROXY_HOPS_ENV}="${raw}" is not a non-negative integer; `
      + 'refusing to trust proxy headers until it is corrected.',
    );
    return 0;
  }
  return parsed;
}

/**
 * Derive the client IP, trusting only the proxy hops the deployment has.
 *
 * `X-Forwarded-For` is the only header consulted. `X-Real-IP` is deliberately
 * NOT used as a fallback: a proxy that sets it overwrites any client value, but
 * a proxy that does not set it lets a client-supplied one through untouched,
 * and we cannot tell those apart from inside the app. Caddy does not set it, so
 * honouring it would leave the bypass open in the deployment we actually ship.
 *
 * @returns the client address, or {@link UNKNOWN_CLIENT_IP} when none can be
 *          trusted. Callers use this as a rate-limit bucket key and as the
 *          `ip_address` column on `license_validations`.
 */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  const hops = getTrustedProxyHops();

  if (hops <= 0) {
    warnOnce(
      'no-hops',
      `${TRUSTED_PROXY_HOPS_ENV}=0 — no proxy headers are trusted, so all callers `
      + 'share a single rate-limit bucket. Configure a positive value only when '
      + 'the deployment proves that its proxy sanitizes or appends the header '
      + '(production Compose explicitly sets 1 for the shipped Caddy).',
    );
    return UNKNOWN_CLIENT_IP;
  }

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded === null || forwarded.trim() === '') {
    warnOnce(
      'no-xff',
      'No X-Forwarded-For header. Either the dashboard is reached directly (set '
      + `${TRUSTED_PROXY_HOPS_ENV}=0) or the reverse proxy is not forwarding it. `
      + 'Per-IP rate limits cannot be applied until this is fixed.',
    );
    return UNKNOWN_CLIENT_IP;
  }

  const chain = forwarded.split(',').map((value) => value.trim());
  if (chain.some((value) => value.length === 0)) {
    warnOnce(
      'malformed-xff-chain',
      'X-Forwarded-For contains an empty chain entry. Refusing to remove it '
      + 'because doing so would change trusted-hop positions.',
    );
    return UNKNOWN_CLIENT_IP;
  }

  if (chain.length < hops) {
    warnOnce(
      'short-xff',
      `X-Forwarded-For has ${chain.length} usable entr${chain.length === 1 ? 'y' : 'ies'}, `
      + `fewer than ${TRUSTED_PROXY_HOPS_ENV}=${hops}. Refusing to guess a client IP.`,
    );
    return UNKNOWN_CLIENT_IP;
  }

  // The last `hops` entries were written by trusted proxies; the client IP is
  // the one the outermost trusted proxy observed.
  const selected = chain[chain.length - hops];
  if (isIP(selected) === 0) {
    warnOnce(
      'invalid-xff',
      'The selected X-Forwarded-For entry is not a valid IPv4 or IPv6 address. '
      + 'Refusing to use it for rate limiting or fraud telemetry.',
    );
    return UNKNOWN_CLIENT_IP;
  }

  return selected;
}
