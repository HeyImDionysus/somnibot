import path from 'node:path';

export const LAUNCHER_APP_NAME = '@somnibot/launcher';

export function resolveLauncherUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, LAUNCHER_APP_NAME);
}

export interface LauncherBootstrapDependencies {
  setAppName(name: string): void;
  setUserDataPath(path: string): void;
  getAppDataPath(): string;
  getUserDataPath(): string;
  loadMain(): Promise<unknown>;
}

/**
 * Establish the stable application identity before any module constructs the
 * encrypted config store. Unpackaged Electron otherwise uses the generic
 * "Electron" user-data directory and silently loses the owner's connections.
 */
export async function bootstrapLauncher(
  dependencies: LauncherBootstrapDependencies,
): Promise<void> {
  dependencies.setAppName(LAUNCHER_APP_NAME);
  // Electron's unpackaged runtime otherwise keeps the generic "Electron"
  // profile even after setName(). That profile is shared with Codex/Desktop
  // and can fail Chromium's singleton lock with ERROR_ACCESS_DENIED. Pin the
  // launcher to the same stable profile used by the packaged build before any
  // module (notably electron-store) is imported. Respect an explicit
  // --user-data-dir override so isolated smoke tests and support diagnostics
  // can use a disposable profile without touching the owner's credentials.
  const genericUserDataPath = path.join(dependencies.getAppDataPath(), 'Electron');
  if (path.normalize(dependencies.getUserDataPath()) === path.normalize(genericUserDataPath)) {
    dependencies.setUserDataPath(resolveLauncherUserDataPath(dependencies.getAppDataPath()));
  }
  await dependencies.loadMain();
}
