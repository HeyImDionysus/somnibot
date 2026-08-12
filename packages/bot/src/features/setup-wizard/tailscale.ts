/**
 * Tailscale Funnel support for the setup wizard.
 *
 * Getting a public HTTPS address is the single hardest part of setup for a
 * self-hoster: PayPal will not deliver webhooks to `localhost`, and nobody but
 * the operator can sign in to a local dashboard. The wizard used to just say
 * "expose port 3000 with a stable HTTPS URL, preferably Tailscale Funnel" and
 * leave them to it — even though the desktop launcher already automates exactly
 * this (packages/launcher/src/main/tailscale-service.ts).
 *
 * This is the same capability, reachable from `/setup`: read the local
 * Tailscale state, and where possible turn the funnel on and hand back the
 * resulting public URL. The one genuinely interactive part — `tailscale up`,
 * which needs a browser login — is reported precisely rather than attempted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@somnibot/shared';
import { resolveDashboardPort } from '../../services/dashboard-supervisor.js';

const execFileAsync = promisify(execFile);
const log = createLogger('TailscaleSetup');

/**
 * Where the dashboard listens locally; the funnel forwards to this.
 *
 * Read at call time from the same env the dashboard supervisor uses to choose
 * its port. Hardcoding 3000 meant that on any other port — the launcher's local
 * profile uses 3456 — the funnel would publish successfully, report success,
 * and point the public sign-in and PayPal callback URLs at nothing.
 */
function dashboardTarget(): string {
  // Same resolution the supervisor uses, imported rather than re-derived: two
  // copies of this rule drifted apart once already (PORT is only the dashboard's
  // when HEALTH_PORT has moved the health server off it), and a funnel pointed
  // at a port nothing serves looks exactly like success.
  return `http://127.0.0.1:${resolveDashboardPort()}`;
}

/** Windows installs Tailscale outside PATH more often than not. */
const CANDIDATE_BINARIES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

export type TailscaleState =
  | 'not-installed'   // no binary anywhere we looked
  | 'logged-out'      // installed, but the node is not signed in
  | 'needs-permission' // installed, but Windows denied service access
  | 'ready'           // signed in, no funnel yet
  | 'funnel-active';  // signed in with a funnel already serving

export interface TailscaleInfo {
  state: TailscaleState;
  /** Public https URL when a funnel is (or has just been) active. */
  publicUrl?: string;
  /** Node DNS name, e.g. machine.tailnet.ts.net */
  dnsName?: string;
  /** Human-readable detail for the operator when something needs doing. */
  detail?: string;
}

async function run(bin: string, args: string[], timeoutMs = 15_000) {
  return execFileAsync(bin, args, { timeout: timeoutMs, windowsHide: true });
}

export type TailscaleSetupRunner = typeof run;

export function isTailscaleSetupPermissionError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; stdout?: string; stderr?: string };
  const text = [candidate?.message, candidate?.stdout, candidate?.stderr, String(error)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  return candidate?.code === 'EACCES'
    || candidate?.code === 'EPERM'
    || text.includes('access is denied')
    || text.includes('permission denied')
    || text.includes('protectedprefix\\administrators\\tailscale')
    || text.includes('protectedprefix/administrators/tailscale');
}

/** First Tailscale binary that responds to `version`. */
async function findBinary(runner: TailscaleSetupRunner = run): Promise<string | null> {
  for (const bin of CANDIDATE_BINARIES) {
    try {
      await runner(bin, ['version'], 8_000);
      return bin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Inspect Tailscale without changing anything. */
export async function detectTailscale(runner: TailscaleSetupRunner = run): Promise<TailscaleInfo> {
  const bin = await findBinary(runner);
  if (!bin) {
    return {
      state: 'not-installed',
      detail: 'Tailscale is not installed (or not on PATH). Install it from https://tailscale.com/download.',
    };
  }

  let dnsName: string | undefined;
  try {
    const { stdout } = await runner(bin, ['status', '--json']);
    const status = JSON.parse(stdout) as {
      BackendState?: string;
      Self?: { DNSName?: string; Online?: boolean };
    };
    dnsName = status.Self?.DNSName?.replace(/\.$/, '') || undefined;
    if (status.BackendState !== 'Running' || !dnsName) {
      return {
        state: 'logged-out',
        detail: 'Tailscale is installed but not signed in. Run `tailscale up` in a terminal '
          + '(it opens a browser to authenticate), then try again.',
      };
    }
  } catch (err) {
    if (isTailscaleSetupPermissionError(err)) {
      return {
        state: 'needs-permission',
        detail: 'Tailscale is installed, but Windows denied SomniBot access to its service. Restart SomniBot with the required permission, then try again.',
      };
    }
    return {
      state: 'logged-out',
      detail: `Could not read Tailscale status: ${String(err).slice(0, 150)}`,
    };
  }

  // Already serving? Then we already have the public URL.
  try {
    const { stdout } = await runner(bin, ['funnel', 'status']);
    if (!/no serve config/i.test(stdout) && /https:\/\//i.test(stdout)) {
      const match = /https:\/\/[^\s]+/i.exec(stdout);
      return {
        state: 'funnel-active',
        dnsName,
        publicUrl: match ? match[0].replace(/\/$/, '') : `https://${dnsName}`,
      };
    }
  } catch (err) {
    if (isTailscaleSetupPermissionError(err)) {
      return {
        state: 'needs-permission',
        dnsName,
        detail: 'Tailscale is signed in, but Windows denied SomniBot access to Funnel status. Restart SomniBot with the required permission, then try again.',
      };
    }
    // Older clients may not support `funnel status`; fall through to 'ready'.
  }

  return { state: 'ready', dnsName };
}

/**
 * Turn the funnel on for the dashboard and return its public URL.
 * Safe to call when one is already active — Tailscale treats it as idempotent.
 */
export async function enableFunnel(
  target = dashboardTarget(),
  runner: TailscaleSetupRunner = run,
): Promise<TailscaleInfo> {
  const info = await detectTailscale(runner);
  if (info.state === 'not-installed' || info.state === 'logged-out' || info.state === 'needs-permission') return info;

  // Deliberately NOT short-circuiting on an already-active funnel.
  //
  // detectTailscale calls a funnel "active" whenever `funnel status` mentions
  // any https URL — including one this machine runs for a completely unrelated
  // application, or for an older dashboard port. Returning that URL meant setup
  // stored it, pointed Supabase redirects and the PayPal webhook at it, and
  // reported success while the dashboard was not exposed at all. Re-running the
  // command is idempotent, so just assert the target we actually want.

  const bin = await findBinary(runner);
  if (!bin) return { state: 'not-installed' };

  try {
    // Mirrors the launcher's invocation: background, standard HTTPS port, no prompt.
    await runner(bin, ['funnel', '--bg', '--https=443', '--yes', target], 30_000);
  } catch (err) {
    if (isTailscaleSetupPermissionError(err)) {
      return {
        state: 'needs-permission',
        dnsName: info.dnsName,
        detail: 'Tailscale is installed, but Windows denied SomniBot access to its service. Restart SomniBot with the required permission, then try again.',
      };
    }
    const message = String((err as { stderr?: string })?.stderr || err).slice(0, 250);
    log.warn('tailscale funnel failed', { error: message });
    return {
      state: info.state,
      dnsName: info.dnsName,
      detail: `Tailscale refused to start the funnel: ${message}`,
    };
  }

  const after = await detectTailscale(runner);
  if (after.publicUrl) return after;
  // Funnel command succeeded but status has not caught up — derive the URL.
  return after.dnsName
    ? { ...after, state: 'funnel-active', publicUrl: `https://${after.dnsName}` }
    : after;
}
