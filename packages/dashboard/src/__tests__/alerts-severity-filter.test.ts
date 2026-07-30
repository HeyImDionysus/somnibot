/**
 * GET /api/alerts — severity filtering.
 *
 * The route's whitelist had drifted out of step with every writer in the
 * codebase, and both halves of the mismatch failed SILENTLY:
 *
 *   - `warning` — the most-written severity, and the one several money-path
 *     alerts use (`paypal_capture_denied`, `paypal_webhook_processing_error`) —
 *     was NOT on the whitelist. A rejected value fell through to `null`, which
 *     dropped the `.eq('severity', …)` filter entirely, so asking for warnings
 *     returned EVERY alert. The caller had no way to tell.
 *   - `high` / `medium` / `low` were on the whitelist but are written by
 *     nothing, so those filters always returned empty.
 *
 * The writable set is fixed by `OwnerAlertSeverity` in the bot's alert-service,
 * the identical union in alert-manager, and the dashboard's own inserts (which
 * pass incident severities through `toAlertSeverity`, collapsing 'outage' to
 * 'critical'). These tests pin the API to that set and pin the silent-drop shut.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const GUILD = '111111111111111111';
const OWNER = '222222222222222222';

/** Every `.eq(column, value)` the route applied to the alerts query. */
let eqCalls: Array<[string, unknown]> = [];

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: vi.fn(async () => ({
    ok: true,
    ctx: { guildId: GUILD, discordId: OWNER },
  })),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(() => ({
    from: () => {
      // Thenable chain: the route builds the query then awaits it directly.
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (column: string, value: unknown) => {
          eqCalls.push([column, value]);
          return chain;
        },
        then: (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  })),
}));

vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn(async () => null),
}));

vi.mock('@/lib/admin-changes', () => ({
  recordAdminChange: vi.fn(async () => {}),
  readRowBefore: vi.fn(async () => null),
  undoByRestoring: vi.fn(() => ({ kind: 'db' })),
}));

/** The severity value handed to Supabase, or undefined if no filter applied. */
function appliedSeverity(): unknown {
  return eqCalls.find(([column]) => column === 'severity')?.[1];
}

async function get(query: string) {
  const { GET } = await import('../app/api/alerts/route');
  return GET(
    new Request(`http://localhost/api/alerts${query}`) as unknown as import('next/server').NextRequest,
  );
}

beforeEach(() => {
  eqCalls = [];
});

describe('GET /api/alerts — severity whitelist matches the writers', () => {
  // The exact set produced by OwnerAlertSeverity and toAlertSeverity.
  it.each(['info', 'warning', 'critical'])('applies the %s filter', async (severity) => {
    const res = await get(`?severity=${severity}`);

    expect(res.status).toBe(200);
    expect(appliedSeverity(), `${severity} must reach the query`).toBe(severity);
  });

  it('applies no severity filter when none is asked for', async () => {
    const res = await get('');

    expect(res.status).toBe(200);
    expect(appliedSeverity()).toBeUndefined();
  });
});

describe('GET /api/alerts — an unusable severity is refused, not ignored', () => {
  // These were previously ACCEPTED and could never match a row.
  it.each(['high', 'medium', 'low'])('rejects %s, which nothing writes', async (severity) => {
    const res = await get(`?severity=${severity}`);

    expect(res.status).toBe(400);
    // The critical part: it must not fall through to an unfiltered query.
    expect(appliedSeverity(), 'a refused filter must not run the query at all').toBeUndefined();
  });

  it('rejects an unknown value rather than silently returning everything', async () => {
    const res = await get('?severity=banana');
    const body = (await res.json()) as { error?: string; detail?: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid severity');
    // The message names the usable values, so the next caller does not have to
    // guess which vocabulary this endpoint speaks.
    expect(body.detail).toContain('warning');
  });

  it('never returns a 200 with the filter quietly dropped', async () => {
    // This is the exact failure the old code produced for ?severity=warning:
    // 200 OK, every alert in the response, and nothing to indicate the filter
    // had been discarded.
    for (const bad of ['high', 'medium', 'low', 'outage', '']) {
      eqCalls = [];
      const res = await get(`?severity=${bad}`);
      if (res.status === 200) {
        expect(
          appliedSeverity(),
          `?severity=${bad} returned 200 — it must have actually filtered`,
        ).toBeDefined();
      }
    }
  });
});
