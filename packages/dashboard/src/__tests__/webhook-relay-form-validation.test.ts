import { describe, expect, it } from 'vitest';
import {
  clearResolvedDestinationError,
  destinationValidationError,
} from '@/lib/webhook-relay-form-validation';

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

  it.each([
    ['no selected channel', null, true],
    ['no authoritative snapshot', 'channel-1', false],
  ])('returns a field-local error with %s', (_state, channelId, authoritative) => {
    expect(destinationValidationError(channelId, authoritative))
      .toBe('Choose a destination from a fresh live Discord snapshot.');
  });

  it('accepts a selected destination from an authoritative snapshot', () => {
    expect(destinationValidationError('channel-1', true)).toBeNull();
  });
});
