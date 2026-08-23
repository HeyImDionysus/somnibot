import { describe, expect, it } from 'vitest';
import { normalizeLicensingCapabilities } from '@/lib/store/licensing-capabilities';

describe('legacy licensing feature flags', () => {
  it('preserves parsing without fabricating capability semantics', () => {
    expect(normalizeLicensingCapabilities(['exports', 'reports'])).toEqual([]);
  });
});
