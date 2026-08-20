import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAdminSupabaseMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/require-owner', () => ({ requireGuildOwner: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: createAdminSupabaseMock }));
vi.mock('@/lib/api/admin-rate-limit', () => ({ checkAdminRateLimit: vi.fn() }));
vi.mock('@/lib/notify-bot', () => ({ notifyBot: vi.fn() }));

import { POST } from '@/app/api/branding/assets/route';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { notifyBot } from '@/lib/notify-bot';

function brandingRequest(): Request {
  const form = new FormData();
  form.set('slot', 'logo');
  form.set('file', new File([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  ], 'logo.png', { type: 'image/png' }));
  return new Request('http://localhost/api/branding/assets', { method: 'POST', body: form });
}

function createBrandingAdmin(updateError: { readonly message: string } | null) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { brand_logo_storage_path: 'guild-1/logo/old.png' },
    error: null,
  });
  const upsert = vi.fn().mockResolvedValue({ error: updateError });
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle,
    upsert,
  };
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const bucket = {
    upload,
    remove,
    getPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: `https://assets.test/${path}` } })),
  };
  return {
    admin: {
      from: vi.fn().mockReturnValue(query),
      storage: { from: vi.fn().mockReturnValue(bucket) },
    },
    upload,
    remove,
    upsert,
  };
}

describe('POST /api/branding/assets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(checkAdminRateLimit).mockResolvedValue(null);
    vi.mocked(requireGuildOwner).mockResolvedValue({
      ok: true,
      ctx: { userId: 'user-1', discordId: 'discord-1', guildId: 'guild-1' },
    });
    vi.mocked(notifyBot).mockResolvedValue(undefined);
  });

  it('removes only the new object when metadata persistence fails', async () => {
    const fixture = createBrandingAdmin({ message: 'metadata failed' });
    createAdminSupabaseMock.mockReturnValue(fixture.admin);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(brandingRequest() as never);

    expect(response.status).toBe(500);
    const uploadedPath = String(fixture.upload.mock.calls[0]?.[0]);
    expect(uploadedPath).toMatch(/^guild-1\/logo\/[0-9a-f-]+\.png$/);
    expect(uploadedPath).not.toBe('guild-1/logo/old.png');
    expect(fixture.remove).toHaveBeenCalledOnce();
    expect(fixture.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it('removes the previous object only after the new metadata is authoritative', async () => {
    const fixture = createBrandingAdmin(null);
    createAdminSupabaseMock.mockReturnValue(fixture.admin);

    const response = await POST(brandingRequest() as never);

    expect(response.status).toBe(200);
    expect(fixture.upsert.mock.invocationCallOrder[0]).toBeLessThan(fixture.remove.mock.invocationCallOrder[0]);
    expect(fixture.remove).toHaveBeenCalledWith(['guild-1/logo/old.png']);
  });
});
