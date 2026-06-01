import { z } from 'zod';

/**
 * Bot environment variables — validated at startup.
 *
 * User-provided (5 required):
 *   DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET,
 *   SUPABASE_URL, SUPABASE_SECRET_KEY
 *
 * Everything else is auto-derived or has sensible defaults.
 *
 * Supabase key format: Uses the new sb_secret / sb_publishable keys.
 * Legacy service_role / anon keys are accepted as fallbacks.
 */
export const BotEnvSchema = z.object({
  // ─── Discord (user-provided) ───
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_CLIENT_SECRET: z.string().optional().default(''),
  DISCORD_GUILD_ID: z.string().optional().default(''),
  DISCORD_PERMISSIONS: z.coerce.number().default(8),

  // ─── Supabase (user-provided) ───
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  // New key format (primary)
  SUPABASE_SECRET_KEY: z.string().optional().default(''),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional().default(''),
  // Legacy key format (accepted as fallback)
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  SUPABASE_ANON_KEY: z.string().optional().default(''),

  // ─── Supabase Management API (optional, for auto-migration) ───
  SUPABASE_ACCESS_TOKEN: z.string().optional().default(''),
  SUPABASE_DB_URL: z.string().optional().default(''),
  // V5-Audit §6.1: Pooled connection URL for multi-replica deployments (pgbouncer)
  SUPABASE_DB_URL_POOLED: z.string().optional().default(''),

  // ─── Lavalink (auto-configured for Railway) ───
  LAVALINK_HOST: z.string().default('localhost'),
  LAVALINK_PORT: z.coerce.number().default(2333),
  // V5 Audit §9.P3c: When Lavalink is enabled, a strong password should be set.
  // Default to empty string so the bot can start without Lavalink configured —
  // the Lavalink client will fail to connect but other features still work.
  LAVALINK_PASSWORD: z.string().default(''),

  // ─── Valkey (auto-configured for Railway) ───
  VALKEY_URL: z.string().default('redis://127.0.0.1:6379'),

  // ─── PayPal (optional — only needed if commerce is enabled) ───
  PAYPAL_CLIENT_ID: z.string().optional().default(''),
  PAYPAL_CLIENT_SECRET: z.string().optional().default(''),
  PAYPAL_SANDBOX: z.string().optional().default('true'),
  PAYPAL_API_BASE: z.string().optional().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional().default(''),
  PAYPAL_WEBHOOK_URL: z.string().optional().default(''),

  // ─── YouTube (optional) ───
  YOUTUBE_OAUTH_REFRESH_TOKEN: z.string().optional().default(''),

  // ─── System ───
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})
  .transform((env) => {
    // Resolve secret key: prefer SUPABASE_SECRET_KEY, fall back to legacy SUPABASE_SERVICE_ROLE_KEY
    if (!env.SUPABASE_SECRET_KEY && env.SUPABASE_SERVICE_ROLE_KEY) {
      env.SUPABASE_SECRET_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    }
    // Resolve publishable key: prefer SUPABASE_PUBLISHABLE_KEY, fall back to legacy SUPABASE_ANON_KEY
    if (!env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_ANON_KEY) {
      env.SUPABASE_PUBLISHABLE_KEY = env.SUPABASE_ANON_KEY;
    }
    // Keep legacy aliases populated for any code that references them
    if (!env.SUPABASE_SERVICE_ROLE_KEY) env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SECRET_KEY;
    if (!env.SUPABASE_ANON_KEY) env.SUPABASE_ANON_KEY = env.SUPABASE_PUBLISHABLE_KEY;
    return env;
  })
  .refine(
    (env) => !!env.SUPABASE_SECRET_KEY,
    { message: 'SUPABASE_SECRET_KEY is required (or set the legacy SUPABASE_SERVICE_ROLE_KEY)', path: ['SUPABASE_SECRET_KEY'] },
  );

export type BotEnv = z.infer<typeof BotEnvSchema>;

/**
 * Dashboard environment variables — validated at startup.
 */
export const DashboardEnvSchema = z.object({
  // Public (available client-side)
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),

  // Server-only — new format is primary, legacy accepted as fallback
  SUPABASE_SECRET_KEY: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_GUILD_ID: z.string().optional().default(''),

  // Security — required for CSRF protection and webhook replay
  CSRF_SECRET: z.string().min(1, 'CSRF_SECRET is required — generate with: openssl rand -hex 32'),
  NEXTAUTH_SECRET: z.string().min(1, 'NEXTAUTH_SECRET is required — generate with: openssl rand -hex 32'),

  // Valkey/Redis — used for rate limiting
  VALKEY_URL: z.string().optional().default(''),
  REDIS_URL: z.string().optional().default(''),

  // PayPal (Commerce — optional)
  PAYPAL_CLIENT_ID: z.string().optional().default(''),
  PAYPAL_CLIENT_SECRET: z.string().optional().default(''),
  PAYPAL_SANDBOX: z.string().optional().default('true'),
  PAYPAL_API_BASE: z.string().optional().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional().default(''),
  PAYPAL_WEBHOOK_URL: z.string().optional().default(''),

  // Optional
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})
  .transform((env) => {
    // Resolve: prefer new key, fall back to legacy
    if (!env.SUPABASE_SECRET_KEY && env.SUPABASE_SERVICE_ROLE_KEY) {
      env.SUPABASE_SECRET_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (!env.SUPABASE_SERVICE_ROLE_KEY) env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SECRET_KEY;
    return env;
  });

export type DashboardEnv = z.infer<typeof DashboardEnvSchema>;
