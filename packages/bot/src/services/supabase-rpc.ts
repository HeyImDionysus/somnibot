import type { SupabaseClient } from '@supabase/supabase-js';

export type SupabaseRpcCall = (
  fn: string,
  params: Record<string, unknown>,
) => ReturnType<SupabaseClient['rpc']>;

export function bindSupabaseRpc(client: SupabaseClient): SupabaseRpcCall {
  return client.rpc.bind(client) as SupabaseRpcCall;
}
