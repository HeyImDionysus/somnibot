/**
 * Setup Wizard Feature — barrel exports.
 *
 * Provides:
 * - /setup slash command (guild owner only)
 * - Launcher handoff for installation credentials, deployment, and services
 * - Compatibility handlers that reject stale setup buttons and modals
 */

export {
  buildSetupCommand,
  handleSetupCommand,
  handleSetupButton,
  handleSetupModal,
  handleReconfigureSelect,
} from './commands.js';

export {
  WIZARD_STEPS,
  type WizardStep,
} from './steps.js';

export {
  loadProgress,
  saveProgress,
  detectConfigured,
  type WizardProgress,
} from './wizard-engine.js';
