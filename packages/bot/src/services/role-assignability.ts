import type { Guild, Role } from 'discord.js';

export type RoleAssignmentIssue = {
  readonly kind: 'missing' | 'managed' | 'permission' | 'hierarchy';
  readonly message: string;
};

export class RoleAssignmentError extends Error {
  readonly name = 'RoleAssignmentError';

  constructor(
    readonly roleId: string,
    readonly issue: RoleAssignmentIssue,
  ) {
    super(issue.message);
  }
}

export function roleAssignmentIssue(guild: Guild, roleId: string): RoleAssignmentIssue | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    return {
      kind: 'missing',
      message: `Configured role ${roleId} no longer exists. Select a current role in the dashboard.`,
    };
  }
  if (role.managed) {
    return {
      kind: 'managed',
      message: `The configured role "${role.name}" is managed by Discord and cannot be changed by SomniBot.`,
    };
  }
  if (!guild.members.me?.permissions.has('ManageRoles')) {
    return {
      kind: 'permission',
      message: 'Grant SomniBot Manage Roles, then retry.',
    };
  }
  if (!role.editable) {
    return {
      kind: 'hierarchy',
      message: `Move SomniBot above the "${role.name}" role and grant Manage Roles, then retry.`,
    };
  }
  return null;
}

export function requireAssignableRole(guild: Guild, roleId: string): Role {
  const issue = roleAssignmentIssue(guild, roleId);
  if (issue) throw new RoleAssignmentError(roleId, issue);
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    throw new RoleAssignmentError(roleId, {
      kind: 'missing',
      message: `Configured role ${roleId} no longer exists. Select a current role in the dashboard.`,
    });
  }
  return role;
}
