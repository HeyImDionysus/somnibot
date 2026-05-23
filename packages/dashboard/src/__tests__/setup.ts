/**
 * Dashboard API route test setup.
 */
import { vi } from 'vitest';

const mockSupabaseQuery = {
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  single: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockReturnThis(),
  or: vi.fn().mockReturnThis(),
};

export const mockSupabase = {
  from: vi.fn(() => mockSupabaseQuery),
  rpc: vi.fn(),
  auth: { getUser: vi.fn() },
};

export const mockSupabaseQuery_ = mockSupabaseQuery;

export function mockAuthSuccess(guildId = 'guild-123', discordId = 'discord-456') {
  return { ok: true as const, ctx: { guildId, discordId, userId: 'user-789' } };
}

export function mockAuthFailure(status = 401) {
  return {
    ok: false as const,
    response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status, headers: { 'Content-Type': 'application/json' },
    }),
  };
}
