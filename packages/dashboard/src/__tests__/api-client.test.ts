/**
 * Tests for the Dashboard API client module.
 *
 * Verifies that API wrapper functions call the correct endpoints with
 * proper methods, serialize payloads, and surface errors via ApiError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, guildApi, rolesApi, channelsApi, deployApi, syncApi } from '@/lib/api/client';

// ── Global fetch mock ──────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonOk(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

function jsonError(status: number, body: Record<string, unknown>) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  });
}

// ── ApiError ───────────────────────────────────────────────

describe('ApiError', () => {
  it('sets status and message', () => {
    const err = new ApiError(404, 'Not found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });
});

// ── guildApi ──────────────────────────────────────────────

describe('guildApi', () => {
  it('get() fetches /api/guild', async () => {
    const data = { guild: {}, config: null, desiredState: null };
    mockFetch.mockReturnValueOnce(jsonOk(data));

    const result = await guildApi.get();
    expect(result).toEqual(data);
    expect(mockFetch).toHaveBeenCalledWith('/api/guild', expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('updateConfig() PATCHes /api/guild with data', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    const config = { welcomeEnabled: true };
    await guildApi.updateConfig(config);
    expect(mockFetch).toHaveBeenCalledWith('/api/guild', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify(config),
    }));
  });

  it('throws ApiError on non-ok response', async () => {
    mockFetch.mockReturnValueOnce(jsonError(403, { error: 'Forbidden' }));

    await expect(guildApi.get()).rejects.toThrow(ApiError);
    await expect(guildApi.get.call(null)).rejects.toThrow();
  });

  it('throws ApiError with fallback message when body has no error field', async () => {
    mockFetch.mockReturnValueOnce(jsonError(500, {}));

    try {
      await guildApi.get();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
      expect((e as ApiError).message).toContain('500');
    }
  });

  it('handles body parse failure gracefully', async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('parse error')),
    }));

    try {
      await guildApi.get();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe('Unknown error');
    }
  });
});

// ── rolesApi ──────────────────────────────────────────────

describe('rolesApi', () => {
  it('list() fetches /api/roles', async () => {
    const data = { success: true, data: [], snapshotAt: null, awaitingSnapshot: false };
    mockFetch.mockReturnValueOnce(jsonOk(data));

    const result = await rolesApi.list();
    expect(result).toEqual(data);
  });

  it('create() POSTs to /api/roles', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true, actionId: 'abc' }));

    await rolesApi.create({ name: 'Mod', tier: 'staff', color: 0xFF0000 });
    expect(mockFetch).toHaveBeenCalledWith('/api/roles', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.name).toBe('Mod');
    expect(body.tier).toBe('staff');
  });

  it('update() PATCHes /api/roles', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await rolesApi.update({ roleId: '123', name: 'Admin' });
    expect(mockFetch).toHaveBeenCalledWith('/api/roles', expect.objectContaining({
      method: 'PATCH',
    }));
  });

  it('delete() DELETEs /api/roles with roleId', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await rolesApi.delete('456', 'template-key');
    expect(mockFetch).toHaveBeenCalledWith('/api/roles', expect.objectContaining({
      method: 'DELETE',
    }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.roleId).toBe('456');
    expect(body.templateKey).toBe('template-key');
  });
});

// ── channelsApi ───────────────────────────────────────────

describe('channelsApi', () => {
  it('list() fetches /api/channels', async () => {
    const data = { success: true, channels: [], categories: [], snapshotAt: null, awaitingSnapshot: false };
    mockFetch.mockReturnValueOnce(jsonOk(data));

    const result = await channelsApi.list();
    expect(result).toEqual(data);
  });

  it('create() POSTs to /api/channels', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await channelsApi.create({ name: 'general', type: 0 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.name).toBe('general');
  });

  it('update() PATCHes /api/channels', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await channelsApi.update({ channelId: '789', topic: 'Welcome' });
    expect(mockFetch).toHaveBeenCalledWith('/api/channels', expect.objectContaining({
      method: 'PATCH',
    }));
  });

  it('deleteChannel() DELETEs with channelId', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await channelsApi.deleteChannel('ch_1');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channelId).toBe('ch_1');
  });

  it('deleteCategory() DELETEs with categoryId and isCategory flag', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await channelsApi.deleteCategory('cat_1');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.categoryId).toBe('cat_1');
    expect(body.isCategory).toBe(true);
  });
});

// ── deployApi ─────────────────────────────────────────────

describe('deployApi', () => {
  it('getStatus() fetches /api/deploy', async () => {
    const data = { desiredState: null, setupCompleted: true, setupStep: 3, recentActions: [] };
    mockFetch.mockReturnValueOnce(jsonOk(data));

    const result = await deployApi.getStatus();
    expect(result).toEqual(data);
  });

  it('deploy() POSTs deployment payload to /api/deploy', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    const payload = { roles: [], channels: [], categories: [] };
    await deployApi.deploy(payload);
    expect(mockFetch).toHaveBeenCalledWith('/api/deploy', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ...payload, action: 'deploy', deployMode: 'safe' }),
    }));
  });
});

// ── syncApi ───────────────────────────────────────────────

describe('syncApi', () => {
  it('getStatus() fetches /api/sync', async () => {
    const data = {
      driftDetected: false,
      driftItems: [],
      lastSyncAt: null,
      config: { syncEnabled: true, syncIntervalMinutes: 5, autoRepair: false, autoRepairEveryone: false },
      recentEvents: [],
    };
    mockFetch.mockReturnValueOnce(jsonOk(data));

    const result = await syncApi.getStatus();
    expect(result).toEqual(data);
  });

  it('updateConfig() POSTs update_config action', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await syncApi.updateConfig({ syncEnabled: true, autoRepair: true });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe('update_config');
    expect(body.syncEnabled).toBe(true);
  });

  it('repair() POSTs repair action with entity details', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await syncApi.repair('role', 'r_1', 'Mod', 'name_changed');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe('repair');
    expect(body.entityType).toBe('role');
    expect(body.entityId).toBe('r_1');
  });

  it('accept() POSTs accept action', async () => {
    mockFetch.mockReturnValueOnce(jsonOk({ success: true }));

    await syncApi.accept('channel', 'c_1', 'general', 'topic_changed');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe('accept');
    expect(body.entityType).toBe('channel');
  });
});
