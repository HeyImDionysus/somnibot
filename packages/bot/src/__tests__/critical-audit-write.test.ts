import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { writeCriticalAuditLog } from '../services/audit.js';

describe('critical audit persistence', () => {
  it('fails with the operation identity when persistence is rejected', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'audit storage unavailable' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    const supabase = createClient('https://database.example.test', 'test-key', {
      global: { fetch: transport },
    });

    await expect(writeCriticalAuditLog(supabase, {
      guildId: 'guild-a',
      actorType: 'system',
      actorId: 'worker',
      action: 'economy.reward_applied',
      correlationId: 'operation-123',
    })).rejects.toMatchObject({
      name: 'CriticalAuditWriteError',
      operationId: 'operation-123',
    });
  });
});
