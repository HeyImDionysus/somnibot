/**
 * Escalation Chain Tests — V53 Phase 5 (Finding 5.3)
 *
 * Tests the pure `getEscalationAction()` function that determines
 * punishment escalation based on active warning count.
 */
import { describe, it, expect } from 'vitest';
import { getEscalationAction } from '../features/moderation/escalation.js';
import { DEFAULT_ESCALATION_CHAIN, type EscalationStep } from '@somnibot/shared';

describe('getEscalationAction', () => {
  it('returns null for empty chain', () => {
    expect(getEscalationAction([], 3)).toBeNull();
  });

  it('returns null for zero warnings', () => {
    expect(getEscalationAction(DEFAULT_ESCALATION_CHAIN, 0)).toBeNull();
  });

  it('returns warn for 1 active warning', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 1);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('warn');
    expect(result!.threshold).toBe(1);
  });

  it('returns warn for 2 active warnings', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 2);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('warn');
    expect(result!.threshold).toBe(2);
  });

  it('returns mute (1h) for 3 active warnings', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 3);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('mute');
    expect(result!.durationMinutes).toBe(60);
  });

  it('returns mute (24h) for 4 active warnings', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 4);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('mute');
    expect(result!.durationMinutes).toBe(1440);
  });

  it('returns kick for 5 active warnings', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 5);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('kick');
  });

  it('returns ban for 6 active warnings', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 6);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('ban');
  });

  it('returns ban for 10+ active warnings (highest threshold)', () => {
    const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, 10);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('ban');
    expect(result!.threshold).toBe(6);
  });

  it('handles custom chain with single step', () => {
    const chain: EscalationStep[] = [
      { threshold: 3, action: 'ban', dmMember: false },
    ];
    expect(getEscalationAction(chain, 2)).toBeNull();
    expect(getEscalationAction(chain, 3)!.action).toBe('ban');
    expect(getEscalationAction(chain, 99)!.action).toBe('ban');
  });

  it('handles custom chain with non-sequential thresholds', () => {
    const chain: EscalationStep[] = [
      { threshold: 1, action: 'warn', dmMember: true },
      { threshold: 5, action: 'mute', durationMinutes: 120, dmMember: true },
      { threshold: 10, action: 'ban', dmMember: true },
    ];
    expect(getEscalationAction(chain, 3)!.action).toBe('warn');
    expect(getEscalationAction(chain, 5)!.action).toBe('mute');
    expect(getEscalationAction(chain, 7)!.action).toBe('mute');
    expect(getEscalationAction(chain, 10)!.action).toBe('ban');
  });

  it('always has dmMember field in returned step', () => {
    for (let i = 1; i <= 6; i++) {
      const result = getEscalationAction(DEFAULT_ESCALATION_CHAIN, i);
      expect(result).not.toBeNull();
      expect(typeof result!.dmMember).toBe('boolean');
    }
  });
});
