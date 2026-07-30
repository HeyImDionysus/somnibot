/**
 * Cross-surface owner setup readiness proof.
 *
 * These tests keep the launcher setup contract and dashboard readiness routes
 * aligned without touching live Supabase, Discord, PayPal, or deployment state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/auto-config', () => ({
  ensureDiscordAuthProvider: vi.fn(),
  getDiscordAuthProviderStatus: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));
vi.mock('@/lib/paypal', () => ({
  applyRuntimePayPalEnv: vi.fn(),
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
// Keep readiness reads network-free: the reachability probe is exercised for
// real in setup-webhook-probe.test.ts and paypal-webhook-probe.test.ts.
vi.mock('@/lib/setup-webhook-probe', () => ({ getSetupWebhookReachability: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { GET as getSetupStatus } from '@/app/api/setup/route';
import { getSetupWebhookReachability } from '@/lib/setup-webhook-probe';
import { POST as createStoreProduct } from '@/app/api/store/products/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { notifyBot } from '@/lib/notify-bot';
import { getPayPalRuntimeConfig, getPayPalToken } from '@/lib/paypal';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getDiscordAuthProviderStatus } from '@/lib/supabase/auto-config';
import { buildRuntimeEnvVars } from '../../../launcher/src/main/runtime-profile';
import { buildSetupStatus } from '../../../launcher/src/main/setup-flow';
import type { ProviderValidationCheck } from '../../../launcher/src/main/validators';

import {
  buildRequest,
  createMockSupabase,
  mockAuthSuccess,
  mockRateLimitPass,
  registerTable,
} from './helpers';

const PUBLIC_CALLBACK_BASE = 'https://somnibot.tailnet.ts.net';
const PAYPAL_WEBHOOK_URL = `${PUBLIC_CALLBACK_BASE}/api/paypal/webhook`;

const paypalConfig = {
  apiBase: 'https://api-m.sandbox.paypal.com',
  clientId: 'paypal-client-id',
  clientSecret: 'paypal-client-secret',
  webhookId: 'WH-123',
  webhookUrl: PAYPAL_WEBHOOK_URL,
  sandbox: true,
  sources: {
    apiBase: 'derived',
    clientId: 'saved',
    clientSecret: 'saved',
    webhookId: 'saved',
    webhookUrl: 'saved',
    sandbox: 'saved',
  },
};

const paidSubscriptionBody = {
  name: 'Founder Pass',
  description: 'Founding member access',
  type: 'subscription',
  delivery_type: 'license_key',
  price_cents: 2500,
  currency: 'USD',
  granted_role_ids: [],
  granted_channel_ids: [],
  active: true,
  plans: [{
    name: 'Monthly',
    interval_unit: 'MONTH',
    interval_count: 1,
    price_cents: 2500,
  }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function ensureChainReturnsSelf(table: ReturnType<typeof registerTable>) {
  table.insert.mockReturnValue(table);
  table.select.mockReturnValue(table);
  table.eq.mockReturnValue(table);
}

function successfulProviderChecks(): ProviderValidationCheck[] {
  return [
    {
      id: 'discord-bot-token',
      label: 'Discord bot token',
      status: 'success',
      summary: 'Bot token belongs to SomniBot.',
    },
    {
      id: 'discord-application',
      label: 'Discord application',
      status: 'success',
      summary: 'Application ID matches the bot token.',
    },
    {
      id: 'discord-client-secret',
      label: 'Discord OAuth secret',
      status: 'success',
      summary: 'Client secret is present for Discord OAuth.',
    },
    {
      id: 'discord-guild',
      label: 'Discord server',
      status: 'success',
      summary: 'Bot can see the selected Discord server.',
    },
    {
      id: 'supabase-project',
      label: 'Supabase project',
      status: 'success',
      summary: 'Supabase URL and API keys are reachable.',
    },
  ];
}

function stepStatuses(status: ReturnType<typeof buildSetupStatus>): Record<string, string> {
  return Object.fromEntries(status.steps.map(step => [step.id, step.status]));
}

/**
 * The DB trigger `commerce_products_provision_license_config` guarantees a
 * `product_license_config` row for every licence-key product; the create route
 * verifies that rail held before reporting success (Finding 6). Model it here so
 * these PayPal-readiness cases exercise the readiness gates, not the rail.
 */
function registerProvisionedLicenseConfig(mock: ReturnType<typeof createMockSupabase>) {
  const table = registerTable(mock, 'product_license_config');
  table.upsert.mockResolvedValue({ error: null });
  table.select.mockReturnValue(table);
  table.eq.mockReturnValue(table);
  table.maybeSingle.mockResolvedValue({ data: { product_id: 'product-1' }, error: null });
  return table;
}

function configureReadySetupDatabase(mock: ReturnType<typeof createMockSupabase>) {
  const guildTable = registerTable(mock, 'guild');
  guildTable.limit
    .mockResolvedValueOnce({ error: null })
    .mockReturnThis();
  guildTable.maybeSingle.mockResolvedValue({
    data: { id: 'guild-1', name: 'Somni Guild' },
    error: null,
  });

  const diagnosticsTable = registerTable(mock, 'bot_diagnostics');
  diagnosticsTable.maybeSingle.mockResolvedValue({
    data: { snapshot_at: new Date().toISOString() },
    error: null,
  });

  const instanceSettingsTable = registerTable(mock, 'instance_settings');
  instanceSettingsTable.maybeSingle.mockResolvedValue({ data: null, error: null });

  registerProvisionedLicenseConfig(mock);

  return {
    productsTable: registerTable(mock, 'products'),
    plansTable: registerTable(mock, 'plans'),
  };
}

describe('owner setup readiness path', () => {
  const originalEnv = { ...process.env };
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      DASHBOARD_URL: 'http://localhost:3456',
      SOMNIBOT_PUBLIC_CALLBACK_BASE_URL: PUBLIC_CALLBACK_BASE,
      NEXT_PUBLIC_APP_URL: PUBLIC_CALLBACK_BASE,
      SOMNIBOT_PUBLIC_CALLBACK_REQUIRED: 'true',
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_CLIENT_SECRET: 'discord-client-secret',
      DISCORD_GUILD_ID: 'guild-1',
      PAYPAL_CLIENT_ID: paypalConfig.clientId,
      PAYPAL_CLIENT_SECRET: paypalConfig.clientSecret,
      PAYPAL_WEBHOOK_ID: paypalConfig.webhookId,
      PAYPAL_WEBHOOK_URL,
      PAYPAL_SANDBOX: 'true',
    };

    mock = createMockSupabase();
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    mockAuthSuccess(requireGuildOwner as ReturnType<typeof vi.fn>, { guildId: 'guild-1' });
    mockRateLimitPass(checkAdminRateLimit as ReturnType<typeof vi.fn>);
    (getDiscordAuthProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: true,
      providerEnabled: true,
      callbackAllowListReady: true,
      missingCallbackUrls: [],
      manualConfigured: false,
    });
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(paypalConfig);
    (getPayPalToken as ReturnType<typeof vi.fn>).mockResolvedValue('paypal-token');
    (getSetupWebhookReachability as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string | null) => (url
        ? {
          status: 'reachable',
          failureReason: null,
          detail: 'Signed probe echo verified.',
          checkedUrl: url,
          checkedAt: new Date().toISOString(),
        }
        : {
          status: 'skipped',
          failureReason: 'no-public-url',
          detail: 'Waiting on a validated public webhook URL.',
          checkedUrl: null,
          checkedAt: null,
        }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('proves regular-local setup, dashboard status, and paid Store readiness agree on the ready path', async () => {
    const { productsTable, plansTable } = configureReadySetupDatabase(mock);
    ensureChainReturnsSelf(productsTable);
    ensureChainReturnsSelf(plansTable);
    productsTable.single
      .mockResolvedValueOnce({
        data: {
          id: 'product-123',
          guild_id: 'guild-1',
          name: 'Founder Pass',
          type: 'subscription',
          paypal_product_id: 'PROD-123',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: 'product-123',
          guild_id: 'guild-1',
          name: 'Founder Pass',
          type: 'subscription',
          paypal_product_id: 'PROD-123',
          plans: [{ id: 'plan-db-123', paypal_plan_id: 'PLAN-123' }],
        },
        error: null,
      });
    plansTable.single.mockResolvedValueOnce({ data: { id: 'plan-db-123' }, error: null });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'PROD-123' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'PLAN-123' })));

    const setupResponse = await getSetupStatus(buildRequest('/api/setup'));
    const setupBody = await setupResponse.json();
    const runtimeEnv = buildRuntimeEnvVars({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: setupBody.publicCallbackBaseUrl,
    });
    const launcherStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: setupBody.publicCallbackBaseUrl,
      discordGuildId: setupBody.guildId,
      credentialReady: setupBody.supabaseConnected && setupBody.discordCredentialsPresent,
      providerValidation: {
        valid: true,
        errors: [],
        checks: successfulProviderChecks(),
      },
      supabaseDiscordAuthProviderStatus: setupBody.discordAuthProviderStatus,
      paypalReady: Boolean(
        setupBody.paypalWebhookUrl
        && process.env.PAYPAL_CLIENT_ID
        && process.env.PAYPAL_CLIENT_SECRET
        && process.env.PAYPAL_WEBHOOK_ID
      ),
      dashboardOnline: setupBody.botOnline,
      localServiceReadiness: {
        dashboard: 'online',
        bot: setupBody.botOnline ? 'online' : 'offline',
        lavalink: 'online',
        dashboardHealth: {
          ok: true,
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
        },
      },
    });

    expect(setupResponse.status).toBe(200);
    expect(setupBody).toMatchObject({
      supabaseConnected: true,
      databaseInitialized: true,
      botOnline: true,
      guildDetected: true,
      guildId: 'guild-1',
      dashboardUrl: PUBLIC_CALLBACK_BASE,
      operatorDashboardUrl: 'http://localhost:3456',
      publicCallbackBaseUrl: PUBLIC_CALLBACK_BASE,
      paypalWebhookUrl: PAYPAL_WEBHOOK_URL,
      publicCallbackReady: true,
      discordCredentialsPresent: true,
      discordAuthProviderReady: true,
      paypalWebhookReachable: true,
      paypalWebhookReachability: expect.objectContaining({
        status: 'reachable',
        checkedUrl: PAYPAL_WEBHOOK_URL,
      }),
    });
    expect(launcherStatus.primaryAction).toEqual({
      label: 'Set Up & Start',
      enabled: true,
      status: 'ready',
    });
    expect(launcherStatus.firstBlockingStepId).toBeNull();
    expect(stepStatuses(launcherStatus)).toEqual({
      'runtime-choice': 'success',
      'regular-callback': 'success',
      credentials: 'success',
      'discord-server': 'success',
      'provider-validation': 'success',
      'auth-provider': 'success',
      'paypal-webhook': 'success',
      'start-local': 'success',
    });
    expect(runtimeEnv).toMatchObject({
      DASHBOARD_URL: 'http://localhost:3456',
      NEXT_PUBLIC_APP_URL: PUBLIC_CALLBACK_BASE,
      PAYPAL_WEBHOOK_URL,
    });
    expect(launcherStatus.summary.diagnostics.paypalWebhookUrl).toBe(PAYPAL_WEBHOOK_URL);
    expect(launcherStatus.summary.authCallbackUrl).toBe(`${PUBLIC_CALLBACK_BASE}/api/auth/callback`);

    const productResponse = await createStoreProduct(buildRequest('/api/store/products', {
      method: 'POST',
      body: paidSubscriptionBody,
    }));
    const productBody = await productResponse.json();

    expect(productResponse.status).toBe(200);
    expect(productBody).toMatchObject({
      success: true,
      paypal_synced: true,
      plans_created: 1,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api-m.sandbox.paypal.com/v1/catalogs/products',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api-m.sandbox.paypal.com/v1/billing/plans',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(productsTable.insert).toHaveBeenCalledWith(expect.objectContaining({
      paypal_product_id: 'PROD-123',
      type: 'subscription',
    }));
    expect(plansTable.insert).toHaveBeenCalledWith(expect.objectContaining({
      paypal_plan_id: 'PLAN-123',
      product_id: 'product-123',
    }));
    expect(notifyBot).toHaveBeenCalledWith('commerce', { product_created: 'product-123' });
  });

  it('keeps the owner path blocked when public callback and PayPal webhook readiness are not proven', async () => {
    process.env.SOMNIBOT_PUBLIC_CALLBACK_BASE_URL = 'http://localhost:3456';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3456';
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_URL;
    configureReadySetupDatabase(mock);
    (getPayPalRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...paypalConfig,
      webhookId: '',
      sources: {
        ...paypalConfig.sources,
        webhookId: 'missing',
      },
    });
    vi.stubGlobal('fetch', vi.fn());

    const setupResponse = await getSetupStatus(buildRequest('/api/setup'));
    const setupBody = await setupResponse.json();
    const launcherStatus = buildSetupStatus({
      runtimeMode: 'regular-local',
      publicCallbackBaseUrl: setupBody.publicCallbackBaseUrl,
      discordGuildId: setupBody.guildId,
      credentialReady: true,
      providerValidation: {
        valid: true,
        errors: [],
        checks: successfulProviderChecks(),
      },
      supabaseDiscordAuthProviderStatus: setupBody.discordAuthProviderStatus,
      paypalReady: false,
      dashboardOnline: true,
      localServiceReadiness: {
        dashboard: 'online',
        bot: 'online',
        lavalink: 'online',
        dashboardHealth: {
          ok: true,
          status: 'healthy',
          services: {
            config: 'valid',
            valkey: 'connected',
            bot: 'online',
          },
        },
      },
    });

    expect(setupResponse.status).toBe(200);
    expect(setupBody).toMatchObject({
      publicCallbackRequired: true,
      publicCallbackReady: false,
      publicCallbackError: 'Public callback URL must use HTTPS before setup can finalize.',
      paypalWebhookUrl: null,
      paypalWebhookReady: false,
      paypalWebhookError: 'Public callback URL must use HTTPS before setup can finalize.',
      paypalWebhookReachable: false,
      paypalWebhookReachability: expect.objectContaining({ status: 'skipped' }),
    });
    expect(launcherStatus.firstBlockingStepId).toBe('regular-callback');
    expect(launcherStatus.primaryAction).toMatchObject({
      enabled: false,
      status: 'blocked',
    });
    expect(stepStatuses(launcherStatus)).toMatchObject({
      'regular-callback': 'recoverable-error',
      'paypal-webhook': 'pending',
    });

    const productResponse = await createStoreProduct(buildRequest('/api/store/products', {
      method: 'POST',
      body: paidSubscriptionBody,
    }));
    const productBody = await productResponse.json();

    expect(productResponse.status).toBe(424);
    expect(productBody).toEqual({
      success: false,
      error: 'PayPal is not ready. Configure PayPal Webhook ID before creating paid products.',
    });
    expect(getPayPalToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mock._tables.products?.insert).not.toHaveBeenCalled();
    expect(mock._tables.plans?.insert).not.toHaveBeenCalled();
  });
});
