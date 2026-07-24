/**
 * Team Invitations — consent-based dashboard-team invitation lifecycle worker.
 *
 * The dashboard owns the HTTP surface (invite / accept / revoke); this module
 * owns the bot-side Discord effects and the time-driven expiry sweep.
 */
export {
  TeamInvitationSweeper,
  startTeamInvitationSweeper,
  stopTeamInvitationSweeper,
} from './sweeper.js';
