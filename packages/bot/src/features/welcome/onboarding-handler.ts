/**
 * Onboarding Handler — Detects Discord onboarding completion and grants the Member role.
 *
 * Flow (from architecture doc §16.2):
 *   1. New member joins → gets @everyone only (zero permissions, sees nothing)
 *   2. Discord shows native onboarding (rules, customization questions)
 *   3. Member completes onboarding → Discord sets COMPLETED_ONBOARDING flag
 *   4. Bot detects flag via guildMemberUpdate → grants Member role
 *   5. Member role grant triggers welcome flow
 *
 * For returning members (guildMemberAdd path):
 *   1. Returning member joins → bot detects via members table
 *   2. If previously completed onboarding → auto-grant Member role + restore roles
 *   3. Skip onboarding detection (they already proved themselves)
 */

import {
  GuildMember,
  GuildMemberFlags,
  type Guild,
  type PartialGuildMember,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAssignableRole } from '../../services/role-assignability.js';
import type { SomniClient } from '../../client.js';
import type { DbGuildConfig } from '@somnibot/shared';
import { z } from 'zod';
import {
  lookupMember,
  recordMemberJoin,
  recordMemberLeave,
  markOnboardingCompleted,
  fetchCompleteRoster,
} from './member-service.js';
import { executeWelcomeFlow } from './welcome-service.js';
import { executeGoodbyeFlow } from './goodbye-service.js';
import { writeAuditLog } from '../../services/audit.js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('Onboarding');
const MAX_FALLBACK_RETRY_DELAY_MS = 60_000;

const fallbackClaimSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('claimed'),
    intent_id: z.string().uuid(),
    attempt_token: z.string().uuid(),
    member_role_id: z.string(),
    attempt_count: z.number().int().nonnegative(),
    role_add_authorized: z.boolean(),
  }),
  z.object({
    status: z.enum([
      'wait',
      'already_completed',
      'stale_config',
      'max_attempts',
      'not_found',
      'role_not_authorized',
    ]),
    intent_id: z.string().uuid().optional(),
    attempt_token: z.string().uuid().optional(),
    member_role_id: z.string().optional(),
    attempt_count: z.number().int().nonnegative().optional(),
    role_add_authorized: z.boolean().optional(),
    retry_after_ms: z.number().int().nonnegative().optional(),
  }),
]);

const fallbackCompletionSchema = z.object({
  status: z.enum([
    'completed',
    'already_completed',
    'stale_config',
    'lost_claim',
    'not_found',
    'native_completed',
    'role_not_authorized',
  ]),
});

const fallbackFailureSchema = z.object({
  status: z.enum(['retry', 'failed', 'lost_claim']),
  retry_after_ms: z.number().int().nonnegative().optional(),
});

const pendingFallbackSchema = z.object({
  discord_id: z.string(),
  member_role_id: z.string(),
  timeout_minutes: z.number().int().min(1).max(1440),
  role_add_authorized: z.boolean(),
  next_attempt_at: z.string(),
});

const pendingFallbackListSchema = z.array(pendingFallbackSchema);

interface ScheduledFallback {
  readonly generation: symbol;
  readonly timer: NodeJS.Timeout;
}

const fallbackTimers = new Map<string, ScheduledFallback>();

function clearFallbackTimer(guildId: string, memberId: string): void {
  const key = `${guildId}:${memberId}`;
  const scheduled = fallbackTimers.get(key);
  if (scheduled) clearTimeout(scheduled.timer);
  fallbackTimers.delete(key);
}

function scheduleFallback(
  client: SomniClient,
  member: GuildMember,
  config: DbGuildConfig,
  delayMs = Math.max(1, config.fallback_timeout_minutes ?? 10) * 60_000,
  replacementConfig?: DbGuildConfig,
  resumingDurableIntent = false,
): void {
  if (config.fallback_mode !== 'grant-after-timeout' || !config.member_role_id) return;
  const key = `${member.guild.id}:${member.id}`;
  if (fallbackTimers.has(key)) return;
  const generation = Symbol(key);
  const timer = setTimeout(async () => {
    try {
      const current = await member.guild.members.fetch(member.id);
      const retryAfterMs = await runFallbackAttempt(
        client,
        current,
        config,
        key,
        generation,
        resumingDurableIntent,
      );
      const scheduled = fallbackTimers.get(key);
      if (scheduled?.generation === generation) fallbackTimers.delete(key);
      if (retryAfterMs !== null) {
        scheduleFallback(
          client,
          current,
          config,
          Math.min(retryAfterMs, MAX_FALLBACK_RETRY_DELAY_MS),
          replacementConfig,
          true,
        );
      } else if (replacementConfig) {
        scheduleFallback(client, current, replacementConfig);
      }
    } catch (err) {
      log.error('Onboarding fallback failed:', { error: String(err) });
      const scheduled = fallbackTimers.get(key);
      if (scheduled?.generation === generation) fallbackTimers.delete(key);
    }
  }, delayMs);
  timer.unref?.();
  fallbackTimers.set(key, { generation, timer });
}

async function runFallbackAttempt(
  client: SomniClient,
  member: GuildMember,
  config: DbGuildConfig,
  timerKey: string,
  generation: symbol,
  resumingDurableIntent: boolean,
): Promise<number | null> {
  const configuredRoleId = config.member_role_id;
  if (!configuredRoleId) return null;
  if (member.flags.has(GuildMemberFlags.CompletedOnboarding)) {
    await recoverNativeCompletedMember(client, member, config);
    return null;
  }
  if (member.pending !== true) {
    if (resumingDurableIntent) {
      await terminateFallbackIntent(client, member.guild.id, member.id, 'member_no_longer_pending');
    }
    return null;
  }

  const roleWasPresent = member.roles.cache.has(configuredRoleId);
  if (roleWasPresent && !resumingDurableIntent) return null;

  const { data, error } = await client.supabase.rpc('claim_onboarding_fallback_intent', {
    p_guild_id: member.guild.id,
    p_discord_id: member.id,
    p_member_role_id: configuredRoleId,
    p_timeout_minutes: config.fallback_timeout_minutes ?? 10,
    p_correlation_id: `onboarding:${member.guild.id}:${member.id}`,
    p_role_add_authorized: !roleWasPresent,
  });
  if (error) throw new Error(`Could not persist onboarding fallback intent: ${error.message}`);
  const claim = fallbackClaimSchema.parse(data);
  if (claim.status === 'wait') return claim.retry_after_ms ?? MAX_FALLBACK_RETRY_DELAY_MS;
  if (claim.status === 'stale_config') {
    await cancelStaleFallback(client, member, claim);
    return null;
  }
  if (claim.status !== 'claimed') return null;
  if (!claim.intent_id || !claim.attempt_token || !claim.member_role_id) {
    throw new Error('Onboarding fallback claim omitted durable identity');
  }

  if (fallbackTimers.get(timerKey)?.generation !== generation) {
    return failFallbackAttempt(
      client,
      claim.intent_id,
      claim.attempt_token,
      'Fallback attempt superseded by current guild configuration',
    );
  }

  if (roleWasPresent && claim.role_add_authorized !== true) {
    await cancelFallbackIntent(client, claim.intent_id, claim.attempt_token);
    return null;
  }
  if (!roleWasPresent) {
    try {
      requireAssignableRole(member.guild, claim.member_role_id);
      await member.roles.add(claim.member_role_id, 'Onboarding fallback timeout');
    } catch (err) {
      return failFallbackAttempt(client, claim.intent_id, claim.attempt_token, String(err));
    }
  }

  if (fallbackTimers.get(timerKey)?.generation !== generation) {
    if (!roleWasPresent) {
      requireAssignableRole(member.guild, claim.member_role_id);
      await member.roles.remove(claim.member_role_id, 'Onboarding fallback configuration changed');
    }
    await cancelFallbackIntent(client, claim.intent_id, claim.attempt_token);
    return null;
  }

  const completionResult = await client.supabase.rpc('complete_onboarding_fallback_intent', {
    p_intent_id: claim.intent_id,
    p_attempt_token: claim.attempt_token,
  });
  if (completionResult.error) {
    throw new Error(`Could not complete onboarding fallback intent: ${completionResult.error.message}`);
  }
  const completion = fallbackCompletionSchema.parse(completionResult.data);
  if (completion.status === 'completed') {
    await executeWelcomeFlow(member, { supabase: client.supabase, config });
    return null;
  }

  if (completion.status === 'already_completed') return null;
  if (completion.status === 'native_completed') return null;
  if (completion.status === 'role_not_authorized') {
    await cancelFallbackIntent(client, claim.intent_id, claim.attempt_token);
    return null;
  }

  if (completion.status === 'stale_config') {
    if (member.roles.cache.has(claim.member_role_id)) {
      requireAssignableRole(member.guild, claim.member_role_id);
      await member.roles.remove(claim.member_role_id, 'Onboarding fallback completion rejected');
    }
    await cancelFallbackIntent(client, claim.intent_id, claim.attempt_token);
    return null;
  }
  if (completion.status === 'not_found' && !roleWasPresent) {
    requireAssignableRole(member.guild, claim.member_role_id);
    await member.roles.remove(claim.member_role_id, 'Onboarding fallback completion rejected');
  }
  return null;
}

async function failFallbackAttempt(
  client: SomniClient,
  intentId: string,
  attemptToken: string,
  errorMessage: string,
): Promise<number | null> {
  const result = await client.supabase.rpc('fail_onboarding_fallback_attempt', {
    p_intent_id: intentId,
    p_attempt_token: attemptToken,
    p_error: errorMessage,
  });
  if (result.error) throw new Error(`Could not record onboarding fallback failure: ${result.error.message}`);
  const failure = fallbackFailureSchema.parse(result.data);
  return failure.status === 'retry' ? failure.retry_after_ms ?? MAX_FALLBACK_RETRY_DELAY_MS : null;
}

async function cancelStaleFallback(
  client: SomniClient,
  member: GuildMember,
  claim: z.infer<typeof fallbackClaimSchema>,
): Promise<void> {
  if (!claim.intent_id || !claim.attempt_token || !claim.member_role_id) return;
  if (member.roles.cache.has(claim.member_role_id)) {
    requireAssignableRole(member.guild, claim.member_role_id);
    await member.roles.remove(claim.member_role_id, 'Onboarding fallback configuration changed');
  }
  await cancelFallbackIntent(client, claim.intent_id, claim.attempt_token);
}

async function cancelFallbackIntent(
  client: SomniClient,
  intentId: string,
  attemptToken: string,
): Promise<void> {
  const result = await client.supabase.rpc('cancel_onboarding_fallback_intent', {
    p_intent_id: intentId,
    p_attempt_token: attemptToken,
  });
  if (result.error) throw new Error(`Could not cancel stale onboarding fallback: ${result.error.message}`);
}

async function terminateFallbackIntent(
  client: SomniClient,
  guildId: string,
  memberId: string,
  reason: string,
): Promise<void> {
  const result = await client.supabase.rpc('terminate_onboarding_fallback_intent', {
    p_guild_id: guildId,
    p_discord_id: memberId,
    p_reason: reason,
  });
  if (result.error) throw new Error(`Could not terminate onboarding fallback: ${result.error.message}`);
}

async function recoverNativeCompletedMember(
  client: SomniClient,
  member: GuildMember,
  config: DbGuildConfig,
): Promise<void> {
  clearFallbackTimer(member.guild.id, member.id);
  await terminateFallbackIntent(
    client,
    member.guild.id,
    member.id,
    'native_onboarding_completed',
  );
  await markOnboardingCompleted(client.supabase, member.guild.id, member.id);
  if (config.member_role_id && !member.roles.cache.has(config.member_role_id)) {
    requireAssignableRole(member.guild, config.member_role_id);
    await member.roles.add(config.member_role_id, 'Recovering completed Discord onboarding');
  }
}

export async function reconcilePendingOnboardingMembers(
  client: SomniClient,
  guild: Guild,
  loadedConfig?: DbGuildConfig,
): Promise<number> {
  const timerPrefix = `${guild.id}:`;
  for (const [key, scheduled] of fallbackTimers) {
    if (!key.startsWith(timerPrefix)) continue;
    clearTimeout(scheduled.timer);
    fallbackTimers.delete(key);
  }

  const config = loadedConfig ?? await getGuildConfig(client, guild.id);
  if (!config) return 0;

  const members = await fetchCompleteRoster(guild);
  if (!members) return 0;

  const pendingResult = await client.supabase.rpc('list_onboarding_fallback_intents', {
    p_guild_id: guild.id,
  });
  if (pendingResult.error) {
    log.error('Could not load durable onboarding fallback intents:', {
      error: pendingResult.error.message,
    });
    return 0;
  }
  const pendingIntents = pendingFallbackListSchema.parse(pendingResult.data ?? []);
  const durableMemberIds = new Set<string>();
  let scheduled = 0;
  for (const intent of pendingIntents) {
    const member = members.get(intent.discord_id);
    if (!member || member.user.bot) {
      await terminateFallbackIntent(
        client,
        guild.id,
        intent.discord_id,
        member ? 'ineligible_bot_member' : 'member_not_in_guild',
      );
      continue;
    }
    durableMemberIds.add(member.id);
    if (member.flags.has(GuildMemberFlags.CompletedOnboarding)) {
      try {
        await recoverNativeCompletedMember(client, member, config);
      } catch (err) {
        log.error('Completed onboarding recovery failed:', { error: String(err) });
      }
      continue;
    }
    const nextAttemptAt = Date.parse(intent.next_attempt_at);
    const retryDelay = Number.isFinite(nextAttemptAt) ? Math.max(0, nextAttemptAt - Date.now()) : 0;
    const replacementConfig = config.onboarding_enabled
      && config.fallback_mode === 'grant-after-timeout'
      && config.member_role_id
      && (
        config.member_role_id !== intent.member_role_id
        || config.fallback_timeout_minutes !== intent.timeout_minutes
      )
      ? config
      : undefined;
    scheduleFallback(client, member, {
      ...config,
      onboarding_enabled: true,
      fallback_mode: 'grant-after-timeout',
      member_role_id: intent.member_role_id,
      fallback_timeout_minutes: intent.timeout_minutes,
    }, retryDelay, replacementConfig, true);
    scheduled++;
  }

  if (
    !config.onboarding_enabled
    || config.fallback_mode !== 'grant-after-timeout'
    || !config.member_role_id
  ) return scheduled;

  for (const member of members.values()) {
    if (
      member.user.bot
      || durableMemberIds.has(member.id)
      || member.roles.cache.has(config.member_role_id)
    ) continue;

    if (member.flags.has(GuildMemberFlags.CompletedOnboarding)) {
      try {
        await recoverNativeCompletedMember(client, member, config);
        log.info('Recovered completed onboarding member role', {
          guildId: guild.id,
          memberId: member.id,
        });
      } catch (err) {
        log.error('Completed onboarding recovery failed:', { error: String(err) });
      }
      continue;
    }

    if (member.pending !== true) continue;

    const key = `${guild.id}:${member.id}`;
    if (fallbackTimers.has(key)) continue;
    scheduleFallback(client, member, config);
    scheduled++;
  }

  if (scheduled > 0) {
    log.info('Reconciled pending onboarding fallback timers', {
      guildId: guild.id,
      scheduled,
    });
  }
  return scheduled;
}

/**
 * Get the guild config, cached in Valkey for 60s.
 */
async function getGuildConfig(
  client: SomniClient,
  guildId: string,
): Promise<DbGuildConfig | null> {
  const cacheKey = `guild_config:${guildId}`;

  // Try Valkey cache first
  try {
    const cached = await client.valkey.get(cacheKey);
    if (cached) return JSON.parse(cached) as DbGuildConfig;
  } catch {
    // Cache miss or error — fall through to DB
  }

  const { data, error } = await client.supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error || !data) {
    log.error('Could not load guild config:', error?.message);
    return null;
  }

  // Cache for 60 seconds
  try {
    await client.valkey.set(cacheKey, JSON.stringify(data), 'EX', 60);
  } catch {
    // Non-critical cache write failure
  }

  return data as DbGuildConfig;
}

/**
 * Handle guildMemberAdd — detect returning members, record join.
 */
export async function handleMemberJoin(
  client: SomniClient,
  member: GuildMember,
): Promise<void> {
  log.info(`Member joined: ${member.user.tag}`);

  const config = await getGuildConfig(client, member.guild.id);
  if (!config) return;

  // Check if this is a returning member
  const lookup = await lookupMember(client.supabase, member.guild.id, member.id);

  // Record the join
  await recordMemberJoin(client.supabase, member, lookup.isReturning);

  // Emit platform event
  client.eventBus.emit('member.joined', member.guild.id, {
    discordId: member.id,
    username: member.user.tag,
    isReturning: lookup.isReturning,
  });

  if (lookup.isReturning) {
    log.info(`Returning member detected: ${member.user.tag}`);

    // V53 B-4: Unsuspend economy wallet for returning members
    try {
      await client.supabase.rpc('unsuspend_member_economy', {
        p_guild_id: member.guild.id,
        p_user_id: member.id,
      });
    } catch (err) {
      log.warn('Failed to unsuspend economy:', (err as Error)?.message ?? err);
    }

    // Returning members skip onboarding — they already completed it
    // Grant Member role immediately
    if (config.member_role_id) {
      try {
        requireAssignableRole(member.guild, config.member_role_id);
        await member.roles.add(config.member_role_id, 'Returning member — auto-granted');
        log.info(`Member role granted to returning member ${member.user.tag}`);
      } catch (err) {
        log.error(`Failed to grant Member role:`, err);
      }
    }

    // Restore previous roles if configured
    if (config.returning_member_restore_entitlements && lookup.previousRoles.length > 0) {
      await restorePreviousRoles(member, lookup.previousRoles);
    }

    // Restore level roles if configured
    if (config.returning_member_restore_levels) {
      await restoreLevelRoles(client.supabase, member);
    }

    // Mark onboarding as completed (they did it before)
    await markOnboardingCompleted(client.supabase, member.guild.id, member.id);

    // Execute welcome flow (unless configured to skip for returning)
    if (!config.returning_member_skip_welcome_dm) {
      await executeWelcomeFlow(member, { supabase: client.supabase, config });
    } else {
      // Still send channel welcome, just skip DM
      const configNoDm: DbGuildConfig = { ...config, welcome_dm_enabled: false };
      await executeWelcomeFlow(member, { supabase: client.supabase, config: configNoDm });
    }

    await writeAuditLog(client.supabase, {
      guildId: member.guild.id,
      actorType: 'bot',
      actorId: 'onboarding',
      action: 'member.returning_welcome',
      category: 'members',
      targetType: 'member',
      targetId: member.id,
      details: {
        username: member.user.tag,
        rolesRestored: lookup.previousRoles.length,
      },
    });
  }
  // For non-returning members, we wait for onboarding completion
  // (handled in handleMemberUpdate below)
  if (!lookup.isReturning) scheduleFallback(client, member, config);
}

/**
 * Handle guildMemberUpdate — detect onboarding completion.
 */
export async function handleMemberUpdate(
  client: SomniClient,
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  // ── Detect onboarding completion ──────────────────────────
  const wasOnboarding =
    !oldMember.flags?.has(GuildMemberFlags.CompletedOnboarding);
  const isCompleted =
    newMember.flags?.has(GuildMemberFlags.CompletedOnboarding) === true;

  if (wasOnboarding && isCompleted) {
    clearFallbackTimer(newMember.guild.id, newMember.id);
    await terminateFallbackIntent(
      client,
      newMember.guild.id,
      newMember.id,
      'native_onboarding_completed',
    );
    log.info(`${newMember.user.tag} completed onboarding`);

    const config = await getGuildConfig(client, newMember.guild.id);
    if (!config) return;

    // Mark in database
    await markOnboardingCompleted(client.supabase, newMember.guild.id, newMember.id);

    // Grant Member role
    if (config.member_role_id) {
      try {
        requireAssignableRole(newMember.guild, config.member_role_id);
        await newMember.roles.add(
          config.member_role_id,
          'Completed Discord onboarding',
        );
        log.info(`Member role granted to ${newMember.user.tag}`);

        // Fire verified event
        client.eventBus.emit('member.verified', newMember.guild.id, {
          discordId: newMember.id,
          username: newMember.user.tag,
          memberNumber: newMember.guild.memberCount,
        });

        // Execute the welcome flow
        await executeWelcomeFlow(newMember, {
          supabase: client.supabase,
          config,
        });

        // Audit log
        await writeAuditLog(client.supabase, {
          guildId: newMember.guild.id,
          actorType: 'bot',
          actorId: 'onboarding',
          action: 'member.onboarding_completed',
          category: 'members',
          targetType: 'member',
          targetId: newMember.id,
          details: { username: newMember.user.tag },
        });
      } catch (err) {
        log.error('Failed to grant Member role:', { error: String(err) });
      }
    }

    // Discord applies interest roles natively from the onboarding prompt
    // payload synced by GuildOnboardingSync. Confirm what arrived on the
    // completed member instead of trying to infer selections that Discord does
    // not expose and issuing duplicate role grants.
    if (config.interest_role_mapping && Object.keys(config.interest_role_mapping).length > 0) {
      logAppliedInterestRoles(newMember, config.interest_role_mapping);
    }
  }

  // ── Detect role changes (existing from Phase 1) ───────────
  const addedRoles = newMember.roles.cache.filter(
    (r) => !oldMember.roles.cache.has(r.id),
  );
  const removedRoles = oldMember.roles.cache.filter(
    (r) => !newMember.roles.cache.has(r.id),
  );

  for (const [, role] of addedRoles) {
    client.eventBus.emit('role.gained', newMember.guild.id, {
      discordId: newMember.id,
      roleId: role.id,
      roleName: role.name,
      source: 'discord',
    });
  }

  for (const [, role] of removedRoles) {
    client.eventBus.emit('role.lost', newMember.guild.id, {
      discordId: newMember.id,
      roleId: role.id,
      roleName: role.name,
      source: 'discord',
    });
  }
}

/**
 * Handle guildMemberRemove — record leave, send goodbye.
 */
export async function handleMemberLeave(
  client: SomniClient,
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  log.info(`Member left: ${member.user?.tag ?? member.id}`);
  clearFallbackTimer(member.guild.id, member.id);
  await terminateFallbackIntent(client, member.guild.id, member.id, 'member_left');

  // Record leave (preserves roles for returning member detection)
  if (member.partial) {
    // Partial member — limited data available
    log.warn('Partial member leave — limited data stored');
  } else {
    await recordMemberLeave(client.supabase, member as GuildMember);
  }

  // Emit event
  client.eventBus.emit('member.left', member.guild.id, {
    discordId: member.id,
    username: member.user?.tag ?? 'Unknown',
    roles: member.roles?.cache.map((r) => r.id) ?? [],
  });

  // Send goodbye message
  const config = await getGuildConfig(client, member.guild.id);
  if (config) {
    await executeGoodbyeFlow(member, config);
  }

  await writeAuditLog(client.supabase, {
    guildId: member.guild.id,
    actorType: 'bot',
    actorId: 'onboarding',
    action: 'member.left',
    category: 'members',
    targetType: 'member',
    targetId: member.id,
    details: { username: member.user?.tag ?? 'Unknown' },
  });
}

/**
 * Restore a returning member's previous roles.
 */
async function restorePreviousRoles(
  member: GuildMember,
  previousRoleIds: string[],
): Promise<void> {
  let restored = 0;
  for (const roleId of previousRoleIds) {
    try {
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue; // Role was deleted while member was away
      if (role.managed) continue; // Don't restore managed roles
      if (member.roles.cache.has(roleId)) continue; // Already has it

      // Don't restore roles above the bot's highest role
      const botHighest = member.guild.members.me?.roles.highest;
      if (botHighest && role.position >= botHighest.position) continue;

      await member.roles.add(role, 'Returning member — restoring previous role');
      restored++;
    } catch (err) {
      log.warn(`Could not restore role ${roleId}:`, err);
    }
  }
  if (restored > 0) {
    log.info(`Restored ${restored} role(s) for ${member.user.tag}`);
  }
}

/**
 * Restore level reward roles for a returning member.
 */
async function restoreLevelRoles(
  supabase: SupabaseClient,
  member: GuildMember,
): Promise<void> {
  try {
    // Get member's level
    const { data: levelData } = await supabase
      .from('member_levels')
      .select('level')
      .eq('guild_id', member.guild.id)
      .eq('member_id', member.id)
      .maybeSingle();

    if (!levelData?.level) return;

    // Get applicable level rewards
    const { data: rewards } = await supabase
      .from('level_rewards')
      .select('role_id, level, remove_at_level')
      .eq('guild_id', member.guild.id)
      .lte('level', levelData.level)
      .order('level', { ascending: true })
      .limit(1000);

    if (!rewards?.length) return;

    let restored = 0;
    for (const reward of rewards) {
      // Check if remove_at_level applies
      if (reward.remove_at_level && levelData.level >= reward.remove_at_level) continue;

      const role = member.guild.roles.cache.get(reward.role_id);
      if (!role || member.roles.cache.has(role.id)) continue;

      try {
        await member.roles.add(role, `Returning member — level ${reward.level} reward`);
        restored++;
      } catch {
        // Skip if can't add
      }
    }

    if (restored > 0) {
      log.info(`Restored ${restored} level reward role(s) for ${member.user.tag}`);
    }
  } catch (err) {
    log.error('Error restoring level roles:', { error: String(err) });
  }
}

/**
 * Record the mapped roles Discord's native onboarding already granted.
 * The mapping keys are onboarding option titles and values are role IDs.
 */
function logAppliedInterestRoles(
  member: GuildMember,
  mapping: Record<string, string>,
): void {
  const applied = Object.values(mapping).filter((roleId) => member.roles.cache.has(roleId));
  log.info(`Discord onboarding applied ${applied.length} mapped interest role(s)`, {
    memberId: member.id,
    configured: Object.keys(mapping).length,
    appliedRoleIds: applied,
  });
}

/**
 * Invalidate the cached guild config (call after dashboard updates).
 */
export async function invalidateGuildConfigCache(
  client: SomniClient,
  guildId: string,
): Promise<void> {
  try {
    await client.valkey.del(`guild_config:${guildId}`);
  } catch {
    // Non-critical
  }
}
