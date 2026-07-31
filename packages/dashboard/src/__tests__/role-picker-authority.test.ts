import { describe, expect, it } from 'vitest';
import { missingRoleIds } from '@/components/shared/role-picker';

describe('RolePicker authoritative deletion state', () => {
  it('preserves configured IDs when the live role lookup is not authoritative', () => {
    expect(missingRoleIds(['role-1'], [], false)).toEqual([]);
  });

  it('marks a configured ID missing only after an authoritative role read', () => {
    expect(missingRoleIds(['role-1'], [], true)).toEqual(['role-1']);
    expect(missingRoleIds(
      ['role-1'],
      [{ id: 'role-1', name: 'Member', color: 0, position: 1 }],
      true,
    )).toEqual([]);
  });
});
