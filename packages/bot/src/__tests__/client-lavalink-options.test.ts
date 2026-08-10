import { describe, expect, it } from 'vitest';
import { SOMNIBOT_SHOUKAKU_OPTIONS } from '../client';

describe('Lavalink reconnect policy', () => {
  it('uses Shoukaku reconnect seconds rather than milliseconds', () => {
    expect(SOMNIBOT_SHOUKAKU_OPTIONS.reconnectTries).toBe(60);
    expect(SOMNIBOT_SHOUKAKU_OPTIONS.reconnectInterval).toBe(5);
  });
});
