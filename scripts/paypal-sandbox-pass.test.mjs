import assert from 'node:assert/strict';
import test from 'node:test';
import { runPayPalSandboxPass } from './paypal-sandbox-pass.mjs';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('sandbox pass verifies reporting, disputes, and PayPal request id replay', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return response(200, { access_token: 'token' });
    if (url.includes('/v1/reporting/transactions?')) return response(200, { transaction_details: [] });
    if (url.includes('/v1/customer/disputes?')) return response(200, { items: [] });
    if (url.endsWith('/v2/checkout/orders')) {
      return response(201, { id: 'ORDER-1', status: 'CREATED', links: [{ rel: 'approve' }] });
    }
    return response(404, {});
  };

  const result = await runPayPalSandboxPass({
    fetchImpl,
    env: {
      PAYPAL_SANDBOX: 'true',
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      PAYPAL_CLIENT_ID: 'client',
      PAYPAL_CLIENT_SECRET: 'secret',
    },
    requestId: 'stable-request',
    now: new Date('2026-07-30T20:00:00.000Z'),
  });

  assert.equal(result.idempotency.sameOrderOnReplay, true);
  assert.equal(result.transactionSearch.permissionVerified, true);
  assert.equal(result.ok, true);
  assert.equal(calls.filter((call) => call.url.endsWith('/v2/checkout/orders')).length, 2);
  assert.equal(
    calls.filter((call) => call.url.endsWith('/v2/checkout/orders'))
      .every((call) => call.init.headers['PayPal-Request-Id'] === 'stable-request'),
    true,
  );
});

test('sandbox pass continues independent probes after Transaction Search is denied', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/oauth2/token')) return response(200, { access_token: 'token' });
    if (url.includes('/v1/reporting/transactions?')) {
      return response(403, { name: 'NOT_AUTHORIZED' });
    }
    if (url.includes('/v1/customer/disputes?')) return response(200, { items: [] });
    if (url.endsWith('/v2/checkout/orders')) {
      return response(201, { id: 'ORDER-1', status: 'CREATED', links: [{ rel: 'approve' }] });
    }
    return response(404, {});
  };

  const result = await runPayPalSandboxPass({
    fetchImpl,
    env: {
      PAYPAL_SANDBOX: 'true',
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      PAYPAL_CLIENT_ID: 'client',
      PAYPAL_CLIENT_SECRET: 'secret',
    },
    requestId: 'stable-request',
  });

  assert.equal(result.ok, false);
  assert.equal(result.transactionSearch.permissionVerified, false);
  assert.equal(result.disputes.responseShapeVerified, true);
  assert.equal(result.idempotency.sameOrderOnReplay, true);
});

test('sandbox pass refuses a live PayPal base before making a request', async () => {
  let called = false;
  await assert.rejects(
    runPayPalSandboxPass({
      fetchImpl: async () => {
        called = true;
        return response(500, {});
      },
      env: {
        PAYPAL_SANDBOX: 'true',
        PAYPAL_API_BASE: 'https://api-m.paypal.com',
        PAYPAL_CLIENT_ID: 'client',
        PAYPAL_CLIENT_SECRET: 'secret',
      },
    }),
    /Refusing to run/,
  );
  assert.equal(called, false);
});
