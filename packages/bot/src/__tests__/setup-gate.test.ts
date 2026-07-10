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
 * `opts.error` fails every read; `opts.errorForKeys` fails only specific keys
 * (to simulate a transient blip on a single lookup).
 */
function makeSupabase(
  settings: Record<string, string>,
  opts: { error?: { code?: string }; errorForKeys?: Record<string, { code?: string }> } = {},
) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            const keyError = opts.error ?? opts.errorForKeys?.[key];
            if (keyError) return { data: null, error: keyError };
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
    // A genuine completed-row read is a CONFIRMED completion — the setup
    // watcher may transition on it.
    expect(result.completionConfirmed).toBe(true);
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
    // Not complete → never a confirmed completion.
    expect(result.completionConfirmed).toBe(false);
  });

  it('stays "in_progress" for a launcher-forked mid-wizard boot (env token AND wizard credential row)', async () => {
    // The desktop launcher forks the bot with DISCORD_TOKEN in env AND syncs
    // the raw discord_bot_token row to instance_settings. Both present with no
    // completion row = a setup flow that has not finalized → verification mode.
    const supabase = makeSupabase({ discord_bot_token: 'a-bot-token' });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('in_progress');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(false);
  });

  // ── Codex round-3 finding #1: env-complete = complete ──
  // A deployment configured entirely through environment variables (VPS /
  // docker-compose .env — the pre-existing supported path) never runs the
  // dashboard wizard, so no setup_completed_at row will EVER exist. Gating it
  // on the mere presence of DISCORD_TOKEN would leave commands/features/
  // presence uninitialized forever. No wizard credential row + token in env
  // must boot fully.
  it('does NOT gate an env-configured deployment (token in env, no wizard rows, no completion row)', async () => {
    const supabase = makeSupabase({});
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('complete');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(true);
    expect(result.message).toBeNull();
    // Not derived from a completion row → the setup-completion watcher must
    // not treat this as a finalize signal.
    expect(result.completionConfirmed).toBe(false);
  });

  it('env-configured classification ignores the bot\'s own sync flags (discord_bot_token_configured)', async () => {
    // syncConfigToDatabase writes `<key>_configured` flags for secrets — never
    // the raw row. Those flags must not be mistaken for wizard-stored
    // credentials, or every env-configured deploy would self-gate after its
    // first boot synced config to the DB.
    const supabase = makeSupabase({ discord_bot_token_configured: 'true' });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('complete');
    expect(result.shouldRunFullInit).toBe(true);
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

  it('treats a missing table (42P01) with an env token as env-configured — boots fully', async () => {
    // Table not created yet → this is an EXPECTED clean absence, not a read
    // failure. No completion row and no wizard credential row can exist in a
    // table that does not exist, so a token in env means the deployment is
    // env-configured (or migrations failed — either way full boot is the
    // state that never strands a working deploy). The wizard's readiness
    // checks still pass against a full boot (heartbeat + guild rows), so a
    // rare launcher fork that races the credential sync still completes setup.
    const supabase = makeSupabase({}, { error: { code: '42P01' } });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('complete');
    expect(result.shouldLogin).toBe(true);
    expect(result.shouldRunFullInit).toBe(true);
    expect(result.completionConfirmed).toBe(false);
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
    // Codex round-2 finding #5: this 'complete' is the read-failure fallback,
    // NOT a genuine completed-row read. It must be flagged unconfirmed so the
    // setup-completion watcher does not fire a premature full-boot transition
    // on a transient blip while in verification mode (where a token is always
    // present, making this fallback path the common one on a read error).
    expect(result.completionConfirmed).toBe(false);
  });

  it('stays "not_started" on a transient read error when no token is present', async () => {
    // No token to log in with even if state is unknown → idle rather than
    // crash-loop by attempting a Discord login.
    const supabase = makeSupabase({}, { error: { code: 'PGRST301' } });
    const result = await evaluateSetupGate(supabase, {} as any);

    expect(result.state).toBe('not_started');
    expect(result.shouldLogin).toBe(false);
  });

  it('boots fully (unconfirmed) when only the wizard-credential read blips and a token is in env', async () => {
    // setup_completed_at reads cleanly absent, but the discord_bot_token
    // lookup fails transiently. With a token in env, prefer full boot over
    // gating a possibly env-configured/finalized deployment on a blip — the
    // same philosophy as the completed-row read-failure fallback. Unconfirmed
    // so the completion watcher never transitions on it.
    const supabase = makeSupabase({}, { errorForKeys: { discord_bot_token: { code: 'PGRST301' } } });
    const result = await evaluateSetupGate(supabase, { DISCORD_TOKEN: 'env-token' } as any);

    expect(result.state).toBe('complete');
    expect(result.shouldRunFullInit).toBe(true);
    expect(result.completionConfirmed).toBe(false);
  });

  it('stays "not_started" when the wizard-credential read blips and no token is in env', async () => {
    const supabase = makeSupabase({}, { errorForKeys: { discord_bot_token: { code: 'PGRST301' } } });
    const result = await evaluateSetupGate(supabase, {} as any);

    expect(result.state).toBe('not_started');
    expect(result.shouldLogin).toBe(false);
  });
});
