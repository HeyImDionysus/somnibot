import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalValkeyUrl = process.env.VALKEY_URL;
const originalRedisUrl = process.env.REDIS_URL;

interface ParsedCommand {
  args: string[];
  rest: string;
}

interface ValkeyFixture {
  url: string;
  commands: string[][];
  close: () => Promise<void>;
}

interface ValkeyFixtureOptions {
  ignorePingAfterReplies?: number;
}

function parseRespCommand(buffer: string): ParsedCommand | null {
  if (!buffer.startsWith('*')) return null;

  let cursor = 1;
  const countEnd = buffer.indexOf('\r\n', cursor);
  if (countEnd === -1) return null;

  const argCount = Number(buffer.slice(cursor, countEnd));
  if (!Number.isFinite(argCount)) return null;
  cursor = countEnd + 2;

  const args: string[] = [];
  for (let index = 0; index < argCount; index += 1) {
    if (buffer[cursor] !== '$') return null;
    const lengthEnd = buffer.indexOf('\r\n', cursor + 1);
    if (lengthEnd === -1) return null;

    const length = Number(buffer.slice(cursor + 1, lengthEnd));
    if (!Number.isFinite(length)) return null;

    const valueStart = lengthEnd + 2;
    const valueEnd = valueStart + length;
    if (buffer.length < valueEnd + 2) return null;

    args.push(buffer.slice(valueStart, valueEnd));
    cursor = valueEnd + 2;
  }

  return { args, rest: buffer.slice(cursor) };
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startValkeyFixture(
  password: string,
  heartbeat: string,
  options: ValkeyFixtureOptions = {},
): Promise<ValkeyFixture> {
  const sockets = new Set<Socket>();
  const commands: string[][] = [];
  let pingReplies = 0;
  let ignoredPing = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let authenticated = false;

    socket.on('data', (data) => {
      buffer += data.toString();

      while (true) {
        const parsed = parseRespCommand(buffer);
        if (!parsed) break;

        buffer = parsed.rest;
        const [rawName, ...args] = parsed.args;
        const name = rawName.toUpperCase();
        commands.push([name, ...args]);

        if (name === 'AUTH') {
          const suppliedPassword = args.at(-1);
          authenticated = suppliedPassword === password;
          socket.write(authenticated ? '+OK\r\n' : '-ERR invalid password\r\n');
          continue;
        }

        if (!authenticated) {
          socket.write('-NOAUTH Authentication required.\r\n');
          continue;
        }

        if (name === 'PING') {
          if (
            options.ignorePingAfterReplies !== undefined &&
            pingReplies >= options.ignorePingAfterReplies &&
            !ignoredPing
          ) {
            ignoredPing = true;
            continue;
          }
          pingReplies += 1;
          socket.write('+PONG\r\n');
        } else if (name === 'GET' && args[0] === 'somnibot:heartbeat:bot') {
          socket.write(bulk(heartbeat));
        } else {
          socket.write('$-1\r\n');
        }
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('Valkey test server did not expose an address.');
  }

  return {
    url: `redis://:${encodeURIComponent(password)}@127.0.0.1:${address.port}`,
    commands,
    close: () => closeServer(server, sockets),
  };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.VALKEY_URL;
  delete process.env.REDIS_URL;
});

afterEach(() => {
  vi.resetModules();
  if (originalValkeyUrl === undefined) {
    delete process.env.VALKEY_URL;
  } else {
    process.env.VALKEY_URL = originalValkeyUrl;
  }
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
});

describe('rate-limit Valkey authentication', () => {
  it('authenticates passworded Valkey URLs before health PING and heartbeat GET', async () => {
    const heartbeat = JSON.stringify({ timestamp: Date.now() });
    const fixture = await startValkeyFixture('s3cret value', heartbeat);
    process.env.VALKEY_URL = fixture.url;

    try {
      const { checkValkeyHealth, readValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(checkValkeyHealth()).resolves.toBe(true);
      await expect(readValkeyKey('somnibot:heartbeat:bot')).resolves.toBe(heartbeat);

      expect(fixture.commands).toEqual([
        ['AUTH', 's3cret value'],
        ['PING'],
        ['GET', 'somnibot:heartbeat:bot'],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('retries Valkey after a transient authentication failure backoff', async () => {
    const heartbeat = JSON.stringify({ timestamp: Date.now() });
    const fixture = await startValkeyFixture('correct value', heartbeat);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.VALKEY_URL = 'redis://:wrong-value@127.0.0.1:' + new URL(fixture.url).port;

    try {
      const { checkValkeyHealth } = await import('@/lib/api/rate-limit');

      await expect(checkValkeyHealth()).resolves.toBe(false);

      process.env.VALKEY_URL = fixture.url;
      now += 5_001;

      await expect(checkValkeyHealth()).resolves.toBe(true);
      expect(fixture.commands).toEqual([
        ['AUTH', 'wrong-value'],
        ['AUTH', 'correct value'],
        ['PING'],
      ]);
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });

  it('keeps the Valkey health socket usable after an idle period', async () => {
    const heartbeat = JSON.stringify({ timestamp: Date.now() });
    const fixture = await startValkeyFixture('idle-safe value', heartbeat);
    process.env.VALKEY_URL = fixture.url;

    try {
      const { checkValkeyHealth, readValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(checkValkeyHealth()).resolves.toBe(true);
      await wait(2_100);
      await expect(checkValkeyHealth()).resolves.toBe(true);
      await expect(readValkeyKey('somnibot:heartbeat:bot')).resolves.toBe(heartbeat);

      expect(fixture.commands).toEqual([
        ['AUTH', 'idle-safe value'],
        ['PING'],
        ['PING'],
        ['GET', 'somnibot:heartbeat:bot'],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('reconnects after a ready Valkey socket stops answering commands', async () => {
    const heartbeat = JSON.stringify({ timestamp: Date.now() });
    const fixture = await startValkeyFixture('timeout-safe value', heartbeat, {
      ignorePingAfterReplies: 1,
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.VALKEY_URL = fixture.url;

    try {
      const { checkValkeyHealth, readValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(checkValkeyHealth()).resolves.toBe(true);
      await expect(checkValkeyHealth()).resolves.toBe(false);
      await expect(readValkeyKey('somnibot:heartbeat:bot')).resolves.toBeNull();

      now += 5_001;

      await expect(checkValkeyHealth()).resolves.toBe(true);
      await expect(readValkeyKey('somnibot:heartbeat:bot')).resolves.toBe(heartbeat);

      expect(fixture.commands).toEqual([
        ['AUTH', 'timeout-safe value'],
        ['PING'],
        ['PING'],
        ['AUTH', 'timeout-safe value'],
        ['PING'],
        ['GET', 'somnibot:heartbeat:bot'],
      ]);
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });
});
