export const LAUNCHER_APP_NAME = '@somnibot/launcher';

export interface LauncherBootstrapDependencies {
  setAppName(name: string): void;
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
  await dependencies.loadMain();
}
