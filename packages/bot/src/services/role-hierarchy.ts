import type { Guild, Role } from 'discord.js';

export class RoleHierarchyError extends Error {
  readonly name = 'RoleHierarchyError';
}

function botRoleIds(guild: Guild): Set<string> {
  return new Set(guild.members.me?.roles.cache.keys() ?? []);
}

function hierarchyContext(guild: Guild, roles: readonly Role[]): string {
  return [
    `botPosition=${guild.members.me?.roles.highest.position ?? 'missing'}`,
    `botManageRoles=${guild.members.me?.permissions.has('ManageRoles') ?? false}`,
    `botAdministrator=${guild.members.me?.permissions.has('Administrator') ?? false}`,
    `targets=${roles.map((role) => `${role.id}:${role.position}:${role.editable}:${role.managed}`).join(',')}`,
  ].join('; ');
}

export async function placeRolesDirectlyBelowBot(
  guild: Guild,
  orderedRoleIds: readonly string[],
): Promise<void> {
  if (orderedRoleIds.length === 0) return;

  await guild.roles.fetch();
  const roles: Role[] = orderedRoleIds.map((roleId) => {
    const role = guild.roles.cache.get(roleId);
    if (!role) throw new RoleHierarchyError(`Desired role ${roleId} is missing after hierarchy refresh`);
    if (role.managed || !role.editable) {
      throw new RoleHierarchyError(`Desired role ${role.name} cannot be moved by the bot`);
    }
    return role;
  });

  for (const role of roles) {
    await guild.roles.fetch();
    const liveRole = guild.roles.cache.get(role.id);
    const botPosition = guild.members.me?.roles.highest.position;
    if (!liveRole || botPosition === undefined) {
      throw new RoleHierarchyError('Bot or desired role disappeared during hierarchy placement');
    }
    if (liveRole.position >= botPosition || !liveRole.editable || liveRole.managed) {
      throw new RoleHierarchyError(
        `Desired role ${liveRole.name} is not movable below the bot (${hierarchyContext(guild, roles)})`,
      );
    }
    await liveRole.setPosition(botPosition - 1, {
      reason: 'SomniBot — apply reviewed role hierarchy',
    });
  }

  await guild.roles.fetch();
  const botPosition = guild.members.me?.roles.highest.position;
  if (botPosition === undefined) {
    throw new RoleHierarchyError('Bot member is unavailable after hierarchy placement');
  }

  const ownRoleIds = botRoleIds(guild);
  const actualTopBlock = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id && !ownRoleIds.has(role.id) && role.position < botPosition)
    .sort((left, right) => right.position - left.position)
    .slice(0, orderedRoleIds.length)
    .map((role) => role.id);
  const expectedTopBlock = [...orderedRoleIds].reverse();
  if (actualTopBlock.some((roleId, index) => roleId !== expectedTopBlock[index])) {
    throw new RoleHierarchyError(
      `Discord did not preserve the reviewed role hierarchy (${hierarchyContext(guild, roles)})`,
    );
  }
}
