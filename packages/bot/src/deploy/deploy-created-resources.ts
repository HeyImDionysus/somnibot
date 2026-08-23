import type { SomniClient } from '../client.js';
import type { DeployResult } from './deployer.js';
import { recordAdminChange, undoByDeleting } from '../services/admin-changes.js';

export async function recordCreatedResourceChanges(
  client: SomniClient,
  guildId: string,
  result: DeployResult,
): Promise<void> {
  for (const action of result.actions) {
    if (action.action !== 'create' || !action.success || !action.discordId) continue;
    if (action.entityType !== 'role'
      && action.entityType !== 'channel'
      && action.entityType !== 'category') continue;

    await recordAdminChange(client.supabase, {
      guildId,
      actorId: 'deployer',
      action: `server_deploy.${action.entityType}_created`,
      targetType: action.entityType,
      targetId: action.discordId,
      description: `Server setup created the ${action.entityType} "${action.entityName}".`,
      before: null,
      after: { name: action.entityName, discord_id: action.discordId },
      blastRadius: action.entityType === 'role' ? 'medium' : 'high',
      undo: undoByDeleting(action.entityType, action.discordId),
    });
  }
}
