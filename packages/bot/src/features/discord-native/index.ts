/**
 * Discord Native Features — barrel exports.
 *
 * GAP 5: Discord Native Potential
 */

export { AutoModSync, type AutoModRule } from './automod-sync.js';
export { GuildOnboardingSync, type OnboardingConfig, type OnboardingPrompt } from './guild-onboarding-sync.js';
export { ForumTicketService, type ForumTicketConfig } from './forum-tickets.js';
export {
  safeInteractionHandler,
  withEphemeralProgress,
  withCooldown,
  type AnyRepliableInteraction,
  type InteractionHandler,
} from './interaction-handler.js';
