import Valkey from 'iovalkey';
import { getConfig } from '../config.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Valkey');

let _client: Valkey | null = null;

/**
 * Get the Valkey (Redis-compatible) client.
 * Used for XP cooldowns, queue state, rate limiting, caching.
 */
export function getValkey(): Valkey {
  if (_client) return _client;

  const config = getConfig();

  // VALKEY_PASSWORD is what docker-compose uses to decide whether to start
  // Valkey with --requirepass, but the client only ever read VALKEY_URL — so
  // setting the password (as DEPLOYMENT.md instructs for a VPS) switched auth
  // on for the server and not for us, and every command failed with
  // "NOAUTH Authentication required". The bot then reported "continuing without
  // cache" and ran on, cacheless, for reasons the operator could not see.
  //
  // Take the password from VALKEY_PASSWORD when the URL does not already carry
  // one, so the two settings cannot disagree. A password embedded in the URL
  // still wins, since that is the more specific instruction.
  const urlHasPassword = (() => {
    try {
      return new URL(config.VALKEY_URL).password !== '';
    } catch {
      return false;
    }
  })();
  const password = urlHasPassword ? undefined : (config.VALKEY_PASSWORD || undefined);

  _client = new Valkey(config.VALKEY_URL, {
    ...(password ? { password } : {}),
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      log.info(`Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    lazyConnect: true,
  });

  _client.on('connect', () => log.info('Connected'));
  _client.on('error', (err) => log.error('Error:', err.message));
  _client.on('close', () => log.info('Connection closed'));

  return _client;
}

/**
 * Initialize Valkey connection.
 *
 * V10 Audit §13: Catches NOAUTH errors from password mismatches and logs
 * a clear message pointing to VALKEY_URL configuration.
 */
export async function connectValkey(): Promise<void> {
  const client = getValkey();
  try {
    await client.connect();
    log.info('Ready');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NOAUTH') || msg.includes('Authentication required')) {
      log.error(
        'Valkey authentication failed (NOAUTH). ' +
        'Check that VALKEY_URL includes the correct password ' +
        '(e.g., redis://:yourpassword@localhost:6379). ' +
        'If Valkey is configured with --requirepass in docker-compose.yml, ' +
        'the password in VALKEY_URL must match.',
      );
    }
    throw err;
  }
}
