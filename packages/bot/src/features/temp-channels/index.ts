/**
 * Temporary Voice Channels — Phase 10
 *
 * Hub-based system: user joins hub VC → bot creates personal VC → deleted when empty.
 * Owner controls via slash commands, keep-alive timer, optional text channel.
 */
export { TempChannelManager } from './temp-channel-manager.js';
export { handleVoiceStateForTempChannels } from './voice-handler.js';
export { buildTempChannelCommands, handleTempChannelCommand } from './commands.js';
