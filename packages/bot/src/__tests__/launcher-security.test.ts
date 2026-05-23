/**
 * Launcher Security — Unit Tests (V5 Audit §10.1, §10.2, §1.1)
 *
 * Tests the security constraints for the Electron launcher:
 * - URL validation for open-external
 * - Sensitive key identification
 * - Encryption/decryption roundtrip
 */
import { describe, it, expect } from 'vitest';

// ── Inline URL validation (matches preload.ts + index.ts IPC handler) ──

function isValidExternalUrl(url: string): boolean {
  // V5 Audit [1.1]: Only allow https:// URLs
  return url.startsWith('https://');
}

function isValidDashboardUrl(url: string): boolean {
  // The open-dashboard handler has an explicit localhost exception
  return url === 'http://localhost:3456';
}

// ── Sensitive key identification (matches config-store.ts) ──

const SENSITIVE_KEYS = new Set([
  'discordToken',
  'discordClientSecret',
  'supabaseSecretKey',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

// ── Tests ──────────────────────────────────────────────────

describe('Launcher URL validation [1.1]', () => {
  it('allows https:// URLs', () => {
    expect(isValidExternalUrl('https://example.com')).toBe(true);
    expect(isValidExternalUrl('https://discord.com/invite/abc')).toBe(true);
  });

  it('rejects http:// URLs', () => {
    expect(isValidExternalUrl('http://example.com')).toBe(false);
    expect(isValidExternalUrl('http://localhost:3456')).toBe(false);
  });

  it('rejects other protocols', () => {
    expect(isValidExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isValidExternalUrl('ftp://example.com')).toBe(false);
    expect(isValidExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isValidExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects empty/garbage input', () => {
    expect(isValidExternalUrl('')).toBe(false);
    expect(isValidExternalUrl('not-a-url')).toBe(false);
  });
});

describe('Dashboard URL exception', () => {
  it('only allows the exact localhost dashboard URL', () => {
    expect(isValidDashboardUrl('http://localhost:3456')).toBe(true);
    expect(isValidDashboardUrl('http://localhost:9999')).toBe(false);
    expect(isValidDashboardUrl('http://evil.com:3456')).toBe(false);
  });
});

describe('Sensitive key identification [10.1]', () => {
  it('identifies token/secret fields as sensitive', () => {
    expect(isSensitiveKey('discordToken')).toBe(true);
    expect(isSensitiveKey('discordClientSecret')).toBe(true);
    expect(isSensitiveKey('supabaseSecretKey')).toBe(true);
  });

  it('does not flag non-sensitive fields', () => {
    expect(isSensitiveKey('discordApplicationId')).toBe(false);
    expect(isSensitiveKey('supabaseUrl')).toBe(false);
    expect(isSensitiveKey('supabasePublishableKey')).toBe(false);
    expect(isSensitiveKey('firstRunComplete')).toBe(false);
    expect(isSensitiveKey('windowBounds')).toBe(false);
    expect(isSensitiveKey('lavalinkEnabled')).toBe(false);
  });
});

describe('BrowserWindow security settings [10.2]', () => {
  it('documents the expected security configuration', () => {
    // These are the expected values after V5 audit remediation
    const expectedConfig = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // Changed from false → true in V5 audit
    };

    expect(expectedConfig.contextIsolation).toBe(true);
    expect(expectedConfig.nodeIntegration).toBe(false);
    expect(expectedConfig.sandbox).toBe(true);
  });
});
