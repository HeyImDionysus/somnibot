import { BotEnvSchema, type BotEnv } from '@somnibot/shared';
export type { BotEnv };

/**
 * Validated bot configuration.
 * Throws at startup if any required env vars are missing or invalid.
 */
let _config: BotEnv | null = null;

export function loadConfig(): BotEnv {
  if (_config) return _config;

  const result = BotEnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error('❌ Invalid environment configuration:\n' + errors);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): BotEnv {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}
