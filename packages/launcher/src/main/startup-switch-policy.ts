/**
 * Chromium debugging switches are process-wide host controls, not launcher
 * configuration. A host-injected remote-debugging port/pipe can make Electron
 * abort before the renderer starts when its named pipe is inaccessible.
 */
export const HOST_DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
] as const;

export interface CommandLineSwitchRemover {
  removeSwitch(name: string): void;
}

export function removeHostDebugSwitches(commandLine: CommandLineSwitchRemover): void {
  for (const name of HOST_DEBUG_SWITCHES) {
    commandLine.removeSwitch(name);
  }
}
