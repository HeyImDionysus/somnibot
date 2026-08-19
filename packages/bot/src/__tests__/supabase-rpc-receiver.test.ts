import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { bindSupabaseRpc } from '../services/supabase-rpc.js';

describe('bindSupabaseRpc', () => {
  it('preserves the Supabase client receiver for runtime RPC calls', async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0]) => new Response(
      JSON.stringify([{ disposition: 'ok' }]),
      { headers: { 'Content-Type': 'application/json' } },
    ));
    const client = createClient('https://supabase.test', 'test-anon-key', {
      auth: { persistSession: false },
      global: { fetch: fetcher },
    });

    const { data, error } = await bindSupabaseRpc(client)(
      'commerce_receiver_probe',
      { p_probe: 'free-claim' },
    );

    expect(error).toBeNull();
    expect(data).toEqual([{ disposition: 'ok' }]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      '/rest/v1/rpc/commerce_receiver_probe',
    );
  });
});
