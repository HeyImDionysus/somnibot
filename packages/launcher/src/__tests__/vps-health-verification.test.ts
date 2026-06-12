import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVpsHealthVerification } from '../main/vps-health-verification';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

const completeVpsInput = {
  runtimeMode: 'vps',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
};

function checkStatus(result: ReturnType<typeof buildVpsHealthVerification>, id: string) {
  return result.checks.find(check => check.id === id)?.status;
}

describe('VPS health verification model', () => {
  it('passes the full VPS health checklist from mocked successful signals', () => {
    const result = buildVpsHealthVerification({
      ...completeVpsInput,
      httpsDashboardProbe: { state: 'success', httpStatus: 200 },
      apiHealthProbe: {
        state: 'success',
        httpStatus: 200,
        response: {
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
          timestamp: '2026-06-12T00:00:00.000Z',
        },
      },
      supabaseCallbackAllowList: { status: 'pass' },
      lavalink: { status: 'pass' },
    });

    expect(result.status).toBe('pass');
    expect(result.checks.map(check => check.id)).toEqual([
      'https-dashboard',
      'api-health',
      'supabase-callback-allow-list',
      'bot-diagnostics',
      'valkey-private-url',
      'lavalink-private-url',
    ]);
    expect(result.checks.every(check => check.status === 'pass')).toBe(true);
    expect(result.redactedDiagnostics['api-health']).toMatchObject({
      endpoint: 'https://somnibot.example.com/api/health',
      httpStatus: '200',
      healthStatus: 'healthy',
      config: 'valid',
    });
    expect(result.redactedDiagnostics['valkey-private-url']?.privateUrl).toBe('redis://:[redacted]@valkey:6379');
    expect(result.redactedDiagnostics['lavalink-private-url']?.endpoint).toBe('http://lavalink:2333');
  });

  it('fails dashboard, health, Supabase, bot, Valkey, and Lavalink checks from mocked bad signals', () => {
    const result = buildVpsHealthVerification({
      ...completeVpsInput,
      httpsDashboardProbe: { state: 'failure', httpStatus: 502, error: 'bad gateway' },
      apiHealthProbe: {
        state: 'success',
        httpStatus: 200,
        response: {
          status: 'degraded',
          services: {
            config: 'invalid',
            valkey: 'fallback',
            bot: 'offline',
          },
        },
      },
      supabaseCallbackAllowList: {
        status: 'fail',
        missingCallbackUrls: ['https://somnibot.example.com/api/auth/callback'],
      },
      lavalink: { status: 'fail', detail: 'Lavalink version endpoint failed.' },
    });

    expect(result.status).toBe('fail');
    expect(checkStatus(result, 'https-dashboard')).toBe('fail');
    expect(checkStatus(result, 'api-health')).toBe('pass');
    expect(checkStatus(result, 'supabase-callback-allow-list')).toBe('fail');
    expect(checkStatus(result, 'bot-diagnostics')).toBe('fail');
    expect(checkStatus(result, 'valkey-private-url')).toBe('fail');
    expect(checkStatus(result, 'lavalink-private-url')).toBe('fail');
  });

  it('models running, timeout, pending, and manual states without live probes', () => {
    const result = buildVpsHealthVerification({
      ...completeVpsInput,
      httpsDashboardProbe: { state: 'running', elapsedMs: 250 },
      apiHealthProbe: { state: 'timeout', elapsedMs: 10_000 },
    });

    expect(result.status).toBe('fail');
    expect(checkStatus(result, 'https-dashboard')).toBe('running');
    expect(checkStatus(result, 'api-health')).toBe('fail');
    expect(checkStatus(result, 'supabase-callback-allow-list')).toBe('manual');
    expect(checkStatus(result, 'bot-diagnostics')).toBe('pending');
    expect(checkStatus(result, 'valkey-private-url')).toBe('pending');
    expect(checkStatus(result, 'lavalink-private-url')).toBe('manual');
  });

  it('blocks verification when the VPS deployment plan is not ready', () => {
    const result = buildVpsHealthVerification({ runtimeMode: 'regular-local' });

    expect(result.status).toBe('blocked');
    expect(result.blockedReasons).toContain('VPS deployment plans are only available in VPS mode.');
    expect(result.blockedReasons).toContain('SSH host is required before preflight can be planned.');
    expect(result.checks).toHaveLength(6);
  });

  it('redacts secret-looking diagnostic values', () => {
    const supabaseSecret = ['sb', 'secret', 'REDACT_ME'].join('_');
    const discordToken = ['M', 'TIredaction.token.value'].join('');
    const paypalSecret = 'fixture-paypal-value';
    const bearerToken = 'fixture-bearer-token';
    const redisPassword = 'fixture-redis-password';
    const secretText = `SUPABASE_SECRET_KEY=${supabaseSecret} raw ${supabaseSecret} token ${discordToken} DISCORD_TOKEN=${discordToken} PAYPAL_CLIENT_SECRET=${paypalSecret} Bearer ${bearerToken}`;
    const result = buildVpsHealthVerification({
      ...completeVpsInput,
      httpsDashboardProbe: {
        state: 'failure',
        httpStatus: 500,
        error: secretText,
      },
      apiHealthProbe: {
        state: 'failure',
        httpStatus: 500,
        error: `redis://:${redisPassword}@valkey:6379 failed`,
      },
      supabaseCallbackAllowList: {
        status: 'fail',
        detail: `Missing callback while using SUPABASE_SECRET_KEY=${supabaseSecret}`,
        missingCallbackUrls: ['https://somnibot.example.com/api/auth/callback'],
      },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(supabaseSecret);
    expect(serialized).not.toContain(discordToken);
    expect(serialized).not.toContain(paypalSecret);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(redisPassword);
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('[redacted-supabase-secret]');
    expect(serialized).toContain('[redacted-discord-token]');
  });

  it('does not import live execution or network APIs in the model', () => {
    const source = readFileSync(path.join(srcDir, 'main', 'vps-health-verification.ts'), 'utf8');

    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn(');
    expect(source).not.toContain('fetch(');
  });
});
