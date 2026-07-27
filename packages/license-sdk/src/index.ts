/**
 * @somnibot/license-sdk
 *
 * Universal License Validation SDK for SomniBot Commerce.
 *
 * Provides a typed client for validating, heartbeating, and deactivating
 * license keys against the SomniBot License API.
 *
 * @example
 * ```ts
 * import { SomniLicense } from '@somnibot/license-sdk';
 *
 * const license = new SomniLicense({
 *   apiBase: 'https://your-domain.example/api',
 *   licenseKey: 'SMNI-XXXX-XXXX-XXXX-XXXX',
 *   productId: 'your-product-uuid',
 * });
 *
 * const result = await license.validate();
 * if (result.valid) {
 *   console.log('License valid!', result.features);
 * }
 * ```
 */

export interface SomniLicenseConfig {
  /** Base URL of the SomniBot dashboard API (e.g., https://dash.example.com/api) */
  apiBase: string;
  /** The license key to validate */
  licenseKey: string;
  /** The product ID this app belongs to */
  productId: string;
  /** Device fingerprint — unique per device/installation */
  deviceFingerprint?: string;
  /** Human-readable device name */
  deviceName?: string;
  /** App version string */
  appVersion?: string;
  /** How long (ms) to cache a valid response locally. Default: 60000 (1 min) */
  cacheTtlMs?: number;
  /**
   * Offline grace period (ms) before a cached validation expires. Default: 86400000 (24h).
   *
   * Note: This uses client-side Date.now() and can be bypassed by clock manipulation.
   * The server-side heartbeat system is the authoritative enforcement mechanism.
   * This grace period is a UX convenience for intermittent connectivity.
   */
  offlineGraceMs?: number;
  /**
   * V5 Audit §3.P3a — Override the server-provided heartbeat interval (seconds).
   * When set, the SDK uses this interval instead of the `heartbeat_interval_seconds`
   * returned by the validation endpoint. Useful for deployments with non-standard
   * network conditions or stricter/relaxed SLAs.
   *
   * Must be > 0. Values under 30s are clamped to 30s to avoid excessive traffic.
   */
  heartbeatIntervalSeconds?: number;
}

/**
 * Statuses that mean **"we could not determine this licence's state"** — as
 * opposed to "this licence is not valid".
 *
 * This distinction is deliberate and load-bearing (see the class docs on
 * `validate`/`heartbeat`). A database blip, an overloaded server, or a rate
 * limit says nothing about whether the customer paid. Treating those as a
 * revocation is how a one-second fault turns into "your licence was revoked"
 * on a paying customer's screen — and, because a failed heartbeat used to
 * clear the cache and stop the timer, it never recovered on its own.
 *
 * Every status listed here is NON-TERMINAL: the SDK keeps its cached
 * validation, keeps the heartbeat timer running, and falls back to the normal
 * offline-grace window. Anything not listed here (`revoked`, `expired`,
 * `suspended`, `invalid_key`, `over_device_limit`, `session_invalidated`, …)
 * is a real verdict from the licence server and stays terminal.
 *
 * The server-side counterparts live in the dashboard's licence routes
 * (`packages/dashboard/src/lib/api/license-status.ts`); keep the two in sync.
 */
export const INDETERMINATE_STATUSES: readonly string[] = [
  /** Server could not answer (DB fault, dependency down). HTTP 503. */
  'service_unavailable',
  /** Too many requests from this IP/key. HTTP 429. Says nothing about the licence. */
  'rate_limited',
];

/**
 * True when a licence-server response means "unknown", not "invalid".
 *
 * Also covers the transport-level cases the body cannot describe: any 5xx, a
 * 429, or a response whose body was not parseable JSON (a proxy error page,
 * a captive portal, a truncated response). Before this existed the SDK never
 * checked `res.ok` at all, so a 500 with `{valid:false,status:'revoked'}`
 * reached the app verbatim as a revocation.
 */
export function isIndeterminateResponse(
  httpStatus: number,
  body: { status?: string } | null,
): boolean {
  if (body === null) return true;
  if (body.status && INDETERMINATE_STATUSES.includes(body.status)) return true;
  return httpStatus >= 500 || httpStatus === 429;
}

/**
 * The status to report for an indeterminate response.
 *
 * Deliberately does NOT echo the body's status unless that status is itself an
 * indeterminate one. A 5xx body may still claim `revoked` — that is exactly the
 * shape the dashboard used to return on an RPC error — and passing it through
 * would reintroduce the bug one layer up.
 */
function indeterminateStatus(body: { status?: string } | null): string {
  if (body?.status && INDETERMINATE_STATUSES.includes(body.status)) return body.status;
  return 'service_unavailable';
}

export interface ValidationResponse {
  valid: boolean;
  /**
   * 'active' for a healthy license. 'grace_period' means the license is
   * still valid but the customer's payment failed — access ends at
   * `grace_period_ends_at` unless payment recovers. Apps should surface
   * this to the user (e.g. "update your payment method").
   *
   * May also be one of {@link INDETERMINATE_STATUSES} — meaning the licence
   * status could NOT be determined. Do not treat those as a revocation.
   */
  status: string;
  /**
   * Set by the server when the failure is a transient service fault rather
   * than a verdict on the licence. Apps should retry rather than degrade.
   */
  retryable?: boolean;
  entitlement_id?: string;
  features?: string[];
  tier?: string | null;
  customer_discord_id?: string;
  customer_name?: string;
  expires_at?: string | null;
  /**
   * Set while `status` is 'grace_period' (and on rejections caused by a
   * lapsed grace window): ISO timestamp at which the payment-failure grace
   * period ends/ended. Null for healthy licenses.
   */
  grace_period_ends_at?: string | null;
  session_id?: string | null;
  heartbeat_interval_seconds?: number;
  error?: string;
}

export interface HeartbeatResponse {
  valid: boolean;
  /**
   * May be one of {@link INDETERMINATE_STATUSES} — the server could not
   * determine the session's state. Non-terminal: the heartbeat timer keeps
   * running so the session self-heals when the fault clears.
   */
  status: string;
  /**
   * Set when a still-valid session's entitlement has entered a payment-failure
   * grace period (status 'grace_period'): ISO timestamp at which access ends
   * unless payment recovers. Null/absent for healthy sessions. Lets apps that
   * monitor license health via heartbeats surface the warning without a
   * separate validation call.
   */
  grace_period_ends_at?: string | null;
  next_heartbeat_seconds: number;
}

export interface DeactivateResponse {
  success: boolean;
  error?: string;
}

export class SomniLicense {
  private config: Required<
    Pick<SomniLicenseConfig, 'apiBase' | 'licenseKey' | 'productId'>
  > &
    SomniLicenseConfig;

  private cachedResult: ValidationResponse | null = null;
  private cacheExpiry: number = 0;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * W2 review — hard stop for a cached `grace_period` response, on the local
   * monotonic timeline.
   *
   * `grace_period_ends_at` is a server-side hard deadline: once it passes the
   * server rejects the key. The offline fallbacks (validate/heartbeat catch
   * paths) must therefore never keep serving a cached grace success past it —
   * otherwise a lapsed payment stays "valid" simply by going offline for the
   * remainder of `offlineGraceMs`. Null unless the last successful validation
   * was a grace response with a placeable deadline; cleared on any healthy
   * (non-grace) validation.
   */
  private cachedGraceDeadlineMono: number | null = null;

  /**
   * V7 Audit §3.P3a — Server-time anchor for offline grace.
   *
   * On each successful validation/heartbeat response, we record both the
   * server's Date header and the local monotonic timestamp (performance.now
   * when available, Date.now fallback). Offline grace checks use the delta
   * between the recorded monotonic timestamp and the current one, making
   * the grace period immune to system clock manipulation.
   */
  private serverTimeAnchor: { serverEpoch: number; localMono: number } | null = null;

  /**
   * Get a monotonic timestamp (ms) via performance.now().
   *
   * V5 Audit §3.P3a: Always use the monotonic clock — no Date.now fallback.
   * performance.now() is available in all browsers, Node ≥16, Deno, and Bun.
   * If an exotic runtime lacks it, fail loudly so the operator notices rather
   * than silently degrading to a manipulable wall-clock source.
   */
  private mono(): number {
    return performance.now();
  }

  /** Record server time from a fetch Response's Date header. */
  private anchorServerTime(res: Response): void {
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverEpoch = new Date(dateHeader).getTime();
      if (!isNaN(serverEpoch)) {
        this.serverTimeAnchor = { serverEpoch, localMono: this.mono() };
      }
    }
  }

  /** Elapsed ms since the server time anchor, using monotonic clock. */
  private elapsedSinceAnchor(): number {
    if (!this.serverTimeAnchor) return Infinity;
    return this.mono() - this.serverTimeAnchor.localMono;
  }

  /**
   * True when the cached success was a `grace_period` response whose
   * server-side deadline has now passed on the local monotonic timeline.
   * Used by the offline fallbacks to hard-stop a lapsed payment-grace license
   * regardless of the (longer) offline grace window.
   */
  private cachedGraceLapsed(): boolean {
    return this.cachedGraceDeadlineMono !== null && this.mono() >= this.cachedGraceDeadlineMono;
  }

  /**
   * Place a server-side ISO deadline on the local monotonic timeline.
   *
   * Uses the server-time anchor when available (immune to local clock
   * manipulation, V7 §3.P3a). `anchored` reports whether a real server-time
   * anchor was used: when false, the mapping fell back to the local wall clock
   * (`Date.now()`), which a behind/ahead client clock can skew — callers that
   * must not TRUST an unanchored deadline (e.g. deciding a cache window) treat
   * it conservatively rather than extending access on a possibly-wrong mono
   * value (W2 P3). Returns null when the deadline is absent or unparseable.
   */
  private serverDeadlineToMono(
    iso: string | null | undefined,
  ): { mono: number; anchored: boolean } | null {
    if (!iso) return null;
    const epoch = new Date(iso).getTime();
    if (isNaN(epoch)) return null;
    if (this.serverTimeAnchor) {
      return {
        mono: this.serverTimeAnchor.localMono + (epoch - this.serverTimeAnchor.serverEpoch),
        anchored: true,
      };
    }
    return { mono: this.mono() + (epoch - Date.now()), anchored: false };
  }

  constructor(config: SomniLicenseConfig) {
    this.config = {
      cacheTtlMs: 60_000,
      offlineGraceMs: 86_400_000,
      ...config,
    };
  }

  /**
   * Parse a response body as JSON, returning null when the body is not JSON.
   *
   * A proxy error page, a captive portal, or a truncated response is a
   * transport failure — not a licence verdict — so it must land on the
   * indeterminate path rather than throwing into the offline catch (which
   * would report `network_error` even though the request reached a server).
   */
  private async readJson<T>(res: Response): Promise<T | null> {
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /**
   * Shared fallback for a validation that could not be completed — used by
   * BOTH the transport catch path (offline) and the indeterminate-response
   * path (server said "I don't know").
   *
   * The two are the same situation from the licence's point of view: we hold
   * a cached verdict and no fresh one, so the offline grace window decides.
   * `terminalStatus` is only reported when there is no cache at all to fall
   * back on.
   *
   * Note what this deliberately does NOT do: it never clears the cache or
   * stops the heartbeat while still inside the grace window. That is the fix
   * for "a one-second database hiccup permanently stops the client".
   */
  private validateFallback(terminalStatus: string, error?: string): ValidationResponse {
    const graceMs = this.config.offlineGraceMs ?? 86_400_000;
    const elapsed = this.elapsedSinceAnchor();

    // W2 review: the payment-failure grace deadline is a HARD server-side
    // stop. If the cached success was a grace_period response and that
    // deadline has now passed, the offline window must NOT ride it out —
    // clear the cache and reject exactly as an elapsed offline grace would.
    if (this.cachedResult?.valid && !this.cachedGraceLapsed() && elapsed < graceMs) {
      return { ...this.cachedResult, status: 'offline_grace' };
    }

    // V5-Audit §3.1: Distinguish expired grace from a first-time failure.
    // If we had a cached result that's now stale, the grace period expired.
    // Clear the stale cache and stop heartbeats to prevent zombie sessions.
    if (this.cachedResult) {
      this.cachedResult = null;
      this.cachedGraceDeadlineMono = null;
      this.stopHeartbeat();
      return { valid: false, status: 'offline_grace_expired' };
    }

    return {
      valid: false,
      status: terminalStatus,
      retryable: true,
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Validate the license key. Returns cached result if still fresh.
   *
   * Three distinct outcomes, deliberately kept apart:
   *
   *  1. **Valid** — `{ valid: true }`. Cached, heartbeat started.
   *  2. **Invalid** — a real verdict from the licence server (`revoked`,
   *     `expired`, `suspended`, `invalid_key`, `over_device_limit`, …).
   *     Returned verbatim; the app should stop.
   *  3. **Indeterminate** — {@link INDETERMINATE_STATUSES}, any 5xx/429, or an
   *     unparseable body. The server could not answer, which is NOT a verdict.
   *     The cached validation and the heartbeat timer are both preserved and
   *     the offline-grace window applies, so a transient fault degrades to
   *     "keep running on cache" instead of "your licence was revoked".
   */
  async validate(): Promise<ValidationResponse> {
    // Return cache if valid
    // V5 Audit §3.1: Use monotonic clock for cache TTL (consistent with
    // offline grace period) to prevent clock-manipulation bypass.
    if (this.cachedResult?.valid && this.mono() < this.cacheExpiry) {
      return this.cachedResult;
    }

    try {
      const res = await fetch(`${this.config.apiBase}/license/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: this.config.licenseKey,
          product_id: this.config.productId,
          device_fingerprint: this.config.deviceFingerprint,
          device_name: this.config.deviceName,
          app_version: this.config.appVersion,
        }),
      });

      const data = await this.readJson<ValidationResponse>(res);

      // ── Indeterminate: the server could not answer ────────────────────
      // Deliberately BEFORE the `data.valid` branch and before any state
      // mutation. Note we do NOT call anchorServerTime() here: re-anchoring on
      // a failed response would reset `elapsedSinceAnchor()` on every retry,
      // so a server stuck at 503 would extend the offline grace window forever
      // instead of letting it expire.
      if (data === null || isIndeterminateResponse(res.status, data)) {
        return this.validateFallback(
          indeterminateStatus(data),
          data?.error ?? 'License status could not be determined',
        );
      }

      if (data.valid) {
        this.cachedResult = data;
        this.sessionId = data.session_id ?? null;

        // V7 Audit §3.P3a — anchor server time on successful validation.
        // (Anchored before the cache-expiry math below, which uses the
        // anchor to place the server-side grace deadline on the local
        // monotonic timeline.)
        this.anchorServerTime(res);

        // V5 Audit §3.1: monotonic clock for cache TTL.
        // W2 review: a grace_period response carries a hard server-side
        // deadline (grace_period_ends_at) after which the server rejects
        // the key — never cache past it. Otherwise a validation moments
        // before the deadline would keep a revoked customer "valid" from
        // cache for the remainder of the full TTL.
        const ttlExpiry = this.mono() + (this.config.cacheTtlMs ?? 60_000);
        const graceDeadline = this.serverDeadlineToMono(data.grace_period_ends_at);
        if (graceDeadline === null) {
          // Healthy (non-grace) response, or no/unparseable deadline: plain TTL.
          this.cacheExpiry = ttlExpiry;
          this.cachedGraceDeadlineMono = null;
        } else if (graceDeadline.anchored) {
          // Grace response with a trustworthy deadline: cap the cache at it,
          // and remember it so the OFFLINE fallbacks (validate/heartbeat catch)
          // stop serving this cached grace success once it passes.
          this.cacheExpiry = Math.min(ttlExpiry, graceDeadline.mono);
          this.cachedGraceDeadlineMono = graceDeadline.mono;
        } else {
          // W2 P3: grace deadline present but NOT server-time-anchored (e.g. a
          // cross-origin fetch that does not expose the Date header). A behind
          // client clock could push graceDeadline.mono past the payment cutoff,
          // so we cannot TRUST it as either a cache window or an offline stop.
          // Make it non-cacheable — force a server revalidation on the very
          // next call — and treat the offline grace as already lapsed (mono
          // "now"), so if that revalidation is offline the fallback rejects
          // instead of riding out offlineGraceMs on an unverifiable deadline.
          this.cacheExpiry = this.mono();
          this.cachedGraceDeadlineMono = this.mono();
        }

        // Auto-start heartbeat — prefer config override, then server-provided interval.
        // V5 Audit §3.P3a: heartbeatIntervalSeconds config option.
        const hbInterval = this.config.heartbeatIntervalSeconds
          ?? data.heartbeat_interval_seconds;
        if (hbInterval && hbInterval > 0) {
          this.startHeartbeat(hbInterval);
        }
      }

      return data;
    } catch (err) {
      // Offline — check grace period using monotonic elapsed time
      // V7 Audit §3.P3a: Uses server-time-anchored monotonic clock instead of
      // raw Date.now() to prevent clock-manipulation bypass.
      return this.validateFallback(
        'network_error',
        err instanceof Error ? err.message : 'Network error',
      );
    }
  }

  /**
   * Shared fallback for a heartbeat that could not be completed — used by both
   * the transport catch path and the indeterminate-response path.
   *
   * While the offline grace window is open the session is reported as still
   * alive and, critically, the heartbeat timer is LEFT RUNNING so the session
   * resumes on its own once the fault clears. Only a genuinely elapsed grace
   * window tears the session down.
   */
  private heartbeatFallback(terminalStatus: string): HeartbeatResponse {
    // V5 Audit §3.2: Check grace period instead of unconditionally returning valid.
    const graceMs = this.config.offlineGraceMs ?? 86_400_000;
    const elapsed = this.elapsedSinceAnchor();
    // W2 review: same hard stop as validate()'s offline path — a lapsed
    // payment-grace deadline overrides the offline window, so a heartbeat
    // cannot keep a session alive past the server-side grace cutoff.
    if (this.cachedResult?.valid && !this.cachedGraceLapsed() && elapsed < graceMs) {
      return { valid: true, status: 'offline', next_heartbeat_seconds: 300 };
    }
    this.cachedResult = null;
    this.cachedGraceDeadlineMono = null;
    this.stopHeartbeat();
    return { valid: false, status: terminalStatus, next_heartbeat_seconds: 0 };
  }

  /**
   * Send a heartbeat to keep the session alive.
   *
   * A `valid: false` heartbeat is terminal — it clears the cache and stops the
   * timer — so it must only ever be reached for a REAL verdict. An
   * indeterminate response ({@link INDETERMINATE_STATUSES}, 5xx, 429,
   * unparseable body) is routed to {@link heartbeatFallback} instead, which
   * keeps the timer alive. That is the difference between a database blip
   * costing a paying customer one heartbeat and costing them the whole session
   * until the app is restarted.
   */
  async heartbeat(): Promise<HeartbeatResponse> {
    if (!this.sessionId) {
      return { valid: false, status: 'no_session', next_heartbeat_seconds: 0 };
    }

    try {
      const res = await fetch(`${this.config.apiBase}/license/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          license_key: this.config.licenseKey,
        }),
      });

      const data = await this.readJson<HeartbeatResponse>(res);

      // ── Indeterminate: the server could not answer ────────────────────
      // Same reasoning as validate(): no state is torn down, no server-time
      // re-anchor, and the heartbeat timer keeps ticking.
      if (data === null || isIndeterminateResponse(res.status, data)) {
        return this.heartbeatFallback(indeterminateStatus(data));
      }

      // V7 Audit §3.P3a — refresh server time anchor on successful heartbeat
      if (data.valid) {
        this.anchorServerTime(res);
        // W2: the entitlement may have ENTERED grace after the initial
        // validation (payment failed mid-session). The heartbeat now reports
        // status 'grace_period' + a deadline. We must both (a) record the
        // offline hard-stop so a subsequent offline heartbeat/validate rejects
        // once it passes, AND (b) cap the ONLINE validation cache at the same
        // deadline and rewrite the cached response to reflect grace — otherwise
        // validate()/isValid() keep serving the stale 'active' cache (from the
        // initial validation) past the deadline until the original, possibly
        // much longer, cacheTtlMs elapses. Only an anchored deadline is trusted
        // (same P3 reasoning as validate()); an unanchored one is treated as an
        // immediate stop (non-cacheable + offline reject). A healthy heartbeat
        // clears any prior grace stop but leaves the existing cache window alone.
        if (data.status === 'grace_period') {
          const graceDeadline = this.serverDeadlineToMono(data.grace_period_ends_at);
          if (graceDeadline === null) {
            // No/unparseable deadline: keep any prior stop, leave cache as-is.
          } else if (graceDeadline.anchored) {
            this.cachedGraceDeadlineMono = graceDeadline.mono;
            // Cap the online cache at the deadline (never EXTEND it) and rewrite
            // the cached success so validate()/isValid() surface grace and stop
            // exactly at the deadline.
            this.cacheExpiry = Math.min(this.cacheExpiry, graceDeadline.mono);
            if (this.cachedResult) {
              this.cachedResult = {
                ...this.cachedResult,
                status: 'grace_period',
                grace_period_ends_at: data.grace_period_ends_at,
              };
            }
          } else {
            // Unanchored deadline: cannot be trusted. Force revalidation on the
            // next validate() and treat the offline stop as already lapsed.
            this.cachedGraceDeadlineMono = this.mono();
            this.cacheExpiry = this.mono();
            if (this.cachedResult) {
              this.cachedResult = {
                ...this.cachedResult,
                status: 'grace_period',
                grace_period_ends_at: data.grace_period_ends_at,
              };
            }
          }
        } else {
          this.cachedGraceDeadlineMono = null;
          // W2 codex: payment recovered — the heartbeat now reports a
          // non-grace status (e.g. 'active'). A PRIOR grace heartbeat may have
          // rewritten cachedResult.status to 'grace_period' (and stamped a
          // deadline) above; clearing only the deadline mono leaves that stale
          // grace payload in the cache, so validate()/isValid() keep returning
          // 'grace_period' until the original cacheTtlMs elapses and apps that
          // treat status !== 'active' as unhealthy keep restricting a recovered
          // customer. Reconcile the cached payload back to the heartbeat's
          // status and drop the stale deadline.
          if (this.cachedResult) {
            this.cachedResult = {
              ...this.cachedResult,
              status: data.status ?? this.cachedResult.status,
              grace_period_ends_at: null,
            };
          }
        }
      } else {
        this.cachedResult = null;
        this.cachedGraceDeadlineMono = null;
        this.stopHeartbeat();
      }

      return data;
    } catch {
      // A network error during heartbeat should still respect the offline
      // grace window.
      return this.heartbeatFallback('offline_grace_expired');
    }
  }

  /**
   * Deactivate this device (e.g., on app uninstall).
   */
  async deactivate(): Promise<DeactivateResponse> {
    this.stopHeartbeat();

    if (!this.sessionId) {
      return { success: true };
    }

    try {
      const res = await fetch(`${this.config.apiBase}/license/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          license_key: this.config.licenseKey,
        }),
      });

      const data: DeactivateResponse = await res.json();
      this.sessionId = null;
      this.cachedResult = null;
      this.cachedGraceDeadlineMono = null;
      return data;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if there's a cached valid result.
   */
  /**
   * V5 Audit §3.2: Uses monotonic clock (consistent with validate/heartbeat).
   */
  isValid(): boolean {
    return !!this.cachedResult?.valid && this.mono() < this.cacheExpiry;
  }

  /**
   * Get cached features list.
   */
  getFeatures(): string[] {
    return this.cachedResult?.features ?? [];
  }

  /**
   * Get cached tier.
   */
  getTier(): string | null {
    return this.cachedResult?.tier ?? null;
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    this.stopHeartbeat();
  }

  // ── Private ──────────────────────────────

  private startHeartbeat(intervalSeconds: number): void {
    this.stopHeartbeat();
    // V5 Audit §3.P3a: Clamp to minimum 30s to prevent excessive traffic
    const clamped = Math.max(intervalSeconds, 30);
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      clamped * 1000,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
