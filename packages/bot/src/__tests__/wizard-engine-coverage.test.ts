/**
 * setup-wizard/wizard-engine — coverage tests
 *
 * Tests loadProgress, saveProgress, getNextStep, detectConfigured,
 * storeCredentials, enableFeatureFlag with REAL imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock steps module — inline factory to avoid hoisting issues
vi.mock('../features/setup-wizard/steps.js', () => ({
  WIZARD_STEPS: [
    {
      id: 'discord',
      name: 'Discord Bot',
      modalFields: [
        { customId: 'token', required: true },
        { customId: 'appId', required: true },
      ],
      fieldToSettingsKey: { token: 'discord_bot_token', appId: 'discord_app_id' },
    },
    {
      id: 'paypal',
      name: 'PayPal',
      modalFields: [
        { customId: 'clientId', required: true },
        { customId: 'secret', required: true },
        { customId: 'sandbox', required: true },
        { customId: 'webhookId', required: true },
        { customId: 'webhookUrl', required: false },
      ],
      fieldToSettingsKey: {
        clientId: 'paypal_client_id',
        secret: 'paypal_client_secret',
        sandbox: 'paypal_sandbox',
        webhookId: 'paypal_webhook_id',
        webhookUrl: 'paypal_webhook_url',
      },
    },
    {
      id: 'lavalink',
      name: 'Lavalink',
      modalFields: [
        { customId: 'host', required: true },
      ],
      fieldToSettingsKey: { host: 'lavalink_host' },
    },
  ],
}));

import {
  loadProgress,
  saveProgress,
  getNextStep,
  detectConfigured,
  storeCredentials,
  enableFeatureFlag,
} from '../features/setup-wizard/wizard-engine.js';

function chainBuilder(resolveValue: any = { data: null, error: null }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'upsert', 'maybeSingle', 'update']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (res: any, rej?: any) => Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeSupabase(responses: Record<string, any> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (responses[table]) return chainBuilder(responses[table]);
      return chainBuilder();
    }),
  };
}

describe('loadProgress', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty progress when no data', async () => {
    const supabase = makeSupabase({ instance_settings: { data: null, error: null } });
    const progress = await loadProgress(supabase as any);
    expect(progress.configured).toEqual([]);
    expect(progress.skipped).toEqual([]);
  });

  it('returns empty progress on error', async () => {
    const supabase = makeSupabase({ instance_settings: { data: null, error: { message: 'err' } } });
    const progress = await loadProgress(supabase as any);
    expect(progress.configured).toEqual([]);
  });

  it('parses stored progress', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: {
          value: JSON.stringify({ configured: ['discord'], skipped: ['paypal'], lastRun: '2026-01-01' }),
        },
        error: null,
      },
    });
    const progress = await loadProgress(supabase as any);
    expect(progress.configured).toEqual(['discord']);
    expect(progress.skipped).toEqual(['paypal']);
    expect(progress.lastRun).toBe('2026-01-01');
  });

  it('handles invalid JSON', async () => {
    const supabase = makeSupabase({
      instance_settings: { data: { value: '{invalid' }, error: null },
    });
    const progress = await loadProgress(supabase as any);
    expect(progress.configured).toEqual([]);
  });

  it('handles malformed progress data', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: { value: JSON.stringify({ configured: 'not-array', skipped: null }) },
        error: null,
      },
    });
    const progress = await loadProgress(supabase as any);
    expect(progress.configured).toEqual([]);
    expect(progress.skipped).toEqual([]);
  });
});

describe('saveProgress', () => {
  it('upserts progress to instance_settings', async () => {
    const supabase = makeSupabase();
    await saveProgress(supabase as any, { configured: ['discord'], skipped: [], lastRun: '2026-01-01' });
    expect(supabase.from).toHaveBeenCalledWith('instance_settings');
  });
});

describe('getNextStep', () => {
  it('returns first step when nothing done', () => {
    const result = getNextStep({ configured: [], skipped: [], lastRun: '' });
    expect(result).not.toBeNull();
    expect(result!.step.id).toBe('discord');
    expect(result!.index).toBe(0);
  });

  it('skips configured steps', () => {
    const result = getNextStep({ configured: ['discord'], skipped: [], lastRun: '' });
    expect(result).not.toBeNull();
    expect(result!.step.id).toBe('paypal');
    expect(result!.index).toBe(1);
  });

  it('skips both configured and skipped steps', () => {
    const result = getNextStep({ configured: ['discord'], skipped: ['paypal'], lastRun: '' });
    expect(result).not.toBeNull();
    expect(result!.step.id).toBe('lavalink');
    expect(result!.index).toBe(2);
  });

  it('returns null when all steps done', () => {
    const result = getNextStep({ configured: ['discord', 'paypal', 'lavalink'], skipped: [], lastRun: '' });
    expect(result).toBeNull();
  });
});

describe('detectConfigured', () => {
  it('returns configured steps based on DB values', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: [
          { key: 'discord_bot_token', value: 'token' },
          { key: 'discord_app_id', value: 'appid' },
          { key: 'paypal_client_id', value: 'pid' },
          // paypal_client_secret missing → paypal not configured
        ],
        error: null,
      },
    });

    const result = await detectConfigured(supabase as any);
    expect(result.has('discord')).toBe(true);
    expect(result.has('paypal')).toBe(false);
  });

  it('returns empty set when no data', async () => {
    const supabase = makeSupabase({ instance_settings: { data: null, error: null } });
    const result = await detectConfigured(supabase as any);
    expect(result.size).toBe(0);
  });

  it('ignores empty values', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: [
          { key: 'discord_bot_token', value: '' },
          { key: 'discord_app_id', value: '   ' },
        ],
        error: null,
      },
    });
    const result = await detectConfigured(supabase as any);
    expect(result.has('discord')).toBe(false);
  });

  it('requires PayPal webhook ID to mark PayPal configured', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: [
          { key: 'paypal_client_id', value: 'pid' },
          { key: 'paypal_client_secret', value: 'secret' },
          { key: 'paypal_sandbox', value: 'true' },
        ],
        error: null,
      },
    });

    const result = await detectConfigured(supabase as any);
    expect(result.has('paypal')).toBe(false);
  });

  it('does not require optional PayPal webhook URL to mark PayPal configured', async () => {
    const supabase = makeSupabase({
      instance_settings: {
        data: [
          { key: 'paypal_client_id', value: 'pid' },
          { key: 'paypal_client_secret', value: 'secret' },
          { key: 'paypal_sandbox', value: 'true' },
          { key: 'paypal_webhook_id', value: 'WH-123' },
        ],
        error: null,
      },
    });

    const result = await detectConfigured(supabase as any);
    expect(result.has('paypal')).toBe(true);
  });
});

describe('storeCredentials', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('stores credentials in instance_settings and updates env', async () => {
    const supabase = makeSupabase();
    const paypalStep = {
      id: 'paypal',
      name: 'PayPal',
      fieldToSettingsKey: {
        clientId: 'paypal_client_id',
        secret: 'paypal_client_secret',
        webhookUrl: 'paypal_webhook_url',
      },
    };
    await storeCredentials(supabase as any, paypalStep as any, {
      clientId: 'my-client-id',
      secret: 'my-secret',
      webhookUrl: 'https://example.com/api/paypal/webhook',
    });
    expect(supabase.from).toHaveBeenCalledWith('instance_settings');
    expect(process.env.PAYPAL_CLIENT_ID).toBe('my-client-id');
    expect(process.env.PAYPAL_WEBHOOK_URL).toBe('https://example.com/api/paypal/webhook');
  });

  it('skips empty values', async () => {
    const supabase = makeSupabase();
    const lavalinkStep = {
      id: 'lavalink',
      name: 'Lavalink',
      fieldToSettingsKey: { host: 'lavalink_host' },
    };
    await storeCredentials(supabase as any, lavalinkStep as any, {
      host: '',
    });
    // Should not upsert anything
  });
});

describe('enableFeatureFlag', () => {
  it('upserts flag in guild_config', async () => {
    const supabase = makeSupabase();
    await enableFeatureFlag(supabase as any, 'g1', 'commerce_enabled');
    expect(supabase.from).toHaveBeenCalledWith('guild_config');
  });
});
