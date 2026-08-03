/**
 * DevTools are a diagnostic surface, not part of normal launcher startup.
 * Keep them opt-in so Chromium's DevTools protocol probes cannot pollute the
 * normal launcher console (and so a development checkout behaves like the
 * packaged app by default).
 */
export const DEVTOOLS_ENVIRONMENT_VARIABLE = 'SOMNIBOT_LAUNCHER_OPEN_DEVTOOLS';

export function shouldOpenDevTools(
  isPackaged: boolean,
  environmentValue: string | undefined = process.env[DEVTOOLS_ENVIRONMENT_VARIABLE],
): boolean {
  return !isPackaged && environmentValue === '1';
}
