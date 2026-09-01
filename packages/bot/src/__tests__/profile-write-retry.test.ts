import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { ProfileWrites } from '../features/profiles/profile-writes.js';

describe('ProfileWrites transient retry audit', () => {
  it('audits one retry and confirms a committed write whose first response was lost', async () => {
    // Given the first RPC response fails after the durable write committed,
    // and the retry observes that same occurrence as an applied replay.
    let rpcCalls = 0;
    const auditBodies: unknown[] = [];
    const supabase = createClient('https://profiles.test', 'anon-key', {
      global: {
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
          if (path.endsWith('/rpc/apply_profile_write_atomic')) {
            rpcCalls += 1;
            if (rpcCalls === 1) {
              return new Response(JSON.stringify({ message: 'response lost' }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response(JSON.stringify({
              outcome: 'replayed',
              originalOutcome: 'applied',
            }), { headers: { 'content-type': 'application/json' } });
          }
          auditBodies.push(JSON.parse(String(init?.body)));
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const writes = new ProfileWrites(supabase);

    // When one interaction applies the profile write.
    const outcome = await writes.apply({
      guildId: 'guild-1',
      interactionId: 'interaction-1',
      actorId: 'member-1',
      targetId: 'member-1',
      field: 'bio',
      value: 'Durable bio',
      truncated: false,
    });

    // Then the caller can confirm once, and the retry is occurrence-keyed.
    expect(outcome).toEqual({ kind: 'applied' });
    expect(rpcCalls).toBe(2);
    expect(auditBodies).toEqual([
      expect.arrayContaining([expect.objectContaining({
        action: 'profiles.write_retried',
        occurrence_key: 'profiles.write_retried:interaction-1',
        success: false,
      })]),
    ]);
  });

  it('returns unavailable after one audited retry also fails', async () => {
    // Given a profile store that stays unavailable for the bounded retry.
    let rpcCalls = 0;
    let auditCalls = 0;
    const supabase = createClient('https://profiles.test', 'anon-key', {
      global: {
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
          if (path.endsWith('/rpc/apply_profile_write_atomic')) {
            rpcCalls += 1;
            return new Response(JSON.stringify({ message: 'database unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          }
          auditCalls += 1;
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const writes = new ProfileWrites(supabase);

    // When the write is attempted.
    const outcome = await writes.apply({
      guildId: 'guild-1',
      interactionId: 'interaction-2',
      actorId: 'member-1',
      targetId: 'member-1',
      field: 'title',
      value: 'Still unavailable',
      truncated: false,
    });

    // Then the command degrades after exactly one retry, without a retry storm.
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(rpcCalls).toBe(2);
    expect(auditCalls).toBe(1);
  });
});
