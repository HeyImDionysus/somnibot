import { describe, expect, it } from 'vitest';
import {
  buildRuntimeEnvVars,
  getLauncherLocalStartBlocker,
  getProviderCallbackUrls,
  normalizeBaseUrl,
  normalizeRuntimeMode,
  normalizeVpsDomain,
  resolveRuntimeProfile,
  validateRuntimeNetworkingConfig,
} from '../main/runtime-profile';

describe('runtime profile model', () => {
  it('defaults unknown and missing runtime modes to regular local', () => {
    expect(normalizeRuntimeMode(undefined)).toBe('regular-local');
    expect(normalizeRuntimeMode('regular-local')).toBe('regular-local');
    expect(normalizeRuntimeMode('something-old')).toBe('regular-local');
    expect(normalizeRuntimeMode('vps')).toBe('vps');
  });

  it('keeps the regular-local operator dashboard separate from the public callback base', () => {
    const profile = resolveRuntimeProfile({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot-laptop.tailnet.ts.net/',
    });

    expect(profile.operatorDashboardUrl).toBe('http://localhost:3456');
    expect(profile.publicCallbackBaseUrl).toBe('https://somnibot-laptop.tailnet.ts.net');
    expect(profile.authCallbackUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/auth/callback');
    expect(profile.paypalWebhookUrl).toBe('https://somnibot-laptop.tailnet.ts.net/api/paypal/webhook');
    expect(profile.dashboardPort).toBe('3456');
    expect(profile.dashboardHostname).toBe('127.0.0.1');
    expect(profile.valkeyUrl).toBe('redis://127.0.0.1:6379');
    expect(profile.lavalinkHost).toBe('localhost');
  });

  it('falls back to the local dashboard URL for regular-local first setup', () => {
    const env = buildRuntimeEnvVars({ runtimeMode: 'regular-local' });

    expect(env.DASHBOARD_URL).toBe('http://localhost:3456');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3456');
    expect(env.PAYPAL_WEBHOOK_URL).toBe('http://localhost:3456/api/paypal/webhook');
    expect(env.SOMNIBOT_RUNTIME_MODE).toBe('regular-local');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_REQUIRED).toBe('true');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL).toBe('http://localhost:3456');
  });

  it('emits the launcher public callback contract for regular-local setup finalization', () => {
    const env = buildRuntimeEnvVars({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net/',
    });

    expect(env.DASHBOARD_URL).toBe('http://localhost:3456');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('https://somnibot.tailnet.ts.net');
    expect(env.SOMNIBOT_RUNTIME_MODE).toBe('regular-local');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_REQUIRED).toBe('true');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL).toBe('https://somnibot.tailnet.ts.net');
    expect(env.PAYPAL_WEBHOOK_URL).toBe('https://somnibot.tailnet.ts.net/api/paypal/webhook');
  });

  it('derives VPS callback and service values from a bare domain', () => {
    const env = buildRuntimeEnvVars({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
    });

    expect(env.DASHBOARD_URL).toBe('https://somnibot.example.com');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('https://somnibot.example.com');
    expect(env.PAYPAL_WEBHOOK_URL).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(env.SOMNIBOT_RUNTIME_MODE).toBe('vps');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_REQUIRED).toBe('true');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL).toBe('https://somnibot.example.com');
    expect(env.PORT).toBe('3000');
    expect(env.HOSTNAME).toBe('0.0.0.0');
    expect(env.VALKEY_URL).toBe('redis://valkey:6379');
    expect(env.LAVALINK_HOST).toBe('lavalink');
  });

  it('prefers the VPS domain over a stale regular-local callback URL', () => {
    const env = buildRuntimeEnvVars({
      runtimeMode: 'vps',
      publicCallbackBaseUrl: 'https://old-laptop.tailnet.ts.net',
      vpsDomain: 'somnibot.example.com',
    });

    expect(env.DASHBOARD_URL).toBe('https://somnibot.example.com');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('https://somnibot.example.com');
    expect(env.PAYPAL_WEBHOOK_URL).toBe('https://somnibot.example.com/api/paypal/webhook');
    expect(env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL).toBe('https://somnibot.example.com');
  });

  it('does not let a stale regular-local callback URL satisfy VPS mode', () => {
    const config = {
      runtimeMode: 'vps' as const,
      publicCallbackBaseUrl: 'https://old-laptop.tailnet.ts.net',
    };

    expect(validateRuntimeNetworkingConfig(config)).toContain(
      'VPS mode needs a public HTTPS domain before setup can finalize.',
    );
    expect(() => buildRuntimeEnvVars(config)).toThrow(
      'VPS mode needs a public HTTPS domain before setup can finalize.',
    );
  });

  it('normalizes callback base URLs without query strings, hashes, or trailing slashes', () => {
    expect(normalizeBaseUrl(' https://example.com/?from=test#frag ')).toBe('https://example.com');
    expect(normalizeVpsDomain('somnibot.example.com/')).toBe('https://somnibot.example.com');
  });

  it('validates production callback URLs as HTTPS base URLs', () => {
    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'http://callback.example.com',
    })).toContain('Public callback URL must use HTTPS unless local testing is explicitly allowed.');

    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://callback.example.com/nested',
    })).toContain('Public callback URL must be the dashboard base URL, not a nested path.');
  });

  it('does not silently fall back to localhost when a configured callback URL is invalid', () => {
    expect(() => buildRuntimeEnvVars({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'somnibot.tailnet.ts.net',
    })).toThrow('Public callback URL must be a valid HTTP or HTTPS URL.');
  });

  it('allows localhost callback URLs only when local testing is explicit', () => {
    const config = {
      runtimeMode: 'regular-local' as const,
      publicCallbackBaseUrl: 'http://localhost:3456',
    };

    expect(validateRuntimeNetworkingConfig(config)).toContain(
      'Public callback URL must use HTTPS unless local testing is explicitly allowed.',
    );
    expect(validateRuntimeNetworkingConfig(config, { allowLocalTesting: true })).toEqual([]);
  });

  it('requires a non-local HTTPS callback base for VPS mode', () => {
    expect(validateRuntimeNetworkingConfig({ runtimeMode: 'vps' })).toContain(
      'VPS mode needs a public HTTPS domain before setup can finalize.',
    );
    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'vps',
      vpsDomain: 'not a domain',
    })).toContain('VPS public domain must be a valid HTTP or HTTPS URL or bare domain.');
    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'vps',
      vpsDomain: 'http://localhost:3000',
    })).toContain('VPS mode cannot use a localhost callback URL.');
    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'vps',
      vpsDomain: 'http://somnibot.example.com',
    })).toContain('VPS public domain must use HTTPS.');
    expect(validateRuntimeNetworkingConfig({
      runtimeMode: 'vps',
      vpsDomain: 'https://somnibot.example.com/app',
    })).toContain('VPS public domain must be the dashboard base domain, not a nested path.');
  });

  it('blocks local launcher startup for invalid callback config or VPS mode', () => {
    expect(getLauncherLocalStartBlocker({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'http://callback.example.com',
    })).toContain('Public callback URL must use HTTPS unless local testing is explicitly allowed.');

    expect(getLauncherLocalStartBlocker({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
    })).toContain('VPS mode uses the guided deployment setup path.');

    expect(getLauncherLocalStartBlocker({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
    })).toBeNull();
  });

  it('derives provider callback URLs from one public base', () => {
    expect(getProviderCallbackUrls('https://public.example.com/')).toEqual({
      authCallbackUrl: 'https://public.example.com/api/auth/callback',
      paypalWebhookUrl: 'https://public.example.com/api/paypal/webhook',
    });
  });

  it('does not promote Tailscale auth keys into runtime env', () => {
    const env = buildRuntimeEnvVars({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: 'https://somnibot.tailnet.ts.net',
      tailscaleAuthKey: 'tskey-secret-value',
    } as Parameters<typeof buildRuntimeEnvVars>[0] & { tailscaleAuthKey: string });

    expect(Object.keys(env).join(' ')).not.toMatch(/auth.*key/i);
    expect(Object.values(env)).not.toContain('tskey-secret-value');
  });
});
