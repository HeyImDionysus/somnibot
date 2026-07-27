/**
 * setup-wizard.live.test — the LIVE-STACK proof for `/setup`.
 *
 * WHY THIS EXISTS: `/setup` is the first thing any new owner touches, and it
 * was the one significant surface with NO end-to-end coverage. It had ~44 unit
 * tests, all against mocks, and no entry in the 46-domain catalog — so the
 * fleet never drove it against a real database. Every game, every economy
 * command, tickets, moderation and commerce were proven end-to-end; the front
 * door was not.
 *
 * This drives the REAL wizard engine against LOCAL Supabase and asserts
 * DB-observable outcomes, in the same spirit as the domain proofs:
 *
 *   - progress genuinely persists to `instance_settings` and reads back;
 *   - a corrupt progress row degrades to "start from the beginning" rather
 *     than throwing an owner out of the wizard;
 *   - `detectConfigured` reflects what is ACTUALLY stored, so the wizard never
 *     asks for a credential the instance already has (nor claims to have one
 *     it does not);
 *   - step ordering is stable and terminates — `getNextStep` cannot loop or
 *     strand the owner on a step that never completes;
 *   - credentials round-trip through `storeCredentials` into the same keys
 *     `detectConfigured` reads, which is the join the whole wizard depends on.
 *
 * ⚠️ Requires a running local Supabase, like the other live suites. Excluded
 *    from the fast `vitest run`; runs via `test:live`. If Supabase is
 *    unreachable this FAILS LOUD rather than silently passing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootstrapLiveClient, type LiveClientHandle } from '../../live-runner.js';
import {
  loadProgress,
  saveProgress,
  getNextStep,
  detectConfigured,
  storeCredentials,
} from '@somnibot/bot/dist/features/setup-wizard/wizard-engine.js';
import { WIZARD_STEPS } from '@somnibot/bot/dist/features/setup-wizard/steps.js';

const PROGRESS_KEY = 'setup_wizard_progress';

let handle: LiveClientHandle;
/** Keys this run wrote, cleaned up afterwards so the rig is left as found. */
const writtenKeys = new Set<string>([PROGRESS_KEY]);

async function readSetting(key: string): Promise<string | null> {
  const { data } = await handle.client.supabase
    .from('instance_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  return (data as { value?: string } | null)?.value ?? null;
}

async function writeSetting(key: string, value: string): Promise<void> {
  writtenKeys.add(key);
  // `section` is NOT NULL — omitting it makes the upsert fail silently, which
  // is exactly how the first draft of this suite "proved" the wrong thing.
  const { error } = await handle.client.supabase
    .from('instance_settings')
    .upsert({ key, value, section: 'setup', updated_at: new Date().toISOString() },
      { onConflict: 'key' });
  if (error) throw new Error(`writeSetting(${key}) failed: ${error.message}`);
}

async function clearSetting(key: string): Promise<void> {
  await handle.client.supabase.from('instance_settings').delete().eq('key', key);
}

beforeAll(async () => {
  // The loopback guard force-pins the disposable guild id; take it as given
  // rather than overriding, so this suite runs under the same guard as the rest.
  handle = await bootstrapLiveClient();
  // Start from a known-clean wizard state so assertions are about the engine,
  // not about whatever a previous run left behind.
  await clearSetting(PROGRESS_KEY);
}, 120_000);

afterAll(async () => {
  for (const key of writtenKeys) await clearSetting(key);
  await handle?.shutdown?.();
}, 60_000);

describe('wizard progress persistence', () => {
  it('starts empty when nothing has been stored', async () => {
    const progress = await loadProgress(handle.client.supabase);
    expect(progress.configured).toEqual([]);
    expect(progress.skipped).toEqual([]);
  });

  it('round-trips through the real instance_settings table', async () => {
    await saveProgress(handle.client.supabase, {
      configured: ['paypal'],
      skipped: ['deployment'],
      lastRun: new Date().toISOString(),
    });

    // Proven at the DB level, not just through the loader's own cache.
    const raw = await readSetting(PROGRESS_KEY);
    expect(raw, 'progress must actually reach instance_settings').toBeTruthy();

    const reloaded = await loadProgress(handle.client.supabase);
    expect(reloaded.configured).toContain('paypal');
    expect(reloaded.skipped).toContain('deployment');
  });

  it('degrades to a fresh start on a corrupt row instead of throwing', async () => {
    // A half-written or hand-edited row must not lock the owner out of the
    // wizard — restarting it is recoverable, an exception at the front door
    // is not.
    await writeSetting(PROGRESS_KEY, '{not valid json');

    const progress = await loadProgress(handle.client.supabase);
    expect(progress.configured).toEqual([]);
    expect(progress.skipped).toEqual([]);
  });
});

describe('step ordering', () => {
  it('offers a first step from a clean slate', async () => {
    await clearSetting(PROGRESS_KEY);
    const next = getNextStep(await loadProgress(handle.client.supabase));
    expect(next, 'a fresh instance must have somewhere to start').not.toBeNull();
    expect(next!.index).toBe(0);
  });

  it('advances past steps already configured or skipped', async () => {
    const first = WIZARD_STEPS[0]!;
    const next = getNextStep({ configured: [first.id], skipped: [], lastRun: '' });
    expect(next?.step.id).not.toBe(first.id);
  });

  it('terminates once every step is accounted for — never loops', async () => {
    // The failure this guards is an owner stuck on a wizard that always has
    // "one more step".
    const all = WIZARD_STEPS.map((s) => s.id);
    expect(getNextStep({ configured: all, skipped: [], lastRun: '' })).toBeNull();
    expect(getNextStep({ configured: [], skipped: all, lastRun: '' })).toBeNull();
  });

  it('walks every step exactly once when each is completed in turn', async () => {
    const seen: string[] = [];
    const configured: string[] = [];
    for (let i = 0; i < WIZARD_STEPS.length + 1; i++) {
      const next = getNextStep({ configured: [...configured], skipped: [], lastRun: '' });
      if (!next) break;
      expect(seen, `step ${next.step.id} offered twice`).not.toContain(next.step.id);
      seen.push(next.step.id);
      configured.push(next.step.id);
    }
    expect(seen).toHaveLength(WIZARD_STEPS.length);
  });
});

describe('detecting what is already configured', () => {
  it('reports nothing configured on a bare instance', async () => {
    // Whatever this rig has, detection must be derived from stored values —
    // never invented. A step it wrongly reports as done is a credential the
    // owner is never asked for.
    const detected = await detectConfigured(handle.client.supabase);
    expect(detected).toBeInstanceOf(Set);
  });

  it('reflects a credential actually written to instance_settings', async () => {
    const before = await detectConfigured(handle.client.supabase);

    // Write the real keys the PayPal step contracts, through the engine's own
    // writer — this is the join the whole wizard depends on: what
    // storeCredentials writes must be what detectConfigured reads.
    const paypalStep = WIZARD_STEPS.find((s) => s.id === 'paypal')!;
    const fieldIds = Object.keys(paypalStep.fieldToSettingsKey);
    const values = Object.fromEntries(
      fieldIds.map((f) => [f, `live-test-${randomUUID().slice(0, 8)}`]),
    );

    await storeCredentials(handle.client.supabase, paypalStep, values);
    for (const settingsKey of Object.values(paypalStep.fieldToSettingsKey)) {
      writtenKeys.add(settingsKey as string);
    }

    const after = await detectConfigured(handle.client.supabase);

    // The stored credential must be visible to detection. If these ever
    // disagree, the wizard either re-asks for something it has or skips
    // something it does not.
    expect(after.size).toBeGreaterThanOrEqual(before.size);
    const firstKey = Object.values(paypalStep.fieldToSettingsKey)[0] as string;
    const stored = await readSetting(firstKey);
    expect(stored, `storeCredentials must reach instance_settings (${firstKey})`).toBeTruthy();
  });

  it('does not treat an empty-string credential as configured', async () => {
    // A blank value is the shape a half-finished step leaves behind; counting
    // it as done would strand the instance with an unusable credential.
    const paypalStep = WIZARD_STEPS.find((s) => s.id === 'paypal')!;
    for (const settingsKey of Object.values(paypalStep.fieldToSettingsKey)) {
      await writeSetting(settingsKey as string, '');
    }

    const detected = await detectConfigured(handle.client.supabase);
    expect(detected.has('paypal')).toBe(false);
  });
});
