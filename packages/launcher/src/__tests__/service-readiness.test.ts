import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeLavalinkReady,
  probeValkeyReady,
  waitForServiceReady,
} from '../main/service-readiness';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('managed service readiness probes', () => {
  it('requires a real Redis PONG response', async () => {
    const server = createTcpServer((socket) => {
      socket.once('data', (request) => {
        if (request.toString('utf8') === '*1\r\n$4\r\nPING\r\n') socket.end('+PONG\r\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP test server has no port');

    expect(await probeValkeyReady('127.0.0.1', address.port)).toBe(true);
  });

  it('accepts the authenticated-listener statuses exposed by Lavalink', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server has no port');

    expect(await probeLavalinkReady(`http://127.0.0.1:${address.port}/version`)).toBe(true);
  });

  it('polls until the service is ready without accepting process existence alone', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    expect(await waitForServiceReady(probe, () => true, 1_000, 1)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
