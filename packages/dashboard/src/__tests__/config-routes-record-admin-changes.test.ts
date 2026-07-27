/**
 * Wiring proof: guild-config routes record an admin change.
 *
 * lib/admin-changes has its own unit tests, but those prove the RECORDER
 * works — not that any route calls it. That distinction matters here more than
 * usual, because `recordAdminChange` deliberately swallows every failure (the
 * mutation it describes has already committed, so bookkeeping must never fail
 * a save). A route that forgot to call it, or called it with the wrong guild
 * or actor, would leave the Admin Changes page silently empty and every
 * existing route test would still pass.
 *
 * So each route below is driven end-to-end with its real handler and asserted
 * on the recorder call: right guild, right actor, the values it wrote, and the
 * prior values needed to make undo real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/require-owner', () => ({
  requireGuildOwner: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: vi.fn(),
}));
vi.mock('@/lib/api/admin-rate-limit', () => ({
  checkAdminRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/notify-bot', () => ({
  notifyBot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/admin-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin-changes')>()),
  recordGuildConfigChange: vi.fn().mockResolvedValue(undefined),
  recordCrudChange: vi.fn().mockResolvedValue(undefined),
  readRowBefore: vi.fn().mockResolvedValue(undefined),
  readGuildConfigBefore: vi.fn().mockResolvedValue({
    store_brand_name: 'Old Name',
    welcome_enabled: false,
  }),
}));

import { NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  recordGuildConfigChange,
  readGuildConfigBefore,
  recordCrudChange,
  readRowBefore,
} from '@/lib/admin-changes';

const GUILD = '111111111111111111';
const ACTOR = '222222222222222222';

/**
 * A guild_config client whose select/upsert/update chains all succeed. The
 * before-read is mocked at the module boundary, so this only has to satisfy
 * the write.
 */
function mockConfigClient(opts: { writeError?: { message: string; code?: string } } = {}) {
  const result = { data: {}, error: opts.writeError ?? null };
  // One self-returning chain that is also awaitable, so every shape these
  // routes use resolves: select().eq().maybeSingle(), update().eq(),
  // upsert(), and upsert().select().single().
  const chain: Record<string, unknown> = {
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  for (const m of ['select', 'eq', 'update', 'upsert', 'insert', 'delete']) {
    chain[m] = vi.fn(() => chain);
  }
  vi.mocked(createAdminSupabase).mockReturnValue({ from: vi.fn(() => chain) } as never);
  return chain;
}

function put(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', discordId: ACTOR, guildId: GUILD },
  } as never);
  vi.mocked(readGuildConfigBefore).mockResolvedValue({
    store_brand_name: 'Old Name',
    welcome_enabled: false,
  });
  mockConfigClient();
});

describe('PUT /api/branding', () => {
  it('records the brand change against the caller and guild', async () => {
    const { PUT } = await import('@/app/api/branding/route');

    const res = await PUT(put('http://x/api/branding', { store_brand_name: 'New Name' }));
    expect(res.status).toBe(200);

    expect(recordGuildConfigChange).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(recordGuildConfigChange).mock.calls[0];
    expect(arg).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'branding.updated',
      updates: { store_brand_name: 'New Name' },
    });
    // The prior values are what make the undo button real rather than decorative.
    expect(arg.before).toBeDefined();
  });

  it('does not record when the write itself failed', async () => {
    mockConfigClient({ writeError: { message: 'boom', code: '23514' } });
    const { PUT } = await import('@/app/api/branding/route');

    const res = await PUT(put('http://x/api/branding', { store_brand_name: 'New Name' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Recording a change that never landed would be a lie on the page.
    expect(recordGuildConfigChange).not.toHaveBeenCalled();
  });
});

describe('PUT /api/welcome', () => {
  it('records the welcome change against the caller and guild', async () => {
    const { PUT } = await import('@/app/api/welcome/route');

    const res = await PUT(put('http://x/api/welcome', { welcome_enabled: true }));
    expect(res.status).toBe(200);

    expect(recordGuildConfigChange).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(recordGuildConfigChange).mock.calls[0];
    expect(arg).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      action: 'welcome.updated',
      updates: { welcome_enabled: true },
    });
  });
});

describe('CRUD routes', () => {
  it('DELETE /api/moderation/rules captures the rule before it is gone', async () => {
    // The row is hard-deleted, so what the recorder captures beforehand is the
    // only remaining description of what the rule was.
    vi.mocked(readRowBefore).mockResolvedValue({ id: 'rule-1', name: 'No links' });
    const { DELETE } = await import('@/app/api/moderation/rules/route');

    const res = await DELETE(
      new NextRequest('http://x/api/moderation/rules?id=rule-1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);

    expect(recordCrudChange).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(recordCrudChange).mock.calls[0];
    expect(arg).toMatchObject({
      guildId: GUILD,
      actorId: ACTOR,
      operation: 'deleted',
      action: 'moderation.rule_deleted',
      table: 'automod_rules',
      targetId: 'rule-1',
      label: 'No links',
    });
    expect(arg.before).toMatchObject({ name: 'No links' });
  });

  it('does not record when the delete itself failed', async () => {
    mockConfigClient({ writeError: { message: 'boom' } });
    vi.mocked(readRowBefore).mockResolvedValue({ id: 'rule-1', name: 'No links' });
    const { DELETE } = await import('@/app/api/moderation/rules/route');

    const res = await DELETE(
      new NextRequest('http://x/api/moderation/rules?id=rule-1', { method: 'DELETE' }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(recordCrudChange).not.toHaveBeenCalled();
  });
});
