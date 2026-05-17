/**
 * Dashboard API client — wraps fetch for internal API routes.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(res.status, body.error ?? `Request failed: ${res.status}`);
  }

  return res.json();
}

// ============================================================
// Guild
// ============================================================

export const guildApi = {
  get: () => request<{
    guild: Record<string, unknown>;
    config: Record<string, unknown> | null;
    desiredState: Record<string, unknown> | null;
  }>('/api/guild'),

  updateConfig: (data: Record<string, unknown>) =>
    request('/api/guild', { method: 'PATCH', body: JSON.stringify(data) }),
};

// ============================================================
// Roles
// ============================================================

export interface RoleTemplateRow {
  id: string;
  guild_id: string;
  name: string;
  tier: string;
  description: string | null;
  permissions: number;
  permission_details: Record<string, unknown>;
  is_builtin: boolean;
  base_template_id: string | null;
  created_at: string;
  updated_at: string;
}

export const rolesApi = {
  list: () => request<RoleTemplateRow[]>('/api/roles'),

  create: (data: {
    name: string;
    tier: string;
    description?: string;
    permissions?: number;
    permissionDetails?: Record<string, unknown>;
    isBuiltin?: boolean;
  }) => request<RoleTemplateRow>('/api/roles', { method: 'POST', body: JSON.stringify(data) }),

  update: (data: { id: string } & Partial<{
    name: string;
    tier: string;
    description: string;
    permissions: number;
    permissionDetails: Record<string, unknown>;
  }>) => request<RoleTemplateRow>('/api/roles', { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request('/api/roles', { method: 'DELETE', body: JSON.stringify({ id }) }),
};

// ============================================================
// Channels
// ============================================================

export interface ChannelTemplateRow {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  target_channel_type: string;
  overrides: Record<string, unknown>[];
  is_builtin: boolean;
  base_template_id: string | null;
  created_at: string;
  updated_at: string;
}

export const channelsApi = {
  list: () => request<ChannelTemplateRow[]>('/api/channels'),

  create: (data: {
    name: string;
    targetChannelType: string;
    description?: string;
    overrides?: Record<string, unknown>[];
  }) => request<ChannelTemplateRow>('/api/channels', { method: 'POST', body: JSON.stringify(data) }),

  update: (data: { id: string } & Partial<{
    name: string;
    description: string;
    targetChannelType: string;
    overrides: Record<string, unknown>[];
  }>) => request<ChannelTemplateRow>('/api/channels', { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request('/api/channels', { method: 'DELETE', body: JSON.stringify({ id }) }),
};

// ============================================================
// Deploy
// ============================================================

export const deployApi = {
  getStatus: () => request<{
    desiredState: Record<string, unknown> | null;
    setupCompleted: boolean;
    setupStep: number;
    recentActions: Record<string, unknown>[];
  }>('/api/deploy'),

  deploy: (data: {
    roles: unknown[];
    channels: unknown[];
    categories: unknown[];
    permissionMap?: Record<string, unknown>;
    cleanExisting?: boolean;
  }) => request('/api/deploy', { method: 'POST', body: JSON.stringify(data) }),
};

// ============================================================
// Sync
// ============================================================

export const syncApi = {
  getStatus: () => request<{
    driftDetected: boolean;
    driftItems: unknown[];
    lastSyncAt: string | null;
    config: {
      syncEnabled: boolean;
      syncIntervalMinutes: number;
      autoRepair: boolean;
      autoRepairEveryone: boolean;
    };
    recentEvents: Record<string, unknown>[];
  }>('/api/sync'),

  updateConfig: (data: {
    syncEnabled?: boolean;
    syncIntervalMinutes?: number;
    autoRepair?: boolean;
    autoRepairEveryone?: boolean;
  }) => request('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'update_config', ...data }) }),

  repair: (entityType: string, entityId: string, entityName: string, driftType: string) =>
    request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ action: 'repair', entityType, entityId, entityName, driftType }),
    }),

  accept: (entityType: string, entityId: string, entityName: string, driftType: string) =>
    request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ action: 'accept', entityType, entityId, entityName, driftType }),
    }),
};
