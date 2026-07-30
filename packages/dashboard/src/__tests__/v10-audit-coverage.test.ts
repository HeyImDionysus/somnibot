/**
 * V10 Audit — coverage for new code paths added by the audit fixes.
 *
 * §5:  CSRF grace-period acceptance via previous cookie
 * §7:  Health route bot heartbeat check
 * §12: Instrumentation SESSION_TOKEN_FILE reading
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── §5 CSRF grace-period ────────────────────────────────────────────

process.env.CSRF_SECRET = 'test-csrf-secret-32chars-minimum';

import {
  generateCsrfToken,
  checkCsrf,
  CSRF_PREV_COOKIE_NAME,
} from '@/lib/api/csrf';
import { NextRequest } from 'next/server';

function makeRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {},
): NextRequest {
  const req = new NextRequest(`http://localhost${path}`, {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
  });
  if (opts.cookies) {
    for (const [name, value] of Object.entries(opts.cookies)) {
      req.cookies.set(name, value);
    }
  }
  return req;
}

describe('CSRF grace-period (V10 §5)', () => {
  const sessionId = 'grace-session-01';

  it('accepts the previous token within the grace window', async () => {
    // Generate two tokens — "old" and "new"
    const old = await generateCsrfToken(sessionId);
    const fresh = await generateCsrfToken(sessionId);

    // Current cookie holds the NEW nonce, prev cookie holds old nonce + timestamp within window
    const nowStr = String(Date.now());
    const req = makeRequest('/api/settings', {
      method: 'PUT',
      headers: { 'x-csrf-token': old.token },
      cookies: {
        'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${nowStr}`,
        [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!${nowStr}`,
      },
    });

    const result = await checkCsrf(req);
    expect(result).toBeNull(); // accepted via grace period
  });

  it('rejects the previous token after the grace window expires', async () => {
    const old = await generateCsrfToken(sessionId);
    const fresh = await generateCsrfToken(sessionId);

    // Timestamp 120 seconds ago — beyond the 60s grace window
    const expiredStr = String(Date.now() - 120_000);
    const req = makeRequest('/api/settings', {
      method: 'PUT',
      headers: { 'x-csrf-token': old.token },
      cookies: {
        'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
        [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!${expiredStr}`,
      },
    });

    const result = await checkCsrf(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('rejects when prev cookie has malformed format', async () => {
    const fresh = await generateCsrfToken(sessionId);
    const req = makeRequest('/api/settings', {
      method: 'PUT',
      headers: { 'x-csrf-token': 'bad-token' },
      cookies: {
        'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
        [CSRF_PREV_COOKIE_NAME]: 'no-colon-here',
      },
    });

    const result = await checkCsrf(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('rejects when prev cookie timestamp is NaN', async () => {
    const old = await generateCsrfToken(sessionId);
    const fresh = await generateCsrfToken(sessionId);
    const req = makeRequest('/api/settings', {
      method: 'PUT',
      headers: { 'x-csrf-token': old.token },
      cookies: {
        'somnibot-csrf-token': `${fresh.nonce}:${sessionId}!${Date.now()}`,
        [CSRF_PREV_COOKIE_NAME]: `${old.nonce}:${sessionId}!notanumber`,
      },
    });

    const result = await checkCsrf(req);
    expect(result).not.toBeNull();
  });
});

// ── §7 Health route — bot heartbeat ─────────────────────────────────

import { GET as healthGET } from '@/app/api/health/route';
import { buildHealthResponse, type HealthProbe } from '@/lib/api/health-response';

const mockCheckHealth = vi.fn<HealthProbe['checkValkeyHealth']>();
const mockReadKey = vi.fn<HealthProbe['readValkeyKey']>();

const probe: HealthProbe = {
  checkValkeyHealth: mockCheckHealth,
  readValkeyKey: mockReadKey,
};

describe('GET /api/health — bot heartbeat (V10 §7)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports bot online when heartbeat is fresh', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(
      JSON.stringify({ timestamp: Date.now() - 10_000 }), // 10s ago
    );

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(body.status).toBe('healthy');
    expect(body.services.bot).toBe('online');
    expect(body.services.valkey).toBe('connected');
  });

  it('reports bot offline when heartbeat is stale', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(
      JSON.stringify({ timestamp: Date.now() - 200_000 }), // 200s ago, > 120s threshold
    );

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('offline');
  });

  it('reports bot offline when no heartbeat key exists', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockResolvedValue(null);

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(body.services.bot).toBe('offline');
  });

  it('reports bot unknown when Valkey is down', async () => {
    mockCheckHealth.mockResolvedValue(false);

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('unknown');
    expect(body.services.valkey).toBe('fallback');
    // readValkeyKey should not be called if Valkey is down
    expect(mockReadKey).not.toHaveBeenCalled();
  });

  it('reports bot unknown when readValkeyKey throws', async () => {
    mockCheckHealth.mockResolvedValue(true);
    mockReadKey.mockRejectedValue(new Error('parse error'));

    const res = await buildHealthResponse(probe);
    const body = await res.json();

    expect(body.status).toBe('degraded');
    expect(body.services.bot).toBe('unknown');
  });

  it('always returns HTTP 200', async () => {
    mockCheckHealth.mockResolvedValue(false);
    const res = await buildHealthResponse(probe);
    expect(res.status).toBe(200);
  });

  it('production health route returns monitor-safe JSON', async () => {
    const res = await healthGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(['healthy', 'degraded']).toContain(body.status);
    expect(['valid', 'invalid', 'unknown']).toContain(body.services.config);
    expect(['connected', 'fallback']).toContain(body.services.valkey);
    expect(['online', 'offline', 'unknown']).toContain(body.services.bot);
    expect(typeof body.timestamp).toBe('string');
  });
});

// ── §12 Instrumentation SESSION_TOKEN_FILE ──────────────────────────

describe('Instrumentation — SESSION_TOKEN_FILE (V10 §12)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reads SESSION_TOKEN from file and deletes it', async () => {
    const mockReadFileSync = vi.fn().mockReturnValue('test-token-123\n');
    const mockUnlinkSync = vi.fn();

    vi.doMock('node:fs', () => ({
      readFileSync: mockReadFileSync,
      unlinkSync: mockUnlinkSync,
    }));

    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN_FILE = '/tmp/test-token-file';
    delete process.env.SESSION_TOKEN;

    // Mock the shared module to prevent env validation from exiting
    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({ success: true }),
      },
    }));

    // Re-import to pick up the mocks
    const mod = await import('@/instrumentation');
    await mod.register();

    expect(process.env.SESSION_TOKEN).toBe('test-token-123');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test-token-file');
  });

  it('warns when SESSION_TOKEN_FILE cannot be read', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      }),
      unlinkSync: vi.fn(),
    }));

    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN_FILE = '/tmp/nonexistent';
    delete process.env.SESSION_TOKEN;

    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({ success: true }),
      },
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('@/instrumentation');
    await mod.register();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SESSION_TOKEN_FILE'),
    );
  });

  it('does not exit on invalid env in Vercel serverless runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.VERCEL = '1';
    delete process.env.SESSION_TOKEN;

    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ['DISCORD_CLIENT_SECRET'], message: 'Required' },
            ],
          },
        }),
      },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('@/instrumentation');
    await mod.register();

    expect(process.env.DASHBOARD_ENV_VALID).toBe('false');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Dashboard Environment Validation Failed'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Serverless runtime will continue'),
    );
  });

  it('still exits on invalid non-serverless cloud env', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.VERCEL;
    delete process.env.SESSION_TOKEN_FILE;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.SESSION_TOKEN = 'accidental-cloud-token';

    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ['DISCORD_CLIENT_SECRET'], message: 'Required' },
            ],
          },
        }),
      },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('@/instrumentation');
    await mod.register();

    expect(process.env.DASHBOARD_ENV_VALID).toBe('false');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Aborting: hosted deploy requires all env vars'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still exits on invalid non-serverless env when token file is set without launcher marker', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.VERCEL;
    delete process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE;
    process.env.SESSION_TOKEN = 'accidental-cloud-token';
    process.env.SESSION_TOKEN_FILE = '/tmp/accidental-cloud-token-file';

    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ['DISCORD_CLIENT_SECRET'], message: 'Required' },
            ],
          },
        }),
      },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mod = await import('@/instrumentation');
    await mod.register();

    expect(process.env.DASHBOARD_ENV_VALID).toBe('false');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Aborting: hosted deploy requires all env vars'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit on invalid launcher local mode', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.VERCEL;
    process.env.SOMNIBOT_DASHBOARD_LOCAL_MODE = '1';
    process.env.SESSION_TOKEN = 'launcher-token';

    vi.doMock('@somnibot/shared', () => ({
      DashboardEnvSchema: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ['DISCORD_CLIENT_SECRET'], message: 'Required' },
            ],
          },
        }),
      },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('@/instrumentation');
    await mod.register();

    expect(process.env.DASHBOARD_ENV_VALID).toBe('false');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Running in local mode'),
    );
  });
});
