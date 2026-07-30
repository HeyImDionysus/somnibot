/**
 * Voice state handler for temp channel hub detection.
 */
import type { VoiceState } from 'discord.js';
import type { TempChannelManager } from './temp-channel-manager.js';

/**
 * Process voice state updates for temp channels.
 * Called from the main voice state event handler.
 */
export async function handleVoiceStateForTempChannels(
  oldState: VoiceState,
  newState: VoiceState,
  manager: TempChannelManager,
): Promise<void> {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  // User joined a channel
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    // Check if this is a hub channel
    if (manager.isHubChannel(newState.channelId)) {
      // Voice gateway events do not expose an interaction id. The live-room
      // identity is therefore guild+hub+member and is released when that room
      // is deleted, allowing a later legitimate join to create a new room.
      await manager.handleJoinHub(
        member,
        newState.channelId,
        `${newState.guild.id}:${newState.channelId}:${member.id}`,
      );
      return;
    }
  }

  // User left a channel (or moved away from one)
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    if (manager.isTempChannel(oldState.channelId)) {
      await manager.handleLeaveTemp(oldState.channelId);
    }
  }
}
