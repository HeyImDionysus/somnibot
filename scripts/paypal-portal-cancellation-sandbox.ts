import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

class VerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'VerificationError';
    this.code = code;
  }
}

type SandboxConfig = {
  readonly evidencePath: string;
  readonly dashboardUrl: string;
  readonly portalToken: string;
  readonly entitlementId: string;
  readonly cancellationTiming: 'immediate' | 'end-of-term';
  readonly supabaseUrl: string;
  readonly supabaseKey: string;
  readonly paypalClientId: string;
  readonly paypalClientSecret: string;
};

const entitlementSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  cancelled_at: z.string().datetime().nullable(),
  portal_cancellation_timing: z.enum(['immediate', 'end-of-term']).nullable(),
});

const orderSchema = z.object({
  paypal_subscription_id: z.string().min(1),
});

const operationSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  status: z.literal('completed'),
  provider_http_status: z.number().int().nullable(),
  provider_status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']).nullable(),
  reconciliation_state: z.enum(['not_required', 'pending', 'confirmed_cancelled', 'confirmed_active', 'unavailable']),
});

const routeResponseSchema = z.object({
  success: z.literal(true),
  deduped: z.boolean(),
  message: z.literal('cancellation-scheduled'),
});

const providerSchema = z.object({
  id: z.string(),
  status: z.literal('CANCELLED'),
});

function requiredEnvironment(primary: string, fallback?: string): string {
  const value = process.env[primary]?.trim() || (fallback ? process.env[fallback]?.trim() : undefined);
  if (!value) throw new VerificationError(`missing_environment:${primary}`);
  return value;
}

function loadConfig(): SandboxConfig {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const evidenceArg = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  if (!evidenceArg) throw new VerificationError('missing_argument:evidence');
  const cancellationTiming = requiredEnvironment('SOMNIBOT_PORTAL_CANCELLATION_TIMING');
  if (cancellationTiming !== 'immediate' && cancellationTiming !== 'end-of-term') {
    throw new VerificationError('invalid_environment:SOMNIBOT_PORTAL_CANCELLATION_TIMING');
  }
  const paypalEnvironment = requiredEnvironment('PAYPAL_ENVIRONMENT');
  if (paypalEnvironment !== 'sandbox') {
    throw new VerificationError('production_paypal_forbidden');
  }
  return {
    evidencePath: resolve(evidenceArg),
    dashboardUrl: requiredEnvironment('SOMNIBOT_DASHBOARD_URL').replace(/\/$/, ''),
    portalToken: requiredEnvironment('SOMNIBOT_PORTAL_TOKEN'),
    entitlementId: requiredEnvironment('SOMNIBOT_PORTAL_ENTITLEMENT_ID'),
    cancellationTiming,
    supabaseUrl: requiredEnvironment('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: requiredEnvironment('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    paypalClientId: requiredEnvironment('PAYPAL_CLIENT_ID'),
    paypalClientSecret: requiredEnvironment('PAYPAL_CLIENT_SECRET'),
  };
}

async function readJson(response: Response, code: string): Promise<unknown> {
  if (!response.ok) throw new VerificationError(`${code}:http_${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error) throw new VerificationError(`${code}:invalid_json`);
    throw error;
  }
}

async function selectRows(
  config: SandboxConfig,
  resource: string,
): Promise<unknown> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${resource}`, {
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    },
  });
  return readJson(response, 'supabase_read_failed');
}

async function paypalAccessToken(config: SandboxConfig): Promise<string> {
  const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const parsed = z.object({ access_token: z.string().min(1) }).safeParse(
    await readJson(response, 'paypal_oauth_failed'),
  );
  if (!parsed.success) throw new VerificationError('paypal_oauth_failed:invalid_response');
  return parsed.data.access_token;
}

async function writeEvidence(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function verifySandbox(config: SandboxConfig): Promise<Readonly<Record<string, unknown>>> {
  const beforeRows = z.array(entitlementSchema).parse(await selectRows(
    config,
    `entitlements?id=eq.${encodeURIComponent(config.entitlementId)}&select=id,order_id,cancelled_at,portal_cancellation_timing`,
  ));
  const before = beforeRows[0];
  if (!before) throw new VerificationError('entitlement_not_found');
  const orderRows = z.array(orderSchema).parse(await selectRows(
    config,
    `orders?id=eq.${encodeURIComponent(before.order_id)}&select=paypal_subscription_id`,
  ));
  const order = orderRows[0];
  if (!order) throw new VerificationError('order_not_found');

  const routeResponse = await fetch(`${config.dashboardUrl}/api/portal/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-portal-token': config.portalToken,
    },
    body: JSON.stringify({
      entitlement_id: config.entitlementId,
      cancellation_timing: config.cancellationTiming,
    }),
  });
  const routeResult = routeResponseSchema.safeParse(
    await readJson(routeResponse, 'portal_cancel_failed'),
  );
  if (!routeResult.success) throw new VerificationError('portal_cancel_failed:invalid_response');

  const afterRows = z.array(entitlementSchema).parse(await selectRows(
    config,
    `entitlements?id=eq.${encodeURIComponent(config.entitlementId)}&select=id,order_id,cancelled_at,portal_cancellation_timing`,
  ));
  const after = afterRows[0];
  if (!after?.cancelled_at) throw new VerificationError('local_cancellation_unconfirmed');
  const operationRows = z.array(operationSchema).parse(await selectRows(
    config,
    `portal_cancellation_operations?entitlement_id=eq.${encodeURIComponent(config.entitlementId)}&select=id,request_id,status,provider_http_status,provider_status,reconciliation_state`,
  ));
  if (operationRows.length !== 1) throw new VerificationError('operation_identity_count_mismatch');
  const operation = operationRows[0];
  if (!operation) throw new VerificationError('operation_not_found');
  const auditRows = z.array(z.object({ occurrence_key: z.string() })).parse(await selectRows(
    config,
    `audit_logs?occurrence_key=eq.${encodeURIComponent(`portal.cancellation_succeeded:${operation.id}`)}&select=occurrence_key`,
  ));
  if (auditRows.length !== 1) throw new VerificationError('success_audit_count_mismatch');

  const providerToken = await paypalAccessToken(config);
  const providerResponse = await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${encodeURIComponent(order.paypal_subscription_id)}`,
    { headers: { Authorization: `Bearer ${providerToken}` } },
  );
  const provider = providerSchema.safeParse(await readJson(providerResponse, 'paypal_readback_failed'));
  if (!provider.success || provider.data.id !== order.paypal_subscription_id) {
    throw new VerificationError('paypal_readback_failed:identity_or_status');
  }

  return {
    passed: true,
    observed_at: new Date().toISOString(),
    dashboard_origin: new URL(config.dashboardUrl).origin,
    entitlement_id: config.entitlementId,
    local_cancelled_at: after.cancelled_at,
    cancellation_timing: after.portal_cancellation_timing,
    operation_id: operation.id,
    provider_request_id: operation.request_id,
    operation_status: operation.status,
    provider_http_status: operation.provider_http_status,
    provider_status: provider.data.status,
    reconciliation_state: operation.reconciliation_state,
    success_audit_count: auditRows.length,
    route_deduped: routeResult.data.deduped,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const evidence = await verifySandbox(config);
  await writeEvidence(config.evidencePath, evidence);
  process.stdout.write(`${config.evidencePath}\n`);
}

void main().catch(async (error: unknown) => {
  const evidenceIndex = process.argv.indexOf('--evidence');
  const evidenceArg = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  const code = error instanceof VerificationError ? error.code : 'unexpected_verification_failure';
  if (evidenceArg) {
    await writeEvidence(resolve(evidenceArg), {
      passed: false,
      observed_at: new Date().toISOString(),
      blocker: code,
    });
  }
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
