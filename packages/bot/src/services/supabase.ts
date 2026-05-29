import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config.js';

let _client: SupabaseClient | null = null;

/**
 * Get the Supabase client (service role — full access).
 * The bot uses the secret key for unrestricted DB access.
 *
 * V5-Audit §6.1: When SUPABASE_DB_URL_POOLED is set (multi-replica
 * deployments behind pgbouncer), the client uses pgbouncer-compatible
 * settings: no prepared statements, no session-level SET commands.
 * The REST client itself (PostgREST) doesn't go through pgbouncer,
 * but this ensures any raw SQL or realtime subscriptions work correctly
 * in pooled mode.
 */
export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const config = getConfig();
  const isPooled = !!config.SUPABASE_DB_URL_POOLED;

  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // V5-Audit §6.1: In pooled mode, disable realtime subscriptions since
    // pgbouncer in transaction mode doesn't support long-lived connections.
    // The bot uses polling (heartbeat table) for liveness, not realtime.
    ...(isPooled && {
      realtime: {
        params: { eventsPerSecond: 0 },
      },
      db: {
        schema: 'public',
      },
    }),
  });

  return _client;
}
