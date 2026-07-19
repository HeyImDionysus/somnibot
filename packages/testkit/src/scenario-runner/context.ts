/**
 * scenario-runner/context — the live context implementation handed to each proof
 * script. It owns the mechanics (boot guilds, mint tokens, drive interactions,
 * record evidence, sweep run-prefixed rows) so scripts stay declarative.
 *
 * Isolation model: every scenario gets its OWN run+scenario-prefixed guild id(s),
 * so per-scenario `guild_config` never bleeds and cleanup is a delete-by-guild
 * sweep. Every user id a script touches is run-prefixed too, so a leftover row is
 * always attributable and always removable.
 */
import { ASSERTION_CLASSES, type AssertionClass, type DomainContract, type ScenarioClass } from '@somnibot/e2e';

import { bootstrapLiveClient, type LiveClientHandle } from '../live-runner.js';
import { createInteractionInjector } from '../inject.js';
import { mintCapabilityToken } from '../capability.js';
import { buildSlashInteraction, type OptionValue } from '../interaction-builders.js';
import type { CapturedResponse } from '../captured-response.js';
import type {
  AssertionRecord,
  BootGuildOptions,
  BoundInjector,
  Capabilities,
  ClassEvidence,
  ObservationChannel,
  RunSlashParams,
  ScenarioContext,
  ScenarioEvidence,
} from './types.js';

/** guild_id-scoped tables always swept in addition to a domain's own list. */
const ALWAYS_SWEPT_GUILD_TABLES = ['guild_config'] as const;

export class ScenarioContextImpl implements ScenarioContext {
  readonly domain: DomainContract;
  readonly scenarioClass: ScenarioClass;
  readonly scenario: DomainContract['scenarios'][number];
  readonly runPrefix: string;
  readonly capabilities: Capabilities;

  private readonly guildScopedTables: readonly string[];
  private readonly records: AssertionRecord[] = [];
  private readonly handles: LiveClientHandle[] = [];
  private readonly guildIds = new Set<string>();
  private readonly injectors = new Map<LiveClientHandle, BoundInjector>();

  constructor(args: {
    domain: DomainContract;
    scenarioClass: ScenarioClass;
    runPrefix: string;
    capabilities: Capabilities;
    guildScopedTables: readonly string[];
  }) {
    this.domain = args.domain;
    this.scenarioClass = args.scenarioClass;
    this.runPrefix = args.runPrefix;
    this.capabilities = args.capabilities;
    this.guildScopedTables = args.guildScopedTables;
    const scenario = args.domain.scenarios.find((s) => s.class === args.scenarioClass);
    if (!scenario) {
      throw new Error(`Domain "${args.domain.id}" has no "${args.scenarioClass}" scenario`);
    }
    this.scenario = scenario;
  }

  scenarioGuildId(label = 'a'): string {
    // Run + scenario + label → deterministic, isolated, sweepable guild id.
    return `${this.runPrefix}${this.scenarioClass.toLowerCase()}-g${label.toLowerCase()}`;
  }

  userId(label: string): string {
    return `${this.runPrefix}u-${label.toLowerCase()}`;
  }

  async bootGuild(options: BootGuildOptions = {}): Promise<LiveClientHandle> {
    const guildId = options.guildId ?? this.scenarioGuildId(options.label);
    // Defer shared-realtime teardown: booting one stack per scenario shares ONE
    // Supabase singleton, so per-handle removeAllChannels() would storm every
    // guild's action-queue listener into a reconnect loop. Channels stay healthy
    // for the run and die with the fork worker.
    const handle = await bootstrapLiveClient({
      ...options,
      guildId,
      deferRealtimeTeardown: options.deferRealtimeTeardown ?? true,
    });
    this.handles.push(handle);
    this.guildIds.add(handle.guildId);
    return handle;
  }

  injectorFor(handle: LiveClientHandle): BoundInjector {
    const existing = this.injectors.get(handle);
    if (existing) return existing;
    const authToken = mintCapabilityToken();
    const injector = createInteractionInjector(handle.client, { authToken });
    // Bind the token to the injector so scripts never handle it directly.
    const bound: BoundInjector = {
      inject: (interaction) => injector.inject(interaction, { authToken }),
    };
    this.injectors.set(handle, bound);
    return bound;
  }

  async runSlash(handle: LiveClientHandle, params: RunSlashParams): Promise<CapturedResponse> {
    const injector = this.injectorFor(handle);
    const interaction = buildSlashInteraction({
      commandName: params.commandName,
      guildId: handle.guildId,
      client: handle.client,
      id: params.interactionId,
      user: {
        id: params.userId,
        username: params.userId,
        displayName: params.displayName ?? params.userId,
      },
      member: params.member,
      options: (params.options ?? {}) as Record<string, OptionValue>,
    });
    return injector.inject(interaction);
  }

  record(record: AssertionRecord): void {
    this.records.push(record);
  }

  pass(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    observation: string,
  ): void {
    this.record({ assertionClass, channel, status: 'PASS', promise, observation });
  }

  fail(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    observation: string,
    impact: string,
  ): void {
    this.record({ assertionClass, channel, status: 'FAIL', promise, observation, impact });
  }

  gate(
    assertionClass: AssertionClass,
    channel: ObservationChannel,
    promise: string,
    gateReason: string,
  ): void {
    this.record({
      assertionClass,
      channel,
      status: 'GATED',
      promise,
      observation: `GATED-PENDING: ${gateReason}`,
      gateReason,
    });
    // Loud, never silent: mirror the PR3 gated-block console discipline.
    // eslint-disable-next-line no-console
    console.warn(
      `[scenario-runner][GATED] ${this.domain.id}/${this.scenarioClass} ` +
        `${assertionClass} via ${channel}: ${gateReason}`,
    );
  }

  expect(
    condition: boolean,
    args: {
      assertionClass: AssertionClass;
      channel: ObservationChannel;
      promise: string;
      observation: string;
      impact: string;
    },
  ): boolean {
    if (condition) {
      this.pass(args.assertionClass, args.channel, args.promise, args.observation);
    } else {
      this.fail(args.assertionClass, args.channel, args.promise, args.observation, args.impact);
    }
    return condition;
  }

  async sweepGuildRows(handle: LiveClientHandle): Promise<void> {
    await sweepGuild(handle, [...this.guildScopedTables]);
  }

  /** Aggregate every recorded assertion into per-class evidence (all 7 classes). */
  buildEvidence(error?: string): ScenarioEvidence {
    const classes: ClassEvidence[] = ASSERTION_CLASSES.map((assertionClass) => {
      const forClass = this.records.filter((r) => r.assertionClass === assertionClass);
      if (forClass.length === 0) {
        // No proof authored for this class in this scenario → explicitly GATED so
        // the report stays honest (never an implicit blank pass).
        return {
          assertionClass,
          status: 'GATED' as const,
          records: [
            {
              assertionClass,
              channel: 'discord-readback' as const,
              status: 'GATED' as const,
              promise: 'Assertion class declared by the catalog scenario.',
              observation: 'GATED-PENDING: not exercised by this scenario script.',
              gateReason: 'not-exercised-by-script',
            },
          ],
        };
      }
      const status = forClass.some((r) => r.status === 'FAIL')
        ? ('FAIL' as const)
        : forClass.some((r) => r.status === 'PASS')
          ? ('PASS' as const)
          : ('GATED' as const);
      return { assertionClass, status, records: forClass };
    });

    return {
      scenarioClass: this.scenarioClass,
      scenarioId: this.scenario.id,
      promise: this.scenario.promise,
      classes,
      error,
    };
  }

  /**
   * Dispose every booted handle and sweep every run-prefixed row it created,
   * recording a real cleanup PASS/FAIL: after the sweep, the domain's tables are
   * re-queried for this scenario's guild(s); zero leftovers = the sweep works.
   * (The CLEANUP scenario additionally proves this inside its own script.)
   */
  async teardown(): Promise<void> {
    for (const handle of this.handles) {
      let leftovers: number | null = null;
      try {
        await sweepGuild(handle, [...this.guildScopedTables]);
        leftovers = await countGuildRows(handle, [...this.guildScopedTables]);
      } catch {
        // Best-effort — a sweep failure must not mask a recorded result.
      }
      if (leftovers !== null) {
        this.expect(leftovers === 0, {
          assertionClass: 'cleanup',
          channel: 'db-observable',
          promise:
            'Every run-prefixed resource this scenario created is removed by the cleanup pass; a final sweep finds zero leftovers.',
          observation:
            `Post-teardown sweep of ${this.scenarioClass} guild(s) left ${leftovers} run-prefixed row(s) ` +
            `across [${this.guildScopedTables.join(', ')}].`,
          impact:
            'Run-prefixed rows survived the cleanup sweep — the suite leaves residue in the disposable database.',
        });
      }
      try {
        await handle.cleanup();
      } catch {
        /* best-effort dispose */
      }
    }
  }
}

/**
 * Delete every scenario-guild-scoped row for a handle's guild across the domain's
 * tables plus guild_config, then the guild row itself. Best-effort per table so a
 * missing/renamed table never aborts the sweep. `guild` is deleted last (children
 * with ON DELETE CASCADE clean up with it).
 */
export async function sweepGuild(
  handle: LiveClientHandle,
  guildScopedTables: readonly string[],
): Promise<void> {
  const supabase = handle.supabase;
  const guildId = handle.guildId;
  const tables = [...guildScopedTables, ...ALWAYS_SWEPT_GUILD_TABLES];
  for (const table of tables) {
    try {
      await supabase.from(table).delete().eq('guild_id', guildId);
    } catch {
      /* best-effort */
    }
  }
  try {
    await supabase.from('guild').delete().eq('id', guildId);
  } catch {
    /* best-effort */
  }
}

/**
 * Count remaining rows for a handle's guild across the given tables — the
 * post-sweep verification the cleanup proof reads. Tables that error (missing,
 * permission) contribute 0 so verification stays best-effort but honest.
 */
export async function countGuildRows(
  handle: LiveClientHandle,
  guildScopedTables: readonly string[],
): Promise<number> {
  const supabase = handle.supabase;
  const guildId = handle.guildId;
  let total = 0;
  for (const table of guildScopedTables) {
    try {
      const { count } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('guild_id', guildId);
      total += count ?? 0;
    } catch {
      /* best-effort */
    }
  }
  return total;
}
