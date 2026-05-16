import { z } from 'zod';

/**
 * Bot environment variables — validated at startup.
 */
export const BotEnvSchema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_GUILD_ID: z.string().min(1, 'DISCORD_GUILD_ID is required'),
  DISCORD_PERMISSIONS: z.coerce.number().default(8),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'SUPABASE_PUBLISHABLE_KEY is required'),
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required'),

  // Lavalink
  LAVALINK_HOST: z.string().default('localhost'),
  LAVALINK_PORT: z.coerce.number().default(2333),
  LAVALINK_PASSWORD: z.string().default('YOUR_LAVALINK_PASSWORD'),

  // Valkey
  VALKEY_URL: z.string().default('redis://127.0.0.1:6379'),

  // Optional
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),

  // Optional
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type DashboardEnv = z.infer<typeof DashboardEnvSchema>;
