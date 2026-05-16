/**
 * @somnibot/license-sdk
 *
 * Universal Licensing Platform SDK.
 * Provides license validation, heartbeat, and multi-device management
 * for external applications using SomniBot-issued license keys.
 *
 * Implementation coming in Phase 10 (Commerce).
 */

export const SDK_VERSION = '0.1.0';

// Placeholder — full implementation in Phase 10
export interface LicenseConfig {
  apiUrl: string;
  productId: string;
  deviceFingerprint?: string;
}

export interface LicenseValidation {
  valid: boolean;
  status: 'valid' | 'invalid_key' | 'expired' | 'suspended' | 'revoked' | 'over_device_limit' | 'product_mismatch';
  expiresAt?: string;
  features?: string[];
  tier?: string;
}

export function createLicenseClient(_config: LicenseConfig) {
  return {
    validate: async (_key: string): Promise<LicenseValidation> => {
      throw new Error('License SDK not yet implemented. Coming in Phase 10.');
    },
    startHeartbeat: (_key: string, _intervalMs?: number) => {
      throw new Error('License SDK not yet implemented. Coming in Phase 10.');
    },
    stopHeartbeat: () => {
      throw new Error('License SDK not yet implemented. Coming in Phase 10.');
    },
  };
}
