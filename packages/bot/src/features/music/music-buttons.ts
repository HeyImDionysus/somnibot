import type { MusicPlayerManager } from './music-player.js';
import type { MusicInteractionAction } from './music-occurrence-fence.js';

export function resolveMusicButtonAction(buttonId: string): MusicInteractionAction | null {
  switch (buttonId) {
    case 'music:pause_resume': return 'pause';
    case 'music:skip': return 'skip';
    case 'music:stop': return 'stop';
    case 'music:shuffle': return 'shuffle';
    case 'music:loop': return 'loop';
    case 'music:vol_down':
    case 'music:vol_up': return 'volume';
    default: return null;
  }
}

export async function applyMusicButtonMutation(
  manager: MusicPlayerManager,
  buttonId: string,
  userId: string,
): Promise<{ message: string }> {
  const guildId = manager.guildId;
  switch (buttonId) {
    case 'music:pause_resume': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'pause');
        return { message: '❌ You need the DJ role to do that' };
      }
      const result = await manager.togglePause(guildId, { userId });
      return { message: result.message };
    }
    case 'music:skip': {
      const isDj = await manager.isDJ(userId);
      if (isDj) {
        const result = await manager.skip(guildId, { userId, method: 'dj_force' });
        return { message: result.message };
      }
      const result = await manager.voteSkip(guildId, userId);
      return { message: result.message };
    }
    case 'music:stop': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'stop');
        return { message: '❌ You need the DJ role to stop playback' };
      }
      const result = await manager.stop(guildId, { userId, reason: 'command' });
      return { message: result.message };
    }
    case 'music:shuffle': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'shuffle');
        return { message: '❌ You need the DJ role to shuffle' };
      }
      const result = await manager.shuffle(guildId, { userId });
      return { message: result.message };
    }
    case 'music:loop': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'loop');
        return { message: '❌ You need the DJ role to change loop mode' };
      }
      const result = await manager.cycleLoopMode(guildId, { userId });
      return { message: result.message };
    }
    case 'music:vol_down': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'volume');
        return { message: '❌ You need the DJ role to change volume' };
      }
      const queue = await manager.queueManager.getQueue(guildId);
      const result = await manager.setVolume(guildId, Math.max(0, (queue?.volume ?? 50) - 10), { userId });
      return { message: result.message };
    }
    case 'music:vol_up': {
      const hasPerm = await manager.isDJ(userId);
      if (!hasPerm) {
        manager.auditPermissionDenied(userId, 'volume');
        return { message: '❌ You need the DJ role to change volume' };
      }
      const queue = await manager.queueManager.getQueue(guildId);
      const result = await manager.setVolume(guildId, Math.min(100, (queue?.volume ?? 50) + 10), { userId });
      return { message: result.message };
    }
    default: return { message: '❌ Unknown action' };
  }
}
