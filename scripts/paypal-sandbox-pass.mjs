#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function assertSandboxBase(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api-m.sandbox.paypal.com') {
    throw new Error('Refusing to run: PAYPAL_API_BASE must be https://api-m.sandbox.paypal.com');
  }
  return parsed.origin;
}

async function paypalRequest(fetchImpl, base, token, path, init = {}) {
  const response = await fetchImpl(`${base}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const issue = body?.name || body?.error || body?.message || `HTTP ${response.status}`;
    throw new Error(`${path} failed: ${issue} (${response.status})`);
  }
  return { status: response.status, body };
}

export async function runPayPalSandboxPass({
  fetchImpl = fetch,
  env = process.env,
  now = new Date(),
  requestId = `somnibot-sandbox-${randomUUID()}`,
} = {}) {
  if (env.PAYPAL_SANDBOX !== undefined && env.PAYPAL_SANDBOX !== 'true') {
    throw new Error('Refusing to run: PAYPAL_SANDBOX must be true');
  }
  const base = assertSandboxBase(env.PAYPAL_API_BASE || SANDBOX_BASE);
  const clientId = requireText(env.PAYPAL_CLIENT_ID, 'PAYPAL_CLIENT_ID');
  const clientSecret = requireText(env.PAYPAL_CLIENT_SECRET, 'PAYPAL_CLIENT_SECRET');

  const tokenResponse = await fetchImpl(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const tokenBody = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || typeof tokenBody?.access_token !== 'string') {
    throw new Error(`PayPal sandbox authentication failed (${tokenResponse.status})`);
  }
  const token = tokenBody.access_token;

  const end = new Date(now);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const reportingQuery = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    fields: 'all',
    page_size: '10',
  });
  let transactionSearchResult;
  try {
    const transactionSearch = await paypalRequest(
      fetchImpl,
      base,
      token,
      `/v1/reporting/transactions?${reportingQuery}`,
    );
    if (!Array.isArray(transactionSearch.body?.transaction_details)) {
      throw new Error('Transaction Search response did not contain transaction_details[]');
    }
    transactionSearchResult = {
      permissionVerified: true,
      responseShapeVerified: true,
      returnedTransactions: transactionSearch.body.transaction_details.length,
    };
  } catch (error) {
    transactionSearchResult = {
      permissionVerified: false,
      responseShapeVerified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let disputesResult;
  try {
    const disputes = await paypalRequest(
      fetchImpl,
      base,
      token,
      '/v1/customer/disputes?page_size=10',
    );
    if (!Array.isArray(disputes.body?.items)) {
      throw new Error('Disputes response did not contain items[]');
    }
    disputesResult = {
      responseShapeVerified: true,
      returnedDisputes: disputes.body.items.length,
    };
  } catch (error) {
    disputesResult = {
      responseShapeVerified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const orderPayload = JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: requestId,
      custom_id: requestId,
      amount: { currency_code: 'USD', value: '1.00' },
    }],
  });
  const createOrder = () => paypalRequest(
    fetchImpl,
    base,
    token,
    '/v2/checkout/orders',
    {
      method: 'POST',
      headers: { 'PayPal-Request-Id': requestId },
      body: orderPayload,
    },
  );
  let idempotencyResult;
  try {
    const firstOrder = await createOrder();
    const replayOrder = await createOrder();
    const firstId = requireText(firstOrder.body?.id, 'PayPal order id');
    const replayId = requireText(replayOrder.body?.id, 'PayPal replay order id');
    if (firstId !== replayId) {
      throw new Error('PayPal-Request-Id replay returned a different order id');
    }
    if (!Array.isArray(firstOrder.body?.links) || firstOrder.body.links.length === 0) {
      throw new Error('Order response did not contain links[]');
    }
    idempotencyResult = {
      requestId,
      orderId: firstId,
      sameOrderOnReplay: true,
      firstStatus: firstOrder.body.status,
      replayStatus: replayOrder.body.status,
    };
  } catch (error) {
    idempotencyResult = {
      requestId,
      sameOrderOnReplay: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const ok = transactionSearchResult.permissionVerified
    && transactionSearchResult.responseShapeVerified
    && disputesResult.responseShapeVerified
    && idempotencyResult.sameOrderOnReplay;

  return {
    ok,
    sandbox: true,
    transactionSearch: transactionSearchResult,
    disputes: disputesResult,
    idempotency: idempotencyResult,
    note: 'The created sandbox order is unapproved and captures no money; PayPal expires it automatically.',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPayPalSandboxPass()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`PayPal sandbox pass failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
