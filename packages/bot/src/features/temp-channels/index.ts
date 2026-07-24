/**
 * Temporary Voice Channels — Phase 10
 *
 * Hub-based system: user joins hub VC → bot creates personal VC → deleted when empty.
 * Owner controls via slash commands, keep-alive timer, optional text channel.
 */
export { TempChannelManager } from './temp-channel-manager.js';
export { handleVoiceStateForTempChannels } from './voice-handler.js';
export { buildTempChannelCommands, handleTempChannelCommand } from './commands.js';
export {
  TEMP_CHANNEL_TEMPLATE_KEYS,
  DEFAULT_TEMP_CHANNEL_TEMPLATES,
  TEMP_CHANNEL_TEMPLATE_VARIABLES,
  resolveTemplate,
  selectTemplate,
  renderTempChannelTemplate,
  type TempChannelTemplateKey,
  type TemplateVars,
  type TemplateSource,
} from './templates.js';
