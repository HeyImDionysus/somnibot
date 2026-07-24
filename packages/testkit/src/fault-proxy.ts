/**
 * fault-proxy — a REAL network seam for dependency-outage fault injection.
 *
 * The DEPFAIL/RETRY catalog scenarios contract behavior "with the database
 * blocked" / "when Valkey drops". The harness's premise is a reachable local
 * stack, so outages must be injected — and the owner's fidelity-over-convenience
 * ruling forbids mock seams. This is the highest-fidelity alternative: a local
 * TCP proxy in front of 127.0.0.1:54321 (Supabase) / 127.0.0.1:6379 (Valkey).
 * The whole domain process routes through it (run-one-domain.mjs points
 * SUPABASE_URL/VALKEY_URL at the proxy ports BEFORE the stack is imported, so
 * the process-wide client singletons bind to it); a fault scenario then calls
 * `sever()` — the listener closes and every live piped socket is destroyed, so
 * in-flight and new requests fail exactly like a real outage — and `restore()`
 * brings the port back. Zero production edits, zero mocks: the bot code
 * experiences a genuine ECONNREFUSED/ECONNRESET window.
 *
 * Safety: the loopback guard still holds (the proxy is 127.0.0.1, and the
 * TARGET is the same disposable local stack). The scenario runner force-
 * restores all proxies after every scenario, so a throwing script can never
 * leave the stack severed for the next scenario or teardown.
 */
import net from 'node:net';

export interface FaultProxy {
  /** The local port the stack was pointed at. */
  readonly port: number;
  /** True while the outage window is open. */
  readonly severed: boolean;
  /** Open the outage window: stop accepting AND destroy every live pipe. */
  sever(): Promise<void>;
  /** Close the outage window: listen again on the same port. */
  restore(): Promise<void>;
  /** Tear the proxy down entirely (end of process). */
  stop(): Promise<void>;
}

class TcpFaultProxy implements FaultProxy {
  private _port: number;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private _severed = false;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
    port: number,
  ) {
    this._port = port;
  }

  get port(): number {
    return this._port;
  }

  get severed(): boolean {
    return this._severed;
  }

  private makeServer(): net.Server {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.sockets.add(client);
      this.sockets.add(upstream);
      const drop = (s: net.Socket) => {
        this.sockets.delete(s);
        s.destroy();
      };
      client.on('error', () => drop(upstream));
      upstream.on('error', () => drop(client));
      client.on('close', () => {
        this.sockets.delete(client);
        drop(upstream);
      });
      upstream.on('close', () => {
        this.sockets.delete(upstream);
        drop(client);
      });
      client.pipe(upstream);
      upstream.pipe(client);
    });
    return server;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = this.makeServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    // Port 0 = ephemeral: capture the assigned port so restores re-listen on
    // the SAME port the stack's clients were bound to.
    const addr = server.address();
    if (addr && typeof addr === 'object') this._port = addr.port;
    this.server = server;
    this._severed = false;
  }

  async sever(): Promise<void> {
    if (this._severed) return;
    this._severed = true;
    const server = this.server;
    this.server = null;
    // Destroy every live pipe FIRST so in-flight requests fail like a cut cable,
    // then stop accepting (new connects get ECONNREFUSED).
    for (const s of [...this.sockets]) s.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async restore(): Promise<void> {
    if (!this._severed) return;
    await this.listen();
  }

  async stop(): Promise<void> {
    await this.sever();
    this._severed = false;
  }
}

/** Start a fault proxy forwarding to `targetHost:targetPort`. Pass port 0 for
 *  an ephemeral (parallel-safe) port — read `.port` for the assigned value,
 *  which restores reuse. */
export async function startFaultProxy(
  targetHost: string,
  targetPort: number,
  port = 0,
): Promise<FaultProxy> {
  const proxy = new TcpFaultProxy(targetHost, targetPort, port);
  await proxy.listen();
  return proxy;
}

/**
 * The per-process fault controls a runner registers when it routed the stack
 * through proxies, and scenario scripts read via `ctx.faults`. Null when the
 * process runs directly against the stack — fault scenarios then GATE honestly.
 */
export interface FaultControls {
  readonly supabase?: FaultProxy;
  readonly valkey?: FaultProxy;
}

let registered: FaultControls | null = null;

export function registerFaultControls(controls: FaultControls): void {
  registered = controls;
}

export function getFaultControls(): FaultControls | null {
  return registered;
}

/** Force-close every registered outage window (runner safety net between scenarios). */
export async function restoreAllFaults(): Promise<void> {
  if (!registered) return;
  if (registered.supabase?.severed) await registered.supabase.restore();
  if (registered.valkey?.severed) await registered.valkey.restore();
}
