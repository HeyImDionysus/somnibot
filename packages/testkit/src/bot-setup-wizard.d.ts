/**
 * Ambient typing for the compiled setup-wizard engine the live `/setup` proof
 * drives (packages/bot/src/features/setup-wizard/* → dist/.../*.js).
 *
 * Companion to bot-dispatcher.d.ts / bot-manifest.d.ts / bot-live-stack.d.ts.
 * @somnibot/bot is built with `declaration: false`, so its `dist/` ships no
 * `.d.ts`; testkit depends on the COMPILED engine (a deep `dist/` import,
 * allowed because @somnibot/bot declares no `exports` map). This supplies
 * exactly the surface the live proof consumes — nothing more, so the shim
 * cannot drift into re-describing the wizard.
 *
 * This is the permitted testkit->bot edge (the isolation check forbids only the
 * reverse, bot->testkit).
 */
declare module '@somnibot/bot/dist/features/setup-wizard/wizard-engine.js' {
  /** Which steps the owner has finished or deliberately skipped. */
  export interface WizardProgress {
    configured: string[];
    skipped: string[];
    lastRun: string;
  }

  /** Read wizard progress from `instance_settings`; empty on a corrupt row. */
  export function loadProgress(supabase: unknown): Promise<WizardProgress>;

  /** Persist wizard progress to `instance_settings`. */
  export function saveProgress(supabase: unknown, progress: WizardProgress): Promise<void>;

  /** The next step to present, or null once every step is accounted for. */
  export function getNextStep(
    progress: WizardProgress,
  ): { step: { id: string }; index: number } | null;

  /** Step ids whose credentials are already present in `instance_settings`. */
  export function detectConfigured(supabase: unknown): Promise<Set<string>>;

  /** Write a step's field values into their contracted settings keys. */
  export function storeCredentials(
    supabase: unknown,
    step: { id: string; fieldToSettingsKey: Record<string, string> },
    values: Record<string, string>,
  ): Promise<void>;
}

declare module '@somnibot/bot/dist/features/setup-wizard/steps.js' {
  /** Only the fields the live proof reads — id and the settings-key mapping. */
  export interface WizardStepShape {
    id: string;
    fieldToSettingsKey: Record<string, string>;
  }

  /** The ordered wizard steps, in the order the owner is walked through them. */
  export const WIZARD_STEPS: readonly WizardStepShape[];
}
