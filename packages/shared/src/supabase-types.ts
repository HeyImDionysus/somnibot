/**
 * Shared Supabase client type alias.
 * V3 Audit: Eliminates `any` type for Supabase clients across feature managers.
 */
import type { SupabaseClient as BaseSupabaseClient } from '@supabase/supabase-js';

/** Re-export with a shorter name used across bot features. */
export type SupabaseClient = BaseSupabaseClient;

/** Generic row type for Supabase query results where exact type isn't available. */
export type DbRow = Record<string, unknown>;
