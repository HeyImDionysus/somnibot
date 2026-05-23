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
  type PartialGuildMember,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SomniClient } from '../../client.js';
import type { DbGuildConfig } from '@somnibot/shared';
import {
  lookupMember,
  recordMemberJoin,
  recordMemberLeave,
  markOnboardingCompleted,
} from './member-service.js';
import { executeWelcomeFlow } from './welcome-service.js';
import { executeGoodbyeFlow } from './goodbye-service.js';
import { writeAuditLog } from '../../services/audit.js';

const log = createLogger('Onboarding');

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
    log.info(`${newMember.user.tag} completed onboarding`);

    const config = await getGuildConfig(client, newMember.guild.id);
    if (!config) return;

    // Mark in database
    await markOnboardingCompleted(client.supabase, newMember.guild.id, newMember.id);

    // Grant Member role
    if (config.member_role_id) {
      try {
        await newMember.roles.add(
          config.member_role_id,
          'Completed Discord onboarding',
        );
        log.info(`Member role granted to ${newMember.user.tag}`);

        // Fire verified event
        client.eventBus.emit('member.verified', newMember.guild.id, {
          discordId: newMember.id,
          username: newMember.user.tag,
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
          targetType: 'member',
          targetId: newMember.id,
          details: { username: newMember.user.tag },
        });
      } catch (err) {
        log.error('Failed to grant Member role:', err);
      }
    }

    // Apply interest role mapping (from onboarding customization)
    if (config.interest_role_mapping && Object.keys(config.interest_role_mapping).length > 0) {
      await applyInterestRoles(newMember, config.interest_role_mapping);
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
      .order('level', { ascending: true });

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
    log.error('Error restoring level roles:', err);
  }
}

/**
 * Apply interest roles based on onboarding customization selections.
 * The interest_role_mapping maps Discord onboarding option IDs to role IDs.
 */
async function applyInterestRoles(
  member: GuildMember,
  mapping: Record<string, string>,
): Promise<void> {
  // Discord doesn't expose which onboarding options a member selected via the API
  // in a straightforward way. The member's roles after onboarding may include
  // interest roles that Discord auto-granted based on onboarding prompts.
  //
  // For now, this is a placeholder — Discord's onboarding can auto-grant roles
  // natively. The mapping is used to document the relationship for the dashboard.
  //
  // If Discord exposes selection data in a future API update, we'll populate this.
  log.info(`Interest role mapping available (${Object.keys(mapping).length} entries)`);
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
