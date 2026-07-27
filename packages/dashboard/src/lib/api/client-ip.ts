/**
 * Client IP derivation for rate limiting and forensic logging.
 *
 * ## The problem
 *
 * `req.headers.get('x-forwarded-for')?.split(',')[0]` takes the FIRST value in
 * the header — which is the value the CLIENT supplied. `X-Forwarded-For` is
 * append-only: each proxy appends the address it received the request from, so
 * a client that sends `X-Forwarded-For: 9.9.9.9` and connects to Caddy produces
 * `9.9.9.9, <real client ip>`. Reading index 0 reads the attacker's own string.
 *
 * Rotating that header therefore defeated every per-IP limit on the licence
 * endpoints outright — `licenseValidate` (30/min) and `licenseFailedAttempt`
 * (5/min). That does not enable key brute-forcing (keys are 80-bit), but it
 * allows unbounded `license_validations` insert amplification, and it poisoned
 * the `ip_address` column the IP-mismatch fraud signal reads.
 *
 * ## The rule
 *
 * Trust exactly as many proxy hops as the deployment actually has. With `N`
 * trusted proxies the last `N` entries were written by our own infrastructure,
 * so the client IP is the `N`-th value counted from the RIGHT. Everything to
 * its left is attacker-controlled and must be ignored.
 *
 * ## How this deployment is actually configured
 *
 * From DEPLOYMENT.md and the shipped compose files, not from assumption:
 *
 *   - **VPS** (docker-compose.prod.yml): `caddy` terminates 80/443 and
 *     `reverse_proxy dashboard:3000` (services/caddy/Caddyfile). Caddy appends
 *     the peer address to `X-Forwarded-For`. **One hop.**
 *   - **Regular local**: the dashboard is reached through a stable public HTTPS
 *     tunnel (Tailscale Funnel preferred; Cloudflare Tunnel / ngrok / a custom
 *     reverse proxy also documented). Each of those appends the client address.
 *     **One hop.**
 *   - Vercel is explicitly not the default target — the root `vercel.json` only
 *     disables git deployments and defines no build.
 *
 * So the default is 1. Stacked proxies (e.g. Cloudflare in front of Caddy) need
 * `SOMNIBOT_TRUSTED_PROXY_HOPS=2`, which is why this is configuration and not a
 * constant.
 *
 * ## Getting it wrong is survivable, on purpose
 *
 * If the hop count is misconfigured, the worst case is that requests share a
 * bucket and hit the limit. That is a degradation rather than a lockout only
 * because a rate-limited licence response is now non-terminal for the SDK (see
 * `./license-status` and `INDETERMINATE_STATUSES`): the customer keeps running
 * on their cached validation instead of being told their licence is invalid.
 */

/** Env var naming the number of reverse-proxy hops in front of the dashboard. */
export const TRUSTED_PROXY_HOPS_ENV = 'SOMNIBOT_TRUSTED_PROXY_HOPS';

/**
 * One hop: Caddy on the VPS, or the public HTTPS tunnel in regular-local mode.
 * See the module header for where this comes from.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

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
 * `0` means the app is directly exposed with no reverse proxy — no header can
 * be trusted at all, so every caller shares one bucket. That is not a supported
 * deployment mode for this app and is warned about loudly.
 */
export function getTrustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnOnce(
      'bad-hops',
      `${TRUSTED_PROXY_HOPS_ENV}="${raw}" is not a non-negative integer; `
      + `falling back to ${DEFAULT_TRUSTED_PROXY_HOPS}.`,
    );
    return DEFAULT_TRUSTED_PROXY_HOPS;
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
      + 'share a single rate-limit bucket. Set this to the number of reverse proxies '
      + 'in front of the dashboard (1 for the shipped Caddy / tunnel setups).',
    );
    return UNKNOWN_CLIENT_IP;
  }

  const forwarded = req.headers.get('x-forwarded-for');
  const chain = (forwarded ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (chain.length === 0) {
    warnOnce(
      'no-xff',
      'No X-Forwarded-For header. Either the dashboard is reached directly (set '
      + `${TRUSTED_PROXY_HOPS_ENV}=0) or the reverse proxy is not forwarding it. `
      + 'Per-IP rate limits cannot be applied until this is fixed.',
    );
    return UNKNOWN_CLIENT_IP;
  }

  // The last `hops` entries were written by our own proxies; the client IP is
  // the one the outermost trusted proxy observed. A chain SHORTER than the
  // configured hop count means every entry came from a trusted proxy, so the
  // leftmost is the earliest trustworthy one.
  const index = Math.max(chain.length - hops, 0);
  return chain[index];
}
