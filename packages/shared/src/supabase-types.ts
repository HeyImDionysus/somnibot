/**
 * Shared Supabase client type alias.
 *
 * V3 Audit: Eliminates `any` type for Supabase clients across feature managers.
 * Uses the generic SupabaseClient from @supabase/supabase-js so features
 * get autocomplete and type checking on .from(), .rpc(), etc.
 */
import type { SupabaseClient as BaseSupabaseClient } from '@supabase/supabase-js';

/** Re-export with a shorter name used across bot features. */
export type SupabaseClient = BaseSupabaseClient;

/**
 * Generic row type for Supabase query results.
 * Use when the exact table type isn't available.
 */
export type DbRow = Record<string, unknown>;

/**
 * Generic RPC result — use for .rpc() calls where return type varies.
 */
export type RpcResult<T = unknown> = {
  data: T | null;
  error: { message: string; code?: string } | null;
};
