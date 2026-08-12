/**
 * Regression guard on real money: an owner refund is NEVER undoable.
 *
 * `/api/orders/[id]/refund` is the only dashboard route that moves real funds
 * out of the owner's PayPal account. PayPal has no "un-refund" — once a capture
 * is refunded the money is gone and the customer would have to buy the product
 * again. The undo route replays a stored payload as a row `.update()`, so the
 * only thing an undo could do here is flip `orders.status` back to 'completed'.
 * That would make the Admin Changes page show a working "Undo" button whose
 * effect is to tell the owner their money came back while PayPal's ledger says
 * it did not. This project has already been burned once by blurring the fake
 * in-server coin economy with the real PayPal store; a false refund reversal is
 * the same class of harm, pointed at the owner's own accounts.
 *
 * Unlike the wiring tests in `commerce-routes-record-admin-changes.test.ts`,
 * this file does NOT stub the recorder. It drives the real
 * `recordAdminChange` and asserts on the row that actually reaches
 * `admin_changes` — because `is_undoable` and `undo_payload` are what the
 * dashboard reads to decide whether to render the button, and a stubbed
 * recorder could never prove they are right.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/paypal', () => ({
  getPayPalRuntimeConfig: vi.fn(),
  getPayPalToken: vi.fn(),
}));

import { POST } from '@/app/api/orders/[id]/refund/route';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface Recorded {
  guild_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  description: string;
  before_state: unknown;
  after_state: unknown;
  undo_payload: unknown;
  is_undoable: boolean;
  blast_radius: string;
  requires_confirmation: boolean;
}

let recorded: Recorded[];
let ordersRow: Record<string, unknown> | null;

/** The frozen attempt the prepare RPC hands back: a real captured payment. */
function paidAttempt(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    attempt_id: ATTEMPT_ID,
    request_id: ATTEMPT_ID,
    status: 'provider_completed',
    provider_action: 'finalize',
    resource_type: 'capture',
    paypal_payment_id: 'CAPTURE-123',
    paypal_refund_id: 'REFUND-123',
    refund_amount_cents: 1999,
    currency: 'USD',
    reason: 'Admin refund',
    actor_id: ACTOR,
    ...overrides,
  };
}

function finalization(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    attempt_id: ATTEMPT_ID,
    status: 'completed',
    order_status: 'refunded',
    already_refunded: false,
    entitlements_changed: 1,
    licenses_changed: 1,
    sessions_changed: 1,
    paypal_refund_id: 'REFUND-123',
    ...overrides,
  };
}

/**
 * A client that captures every `admin_changes` insert and answers the single
 * `orders` read the route makes before finalization.
 */
function client(attempt: Record<string, unknown>, result: Record<string, unknown>) {
  const ordersChain: Record<string, Mock> = {};
  for (const method of ['select', 'eq']) {
    ordersChain[method] = vi.fn(() => ordersChain);
  }
  // Snapshot at call time so a read taken after finalization sees the flip.
  ordersChain.maybeSingle = vi.fn(async () => ({
    data: ordersRow ? { ...ordersRow } : null,
    error: null,
  }));

  const changesChain = {
    insert: vi.fn(async (row: Recorded) => {
      recorded.push(row);
      return { error: null };
    }),
  };

  const policyChain: Record<string, Mock> = {};
  for (const method of ['select', 'eq']) {
    policyChain[method] = vi.fn(() => policyChain);
  }
  policyChain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'orders') return ordersChain;
      if (table === 'admin_changes') return changesChain;
      if (table === 'guild_config') return policyChain;
      throw new Error(`Unexpected table ${table}`);
    }),
    rpc: vi.fn(async (name: string) => {
      if (name === 'commerce_prepare_admin_refund') return { data: attempt, error: null };
      if (name === 'commerce_finalize_admin_refund') {
        // Finalization is what flips the order. Mirroring that here makes the
        // before_state assertion a real ordering guard: a read moved after this
        // point would capture 'refunded' and fail.
        if (ordersRow) ordersRow.status = 'refunded';
        return { data: result, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
  };
  vi.mocked(createAdminSupabase).mockReturnValue(supabase as never);
  return supabase;
}

function refund() {
  return POST(
    new Request(`http://x/api/orders/${ORDER_ID}/refund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer asked' }),
    }) as never,
    { params: Promise.resolve({ id: ORDER_ID }) },
  );
}

beforeEach(() => {
    vi.resetAllMocks();
  recorded = [];
  ordersRow = {
    id: ORDER_ID,
    order_number: 'SB-1042',
    status: 'completed',
    amount_cents: 1999,
    currency: 'USD',
  };
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: ACTOR, guildId: GUILD },
  } as never);
});

describe('POST /api/orders/[id]/refund — the recorded row', () => {
  it('writes exactly one admin_changes row that is NOT undoable', async () => {
    client(paidAttempt(), finalization());

    const res = await refund();
    expect(res.status).toBe(200);

    expect(recorded).toHaveLength(1);
    const row = recorded[0];

    // The three fields the dashboard reads to decide whether to offer Undo.
    // If any of these ever flips, an owner gets a button that claims to bring
    // real money back.
    expect(row.is_undoable).toBe(false);
    expect(row.undo_payload).toBeNull();
    expect(row.requires_confirmation).toBe(false);

    expect(row.blast_radius).toBe('critical');
    expect(row.guild_id).toBe(GUILD);
    expect(row.actor_id).toBe(ACTOR);
    expect(row.action).toBe('commerce.order_refunded');
    expect(row.target_id).toBe(ORDER_ID);
  });

  it('states in the sentence that real money left, and why it cannot be undone', async () => {
    client(paidAttempt(), finalization());

    await refund();

    const { description } = recorded[0];
    expect(description).toContain('19.99 USD');
    expect(description).toContain('SB-1042');
    expect(description).toContain('real money has left your PayPal account');
    // The recorder appends the reason, so the owner reads the refusal in the
    // same sentence rather than hunting for a disabled button's tooltip.
    expect(description).toContain('cannot be undone');
    expect(description).toContain('PayPal has no way to reverse a refund');
  });

  it('keeps the PRE-refund order state as before_state', async () => {
    client(paidAttempt(), finalization());

    await refund();

    // Read before finalization flipped the order — if this ever says
    // 'refunded' the read has drifted after the write.
    expect(recorded[0].before_state).toMatchObject({
      order_number: 'SB-1042',
      status: 'completed',
    });
    expect(recorded[0].after_state).toMatchObject({
      status: 'refunded',
      paypal_refund_id: 'REFUND-123',
      refund_amount_cents: 1999,
      currency: 'USD',
    });
  });

  it('does not say money moved when the order had no captured payment', async () => {
    client(
      paidAttempt({
        status: 'prepared',
        provider_action: 'finalize',
        resource_type: null,
        paypal_payment_id: null,
        paypal_refund_id: null,
        refund_amount_cents: 0,
      }),
      finalization({ paypal_refund_id: null }),
    );

    await refund();

    const { description, is_undoable: isUndoable } = recorded[0];
    expect(description).toContain('no real money moved');
    expect(description).not.toContain('left your PayPal account');
    // Still not undoable: access, license keys and sessions were revoked.
    expect(isUndoable).toBe(false);
  });

  it('still records the money movement when the order row could not be read', async () => {
    // The pre-write read is best-effort. Losing it must cost the before-state,
    // never the record that a refund happened.
    ordersRow = null;
    client(paidAttempt(), finalization());

    await refund();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].before_state).toBeNull();
    expect(recorded[0].description).toContain(ORDER_ID);
    expect(recorded[0].is_undoable).toBe(false);
  });
});
