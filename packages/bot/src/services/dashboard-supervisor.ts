/**
 * Dashboard supervisor — keeps the web dashboard running alongside the bot.
 *
 * Setup asks the operator where their dashboard will live, wires Supabase
 * redirects and PayPal callbacks to that address, and reports success — but
 * nothing ever started the dashboard, so the URL led nowhere. Telling people to
 * go and start a second process themselves is a poor answer: the dashboard is
 * frequently on a VPS being viewed from a phone, where "just run npm start in
 * the other window" is not something the operator can reasonably do.
 *
 * So when the bot is the thing being run directly (not a container image where
 * the orchestrator already runs a separate dashboard service), it starts the
 * dashboard as a supervised child process and keeps it up.
 *
 * Deliberately conservative:
 *  - if something is already serving the port, leave it alone,
 *  - if we are inside a container, do nothing (compose owns that lifecycle),
 *  - if there is no production build, say so once rather than crash-looping,
 *  - restart on unexpected exit with backoff, and stop cleanly on shutdown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Dashboard');

const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;
/** How long the dashboard must stay up before we call the start healthy. */
const HEALTHY_UPTIME_MS = 30_000;

export interface DashboardSupervisorOptions {
  /** Port the dashboard should listen on. Defaults to PORT/3000. */
  port?: number;
  /** Skip everything (env override). */
  disabled?: boolean;
}

let child: ChildProcess | null = null;
let stopping = false;
let restartDelay = RESTART_DELAY_MS;
let healthyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Which port the dashboard should listen on.
 *
 * `PORT` alone is deliberately NOT used: the health server resolves
 * `HEALTH_PORT ?? PORT ?? 3001` and binds first, so on a hosted platform that
 * sets only `PORT` the supervisor would probe that port, find the health
 * server's response, conclude a dashboard was already running, and never start
 * one. `PORT` is only taken when `HEALTH_PORT` is set — i.e. when the health
 * server has been pointed elsewhere and `PORT` is genuinely free.
 */
function resolveDashboardPort(): number {
  const explicit = Number(process.env.DASHBOARD_PORT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const shared = Number(process.env.PORT);
  if (process.env.HEALTH_PORT && Number.isFinite(shared) && shared > 0) return shared;

  return 3000;
}

/** Running inside a container image? Compose/K8s runs the dashboard separately. */
function inContainer(): boolean {
  return existsSync('/.dockerenv') || process.env.SOMNIBOT_IN_CONTAINER === 'true';
}

/** Is something already answering on this port? Then it is not ours to manage. */
async function portInUse(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Locate the built standalone dashboard server, walking up from this file so it
 * works from `dist/` in a checkout and from an installed layout alike.
 */
function findDashboardServer(): { serverPath: string; repoRoot: string } | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(
      dir, 'packages', 'dashboard', '.next', 'standalone', 'packages', 'dashboard', 'server.js',
    );
    if (existsSync(candidate)) return { serverPath: candidate, repoRoot: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Copy `.next/static` and `public` into the standalone runtime directory.
 *
 * `next build` leaves both outside it, so starting server.js directly serves
 * HTML whose CSS and client JavaScript 404 — a dashboard that loads and is
 * unusable, which is worse than one that plainly does not start. The package's
 * own `start` script runs this same script first for exactly this reason.
 */
async function prepareStandaloneAssets(repoRoot: string): Promise<boolean> {
  const script = path.join(repoRoot, 'scripts', 'prepare-dashboard-standalone.mjs');
  if (!existsSync(script)) return true; // packaged layouts ship assets in place

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [script], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr?.on('data', (buf: Buffer) => { stderr += buf.toString(); });
    proc.once('error', () => resolve(false));
    proc.once('exit', (code) => {
      if (code !== 0 && stderr.trim()) log.warn(stderr.trim().slice(0, 300));
      resolve(code === 0);
    });
  });
}

function launch(serverPath: string, port: number): void {
  if (stopping) return;

  // Next's standalone server resolves its assets relative to its own directory.
  const cwd = path.dirname(serverPath);
  child = spawn(process.execPath, [serverPath], {
    cwd,
    env: { ...process.env, PORT: String(port), HOSTNAME: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) log.info(line.slice(0, 300));
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) log.warn(line.slice(0, 300));
  });

  child.once('spawn', () => {
    log.info(`Dashboard started on port ${port}`);
    // Backoff resets on a process that *stayed* up, not one the OS merely
    // managed to launch. A dashboard that exits immediately emits 'spawn' every
    // attempt, so resetting here pinned the delay at 5s forever and turned a
    // persistent startup failure into an endless tight restart loop.
    healthyTimer = setTimeout(() => {
      restartDelay = RESTART_DELAY_MS;
    }, HEALTHY_UPTIME_MS);
    healthyTimer.unref?.();
  });

  child.once('exit', (code, signal) => {
    child = null;
    // Died before it earned a reset — cancel the pending one.
    if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
    if (stopping) return;
    log.warn(`Dashboard exited (code=${code ?? 'null'} signal=${signal ?? 'none'}) — restarting in ${restartDelay / 1000}s`);
    setTimeout(() => {
      restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
      launch(serverPath, port);
    }, restartDelay).unref?.();
  });
}

/**
 * Start supervising the dashboard. Safe to call unconditionally: it decides for
 * itself whether it should act, and never throws into the boot sequence.
 */
export async function startDashboardSupervisor(
  options: DashboardSupervisorOptions = {},
): Promise<void> {
  try {
    if (options.disabled || process.env.SOMNIBOT_AUTOSTART_DASHBOARD === 'false') {
      log.info('Dashboard auto-start disabled (SOMNIBOT_AUTOSTART_DASHBOARD=false)');
      return;
    }
    if (inContainer()) {
      log.info('Running in a container — leaving the dashboard to the orchestrator');
      return;
    }

    const port = options.port ?? resolveDashboardPort();

    if (await portInUse(port)) {
      log.info(`Dashboard already running on port ${port} — not starting another`);
      return;
    }

    const found = findDashboardServer();
    if (!found) {
      log.warn(
        'Dashboard is not built, so it cannot be started automatically. '
        + 'Run `pnpm --filter @somnibot/dashboard build` (or use docker-compose.prod.yml) '
        + 'to enable the web dashboard.',
      );
      return;
    }

    if (!await prepareStandaloneAssets(found.repoRoot)) {
      // Starting anyway would serve a page whose stylesheet and scripts 404,
      // which looks like a broken dashboard rather than an unbuilt one.
      log.warn(
        'Dashboard static assets could not be staged, so it was not started. '
        + 'Run `pnpm --filter @somnibot/dashboard build` to rebuild it.',
      );
      return;
    }

    stopping = false;
    launch(found.serverPath, port);
  } catch (err) {
    // Never let dashboard supervision take the bot down.
    log.error('Could not start the dashboard', { error: String(err) });
  }
}

/** Stop the supervised dashboard (called from the bot's shutdown path). */
export async function stopDashboardSupervisor(): Promise<void> {
  stopping = true;
  if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;

  proc.kill();
  // Give it a moment to exit cleanly, then force.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 5000);
    timer.unref?.();
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  log.info('Dashboard stopped');
}
