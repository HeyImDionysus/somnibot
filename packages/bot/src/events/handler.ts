/**
 * Event Handler — Orchestrator for all Discord gateway events.
 *
 * V5 Audit §6.P3a — Refactored from a 1210-line monolith into a thin
 * orchestrator that delegates to per-event-type handler modules:
 *   - interaction-handler.ts  — interactionCreate (buttons, commands, menus)
 *   - command-registry.ts     — data-driven slash command dispatch
 *
 * Member, message, reaction, voice, and channel events are wired directly
 * here since each is short (~20-50 lines) and doesn't benefit from extraction.
 */

import { Events } from 'discord.js';
import { createLogger } from '@somnibot/shared';
import type { SomniClient } from '../client.js';
import type { EscalationStep } from '@somnibot/shared';

// Event handler modules
import { handleInteraction } from './interaction-handler.js';
import { registerCommand } from './command-registry.js';

// Feature imports — member events
import { handleMemberJoin, handleMemberUpdate, handleMemberLeave } from '../features/welcome/index.js';
import { processAntiRaid } from '../features/anti-raid/index.js';

// Feature imports — message events
import { processMessage, expireInfractions } from '../features/moderation/index.js';
import { processMessageXp, handleLevelUp } from '../features/levels/index.js';
import { logMessageEdit, logMessageDelete } from '../features/message-log/index.js';
import type { EconomyManager } from '../features/economy/economy-manager.js';
import type { QuestsManager } from '../features/quests/quests-manager.js';
import {
  findLiveTemporaryRoleOwner,
  inspectTemporaryRoleGrant,
} from '../services/temp-role-ownership.js';

// Feature imports — reaction events
import { handleReactionAdd, handleReactionRemove } from '../features/reaction-roles/index.js';
import { handleStarboardReaction } from '../features/starboard/index.js';

// Feature imports — voice events
import { onVoiceStateUpdate } from '../features/levels/voice-xp.js';
import { handleVoiceStateForTempChannels } from '../features/temp-channels/index.js';
import type { MusicPlayerManager } from '../features/music/music-player.js';
import type { TempChannelManager } from '../features/temp-channels/temp-channel-manager.js';

// Feature imports — sync events
import { handleRoleCreate, handleRoleUpdate, handleRoleDelete } from '../sync/role-events.js';
import { handleChannelCreate, handleChannelUpdate, handleChannelDelete } from '../sync/channel-events.js';

// Feature imports — tickets (for cron)
import { checkInactiveTickets } from '../features/tickets/index.js';

// Feature imports — command registrations
import { handleWarnCommand, handleMuteCommand, handleKickCommand, handleBanCommand, handlePardonCommand, handleInfractionsCommand } from '../features/moderation/commands.js';
import { handlePurgeCommand } from '../features/moderation/purge-command.js';
import { handleXpAdminCommand } from '../features/levels/admin-commands.js';
import { handleHelpCommand } from '../features/help/index.js';
import { handleForgetMeCommand } from '../features/privacy/forgetme-command.js';
import { handlePrivacyCommand } from '../features/privacy/privacy-command.js';
import { handleMyDataCommand } from '../features/account/mydata-command.js';
import { handleTutorialCommand } from '../features/tutorial/tutorial-command.js';
import { handleSetupCommand } from '../features/setup-wizard/index.js';
import { handleTicketCommand } from '../features/tickets/index.js';

const log = createLogger('Events');
const processCronCleanups = new Set<() => void>();
let processSafetyNetsRegistered = false;
let processCronCleanupRegistered = false;

// ── Command Registry Registrations ──────────────────────────────────
// Moderation
registerCommand('warn', handleWarnCommand);
registerCommand('mute', handleMuteCommand);
registerCommand('kick', handleKickCommand);
registerCommand('ban', handleBanCommand);
registerCommand('pardon', handlePardonCommand);
registerCommand('infractions', handleInfractionsCommand);
registerCommand('purge', (i) => handlePurgeCommand(i));
registerCommand('xp', handleXpAdminCommand);

// Utility
registerCommand('help', handleHelpCommand);
registerCommand('forgetme', (i, c) => handleForgetMeCommand(i, c.supabase, i.guildId!));
registerCommand('privacy', (i) => handlePrivacyCommand(i));
registerCommand('mydata', (i) => handleMyDataCommand(i));
registerCommand('tutorial', (i) => handleTutorialCommand(i));
registerCommand('setup', handleSetupCommand);
registerCommand('ticket', handleTicketCommand);

function registerProcessSafetyNets(): void {
  if (processSafetyNetsRegistered) return;
  processSafetyNetsRegistered = true;

  process.on('unhandledRejection', (error) => {
    log.error('Unhandled promise rejection', { error: String(error) });
  });

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception — process is now unstable, exiting', { error: String(error) });
    setTimeout(() => process.exit(1), 1_000);
  });
}

function registerProcessCronCleanup(cleanup: () => void): void {
  processCronCleanups.add(cleanup);
  if (processCronCleanupRegistered) return;
  processCronCleanupRegistered = true;

  const cleanupAllCrons = () => {
    for (const registeredCleanup of processCronCleanups) {
      registeredCleanup();
    }
    processCronCleanups.clear();
  };

  process.once('SIGTERM', cleanupAllCrons);
  process.once('SIGINT', cleanupAllCrons);
}

function trackCronHandle(cronHandles: NodeJS.Timeout[], handle: NodeJS.Timeout): void {
  handle.unref?.();
  cronHandles.push(handle);
}

const COMMERCE_TEMP_ROLE_SOURCES = new Set(['commerce_purchase', 'economy_purchase', 'purchase']);
const LIVE_ENTITLEMENT_STATUSES = ['active', 'pending', 'grace_period', 'suspended'];
const TEMP_ROLE_GRANT_SWEEP_PAGE_SIZE = 200;

type ExpiredTempRoleGrant = {
  id: string;
  guild_id: string;
  user_id: string;
  role_id: string;
  expires_at: string;
  source: string | null;
  order_id: string | null;
  grant_status: 'pending' | 'applied';
  remove_on_expiry: boolean;
};

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isExpiredTempRoleGrant(value: unknown): value is ExpiredTempRoleGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<ExpiredTempRoleGrant>;
  return (
    isNonBlankString(grant.id)
    && isNonBlankString(grant.guild_id)
    && isNonBlankString(grant.user_id)
    && isNonBlankString(grant.role_id)
    && isNonBlankString(grant.expires_at)
    && Number.isFinite(Date.parse(grant.expires_at))
    && (grant.source === null || isNonBlankString(grant.source))
    && (grant.order_id === null || isNonBlankString(grant.order_id))
    && (grant.grant_status === 'pending' || grant.grant_status === 'applied')
    && typeof grant.remove_on_expiry === 'boolean'
  );
}

async function deleteTempRoleGrant(
  client: Pick<SomniClient, 'supabase'>,
  grant: ExpiredTempRoleGrant,
): Promise<'retired' | 'live' | 'failed'> {
  try {
    if (grant.source === 'commerce_purchase' && grant.order_id !== null) {
      const { data: retired, error } = await client.supabase.rpc(
        'commerce_retire_temp_role_grant',
        {
          p_grant_id: grant.id,
          p_expected_grant_status: grant.grant_status,
          p_expected_expires_at: grant.expires_at,
          p_expected_remove_on_expiry: grant.remove_on_expiry,
        },
      );
      if (error) {
        log.error('Temp role grant tombstone update failed', {
          grantId: grant.id,
          error: error.message,
        });
        return 'failed';
      }
      if (
        !retired
        || typeof retired !== 'object'
        || retired.id !== grant.id
        || typeof retired.retired !== 'boolean'
      ) {
        log.warn('Temp role grant changed before tombstone update; stale sweep preserved it', {
          grantId: grant.id,
        });
        return 'failed';
      }
      if (!retired.retired) return 'live';
      if (retired.grant_status !== 'removed' || retired.source !== 'commerce_reconciled') {
        log.error('Temp role grant retirement returned a malformed tombstone', {
          grantId: grant.id,
        });
        return 'failed';
      }
      return 'retired';
    }

    let query = client.supabase
      .from('temp_role_grants')
      .delete()
      .eq('id', grant.id)
      .eq('guild_id', grant.guild_id)
      .eq('user_id', grant.user_id)
      .eq('role_id', grant.role_id)
      .eq('expires_at', grant.expires_at)
      .eq('grant_status', grant.grant_status)
      .eq('remove_on_expiry', grant.remove_on_expiry);

    query = grant.source === null
      ? query.is('source', null)
      : query.eq('source', grant.source);
    query = grant.order_id === null
      ? query.is('order_id', null)
      : query.eq('order_id', grant.order_id);

    const { data: deleted, error } = await query
      .select('id')
      .maybeSingle();
    if (error) {
      log.error('Temp role grant provenance deletion failed', {
        grantId: grant.id,
        error: error.message,
      });
      return 'failed';
    }
    if (deleted?.id !== grant.id) {
      log.warn('Temp role grant changed before provenance deletion; stale sweep preserved it', {
        grantId: grant.id,
      });
      return 'failed';
    }
    return 'retired';
  } catch (err) {
    log.error('Temp role grant provenance deletion failed', {
      grantId: grant.id,
      error: String(err),
    });
    return 'failed';
  }
}

async function hasOtherLiveRoleOwner(
  client: Pick<SomniClient, 'supabase'>,
  grant: ExpiredTempRoleGrant,
  excludeCurrentGrant = true,
): Promise<boolean> {
  const successor = await findLiveTemporaryRoleOwner(client.supabase, {
    guildId: grant.guild_id,
    userId: grant.user_id,
    roleId: grant.role_id,
    excludeGrantId: excludeCurrentGrant ? grant.id : null,
    excludeOrderId: null,
  });
  if (successor) {

    // If this expiring provenance owned removal, hand that responsibility to
    // the deterministic live successor before deleting the current row. This
    // closes the window where B is purchased after A expired but before A's
    // sweep: B sees the role already present, while A must teach B that the
    // shared role still needs final cleanup.
    if (successor.id !== grant.id && grant.remove_on_expiry && !successor.remove_on_expiry) {
      const { data: transferred, error: transferError } = await client.supabase
        .from('temp_role_grants')
        .update({ remove_on_expiry: true, updated_at: new Date().toISOString() })
        .eq('id', successor.id)
        .eq('guild_id', grant.guild_id)
        .eq('user_id', grant.user_id)
        .eq('role_id', grant.role_id)
        .in('grant_status', ['pending', 'applied'])
        .select('id, remove_on_expiry')
        .maybeSingle();
      if (
        transferError
        || transferred?.id !== successor.id
        || transferred.remove_on_expiry !== true
      ) {
        throw new Error(
          `overlapping grant removal-intent transfer failed: ${transferError?.message ?? 'unacknowledged update'}`,
        );
      }
    }
    const confirmedSuccessor = await findLiveTemporaryRoleOwner(client.supabase, {
      guildId: grant.guild_id,
      userId: grant.user_id,
      roleId: grant.role_id,
      excludeGrantId: excludeCurrentGrant ? grant.id : null,
    });
    if (confirmedSuccessor) return true;
  }

  const { data: customer, error: customerError } = await client.supabase
    .from('customers')
    .select('id')
    .eq('guild_id', grant.guild_id)
    .eq('discord_id', grant.user_id)
    .maybeSingle();
  if (customerError) {
    throw new Error(`customer lookup failed: ${customerError.message}`);
  }
  if (!customer) {
    if (COMMERCE_TEMP_ROLE_SOURCES.has(grant.source ?? '')) {
      throw new Error('customer lookup returned a missing commerce identity');
    }
    return false;
  }
  if (!isNonBlankString(customer.id)) {
    throw new Error('customer lookup returned a malformed or missing identity');
  }

  let entitlementQuery = client.supabase
    .from('entitlements')
    .select('id, order_id')
    .eq('guild_id', grant.guild_id)
    .eq('customer_id', customer.id)
    .in('status', LIVE_ENTITLEMENT_STATUSES)
    .contains('granted_role_ids', [grant.role_id]);
  const { data: entitlements, error: entitlementError } = await entitlementQuery
    .limit(1);
  if (entitlementError) {
    throw new Error(`entitlement lookup failed: ${entitlementError.message}`);
  }
  if (!Array.isArray(entitlements) || entitlements.length > 1) {
    throw new Error('entitlement lookup returned a malformed result');
  }
  if (entitlements.length === 0) return false;
  const entitlement = entitlements[0];
  if (
    !entitlement
    || !isNonBlankString(entitlement.id)
  ) {
    throw new Error('entitlement lookup returned a mismatched owner');
  }
  return true;
}

async function removeDiscordRoleAndConfirm(
  client: Pick<SomniClient, 'guilds'>,
  grant: ExpiredTempRoleGrant,
): Promise<void> {
  const guild = client.guilds.cache.get(grant.guild_id);
  if (!guild) throw new Error('guild is unavailable');

  let member = await guild.members.fetch({ user: grant.user_id, force: true });
  if (!member.roles.cache.has(grant.role_id)) return;

  await member.roles.remove(grant.role_id, 'SomniBot — temporary role expired');
  member = await guild.members.fetch({ user: grant.user_id, force: true });
  if (member.roles.cache.has(grant.role_id)) {
    throw new Error('Discord still reports the expired role after removal');
  }
}

async function ensureDiscordRoleAndConfirm(
  client: Pick<SomniClient, 'guilds'>,
  grant: ExpiredTempRoleGrant,
): Promise<void> {
  const guild = client.guilds.cache.get(grant.guild_id);
  if (!guild) throw new Error('guild is unavailable');

  let member = await guild.members.fetch({ user: grant.user_id, force: true });
  if (!member.roles.cache.has(grant.role_id)) {
    await member.roles.add(
      grant.role_id,
      'SomniBot — repair role retained by a concurrent commerce owner',
    );
    member = await guild.members.fetch({ user: grant.user_id, force: true });
  }
  if (!member.roles.cache.has(grant.role_id)) {
    throw new Error('Discord did not confirm the concurrently-owned role');
  }
}

async function sweepExpiredTempRoleGrant(
  client: Pick<SomniClient, 'guilds' | 'supabase'>,
  grant: ExpiredTempRoleGrant,
  nowIso: string,
): Promise<'removed' | 'preserved'> {
  if (!grant.source) return 'preserved';

  try {
    const commerceGrant = COMMERCE_TEMP_ROLE_SOURCES.has(grant.source);
    let excludeCurrentGrant = true;

    // Every order-backed commerce row is reconciled against its exact parent,
    // even before its provisional/final expiry. This promptly removes access
    // after refunds while preserving delayed pending grants for live orders.
    if (grant.order_id !== null) {
      if (!commerceGrant) {
        if (Date.parse(grant.expires_at) > Date.parse(nowIso)) return 'preserved';
      } else {
        const inspection = await inspectTemporaryRoleGrant(client.supabase, grant.id);
        if (
          !inspection
          || inspection.guild_id !== grant.guild_id
          || inspection.user_id !== grant.user_id
          || inspection.role_id !== grant.role_id
          || inspection.order_id !== grant.order_id
          || inspection.grant_status !== grant.grant_status
          || inspection.remove_on_expiry !== grant.remove_on_expiry
          || inspection.expires_at !== grant.expires_at
        ) {
          log.warn('Order-backed temporary role inspection was missing or mismatched', {
            grantId: grant.id,
            orderId: grant.order_id,
          });
          return 'preserved';
        }

        const parentIsLive = inspection.parent_order_status === 'completed'
          && inspection.entitlement_is_live;
        if (parentIsLive && grant.grant_status === 'pending') return 'preserved';
        if (
          parentIsLive
          && grant.grant_status === 'applied'
          && Date.parse(grant.expires_at) > Date.parse(nowIso)
        ) {
          return 'preserved';
        }
        excludeCurrentGrant = parentIsLive;
      }
    }

    // Legacy commerce rows lack an order-scoped identity and remove intent.
    // Quarantine them rather than guessing whether this process added the
    // member's role.
    if (commerceGrant && !grant.order_id) return 'preserved';

    if (commerceGrant && grant.grant_status === 'pending') {
      if (!grant.remove_on_expiry) {
        return await deleteTempRoleGrant(client, grant) === 'retired' ? 'removed' : 'preserved';
      }
    }

    if (commerceGrant && !grant.remove_on_expiry) {
      return await deleteTempRoleGrant(client, grant) === 'retired' ? 'removed' : 'preserved';
    }

    if (await hasOtherLiveRoleOwner(client, grant, excludeCurrentGrant)) {
      return await deleteTempRoleGrant(client, grant) === 'retired' ? 'removed' : 'preserved';
    }

    await removeDiscordRoleAndConfirm(client, grant);

    try {
      if (await hasOtherLiveRoleOwner(client, grant, excludeCurrentGrant)) {
        await ensureDiscordRoleAndConfirm(client, grant);
      }
    } catch (ownershipError) {
      // Ownership is source-agnostic. If the post-removal read fails, restore
      // the role for both commerce and non-commerce grants rather than strand
      // a concurrent paid/manual/temp owner.
      try {
        await ensureDiscordRoleAndConfirm(client, grant);
      } catch (repairError) {
        throw new Error(
          `post-removal ownership verification failed (${String(ownershipError)}); role repair failed (${String(repairError)})`,
        );
      }
      throw new Error(
        `post-removal ownership verification failed; role was restored (${String(ownershipError)})`,
      );
    }

    const retirement = await deleteTempRoleGrant(client, grant);
    if (retirement !== 'retired') {
      let nowLive: boolean;
      try {
        nowLive = await hasOtherLiveRoleOwner(client, grant, false);
      } catch (ownershipError) {
        await ensureDiscordRoleAndConfirm(client, grant);
        throw new Error(
          `retirement ownership verification failed; role was restored (${String(ownershipError)})`,
        );
      }

      if (nowLive) {
        // The exact grant reactivated after the post-removal ownership read but
        // before the atomic retirement lock. Restore its role immediately.
        await ensureDiscordRoleAndConfirm(client, grant);
        return 'preserved';
      }
      if (retirement === 'failed') return 'preserved';

      // It reactivated at retirement but terminalized again before the fresh
      // owner read. One final locked retirement can now safely close the row.
      const finalRetirement = await deleteTempRoleGrant(client, grant);
      if (finalRetirement === 'live') {
        await ensureDiscordRoleAndConfirm(client, grant);
        return 'preserved';
      }
      return finalRetirement === 'retired' ? 'removed' : 'preserved';
    }
    return 'removed';
  } catch (err) {
    log.error('Temp role expiry failed for grant; provenance preserved', {
      grantId: grant.id,
      error: String(err),
    });
    return 'preserved';
  }
}

/** Sweep every expired role grant without deleting independent or unverified roles. */
export async function sweepExpiredTempRoleGrants(
  client: Pick<SomniClient, 'guilds' | 'supabase'>,
): Promise<void> {
  const nowIso = new Date().toISOString();
  let cursor: string | null = null;
  let removed = 0;
  let preserved = 0;

  while (true) {
    let query = client.supabase
      .from('temp_role_grants')
      .select('id, guild_id, user_id, role_id, expires_at, source, order_id, grant_status, remove_on_expiry')
      .in('grant_status', ['pending', 'applied'])
      // Reconcile every order-backed row so refunds do not wait for expiry;
      // legacy rows remain ordinary expiry candidates only.
      .or(`order_id.not.is.null,and(order_id.is.null,expires_at.lt.${nowIso})`);
    if (cursor !== null) query = query.gt('id', cursor);

    let expired: ExpiredTempRoleGrant[];
    try {
      const result = await query
        .order('id', { ascending: true })
        .limit(TEMP_ROLE_GRANT_SWEEP_PAGE_SIZE);
      if (result.error) {
        log.error('Temp role expiry lookup failed', { error: result.error.message });
        return;
      }
      if (!Array.isArray(result.data)) {
        log.error('Temp role expiry lookup returned a malformed result');
        return;
      }
      expired = result.data;
    } catch (err) {
      log.error('Temp role expiry sweep error', { error: String(err) });
      return;
    }

    if (expired.length === 0) break;

    let previousId = cursor;
    for (const grant of expired) {
      if (
        !isExpiredTempRoleGrant(grant)
        || (previousId !== null && grant.id <= previousId)
      ) {
        log.error('Temp role expiry page is malformed or not strictly ordered; sweep stopped safely', {
          cursor,
        });
        return;
      }
      previousId = grant.id;
    }

    for (const grant of expired) {
      const outcome = await sweepExpiredTempRoleGrant(client, grant, nowIso);
      if (outcome === 'removed') removed++;
      else preserved++;
    }

    if (expired.length < TEMP_ROLE_GRANT_SWEEP_PAGE_SIZE) break;

    const nextCursor = expired.at(-1)?.id;
    if (!nextCursor || nextCursor === cursor) {
      log.error('Temp role expiry cursor did not advance; sweep stopped safely', { cursor });
      return;
    }
    cursor = nextCursor;
  }

  log.info('Temp role sweep complete', { removed, preserved });
}

export function registerEvents(client: SomniClient): void {
  // ── Safety nets ──
  registerProcessSafetyNets();

  // ── Setup-verification gate ──
  // While the bot is in setup-verification mode it is logged in ONLY so the
  // wizard can confirm it is online; the GuildRouter is an empty placeholder
  // and guild_config rows do not exist yet. Normal guild event pipelines
  // (member joins, messages, reactions, voice, drift sync) must not run — they
  // would only emit the pre-setup error noise the gate is meant to suppress.
  // Interaction handling is gated inside handleInteraction itself (it must let
  // the setup wizard's own interactions through while short-circuiting every
  // other command/component — see isSetupInteraction in interaction-handler.ts).
  // The flag is cleared by the boot sequence right before the full boot, so
  // these same handlers light up automatically on transition (no re-register).
  const gatedForVerification = (): boolean => client.setupVerificationMode === true;

  // ── Ready ──
  client.once(Events.ClientReady, async (readyClient) => {
    log.info('Logged in', { tag: readyClient.user.tag, gateway: `${readyClient.ws.ping}ms`, guilds: readyClient.guilds.cache.size });
  });

  // ── Guild Member Events ──
  client.on('guildMemberAdd', async (member) => {
    if (gatedForVerification()) return;
    try {
      const blocked = await processAntiRaid(member.guild, member, client.supabase);
      if (!blocked) await handleMemberJoin(client, member);
    } catch (err) {
      log.error('guildMemberAdd handler error:', { error: String(err) });
    }
  });

  client.on('guildMemberRemove', async (member) => {
    if (gatedForVerification()) return;
    try { await handleMemberLeave(client, member); }
    catch (err) { log.error('guildMemberRemove handler error:', { error: String(err) }); }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (gatedForVerification()) return;
    try { await handleMemberUpdate(client, oldMember, newMember); }
    catch (err) { log.error('guildMemberUpdate handler error:', { error: String(err) }); }
  });

  // ── Role Events (Drift Detection) ──
  client.on('roleCreate', async (role) => {
    if (gatedForVerification()) return;
    try { await handleRoleCreate(client, role); }
    catch (err) { log.error('roleCreate handler error:', { error: String(err) }); }
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    if (gatedForVerification()) return;
    try { await handleRoleUpdate(client, oldRole, newRole); }
    catch (err) { log.error('roleUpdate handler error:', { error: String(err) }); }
  });

  client.on('roleDelete', async (role) => {
    if (gatedForVerification()) return;
    try { await handleRoleDelete(client, role); }
    catch (err) { log.error('roleDelete handler error:', { error: String(err) }); }
  });

  // ── Channel Events (Drift Detection) ──
  client.on('channelCreate', async (channel) => {
    if (gatedForVerification()) return;
    if (!('guild' in channel)) return;
    try { await handleChannelCreate(client, channel); }
    catch (err) { log.error('channelCreate handler error:', { error: String(err) }); }
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (gatedForVerification()) return;
    if (!('guild' in newChannel)) return;
    try { await handleChannelUpdate(client, oldChannel as typeof newChannel, newChannel); }
    catch (err) { log.error('channelUpdate handler error:', { error: String(err) }); }
  });

  client.on('channelDelete', async (channel) => {
    if (gatedForVerification()) return;
    if (!('guild' in channel)) return;
    try { await handleChannelDelete(client, channel); }
    catch (err) { log.error('channelDelete handler error:', { error: String(err) }); }
  });

  // ── Message Events ──
  client.on('messageCreate', async (message) => {
    if (gatedForVerification()) return;
    if (message.author.bot) return;
    if (!message.guild) return;

    // Auto-mod pipeline
    try {
      const modConfig = await loadModConfig(client, message.guild.id);
      const handled = await processMessage(client, message, modConfig);
      if (handled) return;
    } catch (err) {
      log.error('Auto-mod error:', { error: String(err) });
    }

    // Automation engine
    const messageEvent = {
      type: 'message.sent' as const,
      guildId: message.guild!.id,
      timestamp: Date.now(),
      data: {
        discordId: message.author.id,
        username: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
        content: message.content,
      },
    };

    // V10 Audit §6.P3a — use GuildRouter context instead of casting the client
    const guildCtx = client.router?.getContextSync(message.guild!.id);
    const engine = guildCtx?.getManager<import('../features/automations/automation-engine.js').AutomationEngine>('automationEngine');
    if (engine) {
      engine.processMessageEvent(messageEvent, message).catch((err) => {
        log.error('Automation message processing error:', { error: String(err) });
      });
    }

    // XP processing
    try {
      const xpResult = await processMessageXp(message, client.supabase, client.valkey, message.guild!.id);
      if (xpResult.leveledUp && xpResult.newLevel != null && xpResult.oldLevel != null && xpResult.newXp != null) {
        const guild = message.guild;
        if (guild) {
          await handleLevelUp(guild, client.supabase, client.eventBus, message.author.id, xpResult.oldLevel, xpResult.newLevel, xpResult.newXp);
        }
      }
    } catch (err) {
      log.error('XP processing error:', { error: String(err) });
    }

    // Economy chat income
    try {
      const econMgr = guildCtx?.getManager<EconomyManager>('economy');
      if (econMgr) await econMgr.processChatIncome(message.author.id, message.channelId);
    } catch (err) {
      log.error('Economy chat income error:', { error: String(err) });
    }

    // Quest progress: 'chat' activity
    try {
      const qMgr = guildCtx?.getManager<QuestsManager>('quests');
      if (qMgr) qMgr.trackProgress(message.guild!.id, message.author.id, 'chat').catch((e: unknown) => { log.warn('trackProgress failed:', (e as Error)?.message ?? e); });
    } catch {
      // Ignore quest tracking errors
    }
  });

  // ── Reaction Events ──
  client.on('messageReactionAdd', async (reaction, user) => {
    if (gatedForVerification()) return;
    if (user.bot) return;
    const message = reaction.message;
    if (!message.guild) return;

    const guild = message.guild;
    if (guild) {
      try {
        const handled = await handleReactionAdd(reaction, user, guild, client.supabase, client.valkey, client.eventBus);
        if (handled) return;
      } catch (err) {
        log.error('Reaction role add error:', { error: String(err) });
      }
    }

    // Automation event
    const reactionEvent = {
      type: 'reaction.added' as const,
      guildId: message.guild!.id,
      timestamp: Date.now(),
      data: {
        discordId: user.id,
        username: user.username ?? user.id,
        emoji: reaction.emoji.name ?? reaction.emoji.toString(),
        channelId: message.channel.id,
        messageId: message.id,
      },
    };

    const fullMessage = reaction.message.partial
      ? await reaction.message.fetch().catch(() => null)
      : reaction.message;

    if (fullMessage) {
      const reactionCtx = client.router?.getContextSync(message.guild!.id);
      const engine = reactionCtx?.getManager<import('../features/automations/automation-engine.js').AutomationEngine>('automationEngine');
      if (engine) {
        engine.processReactionEvent(reactionEvent, fullMessage).catch((err) => {
          log.error('Automation reaction processing error:', { error: String(err) });
        });
      }
    }

    client.eventBus.emit('reaction.added', reaction.message.guild!.id, reactionEvent.data);

    // Starboard
    try {
      await handleStarboardReaction(reaction, user, client.supabase, reaction.message.guild!.id);
    } catch (err) {
      log.error('Starboard reaction error:', { error: String(err) });
    }
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    if (gatedForVerification()) return;
    if (user.bot) return;
    const message = reaction.message;
    if (!message.guild) return;
    const guild = message.guild;
    if (guild) {
      try {
        await handleReactionRemove(reaction, user, guild, client.supabase, client.valkey, client.eventBus);
      } catch (err) {
        log.error('Reaction role remove error:', { error: String(err) });
      }
    }
  });

  // ── Message Edit/Delete Logging ──
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (gatedForVerification()) return;
    try { await logMessageEdit(client, oldMessage, newMessage); }
    catch (err) { log.error('messageUpdate log error:', { error: String(err) }); }
  });

  client.on('messageDelete', async (message) => {
    if (gatedForVerification()) return;
    try { await logMessageDelete(client, message); }
    catch (err) { log.error('messageDelete log error:', { error: String(err) }); }
  });

  // ── Voice State Events ──
  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (gatedForVerification()) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    // Voice XP
    onVoiceStateUpdate(oldState, newState);

    // Music auto-pause/leave
    const voiceCtx = client.router?.getContextSync(newState.guild.id);
    const musicPlayer = voiceCtx?.getManager<MusicPlayerManager>('musicPlayer');
    if (musicPlayer) {
      const affectedChannelId = oldState.channelId ?? newState.channelId;
      if (affectedChannelId) {
        musicPlayer.handleVoiceStateChange(affectedChannelId).catch((err) => {
          log.error('Music voice state handler error:', { error: String(err) });
        });
      }
    }

    // Temp channels
    const tempMgr = voiceCtx?.getManager<TempChannelManager>('tempChannelManager');
    if (tempMgr) {
      handleVoiceStateForTempChannels(oldState, newState, tempMgr).catch((err) => {
        log.error('Temp channel voice handler error:', { error: String(err) });
      });
    }

    // Event bus emissions
    if (!oldState.channelId && newState.channelId) {
      client.eventBus.emit('voice.joined', newState.guild.id, {
        discordId: member.id, username: member.user.username,
        channelId: newState.channelId, channelName: newState.channel?.name ?? '',
      });
    }
    if (oldState.channelId && !newState.channelId) {
      client.eventBus.emit('voice.left', oldState.guild.id, {
        discordId: member.id, username: member.user.username,
        channelId: oldState.channelId, channelName: oldState.channel?.name ?? '',
      });
    }
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      client.eventBus.emit('voice.left', oldState.guild.id, {
        discordId: member.id, username: member.user.username,
        channelId: oldState.channelId, channelName: oldState.channel?.name ?? '',
      });
      client.eventBus.emit('voice.joined', newState.guild.id, {
        discordId: member.id, username: member.user.username,
        channelId: newState.channelId, channelName: newState.channel?.name ?? '',
      });
    }
  });

  // ── Interaction Handler (V5 Audit §6.P3a — delegated to interaction-handler.ts) ──
  client.on('interactionCreate', (interaction) => handleInteraction(interaction, client));

  // ── Error Handling ──
  client.on('error', (error) => { log.error('Client error:', { error: String(error) }); });
  client.on('warn', (info) => { log.warn('Warning:', info); });

  // ── Periodic Crons ──
  // V5 Audit §6.P3a: Store interval handles for cleanup on shutdown.
  const cronHandles: NodeJS.Timeout[] = [];

  // Infraction expiry (every 15 min)
  trackCronHandle(cronHandles, setInterval(async () => {
    for (const ctx of client.router.all()) {
      try { await expireInfractions(client.supabase, ctx.guildId); }
      catch (err) { log.error('Infraction expiry error', { guildId: ctx.guildId, error: String(err) }); }
    }
  }, 15 * 60 * 1000));

  // Ticket inactivity check (every 30 min)
  trackCronHandle(cronHandles, setInterval(async () => {
    for (const ctx of client.router.all()) {
      try { await checkInactiveTickets(client.supabase, ctx.guild, client.eventBus); }
      catch (err) { log.error('Ticket inactivity check error', { guildId: ctx.guildId, error: String(err) }); }
    }
  }, 30 * 60 * 1000));

  // Temporary role expiry sweep (every 15 min). Commerce rows are acted on
  // only when their order-scoped lifecycle state proves safe ownership;
  // legacy or ambiguous provenance is preserved for reconciliation.
  trackCronHandle(cronHandles, setInterval(
    () => sweepExpiredTempRoleGrants(client),
    15 * 60 * 1000,
  ));

  // Data retention prune (every 6 hours)
  // V5 Audit §14.P3b: Iterate guilds and prune each individually so a failure
  // in one guild doesn't block cleanup for others, and so the single RPC call
  // doesn't lock tables across all guilds simultaneously.
  trackCronHandle(cronHandles, setInterval(async () => {
    let totalPruned = 0;
    const guilds = [...client.router.all()];
    for (const ctx of guilds) {
      try {
        const { data, error } = await client.supabase.rpc('prune_expired_data', {
          p_guild_id: ctx.guildId,
        });
        if (error) throw error;
        const counts = data as Record<string, number> | null;
        const pruned = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : 0;
        totalPruned += pruned;
      } catch (err) {
        log.error('Data retention prune error', { guildId: ctx.guildId, error: String(err) });
      }
    }
    if (totalPruned > 0) log.info('Data pruned', { totalPruned, guilds: guilds.length });
  }, 6 * 60 * 60 * 1000));

  // V5 Audit §6.P3a: Clear all intervals on SIGTERM/SIGINT so tests exit cleanly.
  const cleanupCrons = () => {
    for (const handle of cronHandles) clearInterval(handle);
    cronHandles.length = 0;
  };
  registerProcessCronCleanup(cleanupCrons);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Per-guild moderation config cache */
const _modConfigCache = new Map<string, {
  data: { escalationChain: EscalationStep[]; infractionExpiryDays: number; modLogChannelId: string | null };
  time: number;
}>();
const MOD_CONFIG_TTL = 60_000;
/**
 * V8 Audit §14.P3c — Cap cache size to prevent unbounded growth at scale.
 * When the map exceeds this limit the oldest entry (first inserted) is evicted.
 */
const MOD_CONFIG_MAX_ENTRIES = 10_000;

async function loadModConfig(client: SomniClient, guildId?: string): Promise<{
  escalationChain: EscalationStep[];
  infractionExpiryDays: number;
  modLogChannelId: string | null;
}> {
  const id = guildId ?? client.guildId;
  const now = Date.now();
  const cached = _modConfigCache.get(id);
  if (cached && now - cached.time < MOD_CONFIG_TTL) {
    // V9 Audit §6.P3: Promote to most-recent on access for true LRU eviction.
    _modConfigCache.delete(id);
    _modConfigCache.set(id, cached);
    return cached.data;
  }

  const { data } = await client.supabase
    .from('guild_config')
    .select('escalation_chain, infraction_expiry_days, mod_log_channel_id')
    .eq('guild_id', id)
    .maybeSingle();

  const result = {
    escalationChain: Array.isArray(data?.escalation_chain) ? (data.escalation_chain as EscalationStep[]) : [],
    infractionExpiryDays: (data?.infraction_expiry_days as number) ?? 30,
    modLogChannelId: (data?.mod_log_channel_id as string) ?? null,
  };
  // Evict oldest entry if at capacity (Map preserves insertion order)
  if (_modConfigCache.size >= MOD_CONFIG_MAX_ENTRIES) {
    const oldest = _modConfigCache.keys().next().value;
    if (oldest !== undefined) _modConfigCache.delete(oldest);
  }
  _modConfigCache.set(id, { data: result, time: now });
  return result;
}
