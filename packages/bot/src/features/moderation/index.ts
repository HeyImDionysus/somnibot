/**
 * Moderation Feature — barrel exports.
 *
 * Provides:
 * - Auto-mod engine (message scanning pipeline)
 * - Auto-mod actions (delete, warn, mute, kick, ban)
 * - Infraction service (CRUD)
 * - Escalation chain (threshold-based auto-escalation)
 * - Mod log (formatted channel posting)
 * - Manual slash commands (/warn, /mute, /kick, /ban, /pardon, /infractions)
 */

export { processMessage, invalidateRulesCache } from './automod-engine.js';
export { executeAutoModAction } from './automod-actions.js';
export {
  createInfraction,
  getActiveWarningCount,
  getActiveInfractionCount,
  getMemberInfractions,
  pardonInfraction,
  expireInfractions,
  calculateExpiryDate,
} from './infraction-service.js';
export { executeEscalation, getEscalationAction } from './escalation.js';
export { postModLogEntry } from './mod-log.js';
export {
  buildModerationCommands,
  handleWarnCommand,
  handleMuteCommand,
  handleKickCommand,
  handleBanCommand,
  handlePardonCommand,
  handleInfractionsCommand,
} from './commands.js';
