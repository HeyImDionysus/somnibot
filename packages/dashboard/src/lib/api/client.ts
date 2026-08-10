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
// Roles — Live Discord State
// ============================================================

/** A live Discord role as stored in guild_live_state */
export interface LiveRoleData {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  tags: {
    botId: string | null;
    integrationId: string | null;
    premiumSubscriberRole: boolean;
    availableForPurchase: boolean;
    guildConnections: boolean;
  };
  templateKey: string | null;
  tier: string | null;
  source: string; // 'managed' | 'deployed' | 'manual'
  memberCount: number;
}

export interface RolesResponse {
  success: boolean;
  data: LiveRoleData[];
  botRoleId?: string;
  snapshotAt: string | null;
  awaitingSnapshot: boolean;
}

export interface ActionResponse {
  success: boolean;
  actionId?: string;
  message?: string;
  error?: string;
}

/** Legacy alias — kept so unchanged imports don't break at build time */
export type RoleTemplateRow = LiveRoleData;

export const rolesApi = {
  list: () => request<RolesResponse>('/api/roles'),

  create: (data: {
    name: string;
    tier: string;
    color?: number;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string;
    position?: number;
    templateKey?: string;
  }) => request<ActionResponse>('/api/roles', { method: 'POST', body: JSON.stringify(data) }),

  update: (data: {
    roleId: string;
    name?: string;
    tier?: string;
    color?: number;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string;
    position?: number;
    templateKey?: string;
  }) => request<ActionResponse>('/api/roles', { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (roleId: string, templateKey?: string) =>
    request<ActionResponse>('/api/roles', {
      method: 'DELETE',
      body: JSON.stringify({ roleId, templateKey }),
    }),
};

// ============================================================
// Channels — Live Discord State
// ============================================================

/** A live Discord channel as stored in guild_live_state */
export interface LiveChannelData {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  slowmode: number;
  nsfw: boolean;
  templateKey: string | null;
}

/** A live Discord category as stored in guild_live_state */
export interface LiveCategoryData {
  id: string;
  name: string;
  position: number;
  templateKey: string | null;
}

export interface ChannelsResponse {
  success: boolean;
  channels: LiveChannelData[];
  categories: LiveCategoryData[];
  snapshotAt: string | null;
  awaitingSnapshot: boolean;
}

/** Legacy alias */
export type ChannelTemplateRow = LiveChannelData;

export const channelsApi = {
  list: () => request<ChannelsResponse>('/api/channels'),

  create: (data: {
    name: string;
    type?: number;
    parentId?: string | null;
    topic?: string | null;
    nsfw?: boolean;
    slowmode?: number;
    isCategory?: boolean;
    templateKey?: string;
  }) => request<ActionResponse>('/api/channels', { method: 'POST', body: JSON.stringify(data) }),

  update: (data: {
    channelId: string;
    name?: string;
    topic?: string;
    nsfw?: boolean;
    slowmode?: number;
    parentId?: string | null;
  }) => request<ActionResponse>('/api/channels', { method: 'PATCH', body: JSON.stringify(data) }),

  deleteChannel: (channelId: string) =>
    request<ActionResponse>('/api/channels', {
      method: 'DELETE',
      body: JSON.stringify({ channelId }),
    }),

  deleteCategory: (categoryId: string) =>
    request<ActionResponse>('/api/channels', {
      method: 'DELETE',
      body: JSON.stringify({ categoryId, isCategory: true }),
    }),
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
