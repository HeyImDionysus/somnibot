/**
 * Setup-time PayPal webhook reachability probe.
 *
 * WHY: during first-run setup the PayPal webhook URL (derived from
 * SOMNIBOT_PUBLIC_CALLBACK_BASE_URL, or configured explicitly) is only
 * validated statically — HTTPS, non-localhost, exact path. A URL can pass
 * all of that and still be silently broken: wrong DNS record, expired TLS
 * certificate, firewalled port, or a reverse proxy answering for a
 * different backend. When that happens the paid store keeps creating
 * PayPal orders whose webhooks never arrive, so paid orders never fulfill.
 *
 * HOW: the dashboard POSTs a signed, short-lived challenge to its own
 * public webhook URL. The webhook route recognizes the challenge header,
 * verifies it with a constant-time HMAC compare, performs NO PayPal
 * processing and NO database writes (no webhook_events rows), and answers
 * with an HMAC-signed echo. The prober reports "reachable" only when that
 * echo verifies — proving the request left this process, traversed the
 * public URL, and was answered by a deployment holding this instance's
 * webhook secret, not by a captive portal, CDN placeholder, or an
 * unrelated service that happens to return 200.
 *
 * HONESTY — what this probe does NOT prove:
 * - It does NOT prove PayPal can reach the URL. PayPal's egress path
 *   (routing, IP allow-lists, geo firewalls) can differ from this host's
 *   own outbound path. A "reachable" result is necessary evidence, not
 *   sufficient proof, that webhooks will be delivered.
 * - An "unreachable" result can be a false negative: some NAT/router
 *   setups cannot "hairpin" back to their own public address even though
 *   the outside world (including PayPal) can reach it. That is why the
 *   outcome is surfaced as a readiness signal with a failure reason
 *   instead of hard-blocking finalize.
 * - It says nothing about PayPal credentials or the webhook ID being
 *   correct; separate readiness checks cover those.
 *
 * Challenges are single-purpose and expire after two minutes. Replaying a
 * captured challenge within its lifetime only yields the same side-effect
 * free echo (the endpoint writes nothing and is IP rate-limited), and each
 * probe generates a fresh challenge and accepts only its own echo.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BlockList, isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

/** Header carrying the signed probe challenge to the webhook route. */
export const SETUP_WEBHOOK_PROBE_HEADER = 'x-somnibot-webhook-probe';

const PROBE_CHALLENGE_VERSION = 'v1';
const PROBE_CHALLENGE_TTL_MS = 2 * 60_000;
// Total budget for one probe, covering BOTH the vetting DNS lookup and the
// HTTP round-trip: the DNS phase races against this deadline and the fetch
// only gets whatever budget remains, so a wedged resolver cannot hang
// GET /api/setup or finalize beyond this bound.
const PROBE_TIMEOUT_MS = 8_000;
// Cache probe outcomes: the setup page polls GET /api/setup every few
// seconds, and each probe is an outbound request to our own public URL.
// Without a cache, unauthenticated status polling would fan out into a
// self-inflicted request storm against the webhook endpoint.
const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_CHALLENGE_MAX_LENGTH = 256;
// The legitimate echo body is ~100 bytes of JSON. Anything meaningfully
// larger is by definition not this deployment's webhook route, so the prober
// never buffers more than this from a wrong (or hostile) target.
const PROBE_MAX_RESPONSE_BYTES = 4_096;

export type SetupWebhookProbeFailureReason =
  | 'dns'
  | 'dns-timeout'
  | 'tls'
  | 'timeout'
  | 'connection'
  | 'http-status'
  | 'echo-mismatch'
  | 'oversized-response'
  | 'private-address'
  | 'request-failed'
  | 'no-public-url'
  | 'probe-secret-missing';

export interface SetupWebhookReachability {
  /**
   * reachable   — signed echo verified over the public URL.
   * unreachable — the probe ran and failed; see failureReason/detail.
   * skipped     — the probe could not run (no validated public URL yet, or
   *               no secret to sign challenges with). Not evidence either way.
   */
  status: 'reachable' | 'unreachable' | 'skipped';
  failureReason: SetupWebhookProbeFailureReason | null;
  /** Operator-facing explanation. Never contains secrets or raw error dumps. */
  detail: string;
  checkedUrl: string | null;
  checkedAt: string | null;
}

type ProbeFetch = (input: string, init?: RequestInit) => Promise<Response>;
type ProbeLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

interface ProbeOptions {
  fetchImpl?: ProbeFetch;
  lookupImpl?: ProbeLookup;
  timeoutMs?: number;
}

interface ReachabilityOptions extends ProbeOptions {
  /**
   * Skip the result cache and any shared in-flight probe and run a fresh
   * probe now (the fresh outcome still refreshes the cache). Used by setup
   * finalize, which records a durable verdict and must not consume a result
   * that predates a DNS/TLS fix the operator just made. Status polling keeps
   * using the cache.
   */
  forceFresh?: boolean;
}

const defaultProbeLookup: ProbeLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Same secret sources as webhook replay auth (app/api/paypal/webhook/verify.ts),
 * but domain-separated with an HMAC label so a probe challenge can never be
 * replayed as a replay credential (or vice versa).
 */
function getProbeSecret(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const base = env.WEBHOOK_REPLAY_SECRET || env.NEXTAUTH_SECRET;
  if (!base) return null;
  return createHmac('sha256', base).update('somnibot-setup-webhook-probe:v1').digest();
}

/**
 * Create a signed challenge: `v1.<nonce>.<expiresAtMs>.<hmac>`.
 * Returns null when no signing secret is configured.
 */
export function createSetupWebhookProbeChallenge(now = Date.now()): string | null {
  const secret = getProbeSecret();
  if (!secret) return null;

  const nonce = randomBytes(16).toString('hex');
  const payload = `${PROBE_CHALLENGE_VERSION}.${nonce}.${now + PROBE_CHALLENGE_TTL_MS}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

/**
 * Verify a probe challenge with a constant-time HMAC compare.
 * Used by the webhook route to decide whether a request is a probe.
 */
export function verifySetupWebhookProbeChallenge(
  challenge: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!challenge || challenge.length > PROBE_CHALLENGE_MAX_LENGTH) return false;
  const secret = getProbeSecret();
  if (!secret) return false;

  const parts = challenge.split('.');
  if (parts.length !== 4) return false;
  const [version, nonce, expiresAtRaw, signature] = parts;
  if (version !== PROBE_CHALLENGE_VERSION) return false;
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  if (!/^\d{1,15}$/.test(expiresAtRaw)) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;

  const expected = createHmac('sha256', secret)
    .update(`${version}.${nonce}.${expiresAtRaw}`)
    .digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return false;
  }

  return now <= Number(expiresAtRaw);
}

/**
 * Signed echo for a challenge. Domain-separated from the challenge signature
 * so an echo can never be replayed as a challenge. The prober only reports
 * "reachable" when the endpoint returns exactly this value, which proves the
 * responder shares this deployment's webhook secret.
 */
export function buildSetupWebhookProbeEcho(challenge: string): string | null {
  const secret = getProbeSecret();
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update(`somnibot-webhook-probe-echo:${challenge}`)
    .digest('hex');
}

const HAIRPIN_NOTE =
  'Some NAT/firewall setups cannot reach their own public URL even when the outside world (including PayPal) can.';

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'HOSTNAME_MISMATCH',
  'EPROTO',
]);
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Classify a failed outbound probe into an operator-actionable reason.
 * Walks the error `cause` chain (undici wraps network errors in
 * `TypeError: fetch failed`). Details deliberately expose only the error
 * code, never raw error messages.
 */
function classifyProbeError(err: unknown, timeoutMs: number): {
  failureReason: SetupWebhookProbeFailureReason;
  detail: string;
} {
  const chain: unknown[] = [];
  let current: unknown = err;
  while (current && chain.length < 6) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  for (const entry of chain) {
    if (entry instanceof Error && (entry.name === 'TimeoutError' || entry.name === 'AbortError')) {
      return {
        failureReason: 'timeout',
        detail: `The webhook URL did not respond within ${Math.round(timeoutMs / 1000)}s. ${HAIRPIN_NOTE}`,
      };
    }

    const code = typeof (entry as { code?: unknown } | null)?.code === 'string'
      ? (entry as { code: string }).code
      : '';
    if (!code) continue;

    if (DNS_ERROR_CODES.has(code)) {
      return {
        failureReason: 'dns',
        detail: `DNS lookup for the webhook hostname failed (${code}). The public URL's domain does not resolve from this server.`,
      };
    }
    if (TIMEOUT_ERROR_CODES.has(code)) {
      return {
        failureReason: 'timeout',
        detail: `The connection to the webhook URL timed out (${code}). ${HAIRPIN_NOTE}`,
      };
    }
    if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS')) {
      return {
        failureReason: 'tls',
        detail: `TLS handshake with the webhook URL failed (${code}). Check the certificate served on the public URL.`,
      };
    }
    if (CONNECTION_ERROR_CODES.has(code)) {
      return {
        failureReason: 'connection',
        detail: `Connecting to the webhook URL failed (${code}). ${HAIRPIN_NOTE}`,
      };
    }
  }

  if (chain.some((entry) => entry instanceof Error && /certificate|\btls\b|\bssl\b/i.test(entry.message))) {
    return {
      failureReason: 'tls',
      detail: 'TLS handshake with the webhook URL failed. Check the certificate served on the public URL.',
    };
  }

  return {
    failureReason: 'request-failed',
    detail: 'The probe request failed before receiving a response from the webhook URL.',
  };
}

/**
 * Addresses the probe must never request (SSRF guard), which are also
 * addresses PayPal could never deliver a webhook to: loopback, RFC1918,
 * link-local (includes 169.254.169.254-style cloud metadata services),
 * CGNAT, ULA, multicast, and reserved space. net.BlockList canonicalizes
 * IPv4-mapped IPv6 forms (`::ffff:10.0.0.5`, `::ffff:a00:5`) against the
 * IPv4 rules, so mapped-address smuggling is covered.
 */
const PRIVATE_ADDRESS_BLOCKLIST = new BlockList();
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network" / unspecified
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT (Tailscale exception below)
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local + cloud metadata
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + broadcast
PRIVATE_ADDRESS_BLOCKLIST.addAddress('::', 'ipv6'); // unspecified
PRIVATE_ADDRESS_BLOCKLIST.addAddress('::1', 'ipv6'); // loopback
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6'); // link-local
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6'); // ULA (Tailscale exception below)
PRIVATE_ADDRESS_BLOCKLIST.addSubnet('ff00::', 8, 'ipv6'); // multicast

/**
 * Tailscale tailnet ranges, exempted ONLY for `*.ts.net` hostnames.
 *
 * `tailscale funnel` is a supported deployment path (the launcher derives the
 * public callback URL from a *.ts.net hostname). Publicly those hostnames
 * resolve to Tailscale's funnel ingress (public IPs), but on the funnel
 * machine itself — exactly where this probe runs — MagicDNS resolves them to
 * the node's own tailnet address: 100.64.0.0/10 (CGNAT v4) and
 * fd7a:115c:a1e0::/48 (v6, inside ULA). Without this exception the guard
 * would break every funnel deployment. IP literals and non-ts.net hostnames
 * resolving into these ranges stay blocked (e.g. 100.100.100.200-style CGNAT
 * metadata services), and *.ts.net names cannot be pointed at arbitrary
 * internal addresses: Tailscale controls that zone, and MagicDNS only maps
 * them to nodes of the operator's own tailnet.
 */
const TAILSCALE_ADDRESS_ALLOWLIST = new BlockList();
TAILSCALE_ADDRESS_ALLOWLIST.addSubnet('100.64.0.0', 10, 'ipv4');
TAILSCALE_ADDRESS_ALLOWLIST.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

const TAILSCALE_HOSTNAME_SUFFIX = '.ts.net';

function isBlockedProbeAddress(address: string, hostname: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not a parseable IP — refuse rather than guess
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (
    hostname.toLowerCase().endsWith(TAILSCALE_HOSTNAME_SUFFIX)
    && TAILSCALE_ADDRESS_ALLOWLIST.check(address, type)
  ) {
    return false;
  }
  return PRIVATE_ADDRESS_BLOCKLIST.check(address, type);
}

/**
 * Race a promise against an absolute deadline. Used to keep the vetting DNS
 * lookup inside the overall probe budget: dns/promises lookups have no
 * timeout of their own, so a wedged resolver would otherwise hang the probe
 * (and everything awaiting it) indefinitely.
 *
 * The raced promise keeps running after a timeout — Node offers no way to
 * cancel an in-flight getaddrinfo — so a no-op rejection handler is attached
 * up front to keep a late lookup failure from becoming an unhandled
 * rejection.
 */
async function raceDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<{ kind: 'ok'; value: T } | { kind: 'deadline' }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { kind: 'deadline' };

  promise.catch(() => {}); // handled here so a post-timeout rejection never goes unhandled

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: 'ok' as const, value })),
      new Promise<{ kind: 'deadline' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'deadline' }), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vet the probe target before any outbound request: reject private/internal
 * IP literals outright, and resolve hostnames rejecting the target when ANY
 * resolved address is private (a mixed answer means a rebinding-style DNS
 * name could steer the probe internally). The DNS phase is bounded by
 * `deadlineAt` — the same deadline the fetch later runs against — so the
 * whole probe (DNS + fetch) stays within one PROBE_TIMEOUT_MS budget.
 *
 * Returns null when the target is acceptable, or the terminal
 * SetupWebhookReachability to report otherwise.
 *
 * TOCTOU honesty: this is resolve-then-fetch — the fetch below re-resolves
 * the hostname itself, so a DNS name that flips to a private address between
 * this check and the request (deliberate rebinding) is not fully excluded.
 * That residual window is accepted deliberately: the platform-patched Next.js
 * fetch offers no supported way to pin a request to pre-resolved addresses,
 * and what an attacker gains through it is a single empty-bodied POST whose
 * response is never reflected beyond a coarse failure classification.
 */
async function vetProbeTarget(
  url: string,
  lookupImpl: ProbeLookup,
  timeoutMs: number,
  deadlineAt: number,
  checkedAt: string,
): Promise<SetupWebhookReachability | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return {
      status: 'unreachable',
      failureReason: 'request-failed',
      detail: 'The webhook URL could not be parsed, so the probe did not run.',
      checkedUrl: url,
      checkedAt,
    };
  }

  // WHATWG URL keeps brackets on IPv6 hosts ("[fd00::1]"); strip them so
  // net.isIP and BlockList see the bare address.
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  let addresses: string[];
  if (isIP(bareHost) !== 0) {
    addresses = [bareHost];
  } else {
    let raced: { kind: 'ok'; value: Array<{ address: string; family: number }> } | { kind: 'deadline' };
    try {
      raced = await raceDeadline(lookupImpl(bareHost), deadlineAt);
    } catch (err) {
      // Resolving here (instead of first inside fetch) classifies DNS
      // failures at the same step that vets the answer.
      const { failureReason, detail } = classifyProbeError(err, timeoutMs);
      return { status: 'unreachable', failureReason, detail, checkedUrl: url, checkedAt };
    }
    if (raced.kind === 'deadline') {
      return {
        status: 'unreachable',
        failureReason: 'dns-timeout',
        detail: `DNS lookup for the webhook hostname did not complete within ${Math.round(timeoutMs / 1000)}s — the DNS resolver on this server appears unresponsive.`,
        checkedUrl: url,
        checkedAt,
      };
    }
    addresses = raced.value.map((entry) => entry.address);
    if (addresses.length === 0) {
      return {
        status: 'unreachable',
        failureReason: 'dns',
        detail: 'DNS lookup for the webhook hostname returned no addresses.',
        checkedUrl: url,
        checkedAt,
      };
    }
  }

  if (addresses.some((address) => isBlockedProbeAddress(address, bareHost))) {
    return {
      status: 'unreachable',
      failureReason: 'private-address',
      detail: 'The webhook URL points at a private or internal network address. PayPal delivers webhooks over the public internet and can never reach private addresses, so the probe refuses to call internal targets. (Tailscale *.ts.net hostnames are exempt from this check — funnel deployments resolve to tailnet addresses locally.)',
      checkedUrl: url,
      checkedAt,
    };
  }

  return null;
}

/**
 * Read at most `maxBytes` of the response body. `response.json()` would
 * buffer an unbounded body from a wrong or malicious target; the real echo
 * is ~100 bytes, so anything over the cap is treated as its own failure.
 */
async function readProbeResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ kind: 'ok'; text: string } | { kind: 'oversize' } | { kind: 'unreadable' }> {
  const body = response.body;
  if (!body) return { kind: 'ok', text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: 'oversize' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Run one reachability probe against `url` (no caching — see
 * getSetupWebhookReachability for the cached entry point).
 *
 * SSRF posture: callers only pass URLs that already passed
 * getSetupPayPalWebhookUrlError (HTTPS, non-localhost, exact
 * /api/paypal/webhook path); on top of that, vetProbeTarget rejects
 * private/internal targets before any request (see its TOCTOU note),
 * redirects are never followed, the request body is empty, response bodies
 * are read capped at PROBE_MAX_RESPONSE_BYTES, and nothing from the response
 * is reflected to clients beyond a coarse status classification.
 */
export async function probeSetupWebhookUrl(
  url: string,
  options: ProbeOptions = {},
): Promise<SetupWebhookReachability> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl: ProbeFetch = options.fetchImpl ?? fetch;
  const lookupImpl: ProbeLookup = options.lookupImpl ?? defaultProbeLookup;
  const checkedAt = new Date().toISOString();
  // One deadline covers the whole probe: the vetting DNS lookup races
  // against it, and the fetch below gets only whatever budget remains.
  const deadlineAt = Date.now() + timeoutMs;

  const challenge = createSetupWebhookProbeChallenge();
  if (!challenge) {
    return {
      status: 'skipped',
      failureReason: 'probe-secret-missing',
      detail: 'Reachability probe skipped — set WEBHOOK_REPLAY_SECRET (or NEXTAUTH_SECRET) so probes can be signed.',
      checkedUrl: url,
      checkedAt,
    };
  }

  const targetRejection = await vetProbeTarget(url, lookupImpl, timeoutMs, deadlineAt, checkedAt);
  if (targetRejection) return targetRejection;

  let response: Response;
  try {
    // POST with an empty body: PayPal delivers webhooks via POST, so this
    // proves routing for the method actually used in production.
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { [SETUP_WEBHOOK_PROBE_HEADER]: challenge },
      // Redirects are a failure, not something to follow: PayPal POSTs to
      // the exact configured URL, and redirecting webhook URLs commonly
      // drop the POST body or method along the way.
      redirect: 'manual',
      cache: 'no-store',
      // Remaining slice of the shared probe budget after DNS vetting, so
      // DNS + fetch together never exceed timeoutMs. Clamped to 1ms: a
      // lookup that lands right on the deadline aborts as a plain timeout.
      signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
    });
  } catch (err) {
    const { failureReason, detail } = classifyProbeError(err, timeoutMs);
    return { status: 'unreachable', failureReason, detail, checkedUrl: url, checkedAt };
  }

  if (response.status !== 200) {
    const redirected = response.status >= 300 && response.status < 400;
    return {
      status: 'unreachable',
      failureReason: 'http-status',
      detail: redirected
        ? `The webhook URL redirected (HTTP ${response.status}) instead of answering the probe. PayPal will not follow webhook redirects reliably — configure the final URL directly.`
        : `The webhook URL answered HTTP ${response.status} instead of the probe echo. Another service may be handling this path.`,
      checkedUrl: url,
      checkedAt,
    };
  }

  const bodyRead = await readProbeResponseBody(response, PROBE_MAX_RESPONSE_BYTES);
  if (bodyRead.kind === 'oversize') {
    return {
      status: 'unreachable',
      failureReason: 'oversized-response',
      detail: 'The webhook URL answered HTTP 200 with an oversized response instead of the compact probe echo — another service appears to be behind this URL.',
      checkedUrl: url,
      checkedAt,
    };
  }

  let echo: unknown = null;
  if (bodyRead.kind === 'ok') {
    try {
      const parsed = JSON.parse(bodyRead.text) as { echo?: unknown } | null;
      echo = parsed?.echo ?? null;
    } catch {
      echo = null;
    }
  }

  const expectedEcho = buildSetupWebhookProbeEcho(challenge);
  // Compare BYTE lengths, not string lengths: a multi-byte (non-ASCII) echo
  // can match the expected hex string's length in UTF-16 code units yet
  // encode to a longer Buffer, and timingSafeEqual throws RangeError on
  // unequal-length inputs. Any length mismatch is just a wrong echo.
  let echoValid = false;
  if (typeof echo === 'string' && expectedEcho !== null) {
    const providedEcho = Buffer.from(echo, 'utf8');
    const wantedEcho = Buffer.from(expectedEcho, 'utf8');
    echoValid = providedEcho.length === wantedEcho.length
      && timingSafeEqual(providedEcho, wantedEcho);
  }

  if (!echoValid) {
    return {
      status: 'unreachable',
      failureReason: 'echo-mismatch',
      detail: 'The webhook URL answered HTTP 200 but not with this deployment\'s signed echo — a different deployment, an old build, or another service appears to be behind this URL.',
      checkedUrl: url,
      checkedAt,
    };
  }

  return {
    status: 'reachable',
    failureReason: null,
    detail: 'The dashboard reached its public webhook URL and verified the signed echo. This proves the dashboard\'s own network path to the URL — it does not prove PayPal\'s delivery path.',
    checkedUrl: url,
    checkedAt,
  };
}

// Probes are stamped with a monotonically increasing sequence at start so
// cache writes can be ordered by probe START time, not completion time: a
// forceFresh finalize probe and an older still-in-flight cached poll for the
// same URL can both be running, and whichever finishes LAST would otherwise
// win the cache — letting a probe that began before the operator's fix
// overwrite the fresh verdict with a stale one.
let probeSequence = 0;
let cachedProbe: {
  result: SetupWebhookReachability;
  expiresAt: number;
  sequence: number;
} | null = null;
let inflightProbe: { url: string; promise: Promise<SetupWebhookReachability> } | null = null;

/**
 * Cached, concurrency-safe entry point used by /api/setup readiness.
 *
 * - `url === null` (no validated public webhook URL yet) short-circuits to a
 *   "skipped" result without any network traffic.
 * - Outcomes (including failures) are cached for PROBE_CACHE_TTL_MS.
 * - Concurrent readiness reads share a single in-flight probe instead of
 *   racing multiple outbound requests.
 * - `forceFresh` (finalize) bypasses both the cache and any shared in-flight
 *   probe, then refreshes the cache with the new outcome.
 * - Cache writes are monotonic in probe START order: an older probe that is
 *   still in flight when a newer (e.g. forceFresh) probe completes cannot
 *   later overwrite the cache with its stale verdict.
 */
export async function getSetupWebhookReachability(
  url: string | null,
  options: ReachabilityOptions = {},
): Promise<SetupWebhookReachability> {
  if (!url) {
    return {
      status: 'skipped',
      failureReason: 'no-public-url',
      detail: 'Reachability is probed once a validated public webhook URL exists.',
      checkedUrl: null,
      checkedAt: null,
    };
  }

  if (!options.forceFresh) {
    if (cachedProbe && cachedProbe.result.checkedUrl === url && Date.now() < cachedProbe.expiresAt) {
      return cachedProbe.result;
    }

    if (inflightProbe?.url === url) {
      return inflightProbe.promise;
    }
  }

  const sequence = ++probeSequence;
  const promise = probeSetupWebhookUrl(url, options)
    .catch((): SetupWebhookReachability => ({
      // probeSetupWebhookUrl classifies its own failures; this fallback only
      // guards against unexpected throws so readiness reads can never reject.
      status: 'unreachable',
      failureReason: 'request-failed',
      detail: 'The reachability probe failed unexpectedly.',
      checkedUrl: url,
      checkedAt: new Date().toISOString(),
    }))
    .then((result) => {
      // Monotonic write: only a probe that STARTED at or after the cached
      // entry's probe may replace it. A slower, earlier-started probe that
      // finishes after a fresher one still returns its own result to its
      // caller but never regresses the cache.
      if (!cachedProbe || sequence >= cachedProbe.sequence) {
        cachedProbe = { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS, sequence };
      }
      return result;
    })
    .finally(() => {
      if (inflightProbe?.promise === promise) inflightProbe = null;
    });

  inflightProbe = { url, promise };
  return promise;
}

export function resetSetupWebhookReachabilityCacheForTests(): void {
  cachedProbe = null;
  inflightProbe = null;
}
