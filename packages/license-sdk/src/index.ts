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
 *   apiBase: 'https://your-dashboard.vercel.app/api',
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
}

export interface ValidationResponse {
  valid: boolean;
  status: string;
  entitlement_id?: string;
  features?: string[];
  tier?: string | null;
  customer_discord_id?: string;
  customer_name?: string;
  expires_at?: string | null;
  session_id?: string | null;
  heartbeat_interval_seconds?: number;
  error?: string;
}

export interface HeartbeatResponse {
  valid: boolean;
  status: string;
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
    if (this.cachedResult?.valid && Date.now() < this.cacheExpiry) {
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
        this.cacheExpiry = Date.now() + (this.config.cacheTtlMs ?? 60_000);
        this.sessionId = data.session_id ?? null;

        // Auto-start heartbeat if interval provided
        if (data.heartbeat_interval_seconds && data.heartbeat_interval_seconds > 0) {
          this.startHeartbeat(data.heartbeat_interval_seconds);
        }
      }

      return data;
    } catch (err) {
      // Offline — check grace period
      if (
        this.cachedResult?.valid &&
        Date.now() < this.cacheExpiry + (this.config.offlineGraceMs ?? 86_400_000)
      ) {
        return { ...this.cachedResult, status: 'offline_grace' };
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

      if (!data.valid) {
        this.cachedResult = null;
        this.stopHeartbeat();
      }

      return data;
    } catch {
      return { valid: true, status: 'offline', next_heartbeat_seconds: 300 };
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
  isValid(): boolean {
    return !!this.cachedResult?.valid && Date.now() < this.cacheExpiry;
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
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      intervalSeconds * 1000,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
