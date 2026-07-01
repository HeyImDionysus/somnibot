export type SupabaseConfigSource = 'env' | 'saved' | 'missing';

export interface SupabaseRuntimeConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
  sources: {
    url: SupabaseConfigSource;
    publishableKey: SupabaseConfigSource;
    secretKey: SupabaseConfigSource;
  };
}

export class SupabaseRuntimeConfigError extends Error {
  constructor(
    public readonly code: 'MISSING_PUBLIC_SUPABASE_CONFIG' | 'MISSING_ADMIN_SUPABASE_CONFIG',
    message: string,
  ) {
    super(message);
    this.name = 'SupabaseRuntimeConfigError';
  }
}

export const SUPABASE_RUNTIME_SETTING_KEYS = [
  'supabase_url',
  'supabase_anon_key',
  'supabase_publishable_key',
  'supabase_secret_key',
] as const;

export function readEnvSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseRuntimeConfig {
  return {
    url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '',
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    sources: {
      url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL ? 'env' : 'missing',
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY ? 'env' : 'missing',
      secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY ? 'env' : 'missing',
    },
  };
}

export function readBrowserSupabaseConfig(): SupabaseRuntimeConfig {
  // Next.js only inlines public env vars in client bundles when they are
  // referenced directly as process.env.NEXT_PUBLIC_*. Do not route this
  // through readEnvSupabaseConfig(process.env), because dynamic env object
  // property reads compile to an empty browser env and break Discord login.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

  return {
    url,
    publishableKey,
    secretKey: '',
    sources: {
      url: url ? 'env' : 'missing',
      publishableKey: publishableKey ? 'env' : 'missing',
      secretKey: 'missing',
    },
  };
}

export function readBuildBrowserSupabaseConfig(): SupabaseRuntimeConfig {
  // Values emitted by next.config.ts at dashboard build time. Setup finalization
  // must validate what the browser bundle was built with, not a later runtime
  // .env edit that would require rebuilding the image.
  const url = process.env.SOMNIBOT_BUILD_NEXT_PUBLIC_SUPABASE_URL || '';
  const publishableKey = process.env.SOMNIBOT_BUILD_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

  return {
    url,
    publishableKey,
    secretKey: '',
    sources: {
      url: url ? 'env' : 'missing',
      publishableKey: publishableKey ? 'env' : 'missing',
      secretKey: 'missing',
    },
  };
}

export function applyRuntimeSupabaseEnv(config: {
  url?: string;
  publishableKey?: string;
  secretKey?: string;
}) {
  if (config.url) {
    process.env.SUPABASE_URL = config.url;
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
  }

  if (config.publishableKey) {
    process.env.SUPABASE_ANON_KEY = config.publishableKey;
    process.env.SUPABASE_PUBLISHABLE_KEY = config.publishableKey;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = config.publishableKey;
  }

  if (config.secretKey) {
    process.env.SUPABASE_SECRET_KEY = config.secretKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = config.secretKey;
  }
}

export function requireBrowserSupabaseConfig(
  config: SupabaseRuntimeConfig = readBrowserSupabaseConfig(),
) {
  if (!config.url || !config.publishableKey) {
    throw new SupabaseRuntimeConfigError(
      'MISSING_PUBLIC_SUPABASE_CONFIG',
      'Dashboard browser auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Saved setup values stay server-side; set public Supabase env vars before using remote dashboard auth.',
    );
  }

  return {
    url: config.url,
    publishableKey: config.publishableKey,
    sources: {
      url: config.sources.url,
      publishableKey: config.sources.publishableKey,
    },
  };
}

export function requireAdminSupabaseConfig(
  config: SupabaseRuntimeConfig = readEnvSupabaseConfig(),
) {
  if (!config.url || !config.secretKey) {
    throw new SupabaseRuntimeConfigError(
      'MISSING_ADMIN_SUPABASE_CONFIG',
      'Dashboard admin Supabase access requires SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL plus SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY. Run first-run setup or set server env vars before using admin API routes.',
    );
  }

  return {
    url: config.url,
    secretKey: config.secretKey,
    sources: {
      url: config.sources.url,
      secretKey: config.sources.secretKey,
    },
  };
}
