import { describe, expect, it } from 'vitest';
import { schemas } from '@/lib/api/validation';

describe('public license SDK validation contract', () => {
  it('requires the session id that the deactivate route consumes', () => {
    expect(schemas.licenseSdk.deactivate.safeParse({ license_key: 'SMNI-EXAMPLE' }).success).toBe(false);
    expect(schemas.licenseSdk.deactivate.safeParse({
      license_key: 'SMNI-EXAMPLE',
      session_id: '00000000-0000-4000-8000-000000000123',
    }).success).toBe(true);
  });
});
