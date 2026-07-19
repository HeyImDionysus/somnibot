/**
 * economy-balance.live.test — the LIVE-STACK end-to-end proof.
 *
 * Boots the REAL SomniBot stack against the LOCAL disposable rig (no Discord
 * credentials) by driving the REAL production `initGuildFeatures`, then drives
 * the REAL `/balance` slash command through the PR2 injector. It proves the
 * economy path in BOTH gate states:
 *
 *   1. economy_enabled = TRUE  → the REAL init wires the EconomyManager, and
 *      /balance asserts BOTH observable effects of a DB-backed command:
 *        (a) the captured reply is the expected success balance embed, AND
 *        (b) the REAL `economy_wallets` row was created in local Supabase with
 *            the seeded starting balance.
 *
 *   2. economy_enabled = FALSE → the REAL init's `if (guildCfg?.economy_enabled)`
 *      gate skips wiring, so the dispatcher finds NO economy manager and /balance
 *      takes the REAL "economy is not enabled" reply path — no wallet is created.
 *      This is what makes the harness catch a regression that drops the gate.
 *
 * `/balance` is the SIMPLEST DB-observable proof: its handler creates/credits a
 * wallet row via `client.supabase` (the `economy_get_or_create_wallet` RPC),
 * needs no Valkey (unlike /daily's cooldown SET NX), and has a single
 * deterministic success path.
 *
 * ⚠️  This suite REQUIRES a running local Supabase (with Realtime — the real
 *     init starts the action-queue Realtime listener) and is EXCLUDED from the
 *     default fast `vitest run`. It runs only via the gated
 *     `vitest.live.config.ts` (`pnpm --filter @somnibot/testkit test:live`).
 *     If Supabase is unreachable, bootstrapLiveClient throws — it FAILS LOUD,
 *     never silently passes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootstrapLiveClient, type LiveClientHandle } from '../../live-runner.js';
import { buildSlashInteraction } from '../../interaction-builders.js';
import { createInteractionInjector } from '../../inject.js';
import { mintCapabilityToken } from '../../capability.js';

/** A distinctive starting balance so the SAME number is asserted in the DB row
 *  AND the rendered reply embed — proving the value flowed end-to-end. */
const STARTING_BALANCE = 777;

/** Per-run user prefix so parallel/repeat runs never collide and cleanup is
 *  surgical. The disposable guild + guild_config are shared rig state (upserted
 *  idempotently by the runner) and intentionally left in place. */
const RUN_ID = randomUUID().slice(0, 8);
const RUN_PREFIX = `e2e-live-${RUN_ID}-`;
const USER_ID = `${RUN_PREFIX}user`;
const USER_DISPLAY_NAME = `E2E Live ${RUN_ID}`;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}
interface EmbedData {
  author?: { name?: string };
  fields?: EmbedField[];
  title?: string;
  description?: string;
}

let handle: LiveClientHandle;

beforeAll(async () => {
  // Boots the real stack + seeds guild/guild_config. Throws LOUDLY (never a
  // silent skip) if the local Supabase is unreachable.
  handle = await bootstrapLiveClient({ economyStartingBalance: STARTING_BALANCE });
}, 60_000);

afterAll(async () => {
  if (!handle) return;
  // Clean up only THIS run's rows (prefixed user ids); leave rig state intact.
  await handle.supabase.from('economy_transactions').delete().eq('guild_id', handle.guildId).like('user_id', `${RUN_PREFIX}%`);
  await handle.supabase.from('economy_wallets').delete().eq('guild_id', handle.guildId).like('user_id', `${RUN_PREFIX}%`);
  await handle.cleanup();
});

describe('LIVE /balance — real dispatch, real DB effect (economy ENABLED)', () => {
  it('creates the wallet row AND returns the balance embed (DB + reply asserted)', async () => {
    // The economy manager under test was wired by the REAL initGuildFeatures
    // during bootstrap (economy_enabled = true), not by the harness.
    // Inject through the REAL production dispatcher (PR2 injector), no gateway.
    const authToken = mintCapabilityToken();
    const injector = createInteractionInjector(handle.client, { authToken });

    const interaction = buildSlashInteraction({
      commandName: 'balance',
      guildId: handle.guildId,
      client: handle.client,
      user: { id: USER_ID, username: `e2e-live-${RUN_ID}`, displayName: USER_DISPLAY_NAME },
    });

    const captured = await injector.inject(interaction, { authToken });

    // ── (a) Captured reply is the success balance embed ──────────────────
    expect(captured.has('reply')).toBe(true);
    const reply = captured.find('reply');
    expect(reply).toBeDefined();

    const payload = reply!.payload as { embeds?: Array<{ data?: EmbedData }>; content?: string };
    // A success reply carries an embed; the "economy disabled" failure path
    // would instead reply with a `content` string — assert we took success.
    expect(payload.content).toBeUndefined();
    expect(payload.embeds && payload.embeds.length).toBeGreaterThan(0);

    const embedData = payload.embeds![0].data ?? {};
    expect(String(embedData.author?.name)).toBe(`${USER_DISPLAY_NAME}'s Balance`);

    const walletField = (embedData.fields ?? []).find((f) => f.name.includes('Wallet'));
    expect(walletField).toBeDefined();
    expect(walletField!.value).toContain(String(STARTING_BALANCE));

    // ── (b) REAL DB effect: the economy_wallets row now exists ───────────
    const { data: walletRow, error } = await handle.supabase
      .from('economy_wallets')
      .select('wallet, bank, user_id, guild_id')
      .eq('guild_id', handle.guildId)
      .eq('user_id', USER_ID)
      .maybeSingle();

    expect(error).toBeNull();
    expect(walletRow).not.toBeNull();
    const row = walletRow as { wallet: number; bank: number } | null;
    expect(row!.wallet).toBe(STARTING_BALANCE);
    expect(row!.bank).toBe(0);
  });

  it('Discord-side readback is GATED behind credentials (pending, NOT skipped)', () => {
    // The DB-observable proof above ran with NO Discord secrets. Any assertion
    // needing a REAL Discord effect (role added / channel message) belongs to a
    // LATER, credentialed phase. It is gated behind an explicit opt-in flag AND
    // a live gateway (client.isReady()) — the dummy DISCORD_TOKEN from live-setup
    // does NOT satisfy this, so we never false-trigger.
    const discordReadbackEnabled =
      Boolean(process.env.SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK) && handle.client.isReady();

    if (discordReadbackEnabled) {
      // Credentials + live guild connection are present: this is where the
      // credentialed phase re-reads the Discord side (e.g. asserts a role was
      // granted or a message posted for a role-affecting command). Not part of
      // this DB-only phase — fail loudly rather than pretend it ran.
      throw new Error(
        'Discord-side readback assertion is not implemented for this phase — ' +
          'implement it when the credentialed live lane lands.',
      );
    }

    // eslint-disable-next-line no-console
    console.warn(
      '[live][PENDING CREDENTIALS] Discord-side readback (roles/messages) is GATED behind ' +
        'DISCORD_TOKEN + a live guild connection (set SOMNIBOT_LOOPBACK_E2E_DISCORD_READBACK=1 ' +
        'once real secrets exist). This phase proves the DB-observable effect only; the readback ' +
        'phase is intentionally DEFERRED, not deleted or silently skipped.',
    );
    expect(discordReadbackEnabled).toBe(false);
  });
});

// ── Interface types are shared with the enabled block above ──

const DISABLED_RUN_ID = randomUUID().slice(0, 8);
const DISABLED_USER_ID = `e2e-live-off-${DISABLED_RUN_ID}-user`;

let disabledHandle: LiveClientHandle;

describe('LIVE /balance — real gate honoured (economy DISABLED)', () => {
  beforeAll(async () => {
    // Re-boot the REAL stack, this time seeding economy_enabled = FALSE. The
    // production initGuildFeatures gate must then skip wiring the manager.
    disabledHandle = await bootstrapLiveClient({ economyEnabled: false });
  }, 60_000);

  afterAll(async () => {
    if (!disabledHandle) return;
    // The disabled path must not create rows, but clean defensively anyway.
    await disabledHandle.supabase
      .from('economy_wallets')
      .delete()
      .eq('guild_id', disabledHandle.guildId)
      .eq('user_id', DISABLED_USER_ID);
    await disabledHandle.cleanup();
  });

  it('the REAL init skips economy wiring, so no manager is registered', () => {
    // Direct evidence the production `if (guildCfg?.economy_enabled)` gate held:
    // the exact lookup the dispatcher performs resolves to undefined.
    const ctx = disabledHandle.client.router.getContextSync(disabledHandle.guildId);
    expect(ctx).toBeDefined();
    expect(ctx!.getManager('economy')).toBeUndefined();
  });

  it('/balance replies the real "not enabled" path and creates NO wallet', async () => {
    const authToken = mintCapabilityToken();
    const injector = createInteractionInjector(disabledHandle.client, { authToken });

    const interaction = buildSlashInteraction({
      commandName: 'balance',
      guildId: disabledHandle.guildId,
      client: disabledHandle.client,
      user: {
        id: DISABLED_USER_ID,
        username: `e2e-live-off-${DISABLED_RUN_ID}`,
        displayName: `E2E Live Off ${DISABLED_RUN_ID}`,
      },
    });

    const captured = await injector.inject(interaction, { authToken });

    // ── (a) Captured reply is the REAL "economy not enabled" content ─────
    expect(captured.has('reply')).toBe(true);
    const reply = captured.find('reply');
    expect(reply).toBeDefined();
    const payload = reply!.payload as { embeds?: unknown[]; content?: string };
    // The disabled path replies with a content string (no embed).
    expect(payload.content).toBe('🚫 The economy system is not enabled on this server.');
    expect(payload.embeds ?? []).toHaveLength(0);

    // ── (b) REAL DB effect: NO wallet row was created ────────────────────
    const { data: walletRow, error } = await disabledHandle.supabase
      .from('economy_wallets')
      .select('user_id')
      .eq('guild_id', disabledHandle.guildId)
      .eq('user_id', DISABLED_USER_ID)
      .maybeSingle();

    expect(error).toBeNull();
    expect(walletRow).toBeNull();
  });
});
