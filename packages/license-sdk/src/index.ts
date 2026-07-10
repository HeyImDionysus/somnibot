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

export interface ValidationResponse {
  valid: boolean;
  /**
   * 'active' for a healthy license. 'grace_period' means the license is
   * still valid but the customer's payment failed — access ends at
   * `grace_period_ends_at` unless payment recovers. Apps should surface
   * this to the user (e.g. "update your payment method").
   */
  status: string;
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
   * Validate the license key. Returns cached result if still fresh.
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

      const data: ValidationResponse = await res.json();

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
      const graceMs = this.config.offlineGraceMs ?? 86_400_000;
      const elapsed = this.elapsedSinceAnchor();

      // W2 review: the payment-failure grace deadline is a HARD server-side
      // stop. If the cached success was a grace_period response and that
      // deadline has now passed, the offline window must NOT ride it out —
      // clear the cache and reject exactly as an elapsed offline grace would.
      if (this.cachedResult?.valid && !this.cachedGraceLapsed() && elapsed < graceMs) {
        return { ...this.cachedResult, status: 'offline_grace' };
      }

      // V5-Audit §3.1: Distinguish expired grace from a first-time network error.
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
        status: 'network_error',
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  /**
   * Send a heartbeat to keep the session alive.
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

      const data: HeartbeatResponse = await res.json();

      // V7 Audit §3.P3a — refresh server time anchor on successful heartbeat
      if (data.valid) {
        this.anchorServerTime(res);
        // W2: the entitlement may have ENTERED grace after the initial
        // validation (payment failed mid-session). The heartbeat now reports
        // status 'grace_period' + a deadline — record it as the offline
        // hard-stop so a subsequent offline heartbeat/validate rejects once it
        // passes, even though validate() never saw a grace response. Only an
        // anchored deadline is trusted (same P3 reasoning as validate()); an
        // unanchored one is treated as an immediate stop. A healthy heartbeat
        // clears any prior grace stop.
        if (data.status === 'grace_period') {
          const graceDeadline = this.serverDeadlineToMono(data.grace_period_ends_at);
          this.cachedGraceDeadlineMono =
            graceDeadline === null
              ? this.cachedGraceDeadlineMono
              : graceDeadline.anchored
                ? graceDeadline.mono
                : this.mono();
        } else {
          this.cachedGraceDeadlineMono = null;
        }
      } else {
        this.cachedResult = null;
        this.cachedGraceDeadlineMono = null;
        this.stopHeartbeat();
      }

      return data;
    } catch {
      // V5 Audit §3.2: Check grace period instead of unconditionally returning valid.
      // A network error during heartbeat should still respect the offline grace window.
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
      return { valid: false, status: 'offline_grace_expired', next_heartbeat_seconds: 0 };
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
