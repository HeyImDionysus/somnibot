import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from '@/app/api/setup/route';

const mutationHandlers = {
  POST,
  PUT,
  PATCH,
  DELETE,
} as const;

describe('GET /api/setup', () => {
  it('returns only a read-only Launcher handoff', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      authority: 'launcher',
      dashboardSetup: 'handoff-only',
      mutationAllowed: false,
      setupPath: '/setup',
      message: 'Installation setup is managed in the SomniBot Launcher.',
    });
  });
});

describe.each(Object.entries(mutationHandlers))('%s /api/setup', (method, handler) => {
  it('rejects submitted credentials without echoing or accepting them', async () => {
    const secret = 'must-never-be-persisted';
    const request = new NextRequest('https://dashboard.test/api/setup', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'finalize',
        credentials: {
          discord_bot_token: secret,
          supabase_secret_key: secret,
          paypal_client_secret: secret,
        },
      }),
    });

    const response = handler(request);
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      authority: 'launcher',
      dashboardSetup: 'handoff-only',
      mutationAllowed: false,
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});
