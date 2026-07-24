/**
 * fault-proxy tests — the TCP outage seam behind ctx.faults.
 *
 * Proves the three contracts the DEPFAIL lane depends on:
 *   1. transparent piping while healthy,
 *   2. sever() = a REAL outage (in-flight sockets destroyed, new connects refused),
 *   3. restore() = the SAME port serves again (clients bound to it recover).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { startFaultProxy, type FaultProxy } from '../fault-proxy.js';

/** A tiny echo server standing in for the real dependency. */
function startEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.pipe(s));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.setTimeout(2_000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
    sock.on('data', (d) => { sock.destroy(); resolve(d.toString()); });
    sock.on('connect', () => sock.write(payload));
  });
}

describe('fault-proxy', () => {
  let echo: { port: number; close: () => void };
  let proxy: FaultProxy;

  beforeAll(async () => {
    echo = await startEcho();
    proxy = await startFaultProxy('127.0.0.1', echo.port, 0);
  });

  afterAll(async () => {
    await proxy.stop();
    echo.close();
  });

  it('pipes transparently while healthy', async () => {
    expect(proxy.severed).toBe(false);
    await expect(roundTrip(proxy.port, 'ping')).resolves.toBe('ping');
  });

  it('sever() is a real outage: new connects are refused', async () => {
    await proxy.sever();
    expect(proxy.severed).toBe(true);
    await expect(roundTrip(proxy.port, 'ping')).rejects.toThrow();
  });

  it('restore() serves again on the SAME port', async () => {
    const portBefore = proxy.port;
    await proxy.restore();
    expect(proxy.severed).toBe(false);
    expect(proxy.port).toBe(portBefore);
    await expect(roundTrip(proxy.port, 'ping')).resolves.toBe('ping');
  });

  it('sever() destroys in-flight pipes, not just the listener', async () => {
    // Open a socket through the proxy and hold it, then sever: the held socket
    // must die (close/error), exactly like a cut cable mid-request.
    const held = net.connect(proxy.port, '127.0.0.1');
    await new Promise<void>((resolve) => held.on('connect', () => resolve()));
    const died = new Promise<boolean>((resolve) => {
      held.on('close', () => resolve(true));
      held.on('error', () => resolve(true));
    });
    await proxy.sever();
    await expect(died).resolves.toBe(true);
    await proxy.restore();
  });
});
