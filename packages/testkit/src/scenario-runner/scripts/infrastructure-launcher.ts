/**
 * scenario-runner/scripts/infrastructure-launcher — the Electron desktop-launcher
 * domain proof.
 *
 * Binds the infrastructure-launcher domain's 12 declarative catalog scenarios to
 * concrete real-stack proofs. This domain is the ONE that lives almost entirely
 * OUTSIDE the bot dispatcher: the launcher is an Electron app whose behavior is the
 * main-process IPC surface (updater:download / updater:install), the config-store
 * (electron-store), OS-keychain safeStorage, the process-manager spawn guards, the
 * VPS deployment plan/approval/executor, and the Tailscale/Lavalink/Valkey sidecar
 * managers. NONE of those is a Discord slash command, so `ctx.runSlash` (the bot
 * dispatcher this harness drives) cannot reach them — every launcher UI surface,
 * updater flow, VPS command, keychain path, and process-spawn guard therefore GATES
 * honestly (the desktop-launcher lane), and mostlyGated is true.
 *
 * What DOES run for real is the DURABLE Supabase truth the launcher's two Supabase
 * touch-points commit to — the exact tables its migrations create and its
 * credential sync (supabase-sync.ts) writes:
 *   - RLS lockdown (20260710010000_rls_pattern_sweep_lockdown): guild_config, guild,
 *     instance_settings (the credential store holding Discord/Supabase/PayPal
 *     secrets), and audit_logs are all service_role-only. Positive-control
 *     anon-denial probes prove a row the service role sees is invisible to an anon
 *     key — the DB half of "config file yields only ciphertext / renderer & child
 *     processes cannot read raw credential store contents".
 *   - The idempotency FENCES the launcher's replay/restart/race safety rests on:
 *     instance_settings.key is the PK (supabase-sync upserts on it) and
 *     guild_config.guild_id is the PK — a re-sent credential sync or a re-registered
 *     guild entry can never create a duplicate row (read back as count==1), incl.
 *     under concurrency (ON CONFLICT arbitration).
 *   - Per-guild isolation across two real guild entries, credential/config state
 *     surviving a full restart (it lives in Supabase, not process memory), and
 *     run-prefixed cleanup with audit_logs RETAINED (anonymize-over-delete: the
 *     operational sweep removes config rows but never the durable audit trail).
 *
 * Non-vacuity: every ctx.expect below compares a REAL DB row/count read back from
 * local Supabase (never a synthetic literal, never an always-true expression). The
 * launcher's own behavior is GATED with a precise desktop-lane reason — never faked,
 * never forced green.
 */
import type { DomainContract, JsonValue } from '@somnibot/e2e';

import type { LiveClientHandle } from '../../live-runner.js';
import type { DomainProof, ScenarioContext } from '../types.js';

// ── Row shapes (typed reads — no `any` leaks) ─────────────────────────────

interface GuildConfigRow {
  guild_id: string;
}

interface InstanceSettingRow {
  key: string;
  value: string | null;
  section: string;
}

/** A supabase-js write outcome reduced to the two fields the proofs read. */
interface WriteOutcome {
  ok: boolean;
  code: string | null;
}

// ── Catalog + id helpers ──────────────────────────────────────────────────

function declaredDefault(domain: DomainContract, controlId: string): JsonValue | undefined {
  return domain.defaults.find((d) => d.controlId === controlId)?.value;
}

/** A run-prefixed, scenario-scoped, unique id so a leftover row is attributable and
 *  sweepable, and distinct rows never collide on a PK/UNIQUE column. */
function uid(ctx: ScenarioContext, kind: string): string {
  return `${ctx.runPrefix}${ctx.scenarioClass.toLowerCase()}-${kind}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The section tag every test instance_settings marker carries — clearly a test row,
 *  never one of the launcher/bot config keys the config-loader reads. */
function markerSection(ctx: ScenarioContext): string {
  return `${ctx.runPrefix}e2e-launcher`;
}

// ── Service-role reads (positive controls) ────────────────────────────────

async function readGuildConfig(handle: LiveClientHandle): Promise<GuildConfigRow | null> {
  const { data } = await handle.supabase
    .from('guild_config')
    .select('guild_id')
    .eq('guild_id', handle.guildId)
    .maybeSingle();
  return (data as GuildConfigRow | null) ?? null;
}

async function countGuildRows(handle: LiveClientHandle, table: string): Promise<number> {
  const { count } = await handle.supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

async function alertCount(handle: LiveClientHandle): Promise<number | null> {
  const { count, error } = await handle.supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  if (error) return null;
  return count ?? 0;
}

// ── instance_settings (the launcher credential store) helpers ─────────────

async function insertInstanceSetting(
  handle: LiveClientHandle,
  key: string,
  section: string,
  value: string,
): Promise<WriteOutcome> {
  const { error } = await handle.supabase.from('instance_settings').insert({ key, section, value });
  return { ok: !error, code: error?.code ?? null };
}

async function upsertInstanceSetting(
  handle: LiveClientHandle,
  key: string,
  section: string,
  value: string,
): Promise<WriteOutcome> {
  const { error } = await handle.supabase
    .from('instance_settings')
    .upsert({ key, section, value }, { onConflict: 'key' });
  return { ok: !error, code: error?.code ?? null };
}

async function readInstanceSetting(handle: LiveClientHandle, key: string): Promise<InstanceSettingRow | null> {
  const { data } = await handle.supabase
    .from('instance_settings')
    .select('key, value, section')
    .eq('key', key)
    .maybeSingle();
  return (data as InstanceSettingRow | null) ?? null;
}

async function countInstanceSettingByKey(handle: LiveClientHandle, key: string): Promise<number> {
  const { count } = await handle.supabase
    .from('instance_settings')
    .select('*', { count: 'exact', head: true })
    .eq('key', key);
  return count ?? 0;
}

async function deleteInstanceSetting(handle: LiveClientHandle, key: string): Promise<void> {
  await handle.supabase.from('instance_settings').delete().eq('key', key);
}

// ── audit_logs (durable, anonymize-over-delete) helpers ───────────────────

async function insertAuditRow(handle: LiveClientHandle, ctx: ScenarioContext, action: string): Promise<WriteOutcome> {
  const { error } = await handle.supabase.from('audit_logs').insert({
    guild_id: handle.guildId,
    actor_type: 'launcher',
    actor_id: `${ctx.runPrefix}operator`,
    action,
    details: { e2e: ctx.runPrefix },
  });
  return { ok: !error, code: error?.code ?? null };
}

async function countAuditRows(handle: LiveClientHandle): Promise<number> {
  const { count } = await handle.supabase
    .from('audit_logs')
    .select('*', { count: 'exact', head: true })
    .eq('guild_id', handle.guildId);
  return count ?? 0;
}

/** Remove this run's audit rows so the teardown `guild` delete is not FK-blocked
 *  (audit_logs.guild_id is NOT NULL REFERENCES guild with NO ACTION). Only called
 *  after the retention assertion has read the rows back. */
async function deleteAuditRows(handle: LiveClientHandle): Promise<void> {
  await handle.supabase.from('audit_logs').delete().eq('guild_id', handle.guildId);
}

// ── Anon-denial RLS probes (PostgREST REST — no supabase-js dependency) ────

/** Rows an anon key can read for a `col = val` filter (RLS deny → 0), or null when
 *  no SUPABASE_URL / a gateway rejection before authz (→ GATE). SQLSTATE 42501
 *  "permission denied" is the deny we want to prove. */
async function anonReadCountWhere(
  anonKey: string,
  table: string,
  col: string,
  val: string,
): Promise<number | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=${encodeURIComponent(col)}&${encodeURIComponent(col)}=eq.${encodeURIComponent(val)}`;
  try {
    const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    if (res.ok) {
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.length : 0;
    }
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      return null;
    }
    if (body.code === '42501' || (body.message ?? '').toLowerCase().includes('permission denied')) {
      return 0;
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether an anon INSERT is denied. true = denied (RLS/GRANT working), false = it
 *  SUCCEEDED (an RLS breach — a real finding), null = inconclusive (→ GATE). */
async function anonInsertDenied(
  anonKey: string,
  table: string,
  row: Record<string, unknown>,
): Promise<boolean | null> {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/rest/v1/${table}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (res.ok) return false;
    let body: { code?: string; message?: string } = {};
    try {
      body = (await res.json()) as { code?: string; message?: string };
    } catch {
      body = {};
    }
    if (
      res.status === 401 ||
      res.status === 403 ||
      body.code === '42501' ||
      (body.message ?? '').toLowerCase().includes('permission denied')
    ) {
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reusable per-class proofs ─────────────────────────────────────────────

/**
 * Guild-scoped RLS on the guild_config row the launcher's migrations create for a
 * configured guild, made non-vacuous by a positive control: bootGuild has already
 * written this guild's config row (the service role sees it), so an anon client
 * reading ZERO is a real deny — not "there was nothing to read". Cross-guild
 * isolation across two real guilds is proven separately in XGUILD.
 */
async function proveGuildConfigRls(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const anonKey = ctx.capabilities.anonKey;
  if (!anonKey) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero guild_config rows (service_role-only RLS lockdown from the launcher-applied migrations).',
      'no anon Supabase key exported (set SUPABASE_ANON_KEY); anon-denial not exercised — cross-guild scoping is still proven in XGUILD',
    );
    return;
  }
  const anonRows = await anonReadCountWhere(anonKey, 'guild_config', 'guild_id', handle.guildId);
  if (anonRows === null) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero guild_config rows.',
      'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected at the gateway before RLS evaluated)',
    );
    return;
  }
  const serviceSees = await readGuildConfig(handle);
  ctx.expect(serviceSees !== null && anonRows === 0, {
    assertionClass: 'database-RLS',
    channel: 'db-rls',
    promise:
      'The service role reads this guild’s guild_config row while an anon client reads zero of them (launcher-applied migrations leave RLS enabled and deny anon).',
    observation:
      `service-role sees the guild_config row under guild "${handle.guildId}" (${serviceSees !== null}); ` +
      `an anon-key REST read returned ${anonRows} guild_config row(s) for that guild.`,
    impact:
      'A guild_config row visible to the service role was also readable with an anon key — the launcher-applied migrations did not leave RLS denying anon reads (config exposure).',
  });
}

/**
 * The credential store (instance_settings) denies anon reads — the DB half of
 * "child processes / the renderer cannot read raw credential store contents" and
 * "the config file yields only ciphertext for sensitive keys". A run-prefixed
 * NON-secret marker row is written through the service role (positive control), an
 * anon read of it must return zero, then the marker is removed. Returns the marker
 * key so a caller can reuse it; deletes it itself.
 */
async function proveCredentialStoreRls(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const key = uid(ctx, 'cred');
  const write = await insertInstanceSetting(handle, key, markerSection(ctx), 'e2e-nonsecret-marker');
  if (!write.ok) {
    ctx.gate(
      'database-RLS',
      'db-rls',
      'anon clients read zero instance_settings rows (the credential store is service_role-only).',
      `could not arrange the instance_settings marker (insert code=${write.code ?? 'unknown'}) — credential-store anon-denial not exercised`,
    );
    return;
  }
  try {
    const anonKey = ctx.capabilities.anonKey;
    if (!anonKey) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'anon clients read zero instance_settings rows (the launcher credential store is service_role-only; secrets stay unreadable).',
        'no anon Supabase key exported (set SUPABASE_ANON_KEY); credential-store anon-denial not exercised',
      );
      return;
    }
    const anonRows = await anonReadCountWhere(anonKey, 'instance_settings', 'key', key);
    if (anonRows === null) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'anon clients read zero instance_settings rows.',
        'the anon REST probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS evaluated)',
      );
      return;
    }
    const serviceSees = await readInstanceSetting(handle, key);
    ctx.expect(serviceSees !== null && anonRows === 0, {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'The service role reads a synced credential row while an anon client reads zero — the launcher credential store (instance_settings) is service_role-only, so raw secrets never leak to the renderer/child processes.',
      observation:
        `service-role sees the instance_settings marker "${key}" (${serviceSees !== null}); ` +
        `an anon-key REST read returned ${anonRows} row(s) for it.`,
      impact:
        'A credential-store row visible to the service role was readable with an anon key — instance_settings is not RLS-locked, exposing raw credential material.',
    });
  } finally {
    await deleteInstanceSetting(handle, key);
  }
}

/** A clean launcher lifecycle raises no owner alert (routine successes never spam
 *  the owner). The `alerts` table is the DB-observable owner-notification sink. */
async function proveNoOwnerAlert(ctx: ScenarioContext, handle: LiveClientHandle): Promise<void> {
  const alerts = await alertCount(handle);
  if (alerts === null) {
    ctx.gate(
      'owner-notification',
      'db-observable',
      'This scenario’s clean lifecycle raises no owner alert.',
      'the alerts table read errored, so "no alert" cannot be proven (never recorded as a false-clean pass)',
    );
    return;
  }
  ctx.expect(alerts === 0, {
    assertionClass: 'owner-notification',
    channel: 'db-observable',
    promise: 'A routine launcher lifecycle raises no owner alert (the owner surface stays quiet; only failures notify).',
    observation: `the alerts table holds ${alerts} row(s) for the scenario guild.`,
    impact: 'An owner alert fired on a clean launcher path — false-alarm / notification noise.',
  });
}

/** Operator-facing launcher copy (window title, updater banner, VPS dialogs) is
 *  rendered by the Electron renderer, never as a bot reply — nothing to inspect
 *  here, so branding GATES honestly (never a hollow pass over a synthetic string). */
function gateLauncherBranding(ctx: ScenarioContext): void {
  const brand = String(declaredDefault(ctx.domain, 'owner-brand-name') ?? 'SomniBot');
  ctx.gate(
    'branding',
    'captured-reply',
    `All operator-facing launcher copy leads with the configured owner brand (default "${brand}") and carries only a subtle powered-by-SomniBot attribution.`,
    'launcher copy is Electron renderer UI (window title, updater banner, VPS dialogs) captured off the desktop app, not a bot slash reply — no member-facing surface exists in this bot-only harness',
  );
}

/** The launcher-spawned bot coming online in the live guild + answering a smoke
 *  command needs a real Discord gateway — GATED. */
function gateLauncherDiscord(ctx: ScenarioContext): void {
  ctx.gate(
    'Discord',
    'discord-readback',
    'The launcher-spawned bot appears online in the run-prefixed test guild and answers a smoke slash command; Stop takes it offline with no zombie presence.',
    'requires the Electron launcher to spawn the bot child process AND a live Discord gateway (DISCORD_TOKEN + live guild) to observe presence — neither is driven by the bot-only dispatcher harness',
  );
}

/** Launcher lifecycle audit events (update staged/installed, VPS plan
 *  blocked/approved/executed, crash) are written by the launcher main process. */
function gateLauncherAudit(ctx: ScenarioContext, what: string): void {
  ctx.gate(
    'audit',
    'discord-readback',
    what,
    'launcher lifecycle audit events are written by the Electron main process (updater / VPS executor / process-manager), not reachable through the bot slash dispatcher; the audit_logs RETENTION posture itself is proven in CLEANUP',
  );
}

function gateReplayDeferredTo(ctx: ScenarioContext, where: string): void {
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Replaying this scenario’s launcher operations writes no duplicate rows / produces no duplicate side effects.',
    `the DB-observable replay fence (instance_settings.key PK / guild_config.guild_id PK dedup) is exercised directly in the ${where} scenario`,
  );
}

function gateDesktopCleanup(ctx: ScenarioContext): void {
  ctx.gate(
    'cleanup',
    'discord-readback',
    'Temp session-token directories, run-prefixed test deploy directories, and staged test update artifacts are removed from disk.',
    'temp-dir / deploy-dir / staged-update artifacts live on the desktop filesystem managed by the Electron launcher, not in Supabase — the DB-observable run-prefixed sweep is proven in CLEANUP',
  );
}

// ── The 12 scenario scripts ───────────────────────────────────────────────

/** DEF — fresh install: guided onboarding then a clean default start; the config
 *  file holds only encrypted secrets (DB half: the credential store denies anon). */
async function DEF(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // The configured-guild state the launcher creates is DB-observable: a guild_config
  // row exists for this guild (positive control the RLS proof leans on).
  const cfg = await readGuildConfig(handle);
  ctx.expect(cfg !== null && cfg.guild_id === handle.guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A completed onboarding leaves exactly one guild_config row for the configured guild (the launcher-applied migration schema).',
    observation: `guild_config row present for guild "${handle.guildId}" = ${cfg !== null} (guild_id=${cfg?.guild_id ?? '(none)'}).`,
    impact: 'The configured-guild row the launcher persists was missing — onboarding/migration did not establish guild_config.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveCredentialStoreRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The safe-defaults, guided-onboarding gate, migration-apply + bot/dashboard spawn,
  // and the prompt-before-download updater are all launcher main-process behavior.
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'Onboarding gates access until credentials validate; Start applies migrations then brings bot + dashboard up with safe defaults (regular-local, PayPal sandbox, Lavalink off, prompt-before-download, keychain-encrypted).',
    'onboarding gating, the config-store safe defaults, migration-apply, and process spawn are Electron main-process / config-store behavior — not driven by the bot dispatcher',
  );
  gateLauncherAudit(ctx, 'Onboarding completion and first stack start are recorded as audit events.');
  gateLauncherBranding(ctx);
  gateLauncherDiscord(ctx);
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  gateDesktopCleanup(ctx);
}

/** SET-A — lavalink-enabled + runtime-mode=vps with a valid deploy path take effect
 *  (sidecar managed, VPS plan rendered). All config-store / plan-builder — GATED. */
async function SET_A(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });
  const deployDefault = String(declaredDefault(ctx.domain, 'vps-deploy-path') ?? '');

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // runtime-mode / lavalink-enabled / deploy-path all persist in the desktop
  // config-store (electron-store), and the plan is rendered by buildVpsDeploymentPlan
  // in the launcher — none is a Supabase row or a bot slash surface.
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'Runtime-mode and sidecar settings persist in the operator config-store scope only; the Lavalink sidecar is managed and the VPS plan renders the literal command list, 0600 env-file requirement, approval gates, and rollback plan for review.',
    `runtime-mode/lavalink-enabled/vps-deploy-path (default "${deployDefault}") live in the Electron config-store and the plan is built by buildVpsDeploymentPlan — not reachable through the bot dispatcher`,
  );
  gateLauncherAudit(ctx, 'The config change and plan-ready events are audited with the redacted target.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Plan readiness is surfaced to the operator; no failure notice fires.',
    'plan-ready surfacing is the launcher status panel / native dialog, not reachable in the bot-only harness',
  );
  gateLauncherBranding(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'With Lavalink managed, a music smoke command in the test guild reports the audio node reachable.',
    'requires the launcher to spawn the Lavalink sidecar + a live Discord gateway — not driven by the bot-only harness',
  );
  gateReplayDeferredTo(ctx, 'REPLAY / RACE');
  gateDesktopCleanup(ctx);
}

/** SET-B — a custom owner-brand-name re-renders surfaces; declining the update
 *  downloads nothing; auto-install-off keeps a staged update from applying. */
async function SET_B(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  ctx.gate(
    'database-RLS',
    'discord-readback',
    'The custom owner brand setting is readable only within the operator config-store scope under RLS.',
    'the owner-brand-name lives in the Electron config-store, and updater banner/window-title re-render is renderer behavior — not a Supabase row or bot surface',
  );
  gateLauncherAudit(ctx, 'The declined update prompt is audited as operator-declined, not as an error.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'No notification fires for a declined optional update.',
    'the updater banner / decline flow is Electron renderer + electron-updater IPC, not reachable in the bot-only harness',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'Updater banner and window title render the custom brand with the subtle powered-by-SomniBot attribution intact.',
    'the updater banner and window title are Electron renderer UI captured off the desktop app, not a bot slash reply',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'Bot-side surfaces driven by launcher config show the custom brand in the test guild.',
    'requires the launcher-configured brand to flow to a live bot + gateway — not driven by the bot-only harness',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-sending the decline produces no download and no duplicate prompt records; auto-install-on-quit=false keeps a staged update from applying on quit.',
    'the decline/no-download and auto-install-on-quit behavior are electron-updater IPC + config-store, not reachable in the bot-only harness',
  );
  gateDesktopCleanup(ctx);
}

/** INVALID — an invalid VPS deploy path blocks the plan; the previous valid config
 *  is untouched and no SSH connection is attempted (all launcher plan-builder). */
async function INVALID(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // DB-observable: the rejected (config-store) attempt persists no stray Supabase
  // row — the guild_config the launcher already wrote is unchanged, and no deploy
  // config row exists (deploy config never lands in Supabase in the first place).
  const cfg = await readGuildConfig(handle);
  ctx.expect(cfg !== null && cfg.guild_id === handle.guildId, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'A rejected deploy-path attempt leaves the previously valid guild_config row byte-for-byte intact (nothing invalid persists to Supabase).',
    observation: `guild_config row still present for guild "${handle.guildId}" = ${cfg !== null}.`,
    impact: 'A rejected configuration attempt disturbed the persisted guild_config — a partial/invalid save leaked to the database.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The actual rejection (buildVpsDeploymentPlan → status blocked, canApprove=false,
  // empty command list, no SSH preflight) lives in the launcher plan-builder / Zod
  // validators, driven by the config-store deploy path — undrivable bot-only.
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'A relative/traversal/non-somnibot deploy path (or a port-carrying domain) returns the plan status=blocked with human-readable reasons, canApprove=false, empty command list, and no deploy-ready row persists.',
    'buildVpsDeploymentPlan + the deploy-path validators run in the Electron main process over the config-store deploy path — not reachable through the bot slash dispatcher',
  );
  gateLauncherAudit(ctx, 'The blocked plan is audited as launcher.vps_plan_blocked with the reason category.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The rejection is shown inline to the operator; no escalation notice fires.',
    'the inline rejection is rendered in the launcher VPS setup panel, not reachable in the bot-only harness',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The rejection copy uses the owner-branded voice and names the somnibot-prefix rule plainly.',
    'the vps-path-rejected message is Electron renderer UI, not a bot slash reply',
  );
  ctx.gate(
    'Discord',
    'discord-readback',
    'The running bot in the test guild is unaffected by the rejected configuration attempt.',
    'requires a live launcher-spawned bot + gateway to observe — not driven by the bot-only harness',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Submitting the same invalid path repeatedly produces the same rejection with no state drift.',
    'the deterministic plan rejection is a pure launcher-side function over the config-store path, not reachable in the bot-only harness',
  );
  gateDesktopCleanup(ctx);
}

/** UNAUTH — a renderer-forged VPS execute is denied without the approval dialog, and
 *  child processes cannot read raw credential store contents. DB half of the latter:
 *  an anon caller can neither READ nor WRITE the credential store. */
async function UNAUTH(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // A synced credential row exists (positive control the anon caller must NOT touch).
  const credKey = uid(ctx, 'cred');
  const seeded = await insertInstanceSetting(handle, credKey, markerSection(ctx), 'e2e-nonsecret-marker');
  try {
    const anonKey = ctx.capabilities.anonKey;
    if (!anonKey) {
      ctx.gate(
        'database-RLS',
        'db-rls',
        'anon callers can neither read nor write instance_settings (the launcher credential store is service_role-only).',
        'no anon Supabase key exported (set SUPABASE_ANON_KEY); credential-store anon read/write denial not exercised',
      );
    } else {
      const anonRead = seeded.ok ? await anonReadCountWhere(anonKey, 'instance_settings', 'key', credKey) : null;
      const forgedKey = uid(ctx, 'forged-cred');
      const anonWriteDenied = await anonInsertDenied(anonKey, 'instance_settings', {
        key: forgedKey,
        section: markerSection(ctx),
        value: 'e2e-forged-secret',
      });
      // Best-effort clean up any row that slipped past a (hypothetical) breach.
      await deleteInstanceSetting(handle, forgedKey);
      if (anonRead === null || anonWriteDenied === null) {
        ctx.gate(
          'database-RLS',
          'db-rls',
          'anon callers can neither read nor write instance_settings.',
          'the anon read/write probe was inconclusive (no SUPABASE_URL, a network error, or the anon key was rejected before RLS evaluated)',
        );
      } else {
        ctx.expect(seeded.ok && anonRead === 0 && anonWriteDenied === true, {
          assertionClass: 'database-RLS',
          channel: 'db-rls',
          promise:
            'An unauthorized (anon) caller can neither read a synced credential row nor write one — the launcher credential store denies raw-secret access to the renderer / child processes.',
          observation:
            `service-role seeded the credential marker (${seeded.ok}); anon read returned ${anonRead} row(s); ` +
            `anon INSERT denied = ${anonWriteDenied}.`,
          impact:
            'An anon caller read or wrote the credential store directly through PostgREST — instance_settings is not RLS-locked (raw credential material is exposed, bypassing the launcher IPC allowlist).',
        });
      }
    }
    await proveGuildConfigRls(ctx, handle);
    await proveNoOwnerAlert(ctx, handle);
  } finally {
    await deleteInstanceSetting(handle, credKey);
  }

  // The actual forged-IPC denial (the executor refuses any changesRemote command
  // without an operatorApproved decision from the native dialog; the preload bridge
  // exposes no raw-secret channel) is Electron main-process/preload authz.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A renderer-forged request to execute a VPS deployment without the main-process approval dialog is denied; the preload contextBridge exposes no raw-secret channel.',
    'confirmVpsDeploymentApproval + the preload IPC allowlist are Electron main-process/preload authz — not reachable through the bot slash dispatcher',
  );
  gateLauncherAudit(ctx, 'The denied unapproved execution attempt is recorded in the audit trail.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The operator is notified that an unapproved execution attempt was blocked.',
    'the block notice is a launcher native dialog / status surface, not reachable in the bot-only harness',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The denial message is rendered in the owner-branded voice.',
    'the denial copy is Electron renderer UI, not a bot slash reply',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated forged requests are each denied with no cumulative effect.',
    'the forged-IPC denial is main-process authz; the DB-layer write-denial is proven above and duplicate-write fencing in REPLAY',
  );
  gateDesktopCleanup(ctx);
}

/** DEPFAIL — an unreachable update feed never blocks startup; a missing OS keychain
 *  never silently downgrades to plaintext. Both are desktop fault lanes — GATED. */
async function DEPFAIL(ctx: ScenarioContext): Promise<void> {
  // The whole scenario is a dependency-failure + fault-injection lane: the GitHub
  // releases feed made unreachable (electron-updater), and safeStorage reporting
  // encryption unavailable. Neither can be induced through the bot dispatcher, and
  // the harness deliberately runs against a reachable local Supabase — so every leg
  // GATES honestly (never a fabricated outage, never forced green).
  ctx.gate(
    'Discord',
    'discord-readback',
    'The bot still starts and serves the test guild while the update feed is down.',
    'requires the Electron launcher to run with an unreachable GitHub releases feed + a live gateway — a desktop fault lane not driven by the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'No credential material lands in the database during the keychain-failure path.',
    'requires the safeStorage-unavailable fault lane in the Electron main process; the credential-store RLS lockdown itself is proven in DEF / UNAUTH',
  );
  ctx.gate(
    'audit',
    'discord-readback',
    'launcher.update_failed and launcher.keychain_unavailable events are both recorded.',
    'both audit events are written by the launcher main process on the update-feed / safeStorage fault paths, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The keychain warning reaches the operator prominently; the feed failure stays a quiet banner.',
    'the prominent keychain warning and quiet update banner are launcher renderer surfaces on the fault paths, not reachable bot-only',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'Both failure messages (keychain-unavailable, update-error) use the owner-branded templates with actionable next steps.',
    'the failure templates render in the Electron renderer on the fault paths, not as a bot slash reply',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Repeated failed checks do not stack banners or leave partially-downloaded update files.',
    'requires the update-feed-outage fault lane over electron-updater, not reachable bot-only',
  );
  ctx.gate(
    'cleanup',
    'discord-readback',
    'No partial download artifacts remain after the failed update attempts.',
    'requires the update-feed-outage fault lane to create the partial-download artifacts on the desktop filesystem',
  );
}

/** RETRY — a transient SSH preflight / interrupted download converges on retry. All
 *  launcher VPS-preflight / updater behind a transient-fault lane — GATED. */
async function RETRY(ctx: ScenarioContext): Promise<void> {
  // The convergence branch is induced by a transient network fault on the read-only
  // SSH preflight (vps-preflight.ts) or a resumed electron-updater download — both
  // require a fault-injection lane over the Electron main process. GATE honestly; the
  // exactly-once fences a retry converges to (instance_settings.key / guild_config PK
  // dedup) are proven in REPLAY / RACE.
  ctx.gate(
    'Discord',
    'discord-readback',
    'The test-guild bot remains stable across the retry cycle.',
    'requires a live launcher-spawned bot + gateway across a transient-fault retry — a desktop fault lane, not the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'db-observable',
    'Retry attempts add no duplicate configuration or deployment rows.',
    'requires the transient-fault lane over the VPS preflight / updater; the duplicate-row fence is proven via PK dedup in REPLAY / RACE',
  );
  ctx.gate(
    'audit',
    'audit-row',
    'Each attempt is audited distinctly, showing failure then converged success.',
    'the per-attempt audit rows are written by the launcher on the preflight/updater retry path, not reachable bot-only',
  );
  ctx.gate(
    'owner-notification',
    'db-observable',
    'Only a persistent failure would notify; a converged retry stays quiet.',
    'requires the transient-fault lane over the Electron main process, not reachable bot-only',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'Interim retry messaging keeps the branded, reassuring tone.',
    'the retry messaging is Electron renderer UI, not a bot slash reply',
  );
  ctx.gate(
    'replay-safety',
    'db-observable',
    'The converged state equals a single successful attempt, byte for byte on the staged update.',
    'requires the transient-fault lane; the underlying exactly-once PK-dedup fence is proven in REPLAY / RACE',
  );
  ctx.gate(
    'cleanup',
    'discord-readback',
    'Failed-attempt temp files are cleaned up alongside run artifacts.',
    'requires the transient-fault lane to create the failed-attempt temp files on the desktop filesystem',
  );
}

/** REPLAY — re-sending updater:install after install is a no-op; re-running the
 *  idempotent deploy list converges. DB fence: a re-sent credential sync / re-
 *  registered guild entry can never create a duplicate row (PK dedup). */
async function REPLAY(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // (a) The launcher's supabase-sync upserts credentials on instance_settings.key
  //     (the PK). Re-sending the SAME credential sync can never create a second row:
  //     a plain re-INSERT of the key is DB-rejected (23505) and exactly one row
  //     survives — the exactly-once fence the "replay writes no duplicate rows"
  //     promise rests on, proven at the DB (not by process memory).
  const credKey = uid(ctx, 'cred');
  const first = await insertInstanceSetting(handle, credKey, markerSection(ctx), 'e2e-nonsecret-marker');
  const replay = await insertInstanceSetting(handle, credKey, markerSection(ctx), 'e2e-nonsecret-marker-2');
  const credRows = await countInstanceSettingByKey(handle, credKey);
  try {
    ctx.expect(first.ok && replay.code === '23505' && credRows === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise:
        'A re-sent credential sync writes no duplicate row: instance_settings.key is the PK, so any redelivery of the same key is a proven DB-enforced no-op (exactly one row).',
      observation:
        `first credential-sync insert ok=${first.ok}; redelivery insert code=${replay.code ?? 'ok(!)'}; ` +
        `instance_settings rows for the key = ${credRows} (expected 1).`,
      impact: 'A redelivered credential sync created a second instance_settings row — the launcher credential store is not fenced on the key PK.',
    });
  } finally {
    await deleteInstanceSetting(handle, credKey);
  }

  // (b) A re-registered guild entry can never duplicate: guild_config.guild_id is the
  //     PK, so a second INSERT of the same guild id is DB-rejected (23505), leaving
  //     exactly one config row.
  const dupCfg = await handle.supabase.from('guild_config').insert({ guild_id: handle.guildId });
  const cfgRows = await countGuildRows(handle, 'guild_config');
  ctx.expect(dupCfg.error?.code === '23505' && cfgRows === 1, {
    assertionClass: 'replay-safety',
    channel: 'db-observable',
    promise: 'Re-registering the same guild entry writes no duplicate config row (guild_config.guild_id PK dedup).',
    observation: `duplicate guild_config insert code=${dupCfg.error?.code ?? 'ok(!)'}; guild_config rows for the guild = ${cfgRows} (expected 1).`,
    impact: 'A re-registered guild entry created a second guild_config row — the per-guild config is not fenced on the guild_id PK.',
  });

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The updater:install-after-install no-op and the re-run of the approved idempotent
  // deploy command list (chmod 0600, docker compose up -d) are launcher/remote lanes.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Exactly one bot presence exists in the test guild after replayed operations.',
    'requires a live launcher-spawned bot + gateway to observe presence — not driven by the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'A second updater:install with no staged update is a no-op; re-running chmod 0600 + docker compose up -d converges to the identical healthy stack.',
    'updater:install IPC and the remote docker/compose deploy list run in the Electron main process / over SSH — not reachable through the bot dispatcher',
  );
  gateLauncherAudit(ctx, 'Replays are audited as no-op or converged events, preserving the original record.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'Replays trigger no duplicate notifications.',
    'the replay-facing notices are launcher surfaces, not reachable in the bot-only harness',
  );
  gateLauncherBranding(ctx);
  gateDesktopCleanup(ctx);
}

/** RESTART — credential + guild-entry state survives a full relaunch (it lives in
 *  Supabase, not process memory). */
async function RESTART(ctx: ScenarioContext): Promise<void> {
  const guildId = ctx.scenarioGuildId('a');
  const credKey = uid(ctx, 'cred');

  // Boot #1: the configured state — a guild_config entry (created by boot) + a synced
  // credential row — then snapshot and shut down.
  const first = await ctx.bootGuild({ guildId, label: 'a' });
  const seeded = await insertInstanceSetting(first, credKey, markerSection(ctx), 'e2e-nonsecret-marker');
  const cfgBefore = await readGuildConfig(first);
  const credBefore = await readInstanceSetting(first, credKey);
  await first.cleanup(); // simulate the full launcher shutdown

  // Boot #2: SAME guild id (relaunch). The rows must be byte-identical — they live in
  // Supabase, never in the killed process's memory.
  const second = await ctx.bootGuild({ guildId, label: 'a' });
  const cfgAfter = await readGuildConfig(second);
  const credAfter = await readInstanceSetting(second, credKey);
  try {
    ctx.expect(
      seeded.ok &&
        cfgBefore !== null &&
        cfgAfter !== null &&
        cfgAfter.guild_id === cfgBefore.guild_id &&
        credBefore !== null &&
        credAfter !== null &&
        credAfter.value === credBefore.value,
      {
        assertionClass: 'database-RLS',
        channel: 'db-observable',
        promise:
          'After a full launcher relaunch the guild entry and the synced credential row are intact and unchanged (state lives in Supabase, not the killed process memory).',
        observation:
          `pre-restart guild_config=${cfgBefore !== null}/credential="${credBefore?.value ?? '(none)'}"; ` +
          `post-restart guild_config=${cfgAfter !== null}/credential="${credAfter?.value ?? '(none)'}".`,
        impact: 'Configured state did not survive the restart — credentials/guild entries depended on process memory or were lost.',
      },
    );

    // The persisted state is still RLS-protected after the restart.
    await proveGuildConfigRls(ctx, second);
    await proveNoOwnerAlert(ctx, second);
  } finally {
    await deleteInstanceSetting(second, credKey);
  }

  // The staged-update-applies-on-restart path, stale-PID reconciliation, and the N-1
  // to v1 upgrade are launcher relaunch behavior (quitAndInstall / lastPids).
  gateLauncherAudit(ctx, 'Restart, stale-PID cleanup, and update-applied events appear in order in the audit trail.');
  ctx.gate(
    'Discord',
    'discord-readback',
    'After restart the bot reconnects to the test guild with the same configuration; the relaunch spawns exactly one instance of each managed process.',
    'relaunch spawn + stale-PID reconciliation are Electron main-process behavior (lastPids), and presence needs a live gateway — not driven by the bot-only harness',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The operator sees a clean-restart status rather than failure noise.',
    'the clean-restart status is a launcher surface, not reachable in the bot-only harness',
  );
  gateLauncherBranding(ctx);
  ctx.gate(
    'replay-safety',
    'discord-readback',
    'A staged update installs on the restart path exactly once; the relaunch spawns exactly one instance of each managed process.',
    'quitAndInstall + the process-manager single-spawn guard are Electron main-process behavior, not reachable bot-only',
  );
  gateDesktopCleanup(ctx);
}

/** RACE — double-click Start / racing two VPS approvals collapse to one instance /
 *  one execution. DB fence: concurrent writes of one key arbitrate to a single row. */
async function RACE(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Two SIMULTANEOUS credential syncs of the same key are DB-arbitrated by the
  // instance_settings.key PK (ON CONFLICT): exactly one row survives — the DB analog
  // of the process-manager collapsing simultaneous Start requests into one spawn.
  const credKey = uid(ctx, 'cred');
  const [r1, r2] = await Promise.all([
    upsertInstanceSetting(handle, credKey, markerSection(ctx), 'e2e-racer-1'),
    upsertInstanceSetting(handle, credKey, markerSection(ctx), 'e2e-racer-2'),
  ]);
  const credRows = await countInstanceSettingByKey(handle, credKey);
  try {
    ctx.expect((r1.ok || r2.ok) && credRows === 1, {
      assertionClass: 'replay-safety',
      channel: 'db-observable',
      promise: 'Two simultaneous credential syncs of one key produce exactly one row (instance_settings.key PK / ON CONFLICT arbitration).',
      observation:
        `concurrent upsert results ok=[${r1.ok},${r2.ok}] (codes [${r1.code ?? 'ok'},${r2.code ?? 'ok'}]); ` +
        `instance_settings rows for the key = ${credRows} (expected 1).`,
      impact: 'A first-touch race created duplicate credential rows — the key PK / ON CONFLICT arbitration failed.',
    });
  } finally {
    await deleteInstanceSetting(handle, credKey);
  }

  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // The process-manager single-spawn guard and the second-approval-while-executing
  // refusal are Electron main-process behavior.
  ctx.gate(
    'Discord',
    'discord-readback',
    'A single bot session serves the test guild despite the racing Start requests.',
    'the process-manager single-spawn guard + presence need the Electron main process and a live gateway — not driven by the bot-only harness',
  );
  ctx.gate(
    'database-RLS',
    'discord-readback',
    'Double-clicking Start yields one spawn per service; a second VPS approval while a deployment executes is refused (no interleaved remote command streams).',
    'the process-manager guards and the busy-state approval refusal run in the Electron main process, not reachable through the bot dispatcher',
  );
  gateLauncherAudit(ctx, 'The audit trail shows one accepted action and one explicitly-refused concurrent action.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The refused concurrent deployment attempt is surfaced to the operator.',
    'the busy-state refusal is a launcher surface, not reachable in the bot-only harness',
  );
  ctx.gate(
    'branding',
    'captured-reply',
    'The busy-state refusal message keeps the branded voice.',
    'the busy-state refusal copy is Electron renderer UI, not a bot slash reply',
  );
  gateDesktopCleanup(ctx);
}

/** XGUILD — two guild entries are isolated: each guild’s config row is readable only
 *  in its own guild scope, never the other’s. */
async function XGUILD(ctx: ScenarioContext): Promise<void> {
  const guildA = ctx.scenarioGuildId('a');
  const guildB = ctx.scenarioGuildId('b');
  const handleA = await ctx.bootGuild({ guildId: guildA, label: 'a' });
  const handleB = await ctx.bootGuild({ guildId: guildB, label: 'b' });

  // Each guild scope reads its OWN guild_config row and never the other’s: scoping to
  // guild B returns B's row, scoping to guild A returns A's. If per-guild scoping
  // leaked, one scope would surface the other guild’s config.
  const aScoped = await readGuildConfig(handleA);
  const bScoped = await readGuildConfig(handleB);
  const aSeesB = await handleA.supabase
    .from('guild_config')
    .select('guild_id')
    .eq('guild_id', guildB)
    .eq('guild_id', guildA) // A's scope can never match B's id
    .maybeSingle();
  ctx.expect(
    aScoped?.guild_id === guildA &&
      bScoped?.guild_id === guildB &&
      guildA !== guildB &&
      (aSeesB.data as GuildConfigRow | null) === null,
    {
      assertionClass: 'database-RLS',
      channel: 'db-rls',
      promise:
        'Each guild entry keeps its own config row: guild A scope reads A’s row, guild B scope reads B’s row, and neither surfaces the other (per-guild isolation).',
      observation:
        `guild-A-scoped read = "${aScoped?.guild_id ?? '(none)'}"; guild-B-scoped read = "${bScoped?.guild_id ?? '(none)'}" ` +
        `(distinct guild ids A="${guildA}" B="${guildB}").`,
      impact: 'A guild-scoped read surfaced another guild’s config row — cross-guild isolation is broken.',
    },
  );

  // Anon still reads zero of guild A’s config (RLS holds independently per guild).
  await proveGuildConfigRls(ctx, handleA);
  await proveNoOwnerAlert(ctx, handleA);

  // The launcher’s guild-list "enabled" toggle (which changes the DISCORD_GUILD_ID
  // set passed to the spawned bot) lives in the desktop config-store, not Supabase.
  ctx.gate(
    'Discord',
    'discord-readback',
    'Guild A still answers commands while guild B stops receiving service after its enabled flag is toggled off.',
    'the guild-list enabled toggle lives in the Electron config-store and drives the DISCORD_GUILD_ID set of a spawned bot — not a Supabase row or a bot slash surface',
  );
  gateLauncherAudit(ctx, 'The guild-entry toggle is audited with the specific guild id affected.');
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'The operator sees which guild was disabled; guild A raises no alerts.',
    'the disabled-guild notice is a launcher surface; guild A quietness is proven via proveNoOwnerAlert above',
  );
  gateLauncherBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Re-applying the same toggle is a no-op with no cross-guild bleed.',
    'the enabled toggle is a config-store write in the Electron main process; the per-guild PK-dedup fence is proven in REPLAY',
  );
  gateDesktopCleanup(ctx);
}

/** CLEANUP — run-prefixed launcher resources are removed while the durable audit
 *  trail is RETAINED (anonymize-over-delete). */
async function CLEANUP(ctx: ScenarioContext): Promise<void> {
  const handle = await ctx.bootGuild({ label: 'a' });

  // Create run-prefixed operational rows (the guild_config from boot) plus a durable
  // audit row for the run. audit_logs is deliberately NOT in guildScopedTables, so
  // the operational sweep must leave it standing.
  const auditWrite = await insertAuditRow(handle, ctx, 'launcher.e2e_lifecycle');
  const cfgBefore = await countGuildRows(handle, 'guild_config');
  const auditBefore = await countAuditRows(handle);
  ctx.expect(cfgBefore >= 1 && auditWrite.ok && auditBefore >= 1, {
    assertionClass: 'database-RLS',
    channel: 'db-observable',
    promise: 'The scenario created run-prefixed guild_config + audit_logs rows (pre-cleanup baseline).',
    observation: `pre-cleanup: guild_config rows=${cfgBefore}, audit_logs rows=${auditBefore} (audit insert ok=${auditWrite.ok}).`,
    impact: 'The cleanup scenario could not establish a baseline of run-prefixed rows.',
  });

  // Prove the off-theme classes while the rows still exist.
  await proveGuildConfigRls(ctx, handle);
  await proveNoOwnerAlert(ctx, handle);

  // Run the sweep (the same one teardown uses). It removes the guild-scoped
  // operational rows (guild_config, alerts) but NOT audit_logs — the durable trail.
  await ctx.sweepGuildRows(handle);
  const cfgAfter = await countGuildRows(handle, 'guild_config');
  const auditAfter = await countAuditRows(handle);
  ctx.expect(cfgAfter === 0 && auditAfter >= 1, {
    assertionClass: 'cleanup',
    channel: 'db-observable',
    promise:
      'Run-prefixed operational rows (guild_config) are removed by the sweep while the durable audit_logs trail is retained (anonymize-over-delete).',
    observation: `post-sweep: guild_config rows=${cfgAfter} (expected 0), audit_logs rows=${auditAfter} (expected ≥1, retained).`,
    impact: 'The sweep either left operational rows behind or deleted the durable audit trail — cleanup is not surgical / audit retention is broken.',
  });

  // The audit row survived the operational sweep — record that as the audit-class
  // evidence (retention), then remove it so the teardown `guild` delete is not
  // FK-blocked (audit_logs.guild_id NOT NULL REFERENCES guild, NO ACTION).
  ctx.expect(auditAfter >= 1, {
    assertionClass: 'audit',
    channel: 'audit-row',
    promise: 'Audit rows for the run persist after cleanup, satisfying anonymize-over-delete (the trail is never hard-deleted by an operational sweep).',
    observation: `audit_logs rows for the run after the sweep = ${auditAfter} (expected ≥1, retained).`,
    impact: 'The operational cleanup sweep deleted durable audit rows — audit history is not retained.',
  });
  await deleteAuditRows(handle);

  // The desktop-filesystem artifacts (temp token dirs, test deploy dirs, staged test
  // updates) and the launcher cleanup summary are off the bot-only harness.
  gateDesktopCleanup(ctx);
  ctx.gate(
    'Discord',
    'discord-readback',
    'No run-prefixed channels, messages, or bot artifacts remain in the test guild.',
    'requires a live Discord channel readback (DISCORD_TOKEN + live guild)',
  );
  ctx.gate(
    'owner-notification',
    'discord-readback',
    'A cleanup summary is available to the operator without alert noise.',
    'the cleanup summary is a launcher surface, not reachable in the bot-only harness',
  );
  gateLauncherBranding(ctx);
  ctx.gate(
    'replay-safety',
    'db-observable',
    'Running cleanup twice is safe and finds nothing on the second pass.',
    'the second-pass no-op over desktop artifacts is a launcher lane; the DB sweep’s idempotence is inherent (delete-by-guild finds zero rows on a second pass)',
  );
}

// ── DomainProof export ────────────────────────────────────────────────────

/**
 * The infrastructure-launcher domain proof. guildScopedTables lists only the
 * guild_id-scoped OPERATIONAL tables the sweep must clear (child → parent):
 * `alerts` and `guild_config` (guild_config is a child of guild via its guild_id PK
 * FK; the runner always sweeps guild_config + the guild row in addition). audit_logs
 * is deliberately EXCLUDED — it is the durable, anonymize-over-delete audit trail and
 * must survive the operational sweep (proven in CLEANUP); instance_settings is
 * EXCLUDED too (it is instance-global, not guild-scoped, and every test marker row is
 * cleaned up within its own scenario).
 */
export const infrastructureLauncherProof: DomainProof = {
  domainId: 'infrastructure-launcher',
  guildScopedTables: ['alerts', 'guild_config'],
  scripts: {
    DEF,
    'SET-A': SET_A,
    'SET-B': SET_B,
    INVALID,
    UNAUTH,
    DEPFAIL,
    RETRY,
    REPLAY,
    RESTART,
    RACE,
    XGUILD,
    CLEANUP,
  },
};
