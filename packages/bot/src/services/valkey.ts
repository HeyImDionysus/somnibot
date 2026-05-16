import Valkey from 'iovalkey';
import { getConfig } from '../config.js';

let _client: Valkey | null = null;

/**
 * Get the Valkey (Redis-compatible) client.
 * Used for XP cooldowns, queue state, rate limiting, caching.
 */
export function getValkey(): Valkey {
  if (_client) return _client;

  const config = getConfig();
  _client = new Valkey(config.VALKEY_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      console.log(`[Valkey] Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    lazyConnect: true,
  });

  _client.on('connect', () => console.log('[Valkey] Connected'));
  _client.on('error', (err) => console.error('[Valkey] Error:', err.message));
  _client.on('close', () => console.log('[Valkey] Connection closed'));

  return _client;
}

/**
 * Initialize Valkey connection.
 */
export async function connectValkey(): Promise<void> {
  const client = getValkey();
  await client.connect();
  console.log('[Valkey] Ready');
}
