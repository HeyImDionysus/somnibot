/**
 * slash-bidirectional.live.test — the BIDIRECTIONAL control↔handler proof for
 * the SLASH lane (PR5, Check 1 — STRONG, LIVE).
 *
 * Goal (explicit goal-plan requirement): prove EVERY registered slash command
 * has a dispatcher handler AND every dispatcher slash handler corresponds to a
 * real exposed control — no DEAD commands (Discord shows it, the bot ignores it)
 * and no ORPHAN handlers (the bot routes a name it never registers).
 *
 * How it is made STRONG (no re-implementation):
 *   - EXPOSED set = the command bodies the REAL production `initGuildFeatures`
 *     RETURNS (what index.ts bulk-PUTs to Discord). We boot the real per-guild
 *     bootstrap against LOCAL Supabase with EVERY command-gating feature flag ON
 *     (economy + all economy_*_enabled sub-flags + music/giveaways/temp-channels/
 *     commerce/polls/predictions), so every gated command push actually fires.
 *     `handle.commands` is that return value, captured verbatim by the runner.
 *   - HANDLED set = INLINE_SLASH_COMMAND_NAMES ∪ REGISTRY_COMMAND_NAMES from the
 *     dispatch manifest (the dispatcher SOURCES its routing keys from that same
 *     manifest, so it cannot drift from what the live dispatcher matches).
 *   - We assert BIDIRECTIONAL equality and report each side precisely.
 *
 * Documented EXCLUSIONS (honoring the manifest's COVERAGE BOUNDARY):
 *   - CONTEXT MENUS: `initGuildFeatures` also returns User/Message context-menu
 *     bodies (ApplicationCommandType 2/3). Those are NOT slash commands and are
 *     handled by their own manifest sets (USER/MESSAGE_CONTEXT_MENU), so we drop
 *     them from the exposed SLASH set (keep only type ChatInput = 1/undefined).
 *   - CUSTOM COMMANDS: the dynamic per-guild `isCustomCommand` lane has no static
 *     manifest entry BY DESIGN. Custom-command bodies are `type: 1`, so they are
 *     indistinguishable from real slash commands by type; we exclude them by NAME
 *     using the live `custom_commands` rows for this guild (the disposable guild
 *     is shared rig state, so we compute this rather than assume zero).
 *
 * ⚠️  LIVE: requires a running local Supabase (with Realtime — the real init
 *     starts the action-queue listener). Excluded from the fast `vitest run`;
 *     runs only via `test:live` (vitest.live.config.ts). If Supabase is
 *     unreachable, bootstrapLiveClient throws — it FAILS LOUD, never skips.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootstrapLiveClient, type LiveClientHandle } from '../../live-runner.js';
import {
  INLINE_SLASH_COMMAND_NAMES,
  REGISTRY_COMMAND_NAMES,
} from '@somnibot/bot/dist/events/dispatch-manifest.js';

/**
 * Every `guild_config` flag that GATES a slash-command push in
 * `initGuildFeatures` (packages/bot/src/guild-init.ts), flipped ON so the real
 * init emits the full exposed set. Commands with NO gate (ticket, rank,
 * leaderboard, xp, moderation, purge, help, setup, forgetme, privacy, mydata,
 * tutorial, profiles) push unconditionally and need no flag here.
 *
 * The REST-heavy managers that gate NO command push (stats / scheduled_messages
 * / sync) are deliberately left OFF: enabling them cannot change the exposed set
 * (they add no command) and keeps this gateway-less boot on the runner's safe
 * path — the same rationale the runner documents for its default.
 */
const ALL_COMMAND_GATING_FLAGS_ON: Readonly<Record<string, boolean>> = {
  // Base economy + timers, and every economy sub-feature family.
  economy_enabled: true,
  economy_gathering_enabled: true,
  economy_crafting_enabled: true,
  economy_farming_enabled: true,
  economy_fishing_enabled: true,
  economy_adventures_enabled: true,
  economy_market_enabled: true,
  economy_trivia_enabled: true,
  economy_games_enabled: true,
  economy_lottery_enabled: true,
  economy_pets_enabled: true,
  economy_quests_enabled: true,
  economy_achievements_enabled: true,
  economy_prestige_enabled: true, // also gates the achievements (badges) push
  economy_heist_enabled: true,
  // Polls/predictions (either flag gates the /poll + /predict push).
  polls_enabled: true,
  predictions_enabled: true,
  // Non-economy gated families.
  giveaways_enabled: true, // /giveaway
  music_enabled: true, // /play, /skip, … family
  temp_channels_enabled: true, // /voice
  paypal_enabled: true, // /store, /license
};

/**
 * Allowlists of KNOWN, REPORTED mismatches — kept EMPTY unless the live run
 * surfaces a genuine dead/orphan command. Any entry here MUST be annotated with
 * why it exists and MUST be reported to the owner as a finding needing a
 * decision — this is the "green-but-honest" escape hatch, never a silent hide.
 */
const KNOWN_DEAD_COMMANDS: readonly string[] = [
  // (exposed by initGuildFeatures but no manifest handler) — none currently.
];
const KNOWN_ORPHAN_HANDLERS: readonly string[] = [
  // (handled per manifest but never exposed by initGuildFeatures) — none currently.
];

/** discord.js ApplicationCommandType: User = 2, Message = 3 (context menus). */
const CONTEXT_MENU_TYPES = new Set<number>([2, 3]);

function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

let handle: LiveClientHandle;
let exposedSlash: Set<string>;
let handled: Set<string>;
let customCommandNames: Set<string>;
let deadCommands: string[];
let orphanHandlers: string[];

beforeAll(async () => {
  // Boot the REAL stack with every command-gating flag ON. Throws LOUDLY (never
  // a silent skip) if the local Supabase is unreachable.
  handle = await bootstrapLiveClient({
    economyEnabled: true,
    guildConfigOverrides: ALL_COMMAND_GATING_FLAGS_ON,
  });

  // EXCLUSION 2 — custom commands: computed from the live rows (shared rig state
  // may hold leftovers), not assumed empty. `type: 1`, so name-based exclusion.
  const { data: customRows, error: customErr } = await handle.supabase
    .from('custom_commands')
    .select('name')
    .eq('guild_id', handle.guildId)
    .eq('enabled', true);
  if (customErr) {
    throw new Error(`failed reading custom_commands for exclusion: ${customErr.message}`);
  }
  customCommandNames = new Set((customRows ?? []).map((r: { name: string }) => r.name));

  // EXCLUSION 1 — context menus (type 2/3): keep only ChatInput slash bodies.
  exposedSlash = new Set(
    handle.commands
      .filter((c) => c.type === undefined || !CONTEXT_MENU_TYPES.has(c.type))
      .map((c) => c.name)
      .filter((name) => !customCommandNames.has(name)),
  );

  handled = new Set<string>([...INLINE_SLASH_COMMAND_NAMES, ...REGISTRY_COMMAND_NAMES]);

  // DEAD  = exposed but NOT handled (Discord shows it; dispatcher ignores it).
  // ORPHAN = handled but NOT exposed (dispatcher routes a name never registered).
  deadCommands = difference(exposedSlash, handled).filter((n) => !KNOWN_DEAD_COMMANDS.includes(n));
  orphanHandlers = difference(handled, exposedSlash).filter((n) => !KNOWN_ORPHAN_HANDLERS.includes(n));

  // Report the precise sets (visible with --reporter=verbose).
  // eslint-disable-next-line no-console
  console.warn(
    `[live][slash-bidirectional] exposed slash (${exposedSlash.size}): ` +
      `${[...exposedSlash].sort().join(', ')}`,
  );
  // eslint-disable-next-line no-console
  console.warn(
    `[live][slash-bidirectional] handled (${handled.size}): ` +
      `${[...handled].sort().join(', ')}`,
  );
  if (customCommandNames.size > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[live][slash-bidirectional] excluded custom commands (${customCommandNames.size}): ` +
        `${[...customCommandNames].sort().join(', ')}`,
    );
  }
}, 60_000);

afterAll(async () => {
  if (handle) await handle.cleanup();
});

describe('LIVE slash bidirectional — exposed controls ↔ dispatcher handlers', () => {
  it('the REAL init exposed a non-trivial slash set (guards against a vacuous pass)', () => {
    // Unconditional pushes alone guarantee a sizeable set; a tiny set would mean
    // the all-flags boot silently under-emitted (a harness fault, not a finding).
    expect(exposedSlash.size).toBeGreaterThan(50);
    // Spot-check a few unconditional + gated commands are actually present.
    for (const name of ['help', 'setup', 'ticket', 'balance', 'play', 'giveaway', 'heist']) {
      expect(exposedSlash.has(name), `expected exposed slash set to include /${name}`).toBe(true);
    }
  });

  it('has NO dead commands (every exposed slash command has a dispatcher handler)', () => {
    // A non-empty list is a REAL finding: Discord would show these commands but
    // the dispatcher has no branch for them — the bot would ignore the click.
    expect(
      deadCommands,
      `DEAD COMMANDS (exposed by initGuildFeatures but unhandled by the dispatch ` +
        `manifest): ${deadCommands.join(', ') || '(none)'}. Each is a real ` +
        `dead-command defect for the owner to adjudicate (add a handler or stop ` +
        `registering the command) — NOT a validator bug.`,
    ).toEqual([]);
  });

  it('has NO orphan handlers (every dispatcher slash handler maps to an exposed command)', () => {
    // A non-empty list is a REAL finding: the dispatcher routes a name that the
    // real init never registers to Discord, so the branch is unreachable.
    expect(
      orphanHandlers,
      `ORPHAN HANDLERS (handled by the dispatch manifest but never exposed by ` +
        `initGuildFeatures with ALL command-gating flags ON): ${orphanHandlers.join(', ') || '(none)'}. ` +
        `Each is a real orphan-handler defect for the owner to adjudicate (register ` +
        `the command or remove the dead routing branch) — NOT a validator bug.`,
    ).toEqual([]);
  });

  it('is BIDIRECTIONALLY equal (exposed slash set === handled set, modulo documented allowlists)', () => {
    const exposedForEquality = new Set(
      [...exposedSlash].filter((n) => !KNOWN_DEAD_COMMANDS.includes(n)),
    );
    const handledForEquality = new Set(
      [...handled].filter((n) => !KNOWN_ORPHAN_HANDLERS.includes(n)),
    );
    expect([...exposedForEquality].sort()).toEqual([...handledForEquality].sort());
  });
});
