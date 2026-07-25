/**
 * Setup Wizard — Engine.
 *
 * Manages the sequential flow: determines which step to show,
 * stores/retrieves progress from Supabase, and handles transitions.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  WIZARD_STEPS,
  type WizardStep,
} from './steps.js';

/* ------------------------------------------------------------------ */
/*  Progress tracking via instance_settings                            */
/* ------------------------------------------------------------------ */

const PROGRESS_KEY = 'setup_wizard_progress';
const PROGRESS_SECTION = 'setup';

export interface WizardProgress {
  /** Step IDs that have been fully configured (credentials verified). */
  configured: string[];
  /** Step IDs explicitly skipped by the user. */
  skipped: string[];
  /** Timestamp of last /setup run. */
  lastRun: string;
}

const EMPTY_PROGRESS: WizardProgress = {
  configured: [],
  skipped: [],
  lastRun: new Date().toISOString(),
};

export async function loadProgress(supabase: SupabaseClient): Promise<WizardProgress> {
  const { data, error } = await supabase
    .from('instance_settings')
    .select('value')
    .eq('key', PROGRESS_KEY)
    .maybeSingle();

  if (error || !data?.value) return { ...EMPTY_PROGRESS };

  try {
    const parsed = JSON.parse(data.value) as WizardProgress;
    return {
      configured: Array.isArray(parsed.configured) ? parsed.configured : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      lastRun: parsed.lastRun ?? new Date().toISOString(),
    };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

export async function saveProgress(
  supabase: SupabaseClient,
  progress: WizardProgress,
): Promise<void> {
  await supabase
    .from('instance_settings')
    .upsert(
      {
        key: PROGRESS_KEY,
        value: JSON.stringify(progress),
        section: PROGRESS_SECTION,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );
}

/* ------------------------------------------------------------------ */
/*  Step resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Determine the next step to show.
 * Returns null if all steps are configured or skipped (wizard complete).
 */
export function getNextStep(progress: WizardProgress): { step: WizardStep; index: number } | null {
  const done = new Set([...progress.configured, ...progress.skipped]);
  for (let i = 0; i < WIZARD_STEPS.length; i++) {
    if (!done.has(WIZARD_STEPS[i]!.id)) {
      return { step: WIZARD_STEPS[i]!, index: i };
    }
  }
  return null;
}

/**
 * Settings keys a step must ALSO have before it counts as configured, even
 * though the operator never types them — the wizard generates them.
 */
const REQUIRED_PROVISIONED_KEYS: Record<string, readonly string[]> = {
  paypal: ['paypal_webhook_id'],
};

/**
 * Check which services already have credentials stored in instance_settings.
 * Returns step IDs that are already configured (regardless of wizard progress).
 */
export async function detectConfigured(supabase: SupabaseClient): Promise<Set<string>> {
  const configured = new Set<string>();

  // Gather all instance_settings keys we care about
  const allKeys: string[] = [];
  for (const step of WIZARD_STEPS) {
    allKeys.push(...Object.values(step.fieldToSettingsKey));
  }

  const { data } = await supabase
    .from('instance_settings')
    .select('key, value')
    .in('key', allKeys)
    .limit(1000);

  if (!data) return configured;

  const filledKeys = new Set(
    data.filter((row) => row.value && row.value.trim().length > 0).map((row) => row.key),
  );

  // A step is configured if ALL required modal fields have stored values.
  // Optional fields such as PayPal webhook URL should not keep a step
  // permanently unconfigured after the operator submitted valid credentials.
  for (const step of WIZARD_STEPS) {
    const required = step.modalFields
      .filter((field) => field.required)
      .map((field) => step.fieldToSettingsKey[field.customId])
      .filter((key): key is string => Boolean(key));
    if (required.length > 0 && required.every((k) => filledKeys.has(k))) {
      // Some keys are proof of work the wizard does on the operator's behalf
      // rather than fields they type, so requiring only the typed fields is not
      // enough. PayPal is the case that matters: an install seeded from .env has
      // a client id and secret but no webhook, and calling that "configured"
      // let the operator finish setup with payment events going nowhere.
      const provisioned = REQUIRED_PROVISIONED_KEYS[step.id];
      if (provisioned && !provisioned.every((k) => filledKeys.has(k))) continue;
      configured.add(step.id);
    }
  }

  return configured;
}

/* ------------------------------------------------------------------ */
/*  Credential storage                                                 */
/* ------------------------------------------------------------------ */

/**
 * Store verified credentials in instance_settings and sync to process.env.
 */
export async function storeCredentials(
  supabase: SupabaseClient,
  step: WizardStep,
  values: Record<string, string>,
): Promise<void> {
  const rows: { key: string; value: string; section: string; updated_at: string }[] = [];

  for (const [fieldId, settingsKey] of Object.entries(step.fieldToSettingsKey)) {
    const value = values[fieldId]?.trim();
    if (value) {
      rows.push({
        key: settingsKey,
        value,
        section: step.id,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (rows.length > 0) {
    await supabase
      .from('instance_settings')
      .upsert(rows, { onConflict: 'key' });
  }

  // Also update process.env so the current bot session can use them immediately
  // (maps instance_settings keys → env var names, matching config-loader.ts)
  const SETTINGS_TO_ENV: Record<string, string> = {
    // PayPal
    paypal_client_id: 'PAYPAL_CLIENT_ID',
    paypal_client_secret: 'PAYPAL_CLIENT_SECRET',
    paypal_sandbox: 'PAYPAL_SANDBOX',
    paypal_webhook_id: 'PAYPAL_WEBHOOK_ID',
    paypal_webhook_url: 'PAYPAL_WEBHOOK_URL',
    // Supabase Management
    supabase_access_token: 'SUPABASE_ACCESS_TOKEN',
    supabase_db_url: 'SUPABASE_DB_URL',
    // Deployment
    dashboard_url: 'DASHBOARD_URL',
  };

  for (const [fieldId, settingsKey] of Object.entries(step.fieldToSettingsKey)) {
    const envVar = SETTINGS_TO_ENV[settingsKey];
    const value = values[fieldId]?.trim();
    if (envVar && value) {
      process.env[envVar] = value;
    }
  }
}

/**
 * Enable the feature flag in guild_config after successful credential setup.
 */
export async function enableFeatureFlag(
  supabase: SupabaseClient,
  guildId: string,
  flagKey: string,
): Promise<void> {
  await supabase
    .from('guild_config')
    .upsert(
      { guild_id: guildId, [flagKey]: true },
      { onConflict: 'guild_id' },
    );
}
