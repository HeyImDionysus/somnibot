import { describe, expect, it } from 'vitest';
import { getOperatorLicensingGuide } from '@/lib/store/operator-licensing-guide';

describe('operator licensing guide', () => {
  it('routes a download-once product away from license keys', () => {
    const guide = getOperatorLicensingGuide({
      type: 'one_time',
      deliveryType: 'file',
    });

    expect(guide.kind).toBe('download');
    expect(guide.keyRequired).toBe(false);
    expect(guide.steps.join(' ')).toContain('five-minute');
    expect(guide.steps.join(' ')).toContain('cannot be reused');
  });

  it('keeps download guidance when the product also grants a bonus role', () => {
    const guide = getOperatorLicensingGuide({
      type: 'one_time',
      deliveryType: 'file',
      grantedRoleCount: 1,
    });

    expect(guide.kind).toBe('download');
    expect(guide.steps.join(' ')).toContain('upload the customer download');
    expect(guide.steps.join(' ')).toContain('bonus Discord role');
  });

  it('makes the software outage-policy choice explicit', () => {
    const guide = getOperatorLicensingGuide({
      type: 'one_time',
      deliveryType: 'license_key',
    });

    expect(guide.kind).toBe('software');
    expect(guide.keyRequired).toBe(true);
    expect(guide.steps.some((step) => step.startsWith('Fail open:'))).toBe(true);
    expect(guide.steps.some((step) => step.startsWith('Fail closed:'))).toBe(true);
  });

  it('ties recurring keys to the paid entitlement lifecycle', () => {
    const guide = getOperatorLicensingGuide({
      type: 'subscription',
      deliveryType: 'license_key',
    });

    expect(guide.kind).toBe('subscription');
    expect(guide.keyRequired).toBe(true);
    expect(guide.summary).toContain('only while the paid entitlement is live');
  });

  it('treats a recurring Discord role as the product without minting a key', () => {
    const guide = getOperatorLicensingGuide({
      type: 'subscription',
      deliveryType: 'access_pass',
      grantedRoleCount: 1,
    });

    expect(guide.kind).toBe('discord_perk');
    expect(guide.keyRequired).toBe(false);
    expect(guide.summary).toContain('Discord role');
  });

  it('does not silently reduce mixed delivery to software-only instructions', () => {
    const guide = getOperatorLicensingGuide({
      type: 'one_time',
      deliveryType: 'mixed',
      grantedRoleCount: 1,
    });

    expect(guide.kind).toBe('mixed');
    expect(guide.steps.join(' ')).toContain('every bundled delivery');
  });
});
