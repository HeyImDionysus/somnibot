/**
 * Startup Setup Gate — unit tests.
 *
 * Verifies the boot sequence can distinguish:
 *   - setup complete            → full boot
 *   - setup in progress          → minimal verification boot (login, no full init)
 *   - setup never started        → idle, do not attempt Discord login
 *
 * And that the "in progress" path keeps the wizard's bot-online verification
 * working (the bot still logs in so it can heartbeat / be detected).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluateSetupGate, resolveDashboardUrl } from '../services/setup-gate.js';

/**
 * Build a stub Supabase whose `instance_settings` reads resolve from a
 * key→value map. Mirrors the real `.from().select().eq().maybeSingle()` chain.
 */
function makeSupabase(settings: Record<string, string>, opts: { error?: { code?: string } } = {}) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            if (opts.error) return { data: null, error: opts.error };
            const value = settings[key];
            return { data: value !== undefined ? { value } : null, error: null };
          },
        }),
      }),
    }),
  } as any;
}

describe('resolveDashboardUrl', () => {
  it('prefers DASHBOARD_URL, falls back to the local launcher dashboard', () => {
    expect(resolveDashboardUrl({ DASHBOARD_URL: 'https://dash.example.com' } as any)).toBe(
      'https://dash.example.com',
    );
    expect(resolveDashboardUrl({} as any)).toBe('http://localhost:3456');
  });
});

describe('evaluateSetupGate', () => {
  const baseEnv = {} as NodeJS.ProcessEnv;

  it('returns "complete" and runs full init when setup_completed_at is set', async () => {
    const supabase = makeSupabase({ setup_completed_at: '2026-07-10T00:00:00.000Z' });
    const result = await evaluateSetupGate(supabase, baseEnv);

    expect(result.state).toBe('complete');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(true);
    expect(result.message).toBeNull();
  });

  it('returns "in_progress" when a Discord token exists but setup is not finalized', async () => {
    // Token present in instance_settings (verify-discord ran) but not finalized.
    const supabase = makeSupabase({ discord_bot_token: 'a-bot-token' });
    const result = await evaluateSetupGate(supabase, baseEnv);

    expect(result.state).toBe('in_progress');
    // Wizard needs the bot reachable to verify "bot online" → must still log in.
    expect(result.shouldLogin).toBe(true);
    // But NOT the heavy feature init that spams errors mid-setup.
    expect(result.shouldRunFullInit).toBe(false);
    expect(result.message).toContain('Setup not complete');
    expect(result.message).toContain('http://localhost:3456');
  });

  it('treats a token present in env (launcher-forked) as "in_progress"', async () => {
    const supabase = makeSupabase({});
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('in_progress');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(false);
  });

  it('returns "not_started" when no Discord token exists anywhere', async () => {
    const supabase = makeSupabase({});
    const result = await evaluateSetupGate(supabase, baseEnv);

    expect(result.state).toBe('not_started');
    // No token → attempting a Discord login would only error; stay idle.
    expect(result.shouldLogin).toBe(false);
    expect(result.shouldRunFullInit).toBe(false);
    expect(result.message).toContain('Setup not complete');
    expect(result.message).toContain('no Discord bot token');
  });

  it('surfaces the configured dashboard URL in the gate message', async () => {
    const supabase = makeSupabase({});
    const result = await evaluateSetupGate(supabase, {
      DASHBOARD_URL: 'https://ops.example.com',
    } as any);

    expect(result.dashboardUrl).toBe('https://ops.example.com');
    expect(result.message).toContain('https://ops.example.com');
  });

  it('treats a missing table (42P01) as a clean first-boot absence, staying wizard-usable', async () => {
    // Table not created yet → this is an EXPECTED absence, not a read failure.
    // With a token in env the wizard must still be able to verify the bot.
    const supabase = makeSupabase({}, { error: { code: '42P01' } });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('in_progress');
    expect(result.shouldLogin).toBe(true);
  });

  it('degrades to "not_started" on a missing table when no token is present', async () => {
    const supabase = makeSupabase({}, { error: { code: '42P01' } });
    const result = await evaluateSetupGate(supabase, {} as any);

    expect(result.state).toBe('not_started');
    expect(result.shouldLogin).toBe(false);
  });

  it('does NOT downgrade a finalized bot to verification mode on a transient read error', async () => {
    // A transient PostgREST/RLS error (not 42P01) on the setup_completed_at
    // lookup must NOT be treated as "setup incomplete": with a token present we
    // fall through to normal full boot instead of verification-only mode.
    const supabase = makeSupabase({ setup_completed_at: '2026-07-10T00:00:00.000Z' }, {
      error: { code: 'PGRST301' },
    });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('complete');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(true);
  });

  it('stays "not_started" on a transient read error when no token is present', async () => {
    // No token to log in with even if state is unknown → idle rather than
    // crash-loop by attempting a Discord login.
    const supabase = makeSupabase({}, { error: { code: 'PGRST301' } });
    const result = await evaluateSetupGate(supabase, {} as any);

    expect(result.state).toBe('not_started');
    expect(result.shouldLogin).toBe(false);
  });
});
