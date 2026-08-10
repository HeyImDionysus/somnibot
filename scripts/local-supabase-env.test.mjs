import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSupabaseStatusEnv, readLocalSupabaseStatus } from './local-supabase-env.mjs';

test('parses status env output without requiring a specific key format', () => {
  const parsed = parseSupabaseStatusEnv(`API_URL=http://127.0.0.1:54321\nANON_KEY=anon-current\nSERVICE_ROLE_KEY="service-current"`);
  assert.deepEqual(parsed, {
    API_URL: 'http://127.0.0.1:54321',
    ANON_KEY: 'anon-current',
    SERVICE_ROLE_KEY: 'service-current',
  });
});

test('maps current publishable/secret names when the CLI emits them', () => {
  let invocation;
  const result = readLocalSupabaseStatus({
    cliPath: '',
    exec: (command, args) => {
      invocation = { command, args };
      return 'API_URL=http://127.0.0.1:65432\nPUBLISHABLE_KEY=sb_publishable_current\nSECRET_KEY=sb_secret_current';
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /node_modules[\\/]supabase[\\/]dist[\\/]supabase\.js$/);
  assert.deepEqual(invocation.args.slice(1), ['status', '--output', 'env']);
  assert.deepEqual(result, {
    url: 'http://127.0.0.1:65432',
    anonKey: 'sb_publishable_current',
    publishableKey: 'sb_publishable_current',
    serviceKey: 'sb_secret_current',
    source: 'supabase status',
  });
});

test('uses an explicitly configured Supabase CLI executable', () => {
  let invocation;
  const result = readLocalSupabaseStatus({
    cliPath: '/usr/local/bin/supabase',
    exec: (command, args) => {
      invocation = { command, args };
      return 'API_URL=http://127.0.0.1:54321\nANON_KEY=anon-current\nSERVICE_ROLE_KEY=service-current';
    },
  });
  assert.deepEqual(invocation, {
    command: '/usr/local/bin/supabase',
    args: ['status', '--output', 'env'],
  });
  assert.equal(result.source, 'supabase status');
  assert.equal(result.url, 'http://127.0.0.1:54321');
});

test('does not expose status output when the CLI is unavailable', () => {
  const result = readLocalSupabaseStatus({ exec: () => { throw new Error('status unavailable'); } });
  assert.deepEqual(result, { url: 'http://127.0.0.1:54321', source: 'unavailable' });
});
