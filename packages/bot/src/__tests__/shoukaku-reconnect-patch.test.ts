import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';
import { Connector, Shoukaku, type NodeOption } from 'shoukaku';

class ImmediateConnector extends Connector {
  getId(): string {
    return 'test-bot-user';
  }

  sendPacket(_shardId: number, _payload: unknown, _important: boolean): void {}

  listen(nodes: NodeOption[]): void {
    this.ready(nodes);
  }
}

describe('Shoukaku reconnect dependency patch', () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  });

  it('keeps the Lavalink node when a retry succeeds after an initial connection failure', async () => {
    const server = createServer();
    const sockets = new Set<Socket>();
    let connectionAttempts = 0;

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    const secondConnection = new Promise<void>((resolve, reject) => {
      server.on('upgrade', (request, socket) => {
        connectionAttempts += 1;
        if (connectionAttempts === 1) {
          socket.destroy();
          return;
        }

        const websocketKey = request.headers['sec-websocket-key'];
        if (typeof websocketKey !== 'string') {
          reject(new TypeError('Expected a WebSocket handshake key'));
          socket.destroy();
          return;
        }

        const accept = createHash('sha1')
          .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'));

        const readyPayload = Buffer.from(JSON.stringify({
          op: 'ready',
          resumed: false,
          sessionId: 'restart-recovery-session',
        }));
        socket.write(Buffer.concat([
          Buffer.from([0x81, readyPayload.length]),
          readyPayload,
        ]), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    cleanupTasks.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new TypeError('Expected the test server to expose an ephemeral TCP port');
    }

    const shoukaku = new Shoukaku(
      new ImmediateConnector(null),
      [{ name: 'main', url: `127.0.0.1:${address.port}`, auth: 'test-password' }],
      { reconnectTries: 2, reconnectInterval: 0 },
    );
    const errors: Error[] = [];
    shoukaku.on('error', (_name, error) => errors.push(error));

    await secondConnection;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(connectionAttempts).toBe(2);
    expect(shoukaku.nodes.get('main')?.state).toBe(1);
  });
});
