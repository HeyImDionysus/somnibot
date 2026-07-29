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
  initialValues?: Record<string, string>;
  dropFirstSetBeforeCommit?: boolean;
  dropFirstSetReplyAfterCommit?: boolean;
  rejectConnectionsAfterDroppedSet?: boolean;
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
  const values = new Map<string, string>(Object.entries(options.initialValues ?? {}));
  let pingReplies = 0;
  let ignoredPing = false;
  let droppedSetReply = false;
  let rejectConnections = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    if (rejectConnections) {
      socket.destroy();
      return;
    }
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
        } else if (name === 'SET') {
          const [key, value, ...setOptions] = args;
          const nx = setOptions.some((option) => option.toUpperCase() === 'NX');
          if (!key || value === undefined) {
            socket.write('-ERR invalid SET\r\n');
          } else if (nx && values.has(key)) {
            socket.write('$-1\r\n');
          } else if (
            options.dropFirstSetBeforeCommit
            && !droppedSetReply
          ) {
            droppedSetReply = true;
            socket.destroy();
          } else {
            values.set(key, value);
            if (
              options.dropFirstSetReplyAfterCommit
              && !droppedSetReply
            ) {
              droppedSetReply = true;
              rejectConnections = options.rejectConnectionsAfterDroppedSet ?? false;
              socket.destroy();
            } else {
              socket.write('+OK\r\n');
            }
          }
        } else if (name === 'GET' && args[0] === 'somnibot:heartbeat:bot') {
          socket.write(bulk(heartbeat));
        } else if (name === 'GET' && args[0] && values.has(args[0])) {
          socket.write(bulk(values.get(args[0])!));
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
  it('atomically consumes a single-use key in shared Valkey', async () => {
    const fixture = await startValkeyFixture('nonce value', '{}');
    process.env.VALKEY_URL = fixture.url;

    try {
      const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(
        consumeSingleUseValkeyKey('ratelimit:download:nonce:one', 330),
      ).resolves.toBe('consumed');
      await expect(
        consumeSingleUseValkeyKey('ratelimit:download:nonce:one', 330),
      ).resolves.toBe('replay');

      expect(fixture.commands).toHaveLength(3);
      expect(fixture.commands[0]).toEqual(['AUTH', 'nonce value']);
      expect(fixture.commands[1].slice(0, 2)).toEqual([
        'SET',
        'ratelimit:download:nonce:one',
      ]);
      expect(fixture.commands[1].slice(3)).toEqual(['NX', 'EX', '330']);
      expect(Number(fixture.commands[1][2])).toBeGreaterThanOrEqual(2);
      expect(fixture.commands[2].slice(0, 2)).toEqual([
        'SET',
        'ratelimit:download:nonce:one',
      ]);
      expect(fixture.commands[2].slice(3)).toEqual(['NX', 'EX', '330']);
      expect(fixture.commands[2][2]).not.toBe(fixture.commands[1][2]);
    } finally {
      await fixture.close();
    }
  });

  it('confirms its own committed claim after the SET reply is lost', async () => {
    const fixture = await startValkeyFixture('lost reply value', '{}', {
      dropFirstSetReplyAfterCommit: true,
    });
    process.env.VALKEY_URL = fixture.url;

    try {
      const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');
      const key = 'ratelimit:download:nonce:lost-reply';

      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('consumed');
      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('replay');

      expect(fixture.commands).toHaveLength(5);
      expect(fixture.commands[0]).toEqual(['AUTH', 'lost reply value']);
      expect(fixture.commands[1].slice(0, 2)).toEqual(['SET', key]);
      const claim = fixture.commands[1][2];
      expect(Number(claim)).toBeGreaterThanOrEqual(2);
      expect(fixture.commands[2]).toEqual(['AUTH', 'lost reply value']);
      expect(fixture.commands[3]).toEqual(['GET', key]);
      expect(fixture.commands[4].slice(0, 2)).toEqual(['SET', key]);
      expect(fixture.commands[4][2]).not.toBe(claim);
    } finally {
      await fixture.close();
    }
  });

  it('keeps a retry safe when fresh confirmation proves the dispatched SET did not commit', async () => {
    const fixture = await startValkeyFixture('absent claim value', '{}', {
      dropFirstSetBeforeCommit: true,
    });
    process.env.VALKEY_URL = fixture.url;

    try {
      const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');
      const key = 'ratelimit:download:nonce:confirmed-absent';

      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('unavailable');
      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('consumed');
      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('replay');
    } finally {
      await fixture.close();
    }
  });

  it('treats a legacy numeric claim as replay during a rolling deployment', async () => {
    const key = 'ratelimit:download:nonce:legacy';
    const fixture = await startValkeyFixture('legacy value', '{}', {
      initialValues: { [key]: '1' },
    });
    process.env.VALKEY_URL = fixture.url;

    try {
      const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(
        consumeSingleUseValkeyKey(key, 330),
      ).resolves.toBe('replay');
    } finally {
      await fixture.close();
    }
  });

  it('reports an unresolved dispatched write as uncertain, not retryable unavailability', async () => {
    const fixture = await startValkeyFixture('uncertain value', '{}', {
      dropFirstSetReplyAfterCommit: true,
      rejectConnectionsAfterDroppedSet: true,
    });
    process.env.VALKEY_URL = fixture.url;

    try {
      const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');

      await expect(
        consumeSingleUseValkeyKey('ratelimit:download:nonce:uncertain', 330),
      ).resolves.toBe('uncertain');
    } finally {
      await fixture.close();
    }
  });

  it('does not call a dispatched write retryable when shared Valkey disappears', async () => {
    const fixture = await startValkeyFixture('outage value', '{}');
    process.env.VALKEY_URL = fixture.url;
    const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');

    await expect(
      consumeSingleUseValkeyKey('download:nonce:outage', 330),
    ).resolves.toBe('consumed');
    await fixture.close();

    await expect(
      consumeSingleUseValkeyKey('download:nonce:outage', 330),
    ).resolves.toBe('uncertain');
  });

  it('recovers from an unavailable store without creating local nonce state', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { consumeSingleUseValkeyKey } = await import('@/lib/api/rate-limit');

    await expect(
      consumeSingleUseValkeyKey('download:nonce:recovery', 330),
    ).resolves.toBe('unavailable');

    const fixture = await startValkeyFixture('recovery value', '{}');
    process.env.VALKEY_URL = fixture.url;
    now += 5_001;

    try {
      await expect(
        consumeSingleUseValkeyKey('download:nonce:recovery', 330),
      ).resolves.toBe('consumed');
      await expect(
        consumeSingleUseValkeyKey('download:nonce:recovery', 330),
      ).resolves.toBe('replay');
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });

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
