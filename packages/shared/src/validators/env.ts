import { z } from 'zod';

/**
 * Bot environment variables — validated at startup.
 *
 * User-provided (5 required):
 *   DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Everything else is auto-derived or has sensible defaults.
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
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  // Legacy aliases (auto-derived from SERVICE_ROLE_KEY if not set)
  SUPABASE_PUBLISHABLE_KEY: z.string().optional().default(''),
  SUPABASE_SECRET_KEY: z.string().optional().default(''),
  SUPABASE_ANON_KEY: z.string().optional().default(''),

  // ─── Supabase Management API (optional, for auto-migration) ───
  SUPABASE_ACCESS_TOKEN: z.string().optional().default(''),
  SUPABASE_DB_URL: z.string().optional().default(''),

  // ─── Lavalink (auto-configured for Railway) ───
  LAVALINK_HOST: z.string().default('localhost'),
  LAVALINK_PORT: z.coerce.number().default(2333),
  LAVALINK_PASSWORD: z.string().default('YOUR_LAVALINK_PASSWORD'),

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
    // Auto-derive missing keys from SERVICE_ROLE_KEY
    if (!env.SUPABASE_PUBLISHABLE_KEY) env.SUPABASE_PUBLISHABLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!env.SUPABASE_SECRET_KEY) env.SUPABASE_SECRET_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!env.SUPABASE_ANON_KEY) env.SUPABASE_ANON_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    return env;
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

  // Server-only
  SUPABASE_SECRET_KEY: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_GUILD_ID: z.string().optional().default(''),

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
    // Auto-derive missing keys
    if (!env.SUPABASE_SECRET_KEY) env.SUPABASE_SECRET_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    return env;
  });

export type DashboardEnv = z.infer<typeof DashboardEnvSchema>;
