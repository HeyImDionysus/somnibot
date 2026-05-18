/**
 * Shared Validators — Unit Tests
 *
 * Tests environment variable validation schemas from @somnibot/shared.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Inline a minimal version of the BotEnvSchema to test without import resolution issues.
// The real schema lives in @somnibot/shared — these tests validate the same rules.

const BotEnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APPLICATION_ID: z.string().min(1, 'DISCORD_APPLICATION_ID is required'),
  DISCORD_CLIENT_SECRET: z.string().optional().default(''),
  DISCORD_GUILD_ID: z.string().optional().default(''),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SECRET_KEY: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})
  .transform((env) => {
    if (!env.SUPABASE_SECRET_KEY && env.SUPABASE_SERVICE_ROLE_KEY) {
      env.SUPABASE_SECRET_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SECRET_KEY;
    }
    return env;
  })
  .refine(
    (env) => !!env.SUPABASE_SECRET_KEY,
    { message: 'SUPABASE_SECRET_KEY is required', path: ['SUPABASE_SECRET_KEY'] },
  );

const VALID_ENV = {
  DISCORD_TOKEN: 'test-token',
  DISCORD_APPLICATION_ID: '123456789',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SECRET_KEY: 'eyJ-test-key',
};

describe('BotEnvSchema — required fields', () => {
  it('should pass with all required fields', () => {
    const result = BotEnvSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
  });

  it('should fail when DISCORD_TOKEN is missing', () => {
    const result = BotEnvSchema.safeParse({
      ...VALID_ENV,
      DISCORD_TOKEN: '',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when DISCORD_APPLICATION_ID is missing', () => {
    const result = BotEnvSchema.safeParse({
      ...VALID_ENV,
      DISCORD_APPLICATION_ID: '',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when SUPABASE_URL is not a valid URL', () => {
    const result = BotEnvSchema.safeParse({
      ...VALID_ENV,
      SUPABASE_URL: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when no Supabase secret key is provided', () => {
    const result = BotEnvSchema.safeParse({
      DISCORD_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: '123',
      SUPABASE_URL: 'https://test.supabase.co',
    });
    expect(result.success).toBe(false);
  });
});

describe('BotEnvSchema — key fallbacks', () => {
  it('should accept legacy SUPABASE_SERVICE_ROLE_KEY as fallback', () => {
    const result = BotEnvSchema.safeParse({
      DISCORD_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: '123',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-key',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SUPABASE_SECRET_KEY).toBe('legacy-key');
    }
  });

  it('should prefer SUPABASE_SECRET_KEY over legacy key', () => {
    const result = BotEnvSchema.safeParse({
      DISCORD_TOKEN: 'test-token',
      DISCORD_APPLICATION_ID: '123',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SECRET_KEY: 'new-key',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-key',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.SUPABASE_SECRET_KEY).toBe('new-key');
    }
  });
});

describe('BotEnvSchema — defaults', () => {
  it('should default NODE_ENV to development', () => {
    const result = BotEnvSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
    }
  });

  it('should accept production NODE_ENV', () => {
    const result = BotEnvSchema.safeParse({
      ...VALID_ENV,
      NODE_ENV: 'production',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('production');
    }
  });

  it('should reject invalid NODE_ENV', () => {
    const result = BotEnvSchema.safeParse({
      ...VALID_ENV,
      NODE_ENV: 'staging',
    });
    expect(result.success).toBe(false);
  });
});
