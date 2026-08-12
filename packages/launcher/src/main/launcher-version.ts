import { readFileSync } from 'node:fs';

interface LauncherPackageMetadata {
  version?: unknown;
}

/** Read the product version from the launcher's package, never Electron's binary metadata. */
export function readDeclaredLauncherVersion(
  packageJsonUrl: URL = new URL('../../package.json', import.meta.url),
): string {
  try {
    const metadata = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as LauncherPackageMetadata;
    return typeof metadata.version === 'string' ? metadata.version.trim() : '';
  } catch {
    return '';
  }
}

export function resolveLauncherDisplayVersion(options: {
  appVersion: string;
  declaredVersion?: string;
}): string {
  const declaredVersion = options.declaredVersion ?? readDeclaredLauncherVersion();
  return declaredVersion || options.appVersion.trim() || 'unknown';
}
