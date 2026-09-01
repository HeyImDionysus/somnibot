import { describe, expect, it } from 'vitest';
import {
  adoptionStateErrors,
  normalizeAdoptionMapState,
} from '@/lib/dashboard/adoption-map';

describe('dashboard adoption-map games track', () => {
  it('preserves existing activation when evidence expires during an adoption-only edit', () => {
    const previous = normalizeAdoptionMapState({ mode: 'guided', tutorialVisible: true, selectedTrackIds: ['core','recovery','games'], verifiedTrackIds: [], trackStates: { core: 'active', games: 'active' } });
    expect(adoptionStateErrors({ ...previous, tutorialVisible: false }, previous)).toEqual([]);
  });

  it('requires current proof to reactivate a paused track', () => {
    const previous = normalizeAdoptionMapState({ mode: 'guided', tutorialVisible: true, selectedTrackIds: ['core','recovery','games'], verifiedTrackIds: [], trackStates: { core: 'active', games: 'paused' } });
    expect(adoptionStateErrors({ ...previous, trackStates: { core: 'active', games: 'active' } }, previous)).toContain('games:verification_required');
  });
  it('preserves a selected games track from authoritative readback', () => {
    // Given a saved map that includes games alongside the required tracks.
    const state = normalizeAdoptionMapState({
      mode: 'guided',
      tutorialVisible: true,
      selectedTrackIds: ['core', 'recovery', 'games'],
      verifiedTrackIds: ['core', 'games'],
      trackStates: { core: 'active', games: 'paused' },
    });

    // When the saved state is normalized at the dashboard boundary.

    // Then the independently selected paused games track remains readable.
    expect(state).toMatchObject({
      selectedTrackIds: ['core', 'recovery', 'games'],
      trackStates: { games: 'paused' },
    });
  });

  it('allows verified games activation without activating economy', () => {
    // Given core and games have server-derived verification evidence.
    const state = {
      mode: 'guided' as const,
      tutorialVisible: true,
      selectedTrackIds: ['core', 'recovery', 'games'],
      verifiedTrackIds: ['core', 'games'],
      trackStates: { core: 'active' as const, games: 'active' as const },
    };

    // When games is activated through the independent track state machine.
    const errors = adoptionStateErrors(state);

    // Then it has no dependency on economy activation.
    expect(errors).toEqual([]);
  });
});
