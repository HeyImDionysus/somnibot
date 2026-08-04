import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: vi.fn() }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/admin-changes', () => ({ recordGuildConfigChange: vi.fn().mockResolvedValue(undefined), readGuildConfigBefore: vi.fn().mockResolvedValue({}) }));
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/guild/route';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
const request = (body: unknown) => new NextRequest('http://localhost/api/guild', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireGuildOwner).mockResolvedValue({ ok: true, ctx: { guildId: '111111111111111111', discordId: '222222222222222222', userId: 'u' } } as never);
  const chain: Record<string, unknown> = { maybeSingle: vi.fn(async () => ({ data: {}, error: null })), single: vi.fn(async () => ({ data: {}, error: null })), then: (resolve: (value: unknown) => unknown) => resolve({ error: null }) };
  for (const method of ['select', 'eq', 'upsert', 'update']) chain[method] = vi.fn(() => chain);
  vi.mocked(createAdminSupabase).mockReturnValue({ from: vi.fn(() => chain) } as never);
});
describe('administration/infrastructure guild controls', () => {
  it('accepts editable control families', async () => {
    const response = await PATCH(request({ audit_export_row_limit: 2500, audit_flush_interval_ms: 10000, automation_dm_cooldown_seconds: 600, automation_max_chain_depth: 4, automation_preview_required: false, automation_user_fire_limit_per_minute: 10, custom_commands_max_per_guild: 2000, diagnostics_snapshot_interval_ms: 120000, incidents_auto_create_from_critical_alerts: false, incidents_default_severity: 'critical', incidents_list_page_size: 25, rbac_custom_role_priority_default: 20, rbac_max_permissions_per_role: 150 }));
    expect(response.status).toBe(200);
  });
  it.each([{ audit_export_row_limit: 0 }, { audit_flush_interval_ms: 999 }, { automation_max_chain_depth: 11 }, { custom_commands_max_per_guild: 10001 }, { diagnostics_snapshot_interval_ms: 9999 }, { incidents_list_page_size: 101 }, { rbac_max_permissions_per_role: 501 }])('rejects invalid range %j before persistence', async (body) => expect((await PATCH(request(body))).status).toBe(400));
  it('keeps security invariants locked', async () => {
    expect((await PATCH(request({ custom_commands_mention_safety: false }))).status).toBe(400);
    expect((await PATCH(request({ rbac_priority_escalation_guard: false }))).status).toBe(400);
    expect((await PATCH(request({ rbac_unknown_route_access: 'allow' }))).status).toBe(400);
  });
});
