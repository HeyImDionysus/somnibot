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

const execFileAsync = promisify(execFile);
const log = createLogger('TailscaleSetup');

/** Where the dashboard listens locally; the funnel forwards to this. */
const DEFAULT_DASHBOARD_TARGET = 'http://127.0.0.1:3000';

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

/** First Tailscale binary that responds to `version`. */
async function findBinary(): Promise<string | null> {
  for (const bin of CANDIDATE_BINARIES) {
    try {
      await run(bin, ['version'], 8_000);
      return bin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Inspect Tailscale without changing anything. */
export async function detectTailscale(): Promise<TailscaleInfo> {
  const bin = await findBinary();
  if (!bin) {
    return {
      state: 'not-installed',
      detail: 'Tailscale is not installed (or not on PATH). Install it from https://tailscale.com/download.',
    };
  }

  let dnsName: string | undefined;
  try {
    const { stdout } = await run(bin, ['status', '--json']);
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
    return {
      state: 'logged-out',
      detail: `Could not read Tailscale status: ${String(err).slice(0, 150)}`,
    };
  }

  // Already serving? Then we already have the public URL.
  try {
    const { stdout } = await run(bin, ['funnel', 'status']);
    if (!/no serve config/i.test(stdout) && /https:\/\//i.test(stdout)) {
      const match = /https:\/\/[^\s]+/i.exec(stdout);
      return {
        state: 'funnel-active',
        dnsName,
        publicUrl: match ? match[0].replace(/\/$/, '') : `https://${dnsName}`,
      };
    }
  } catch {
    // Older clients may not support `funnel status`; fall through to 'ready'.
  }

  return { state: 'ready', dnsName };
}

/**
 * Turn the funnel on for the dashboard and return its public URL.
 * Safe to call when one is already active — Tailscale treats it as idempotent.
 */
export async function enableFunnel(
  target = DEFAULT_DASHBOARD_TARGET,
): Promise<TailscaleInfo> {
  const info = await detectTailscale();
  if (info.state === 'not-installed' || info.state === 'logged-out') return info;
  if (info.state === 'funnel-active' && info.publicUrl) return info;

  const bin = await findBinary();
  if (!bin) return { state: 'not-installed' };

  try {
    // Mirrors the launcher's invocation: background, standard HTTPS port, no prompt.
    await run(bin, ['funnel', '--bg', '--https=443', '--yes', target], 30_000);
  } catch (err) {
    const message = String((err as { stderr?: string })?.stderr || err).slice(0, 250);
    log.warn('tailscale funnel failed', { error: message });
    return {
      state: info.state,
      dnsName: info.dnsName,
      detail: `Tailscale refused to start the funnel: ${message}`,
    };
  }

  const after = await detectTailscale();
  if (after.publicUrl) return after;
  // Funnel command succeeded but status has not caught up — derive the URL.
  return after.dnsName
    ? { ...after, state: 'funnel-active', publicUrl: `https://${after.dnsName}` }
    : after;
}
