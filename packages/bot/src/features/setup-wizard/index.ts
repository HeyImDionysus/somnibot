/**
 * Setup Wizard Feature — barrel exports.
 *
 * Provides:
 * - /setup slash command (guild owner only)
 * - Sequential flow: PayPal → Deployment → Supabase Management
 * - Button, modal, and select menu interaction handlers
 * - Credential verification via real API calls
 * - Progress persistence in Supabase instance_settings
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
