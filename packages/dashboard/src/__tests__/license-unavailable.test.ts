/**
 * "We could not determine your licence status" is NOT "your licence is
 * revoked".
 *
 * These routes decide whether a paying customer's software keeps running. Every
 * one of them used to answer a DATABASE FAILURE with a verdict:
 *
 *   - validate   : RPC error → HTTP 500 `{ valid:false, status:'revoked' }`
 *   - heartbeat  : destructured only `{ data }`, so any query error became
 *                  `data === null` became `status: 'revoked'`
 *   - downloads  : query error → 403 "No active entitlement for this product"
 *
 * and the SDK treats `valid:false` as terminal — it clears its cache and stops
 * heartbeating for good. A one-second hiccup therefore cost a paying customer
 * their session until they restarted the app, and told them they had been
 * revoked while it happened.
 *
 * The rule these tests pin: a verdict may only be returned for a state the
 * server actually read. A failed read is HTTP 503 + 'service_unavailable',
 * which `@somnibot/license-sdk` handles non-terminally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/rate-limit', () => ({
  rateLimits: {
    licenseValidate: vi.fn().mockResolvedValue({ limited: false, remaining: 29, retryAfterMs: 0 }),
    licensePerKey: vi.fn().mockResolvedValue({ limited: false, remaining: 59, retryAfterMs: 0 }),
    licenseFailedAttempt: vi.fn().mockResolvedValue({ limited: false, remaining: 4, retryAfterMs: 0 }),
    licenseHeartbeat: vi.fn().mockResolvedValue({ limited: false, remaining: 19, retryAfterMs: 0 }),
    portalDownload: vi.fn().mockResolvedValue({ limited: false, retryAfterMs: 0 }),
  },
}));
vi.mock('@/lib/api/signed-url', () => ({
  verifySignedDownloadUrl: vi.fn(() => ({ customerId: 'cust-1', guildId: 'guild-1', nonce: undefined })),
}));
vi.mock('@/lib/api/download-nonce', () => ({
  consumeDownloadNonce: vi.fn().mockResolvedValue('consumed'),
}));

import { NextRequest } from 'next/server';
import { POST as validatePost } from '@/app/api/license/validate/route';
import { POST as heartbeatPost } from '@/app/api/license/heartbeat/route';
import { GET as downloadGet } from '@/app/api/downloads/[productId]/[fileId]/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  createMockSupabase,
  registerTable,
  buildRequest,
} from './helpers';

const PRODUCT_ID = '00000000-0000-4000-a000-000000000001';
const FILE_ID = '00000000-0000-4000-a000-0000000000f1';
const SESSION_ID = '00000000-0000-4000-a000-0000000000s1'.replace('s1', 'e1');

/** A PostgREST-shaped failure. Supabase builders resolve, they do not reject. */
const DB_DOWN = { message: 'could not connect to server: Connection refused', code: '08006' };

type EntitlementFixture = {
  id: string;
  license_key_id: string;
  status: string;
  grace_period_ends_at: string | null;
  updated_at: string;
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ───────────────────────── validate ─────────────────────────

describe('POST /api/license/validate — a failed lookup is not a revocation', () => {
  function setup(rpcResult: { data: unknown; error: unknown }) {
    const mock = Object.assign(createMockSupabase(), {
      rpc: vi.fn().mockResolvedValue(rpcResult),
    });
    const validations = registerTable(mock, 'license_validations');
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return { mock, validations };
  }

  function req() {
    return buildRequest('/api/license/validate', {
      method: 'POST',
      body: { license_key: 'SOMNI-TEST-1234-ABCD', product_id: PRODUCT_ID },
    });
  }

  it('answers 503 service_unavailable — never "revoked" — when the lookup RPC fails', async () => {
    setup({ data: null, error: DB_DOWN });

    const res = await validatePost(req() as never);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('service_unavailable');
    expect(body.status).not.toBe('revoked');
    expect(body.valid).toBe(false);
    expect(body.retryable).toBe(true);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not leak the database error text to the caller', async () => {
    setup({ data: null, error: DB_DOWN });

    const body = await (await validatePost(req() as never)).json();
    expect(JSON.stringify(body)).not.toContain('Connection refused');
    // …but it IS logged server-side for the operator.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('license_validate_lookup'),
      expect.stringContaining('Connection refused'),
    );
  });

  it('records the outage in the forensic ledger as "unavailable", not as a rejection', async () => {
    const { validations } = setup({ data: null, error: DB_DOWN });

    await validatePost(req() as never);

    expect(validations.insert).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'unavailable', product_id: PRODUCT_ID }),
    );
  });

  it('still reports a genuine "key not found" as invalid', async () => {
    // The other side of the split: a lookup that SUCCEEDS and finds nothing is
    // a real verdict and must keep its teeth.
    setup({ data: { found: false }, error: null });

    const res = await validatePost(req() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.status).toBe('revoked');
  });
});

// ───────────────────────── heartbeat ─────────────────────────

describe('POST /api/license/heartbeat — heartbeats survive a transient fault', () => {
  function atomicDecision(
    rows: EntitlementFixture[],
    key: { id: string; status: string } | null,
    session: { active: boolean } | null,
  ) {
    const decisionAt = new Date().toISOString();
    let chosen: EntitlementFixture | undefined;

    if (key?.status === 'active') {
      chosen = rows
        .filter((row) => row.status === 'active')
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      chosen ??= rows
        .filter((row) => (
          row.status === 'grace_period'
          && row.grace_period_ends_at !== null
          && !(row.grace_period_ends_at < decisionAt)
        ))
        .sort((left, right) => (
          right.grace_period_ends_at!.localeCompare(left.grace_period_ends_at!)
          || left.id.localeCompare(right.id)
        ))[0];
      chosen ??= rows
        .filter((row) => row.status === 'grace_period')
        .sort((left, right) => (
          (right.grace_period_ends_at ?? '').localeCompare(left.grace_period_ends_at ?? '')
          || left.id.localeCompare(right.id)
        ))[0];
      chosen ??= rows
        .filter((row) => row.status !== 'active' && row.status !== 'grace_period')
        .sort((left, right) => (
          right.updated_at.localeCompare(left.updated_at)
          || left.id.localeCompare(right.id)
        ))[0];
    }

    let status = key?.status ?? 'revoked';
    if (key?.status === 'active') {
      if (!chosen) {
        status = 'revoked';
      } else if (
        chosen.status === 'grace_period'
        && chosen.grace_period_ends_at === null
      ) {
        status = 'malformed';
      } else if (
        chosen.status === 'grace_period'
        && chosen.grace_period_ends_at! < decisionAt
      ) {
        status = 'expired';
      } else {
        status = chosen.status;
      }
    }

    const liveEntitlement = status === 'active' || status === 'grace_period';
    const sessionTouched = liveEntitlement && session?.active === true;
    if (liveEntitlement && !sessionTouched) status = 'session_invalidated';

    return {
      entitlement_id: chosen?.id ?? null,
      status,
      grace_period_ends_at: chosen?.grace_period_ends_at ?? null,
      decided_at: decisionAt,
      candidate_count: key ? rows.length : 0,
      session_touched: sessionTouched,
      next_heartbeat_seconds: 300,
    };
  }

  /**
   * Model the consolidated RPC result. Any internal read/touch error rejects
   * the whole database statement, so each override states which dependency
   * made the decision indeterminate.
   */
  function setup(over: {
    key?: { data: unknown; error: unknown };
    entitlements?: { data: unknown; error: unknown };
    session?: { data: unknown; error: unknown };
    touch?: { error: unknown };
  } = {}) {
    const mock = createMockSupabase();
    const keyResult = over.key
      ?? { data: { id: 'key-1', status: 'active', product_id: PRODUCT_ID }, error: null };
    const entitlementResult = over.entitlements
      ?? { data: [{ status: 'active', grace_period_ends_at: null }], error: null };
    const entitlementRows = (
      Array.isArray(entitlementResult.data) ? entitlementResult.data : []
    ).map((candidate, index) => {
      const row = candidate as Partial<EntitlementFixture>;
      return {
        id: row.id ?? `entitlement-${index}`,
        license_key_id: row.license_key_id ?? 'key-1',
        status: row.status ?? 'cancelled',
        grace_period_ends_at: row.grace_period_ends_at ?? null,
        updated_at: row.updated_at ?? new Date(index).toISOString(),
      };
    });
    const sessionResult = over.session
      ?? { data: { id: SESSION_ID, active: true }, error: null };
    const rpcError = keyResult.error
      ?? entitlementResult.error
      ?? sessionResult.error
      ?? over.touch?.error
      ?? null;
    mock.rpc.mockResolvedValue({
      data: rpcError
        ? null
        : atomicDecision(
          entitlementRows,
          keyResult.data as { id: string; status: string } | null,
          sessionResult.data as { active: boolean } | null,
        ),
      error: rpcError,
    });
    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return mock;
  }

  function req() {
    return buildRequest('/api/license/heartbeat', {
      method: 'POST',
      body: { license_key: 'SOMNI-TEST-1234-ABCD', session_id: SESSION_ID },
    });
  }

  it('answers 503 — never "revoked" — when the key lookup fails', async () => {
    setup({ key: { data: null, error: DB_DOWN } });

    const res = await heartbeatPost(req() as never);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('service_unavailable');
    expect(body.status).not.toBe('revoked');
    // Shape contract: heartbeat responses always carry this field.
    expect(body.next_heartbeat_seconds).toBe(0);
  });

  it('answers 503 when the entitlement lookup fails', async () => {
    setup({ entitlements: { data: null, error: DB_DOWN } });

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.status).toBe('service_unavailable');
  });

  it('answers 503 when the session lookup fails — not "session_invalidated"', async () => {
    setup({ session: { data: null, error: DB_DOWN } });

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.status).toBe('service_unavailable');
    expect(body.status).not.toBe('session_invalidated');
  });

  it('answers 503 when the keepalive write fails, rather than a false "all good"', async () => {
    // A heartbeat that recorded nothing did not keep the session alive; the
    // reaper will time it out. Saying `valid:true` would be a lie the client
    // acts on.
    setup({ touch: { error: DB_DOWN } });

    const res = await heartbeatPost(req() as never);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe('service_unavailable');
  });

  it('still reports a genuinely unknown key as revoked', async () => {
    setup({ key: { data: null, error: null } });

    const res = await heartbeatPost(req() as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.status).toBe('revoked');
  });

  it('still reports a genuinely deactivated session as session_invalidated', async () => {
    setup({ session: { data: { id: SESSION_ID, active: false }, error: null } });

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.valid).toBe(false);
    expect(body.status).toBe('session_invalidated');
  });

  it('keeps a customer alive when they hold several entitlement rows for one key', async () => {
    // `.single()` errors on multiple rows, and the old code turned that error
    // into `status: 'revoked'` — a customer who re-bought the product was told
    // their licence was cancelled.
    setup({
      entitlements: {
        data: [
          { status: 'cancelled', grace_period_ends_at: null },
          { status: 'active', grace_period_ends_at: null },
        ],
        error: null,
      },
    });

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.status).toBe('active');
  });

  function setupManyEntitlements(rows: EntitlementFixture[]) {
    return setup({
      entitlements: {
        data: rows,
        error: null,
      },
    });
  }

  it('finds an active entitlement after 50 dead rows without a client-side scan', async () => {
    const rows: EntitlementFixture[] = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `dead-${index}`,
        license_key_id: 'key-1',
        status: 'cancelled',
        grace_period_ends_at: null,
        updated_at: new Date(index).toISOString(),
      })),
      {
        id: 'live-active',
        license_key_id: 'key-1',
        status: 'active',
        grace_period_ends_at: null,
        updated_at: new Date(51).toISOString(),
      },
    ];
    const mock = setupManyEntitlements(rows);

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.status).toBe('active');
    expect(mock.from).not.toHaveBeenCalledWith('entitlements');
  });

  it('finds an unexpired grace entitlement after 50 dead rows without a client-side scan', async () => {
    const graceDeadline = new Date(Date.now() + 60_000).toISOString();
    const rows: EntitlementFixture[] = [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `dead-${index}`,
        license_key_id: 'key-1',
        status: 'cancelled',
        grace_period_ends_at: null,
        updated_at: new Date(index).toISOString(),
      })),
      {
        id: 'live-grace',
        license_key_id: 'key-1',
        status: 'grace_period',
        grace_period_ends_at: graceDeadline,
        updated_at: new Date(51).toISOString(),
      },
    ];
    const mock = setupManyEntitlements(rows);

    const body = await (await heartbeatPost(req() as never)).json();
    expect(body.valid).toBe(true);
    expect(body.status).toBe('grace_period');
    expect(body.grace_period_ends_at).toBe(graceDeadline);
    expect(mock.from).not.toHaveBeenCalledWith('entitlements');
  });

  it('reports a lapsed payment grace as expired, and an unexpired one as still valid', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    setup({ entitlements: { data: [{ status: 'grace_period', grace_period_ends_at: past }], error: null } });
    expect((await (await heartbeatPost(req() as never)).json()).status).toBe('expired');

    const future = new Date(Date.now() + 60_000).toISOString();
    setup({ entitlements: { data: [{ status: 'grace_period', grace_period_ends_at: future }], error: null } });
    const live = await (await heartbeatPost(req() as never)).json();
    expect(live.valid).toBe(true);
    expect(live.status).toBe('grace_period');
  });
});

// ───────────────────────── downloads ─────────────────────────

describe('GET /api/downloads/[productId]/[fileId] — a failed check is not a refusal', () => {
  function setup(over: {
    entitlements?: { data: unknown; error: unknown };
    file?: { data: unknown; error: unknown };
  } = {}) {
    const mock = createMockSupabase();

    const entitlements = registerTable(mock, 'entitlements');
    entitlements.in.mockResolvedValue(
      over.entitlements ?? { data: [{ id: 'ent-1', status: 'active', grace_period_ends_at: null }], error: null },
    );

    const files = registerTable(mock, 'product_files');
    files.maybeSingle.mockResolvedValue(
      over.file ?? { data: { id: FILE_ID, file_path: 'p/f.zip' }, error: null },
    );

    (mock as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn().mockResolvedValue({ error: null });
    (mock as unknown as { storage: unknown }).storage = {
      from: vi.fn().mockReturnValue({
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://s.example/x' }, error: null }),
      }),
    };

    (createAdminSupabase as ReturnType<typeof vi.fn>).mockReturnValue(mock);
    return mock;
  }

  function req() {
    const sp = new URLSearchParams({
      sig: 's',
      exp: String(Math.floor(Date.now() / 1000) + 300),
      cid: 'cust-1',
      gid: 'guild-1',
    });
    return new NextRequest(`http://localhost/api/downloads/${PRODUCT_ID}/${FILE_ID}?${sp.toString()}`);
  }

  const params = { params: Promise.resolve({ productId: PRODUCT_ID, fileId: FILE_ID }) };

  it('answers 503 — never 403 "no entitlement" — when the entitlement query fails', async () => {
    setup({ entitlements: { data: null, error: DB_DOWN } });

    const res = await downloadGet(req() as never, params);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(403);
    expect(body.retryable).toBe(true);
    expect(body.error).not.toMatch(/no active entitlement/i);
  });

  it('answers 503 — never 404 — when the file lookup fails', async () => {
    setup({ file: { data: null, error: DB_DOWN } });

    const res = await downloadGet(req() as never, params);
    expect(res.status).toBe(503);
  });

  it('still refuses a customer who genuinely has no entitlement', async () => {
    setup({ entitlements: { data: [], error: null } });

    const res = await downloadGet(req() as never, params);
    expect(res.status).toBe(403);
  });

  it('still 404s a file that genuinely does not exist', async () => {
    setup({ file: { data: null, error: null } });

    const res = await downloadGet(req() as never, params);
    expect(res.status).toBe(404);
  });
});
