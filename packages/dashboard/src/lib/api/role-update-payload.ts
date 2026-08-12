import type { LiveRoleData } from './client';

export function roleUpdatePayload(role: LiveRoleData) {
  return {
    roleId: role.id,
    name: role.name,
    tier: role.tier ?? undefined,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions,
    templateKey: role.templateKey ?? undefined,
  };
}
