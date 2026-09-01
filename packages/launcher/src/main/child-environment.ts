const SAFE_PARENT_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
] as const;

const RELEASE_IDENTITY_KEYS = [
  'SOMNIBOT_GIT_SHA',
  'SOMNIBOT_MIGRATION_HEAD',
  'SOMNIBOT_CONFIG_GENERATION',
] as const;

export interface PackagedReleaseIdentity {
  readonly exactSha: string;
  readonly migrationHead: string;
  readonly configurationGeneration: number;
}

export interface ManagedChildEnvironmentOptions {
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly serviceEnv: Readonly<Record<string, string>>;
  readonly isPackaged: boolean;
  readonly releaseIdentity: PackagedReleaseIdentity;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function safeParentEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

function isValidReleaseIdentity(identity: PackagedReleaseIdentity): boolean {
  return /^[0-9a-f]{40}$/i.test(identity.exactSha)
    && /^\d{14}_[a-z0-9_]+\.sql$/.test(identity.migrationHead)
    && Number.isSafeInteger(identity.configurationGeneration)
    && identity.configurationGeneration >= 0;
}

function withoutReleaseIdentity(environment: Readonly<Record<string, string>>): Record<string, string> {
  const result = { ...environment };
  for (const key of RELEASE_IDENTITY_KEYS) delete result[key];
  return result;
}

function releaseIdentityEnvironment(identity: PackagedReleaseIdentity): Record<string, string> {
  return {
    SOMNIBOT_GIT_SHA: identity.exactSha.toLowerCase(),
    SOMNIBOT_MIGRATION_HEAD: identity.migrationHead,
    SOMNIBOT_CONFIG_GENERATION: String(identity.configurationGeneration),
  };
}

export function buildManagedChildEnvironment(options: ManagedChildEnvironmentOptions): Record<string, string> {
  const environment = {
    ...safeParentEnv(options.parentEnv),
    ...options.serviceEnv,
    ...options.extraEnv,
  };

  if (!options.isPackaged) return environment;

  const withoutUntrustedReleaseIdentity = withoutReleaseIdentity(environment);
  if (environment.SOMNIBOT_RUNTIME_MODE !== 'regular-local') return withoutUntrustedReleaseIdentity;
  if (!isValidReleaseIdentity(options.releaseIdentity)) return withoutUntrustedReleaseIdentity;

  return {
    ...withoutUntrustedReleaseIdentity,
    ...releaseIdentityEnvironment(options.releaseIdentity),
  };
}
