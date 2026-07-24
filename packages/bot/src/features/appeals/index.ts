/**
 * Appeals Feature — barrel exports.
 *
 * Provides:
 * - AppealsManager (submit / list / review / decide + expiry sweep)
 * - /appeal slash command (submit + status)
 * - Decision DM delivery + periodic maintenance sweep
 */

export {
  AppealsManager,
  calculateAppealExpiry,
  DEFAULT_APPEAL_WINDOW_DAYS,
  APPEAL_REASON_MAX,
  type AppealRecord,
  type AppealStatus,
  type AppealDecision,
  type SubmitAppealInput,
  type SubmitAppealResult,
  type SubmitAppealError,
  type ListAppealsOptions,
} from './appeals-manager.js';

export { appealCommand, handleAppealCommand } from './appeal-commands.js';

export {
  buildDecisionDmEmbed,
  deliverDecisionDm,
  deliverDecisionDmsForGuild,
  runAppealsMaintenance,
} from './appeal-notifier.js';
