import { describe, expect, it } from 'vitest';
import { clearResolvedDestinationError } from '@/lib/webhook-relay-form-validation';

describe('webhook relay destination validation', () => {
  it('clears a stale error after a live channel selection becomes valid', () => {
    expect(clearResolvedDestinationError(
      'Choose a destination from a fresh live Discord snapshot.',
      'channel-1',
      true,
    )).toBeNull();
  });

  it.each([
    ['no selected channel', null, true],
    ['no authoritative snapshot', 'channel-1', false],
  ])('retains the error with %s', (_state, channelId, authoritative) => {
    const error = 'Choose a destination from a fresh live Discord snapshot.';

    expect(clearResolvedDestinationError(error, channelId, authoritative)).toBe(error);
  });
});
