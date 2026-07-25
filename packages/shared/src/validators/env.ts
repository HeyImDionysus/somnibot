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
  // Set either new or legacy name — transform resolves both.
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // ─── Supabase Management API (optional, for auto-migration) ───
  SUPABASE_ACCESS_TOKEN: z.string().optional().default(''),
  SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED: z.string().optional().default('false'),
  SUPABASE_DB_URL: z.string().optional().default(''),
  // V5-Audit §6.1: Pooled connection URL for multi-replica deployments (pgbouncer)
  SUPABASE_DB_URL_POOLED: z.string().optional().default(''),

  // ─── Lavalink (local/VPS stack) ───
  LAVALINK_HOST: z.string().default('localhost'),
  LAVALINK_PORT: z.coerce.number().default(2333),
  // V5 Audit §9.P3c: When Lavalink is enabled, a strong password should be set.
  // Default to empty string so the bot can start without Lavalink configured —
  // the Lavalink client will fail to connect but other features still work.
  LAVALINK_PASSWORD: z.string().default(''),

  // ─── Valkey (local/VPS stack) ───
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
  .refine(
    (env) => !!(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
    { message: 'Set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY', path: ['SUPABASE_SECRET_KEY'] },
  )
  .transform((env) => {
    // Resolve aliases — populate both names from whichever was provided.
    const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
    const pub = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
    return {
      ...env,
      SUPABASE_SECRET_KEY: secret,
      SUPABASE_SERVICE_ROLE_KEY: secret,
      SUPABASE_PUBLISHABLE_KEY: pub,
      SUPABASE_ANON_KEY: pub,
    };
  });

export type BotEnv = z.infer<typeof BotEnvSchema>;

/**
 * Dashboard environment variables — validated at startup.
 */
export const DashboardEnvSchema = z.object({
  // Public (available client-side)
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),

  // Server-only — set either one (new name or legacy); transform resolves both.
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ACCESS_TOKEN: z.string().optional().default(''),
  SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED: z.string().optional().default('false'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_GUILD_ID: z.string().optional().default(''),

  // Security — required for CSRF protection and webhook replay
  CSRF_SECRET: z.string().min(1, 'CSRF_SECRET is required — generate with: node scripts/gen-secret.mjs'),
  NEXTAUTH_SECRET: z.string().min(1, 'NEXTAUTH_SECRET is required — generate with: node scripts/gen-secret.mjs'),
  WEBHOOK_REPLAY_SECRET: z.string().min(1, 'WEBHOOK_REPLAY_SECRET is required — generate with: node scripts/gen-secret.mjs'),

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
  .refine(
    (env) => !!(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
    { message: 'Set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY — admin API routes need a service-role key', path: ['SUPABASE_SECRET_KEY'] },
  )
  .transform((env) => {
    // Resolve aliases — whichever is set, populate both so downstream
    // code can reference either name without checking.
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
    return { ...env, SUPABASE_SECRET_KEY: key, SUPABASE_SERVICE_ROLE_KEY: key };
  });

export type DashboardEnv = z.infer<typeof DashboardEnvSchema>;
