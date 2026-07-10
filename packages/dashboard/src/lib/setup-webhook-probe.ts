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

/** Header carrying the signed probe challenge to the webhook route. */
export const SETUP_WEBHOOK_PROBE_HEADER = 'x-somnibot-webhook-probe';

const PROBE_CHALLENGE_VERSION = 'v1';
const PROBE_CHALLENGE_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
// Cache probe outcomes: the setup page polls GET /api/setup every few
// seconds, and each probe is an outbound request to our own public URL.
// Without a cache, unauthenticated status polling would fan out into a
// self-inflicted request storm against the webhook endpoint.
const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_CHALLENGE_MAX_LENGTH = 256;

export type SetupWebhookProbeFailureReason =
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'connection'
  | 'http-status'
  | 'echo-mismatch'
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

interface ProbeOptions {
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
}

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
 * Run one reachability probe against `url` (no caching — see
 * getSetupWebhookReachability for the cached entry point).
 *
 * SSRF posture: callers only pass URLs that already passed
 * getSetupPayPalWebhookUrlError (HTTPS, non-localhost, exact
 * /api/paypal/webhook path), redirects are never followed, the request
 * body is empty, and nothing from the response is reflected to clients
 * beyond a coarse status classification.
 */
export async function probeSetupWebhookUrl(
  url: string,
  options: ProbeOptions = {},
): Promise<SetupWebhookReachability> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl: ProbeFetch = options.fetchImpl ?? fetch;
  const checkedAt = new Date().toISOString();

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
      signal: AbortSignal.timeout(timeoutMs),
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

  let echo: unknown = null;
  try {
    const body = await response.json() as { echo?: unknown } | null;
    echo = body?.echo ?? null;
  } catch {
    echo = null;
  }

  const expectedEcho = buildSetupWebhookProbeEcho(challenge);
  const echoValid = typeof echo === 'string'
    && expectedEcho !== null
    && echo.length === expectedEcho.length
    && timingSafeEqual(Buffer.from(echo), Buffer.from(expectedEcho));

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

let cachedProbe: { result: SetupWebhookReachability; expiresAt: number } | null = null;
let inflightProbe: { url: string; promise: Promise<SetupWebhookReachability> } | null = null;

/**
 * Cached, concurrency-safe entry point used by /api/setup readiness.
 *
 * - `url === null` (no validated public webhook URL yet) short-circuits to a
 *   "skipped" result without any network traffic.
 * - Outcomes (including failures) are cached for PROBE_CACHE_TTL_MS.
 * - Concurrent readiness reads share a single in-flight probe instead of
 *   racing multiple outbound requests.
 */
export async function getSetupWebhookReachability(
  url: string | null,
  options: ProbeOptions = {},
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

  if (cachedProbe && cachedProbe.result.checkedUrl === url && Date.now() < cachedProbe.expiresAt) {
    return cachedProbe.result;
  }

  if (inflightProbe?.url === url) {
    return inflightProbe.promise;
  }

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
      cachedProbe = { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS };
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
