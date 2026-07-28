/**
 * Bot Action Queue Listener
 *
 * Subscribes to the `bot_action_queue` table via Supabase Realtime.
 * When the dashboard inserts a new action, the bot picks it up and executes it.
 *
 * Supported actions:
 * - create_role: Create a new Discord role
 * - update_role: Update an existing Discord role
 * - delete_role: Delete a Discord role
 * - create_channel: Create a new Discord channel
 * - update_channel: Update an existing Discord channel
 * - delete_channel: Delete a Discord channel
 * - create_category: Create a new Discord category
 * - delete_category: Delete a Discord category
 * - refresh_snapshot: Force a guild snapshot refresh
 * - send_embed: Send an embed template to a Discord channel
 * - test_welcome: Send a test welcome/goodbye message to a Discord channel
 *
 * Lane segregation: every row is classified into a 'commerce' or 'game' lane
 * (see services/action-queue-lanes.ts and migration 20260710020000). Commerce
 * rows — real-money fulfillment, receipt delivery, entitlement revocation —
 * are always claimed before game rows in sweeps, and the Realtime path runs
 * under per-lane concurrency budgets so a game-job flood can never starve or
 * delay commerce processing.
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeGuildSnapshot } from './guild-snapshot.js';
import { writeAuditLog } from './audit.js';
import { codePointLength, sqlSpaceTrim } from '../utils/prize-snapshot.js';
import {
  CommerceFulfillmentService,
  RECEIPT_DELIVERY_ACTION,
  classifyDeliveryError,
  writeReceiptDeliveryAlert,
  type FulfillmentPayload,
  type ReceiptDeliveryPayload,
} from './commerce-fulfillment.js';
import { deliverReceiptDM } from '../features/commerce/receipt-builder.js';
import { resolveBrandKit } from '../features/branding/index.js';
import { EntitlementService } from '../features/commerce/entitlement-service.js';
import {
  GiveawayFulfillmentService,
  GiveawayPrizeContractError,
} from './giveaway-fulfillment.js';
import {
  ACTION_QUEUE_LANES,
  COMMERCE_LANE_ACTIONS,
  LANE_CONCURRENCY,
  LANE_DEPTH_ALERT_SEVERITY,
  LANE_PENDING_DEPTH_THRESHOLDS,
  LaneScheduler,
  laneDepthAlertType,
  laneForAction,
  type ActionQueueLane,
} from './action-queue-lanes.js';
import { eventBus } from './event-bus.js';
import {
  parseActionQueuePlatformEvent,
  parseConfigReloadAuditEvent,
} from './action-queue-event-ingress.js';
import { runReconciliation } from './reconciliation.js';
import { repairDriftItem, acceptDriftItem, ignoreDriftItem, clearAllDrift } from '../sync/repair-actions.js';
import { raiseOwnerAlert, resolveOwnerAlert } from './alert-service.js';
import { createLogger, type DriftItem } from '@somnibot/shared';

const log = createLogger('ActionQueue');
export const ACTION_QUEUE_CLAIM_PROTOCOL_VERSION = 2;

// ============================================================
// Types
// ============================================================

interface ActionRow {
  id: string;
  guild_id: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  next_retry_at?: string | null;
  /** 'commerce' | 'game' — stamped by the DB trigger at insert. */
  lane?: string;
}

interface ClaimedActionRow extends ActionRow {
  status: 'processing';
  retry_count: number;
  claim_token: string;
  lane: ActionQueueLane;
}

export interface ClaimedActionContext {
  actionId: string;
  claimToken: string;
}

/**
 * Lane of a queue row. Prefers the DB-stamped lane column (authoritative —
 * set by the BEFORE INSERT trigger); falls back to classifying the action
 * type for rows that predate the lane migration.
 */
function laneOf(action: Pick<ActionRow, 'action' | 'lane'>): ActionQueueLane {
  return action.lane === 'commerce' || action.lane === 'game'
    ? action.lane
    : laneForAction(action.action);
}

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
  claimTransition?: 'deferred';
}

type ActionHandler = (
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  context: ClaimedActionContext,
) => Promise<ActionResult>;

function parseClaimedActionRow(
  value: unknown,
  requestedActionId: string,
  guildId: string,
): ClaimedActionRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.id !== requestedActionId
    || row.guild_id !== guildId
    || typeof row.action !== 'string'
    || row.action.length === 0
    || row.action.trim() !== row.action
    || !row.payload
    || typeof row.payload !== 'object'
    || Array.isArray(row.payload)
    || row.status !== 'processing'
    || !Number.isSafeInteger(row.retry_count)
    || Number(row.retry_count) < 0
    || typeof row.claim_token !== 'string'
    || row.claim_token.length === 0
    || row.claim_token.trim() !== row.claim_token
    || (row.lane !== 'commerce' && row.lane !== 'game')
    || row.lane !== laneForAction(row.action)
  ) {
    return null;
  }
  return row as unknown as ClaimedActionRow;
}

type RetryClaimDisposition =
  | 'requeued'
  | 'completed'
  | 'operator_held'
  | 'stale_claim'
  | 'intent_raced';

function parseRetryClaimTransition(
  value: unknown,
): { applied: boolean; disposition: RetryClaimDisposition } | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const evidence = row as Record<string, unknown>;
  if (
    typeof evidence.applied !== 'boolean'
    || typeof evidence.disposition !== 'string'
    || ![
      'requeued',
      'completed',
      'operator_held',
      'stale_claim',
      'intent_raced',
    ].includes(evidence.disposition)
  ) {
    return null;
  }
  const disposition = evidence.disposition as RetryClaimDisposition;
  const combinationMatches = disposition === 'requeued'
    ? evidence.applied === true
    : evidence.applied === false;
  return combinationMatches
    ? { applied: evidence.applied, disposition }
    : null;
}

type FinalClaimDisposition = 'completed' | 'completed_from_evidence' | 'failed';

function parseFinalClaimTransition(
  value: unknown,
  handlerSuccess: boolean,
): FinalClaimDisposition | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const evidence = row as Record<string, unknown>;
  if (evidence.applied !== true || typeof evidence.disposition !== 'string') return null;
  if (handlerSuccess) {
    return evidence.disposition === 'completed' ? 'completed' : null;
  }
  return evidence.disposition === 'failed'
    || evidence.disposition === 'completed_from_evidence'
    ? evidence.disposition
    : null;
}

// ============================================================
// Action Handlers
// ============================================================

async function handleCreateRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  const tier = payload.tier as string;
  const color = (payload.color as number) ?? 0;
  const hoist = (payload.hoist as boolean) ?? false;
  const mentionable = (payload.mentionable as boolean) ?? false;
  const permissions = payload.permissions as string | undefined;
  const position = payload.position as number | undefined;

  if (!name || !tier) {
    return { success: false, error: 'Missing required fields: name, tier' };
  }

  const role = await guild.roles.create({
    name,
    color,
    hoist,
    mentionable,
    permissions: permissions
      ? new PermissionsBitField(BigInt(permissions))
      : undefined,
    reason: `SomniBot dashboard — created ${tier} role`,
  });

  // Set position if specified
  if (position !== undefined) {
    try {
      await role.setPosition(position, { reason: 'SomniBot dashboard — set role position' });
    } catch {
      // Position conflicts aren't fatal
    }
  }

  // Update discord_id_map
  const templateKey = (payload.templateKey as string) ?? `custom-${role.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'role',
      template_key: templateKey,
      discord_id: role.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  // Update guild_desired_state with the new role
  await addRoleToDesiredState(supabase, guild.id, {
    key: templateKey,
    name,
    tier,
    permissions: permissions ?? '0',
    color,
    hoist,
    mentionable,
    position: position ?? role.position,
  });

  return {
    success: true,
    data: { roleId: role.id, name: role.name, templateKey },
  };
}

async function handleUpdateRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const roleId = payload.roleId as string;
  if (!roleId) return { success: false, error: 'Missing roleId' };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { success: false, error: `Role ${roleId} not found` };
  if (role.managed) return { success: false, error: 'Cannot edit managed roles' };

  const updates: Record<string, unknown> = {};
  if (payload.name !== undefined) updates.name = payload.name;
  if (payload.color !== undefined) updates.color = payload.color;
  if (payload.hoist !== undefined) updates.hoist = payload.hoist;
  if (payload.mentionable !== undefined) updates.mentionable = payload.mentionable;
  if (payload.permissions !== undefined) {
    updates.permissions = new PermissionsBitField(BigInt(payload.permissions as string));
  }

  await role.edit({ ...updates, reason: 'SomniBot dashboard — role updated' } as Parameters<typeof role.edit>[0]);

  if (payload.position !== undefined) {
    try {
      await role.setPosition(payload.position as number, {
        reason: 'SomniBot dashboard — position updated',
      });
    } catch {
      // Position conflicts aren't fatal
    }
  }

  // Update desired state
  const templateKey = payload.templateKey as string | undefined;
  if (templateKey) {
    await updateRoleInDesiredState(supabase, guild.id, templateKey, payload);
  }

  return { success: true, data: { roleId: role.id, name: role.name } };
}

async function handleDeleteRole(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const roleId = payload.roleId as string;
  if (!roleId) return { success: false, error: 'Missing roleId' };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { success: false, error: `Role ${roleId} not found` };
  if (role.managed) return { success: false, error: 'Cannot delete managed roles' };

  const roleName = role.name;
  await role.delete('SomniBot dashboard — role deleted');

  // Remove from discord_id_map
  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'role')
    .eq('discord_id', roleId);

  // Remove from desired state
  const templateKey = payload.templateKey as string | undefined;
  if (templateKey) {
    await removeRoleFromDesiredState(supabase, guild.id, templateKey);
  }

  return { success: true, data: { roleId, name: roleName } };
}

async function handleCreateChannel(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  const type = payload.type as number ?? ChannelType.GuildText;
  const parentId = payload.parentId as string | null ?? null;
  const topic = payload.topic as string | null ?? null;
  const nsfw = payload.nsfw as boolean ?? false;
  const rateLimitPerUser = payload.slowmode as number ?? 0;

  if (!name) return { success: false, error: 'Missing channel name' };

  const created = await guild.channels.create({
    name,
    type: type as ChannelType.GuildText,
    parent: parentId ?? undefined,
    topic: topic ?? undefined,
    nsfw,
    rateLimitPerUser,
    reason: 'SomniBot dashboard — channel created',
  });

  const templateKey = (payload.templateKey as string) ?? `ch-${created.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'channel',
      template_key: templateKey,
      discord_id: created.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  return {
    success: true,
    data: { channelId: created.id, name: created.name, templateKey },
  };
}

async function handleUpdateChannel(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channelId as string;
  if (!channelId) return { success: false, error: 'Missing channelId' };

  const channel = guild.channels.cache.get(channelId) as GuildChannel | undefined;
  if (!channel) return { success: false, error: `Channel ${channelId} not found` };

  const editOptions: Record<string, unknown> = { reason: 'SomniBot dashboard — channel updated' };
  if (payload.name !== undefined) editOptions.name = payload.name;
  if (payload.topic !== undefined) editOptions.topic = payload.topic;
  if (payload.nsfw !== undefined) editOptions.nsfw = payload.nsfw;
  if (payload.slowmode !== undefined) editOptions.rateLimitPerUser = payload.slowmode;
  if (payload.parentId !== undefined) editOptions.parent = payload.parentId || null;

  await channel.edit(editOptions as Parameters<typeof channel.edit>[0]);

  return { success: true, data: { channelId, name: channel.name } };
}

async function handleDeleteChannel(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channelId as string;
  if (!channelId) return { success: false, error: 'Missing channelId' };

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { success: false, error: `Channel ${channelId} not found` };

  const channelName = channel.name;
  await channel.delete('SomniBot dashboard — channel deleted');

  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'channel')
    .eq('discord_id', channelId);

  return { success: true, data: { channelId, name: channelName } };
}

async function handleCreateCategory(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const name = payload.name as string;
  if (!name) return { success: false, error: 'Missing category name' };

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: 'SomniBot dashboard — category created',
  });

  const templateKey = (payload.templateKey as string) ?? `cat-${category.id}`;
  await supabase.from('discord_id_map').upsert(
    {
      guild_id: guild.id,
      entity_type: 'category',
      template_key: templateKey,
      discord_id: category.id,
    },
    { onConflict: 'guild_id,entity_type,template_key' },
  );

  return {
    success: true,
    data: { categoryId: category.id, name: category.name, templateKey },
  };
}

async function handleDeleteCategory(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const categoryId = payload.categoryId as string;
  if (!categoryId) return { success: false, error: 'Missing categoryId' };

  const channel = guild.channels.cache.get(categoryId);
  if (!channel) return { success: false, error: `Category ${categoryId} not found` };
  if (channel.type !== ChannelType.GuildCategory)
    return { success: false, error: 'Not a category' };

  const categoryName = channel.name;
  await channel.delete('SomniBot dashboard — category deleted');

  await supabase
    .from('discord_id_map')
    .delete()
    .eq('guild_id', guild.id)
    .eq('entity_type', 'category')
    .eq('discord_id', categoryId);

  return { success: true, data: { categoryId, name: categoryName } };
}

// ============================================================
// Desired State Helpers
// ============================================================

async function addRoleToDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  role: {
    key: string;
    name: string;
    tier: string;
    permissions: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
    position: number;
  },
): Promise<void> {
  // Atomic: appends to the JSONB array in a single UPDATE (no read-modify-write race)
  const { error } = await supabase.rpc('desired_state_add_role', {
    p_guild_id: guildId,
    p_role: role,
  });
  if (error) {
    log.error('desired_state_add_role RPC failed:', error.message);
  }
}

async function updateRoleInDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // Atomic: locks row FOR UPDATE, finds role by key, merges updates in SQL
  const roleUpdates: Record<string, unknown> = {};
  if (updates.name !== undefined) roleUpdates.name = updates.name;
  if (updates.tier !== undefined) roleUpdates.tier = updates.tier;
  if (updates.color !== undefined) roleUpdates.color = updates.color;
  if (updates.hoist !== undefined) roleUpdates.hoist = updates.hoist;
  if (updates.mentionable !== undefined) roleUpdates.mentionable = updates.mentionable;
  if (updates.permissions !== undefined) roleUpdates.permissions = updates.permissions;
  if (updates.position !== undefined) roleUpdates.position = updates.position;

  const { error } = await supabase.rpc('desired_state_update_role', {
    p_guild_id: guildId,
    p_template_key: templateKey,
    p_updates: roleUpdates,
  });
  if (error) {
    log.error('desired_state_update_role RPC failed:', error.message);
  }
}

async function removeRoleFromDesiredState(
  supabase: SupabaseClient,
  guildId: string,
  templateKey: string,
): Promise<void> {
  // Atomic: locks row FOR UPDATE, filters out the role by key in SQL
  const { error } = await supabase.rpc('desired_state_remove_role', {
    p_guild_id: guildId,
    p_template_key: templateKey,
  });
  if (error) {
    log.error('desired_state_remove_role RPC failed:', error.message);
  }
}

// ============================================================
// Action Router
// ============================================================

// ── Commerce Fulfillment Handler ──────────────────────

async function handleFulfillment(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  context: ClaimedActionContext,
): Promise<ActionResult> {
  const fulfillmentService = new CommerceFulfillmentService(guild, supabase, eventBus);
  const fulfillmentPayload = payload as unknown as FulfillmentPayload;

  const result = await fulfillmentService.fulfill(fulfillmentPayload, context);

  if (result.success) {
    return {
      success: true,
      data: {
        entitlementId: result.entitlementId,
        receiptSent: result.receiptSent,
        paidFulfillmentHeld: result.paidFulfillmentHeld,
        eventEmitted: result.eventEmitted,
      },
    };
  } else {
    return {
      success: false,
      error: result.errors.join('; '),
    };
  }
}

export async function handleGiveawayPrizeFulfillment(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  if (
    !['giveaway_atomic_end', 'giveaway_atomic_reroll'].includes(
      payload.source as string,
    )
    || payload.guild_id !== guild.id
    || typeof payload.giveaway_id !== 'string'
    || !UUID_PATTERN.test(payload.giveaway_id)
    || typeof payload.winner_id !== 'string'
    || !/^\d{17,20}$/.test(payload.winner_id)
    || typeof payload.product_id !== 'string'
    || !UUID_PATTERN.test(payload.product_id)
  ) {
    return {
      success: false,
      error: 'Missing or malformed durable giveaway prize identity',
      retryable: false,
    };
  }

  try {
    const service = new GiveawayFulfillmentService(guild, supabase, eventBus);
    const result = await service.fulfillQueuedProductPrize({
      giveawayId: payload.giveaway_id,
      winnerId: payload.winner_id,
      productId: payload.product_id,
    });
    return {
      success: true,
      data: {
        giveawayId: result.giveawayId,
        winnerId: result.winnerId,
        productId: result.productId,
        entitlementId: result.entitlementId,
        requestId: result.requestId,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: !(error instanceof GiveawayPrizeContractError),
    };
  }
}

export async function handleGiveawayWinnerNotification(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const allowed = new Set([
    'source',
    'guild_id',
    'giveaway_id',
    'winner_id',
    'product_id',
    'delivery_kind',
    'prize_snapshot',
  ]);
  if (
    Object.keys(payload).some((field) => !allowed.has(field))
    || !['giveaway_atomic_end', 'giveaway_atomic_reroll'].includes(
      payload.source as string,
    )
    || payload.guild_id !== guild.id
    || typeof payload.giveaway_id !== 'string'
    || !UUID_PATTERN.test(payload.giveaway_id)
    || typeof payload.winner_id !== 'string'
    || !/^\d{17,20}$/.test(payload.winner_id)
    || !['manual', 'product'].includes(payload.delivery_kind as string)
    || (payload.delivery_kind === 'product'
      && (typeof payload.product_id !== 'string' || !UUID_PATTERN.test(payload.product_id)))
    || (payload.delivery_kind === 'manual' && payload.product_id !== null)
    || typeof payload.prize_snapshot !== 'string'
    || payload.prize_snapshot.length === 0
    // btrim/left replica: SQL snapshots may legally carry edge tabs or
    // newlines and count length in code points, not UTF-16 units.
    || sqlSpaceTrim(payload.prize_snapshot) !== payload.prize_snapshot
    || codePointLength(payload.prize_snapshot) > 1_000
  ) {
    return {
      success: false,
      error: 'Missing or malformed durable giveaway notification identity',
      retryable: false,
    };
  }

  try {
    const service = new GiveawayFulfillmentService(guild, supabase, eventBus);
    const result = await service.notifyQueuedWinner({
      source: payload.source as 'giveaway_atomic_end' | 'giveaway_atomic_reroll',
      giveawayId: payload.giveaway_id,
      winnerId: payload.winner_id,
      productId: payload.product_id as string | null,
      deliveryKind: payload.delivery_kind as 'manual' | 'product',
      prizeSnapshot: payload.prize_snapshot,
    });
    return {
      success: true,
      data: {
        giveawayId: result.giveawayId,
        winnerId: result.winnerId,
        deliveryKind: result.deliveryKind,
        entitlementId: result.entitlementId,
        messageId: result.messageId,
        nonce: result.nonce,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: !(error instanceof GiveawayPrizeContractError),
    };
  }
}

type ReconcileEntitlementRolesPayload = {
  mode: 'ensure_live' | 'ensure_live_request' | 'cleanup';
  action_id: string;
  target_delivery_intent_id?: string;
  guild_id: string;
  entitlement_id?: string;
  customer_id?: string;
  old_discord_id?: string;
  discord_id?: string;
  order_id?: string;
  product_id?: string;
  plan_id?: string | null;
  entitlement_type?: 'one_time' | 'subscription';
  source?: 'purchase' | null;
  entitlement_status?: 'active' | 'pending' | 'grace_period' | 'suspended';
  granted_role_ids?: string[];
};

function isExactNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function exactUniqueRoleVector(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isExactNonBlankString)
    && new Set(value).size === value.length;
}

export async function handleReconcileEntitlementRoles(
  guild: Guild,
  supabase: SupabaseClient,
  payloadValue: Record<string, unknown>,
  context: ClaimedActionContext,
): Promise<ActionResult> {
  const payload = payloadValue as ReconcileEntitlementRolesPayload;
  if (
    !['ensure_live', 'ensure_live_request', 'cleanup'].includes(payload.mode)
    || !isExactNonBlankString(payload.action_id)
    || payload.action_id !== context.actionId
    || payload.guild_id !== guild.id
  ) {
    return {
      success: false,
      error: 'Missing or mismatched durable paid-role reconciliation identity',
      retryable: false,
    };
  }

  if (payload.mode === 'ensure_live_request') {
    if (
      !isExactNonBlankString(payload.entitlement_id)
      || !isExactNonBlankString(payload.customer_id)
      || !isExactNonBlankString(payload.old_discord_id)
      || !isExactNonBlankString(payload.discord_id)
      || payload.old_discord_id === payload.discord_id
    ) {
      return { success: false, error: 'Malformed paid-role ensure request', retryable: false };
    }

    const { data, error } = await (
      supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof supabase.rpc>
    )('commerce_ensure_live_role_delivery_action', {
      p_entitlement_id: payload.entitlement_id,
    });
    if (error) {
      return {
        success: false,
        error: `Paid-role ensure request failed: ${error.message}`,
      };
    }
    if (!Array.isArray(data) || data.length > 1) {
      return {
        success: false,
        error: 'Paid-role ensure request returned malformed carrier cardinality',
        retryable: false,
      };
    }
    const carrier = data[0] as Record<string, unknown> | undefined;
    if (
      carrier !== undefined
      && (
        carrier == null
        || typeof carrier !== 'object'
        || Array.isArray(carrier)
        || !isExactNonBlankString(carrier.action_id)
        || typeof carrier.action_status !== 'string'
        || !['pending', 'processing'].includes(carrier.action_status)
      )
    ) {
      return {
        success: false,
        error: 'Paid-role ensure request returned malformed carrier identity',
        retryable: false,
      };
    }
    return {
      success: true,
      data: {
        actionId: payload.action_id,
        entitlementId: payload.entitlement_id,
        outcome: carrier !== undefined
          ? 'ensure_queued'
          : 'ensure_deferred_or_terminal',
      },
    };
  }

  const service = new EntitlementService(guild, supabase, eventBus);
  if (payload.mode === 'cleanup') {
    if (!isExactNonBlankString(payload.target_delivery_intent_id)) {
      return { success: false, error: 'Missing paid-role cleanup target intent', retryable: false };
    }
    try {
      const finished = await service.executeOwnedPurchaseRoleCleanup(
        payload.target_delivery_intent_id,
        context,
      );
      if (!finished.settled) {
        return {
          success: false,
          error: 'Paid role cleanup remains unresolved after confirmed mutation',
        };
      }
      return {
        success: true,
        data: {
          deliveryIntentId: payload.target_delivery_intent_id,
          outcome: 'settled_cleanup',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Paid role cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (
    !isExactNonBlankString(payload.entitlement_id)
    || !isExactNonBlankString(payload.customer_id)
    || !isExactNonBlankString(payload.discord_id)
    || !isExactNonBlankString(payload.order_id)
    || !isExactNonBlankString(payload.product_id)
    || (payload.entitlement_type !== 'one_time' && payload.entitlement_type !== 'subscription')
    || (payload.source !== 'purchase' && payload.source !== null)
    || !['active', 'pending', 'grace_period', 'suspended'].includes(
      String(payload.entitlement_status),
    )
    || !exactUniqueRoleVector(payload.granted_role_ids)
    || (
      payload.entitlement_type === 'subscription'
      && !isExactNonBlankString(payload.plan_id)
    )
    || (payload.entitlement_type === 'one_time' && payload.plan_id !== null)
  ) {
    return { success: false, error: 'Malformed paid-role ensure payload', retryable: false };
  }

  const contract = {
    customerId: payload.customer_id,
    productId: payload.product_id,
    orderId: payload.order_id,
    planId: payload.plan_id ?? null,
    discordId: payload.discord_id,
    grantedRoleIds: payload.granted_role_ids,
    entitlementType: payload.entitlement_type,
  };
  const begun = await service.beginPurchaseRoleDeliveryAttempt(
    payload.entitlement_id,
    contract,
    context,
  );
  if (begun.state === 'confirmed_live') {
    return {
      success: true,
      data: { actionId: payload.action_id, outcome: 'live_confirmed' },
    };
  }
  if (begun.state === 'terminal') {
    if (begun.cleanupNeeded) {
      const cleanup = await service.executeOwnedPurchaseRoleCleanup(
        begun.intentId,
        context,
      );
      if (!cleanup.settled) {
        return {
          success: false,
          error: 'Paid role terminal cleanup remains unresolved',
        };
      }
    }
    return {
      success: true,
      data: { actionId: payload.action_id, outcome: 'terminal_noop' },
    };
  }

  const outcome = await service.reconcilePurchaseGrantedRoles(
    payload.entitlement_id,
    contract,
    begun.attempt,
  );
  const activeAttempt = service.getActivePurchaseRoleDeliveryAttempt();
  const finalized = activeAttempt?.intentId === begun.attempt.intentId
    ? await service.finishPurchaseRoleDeliveryAttempt(
      begun.attempt,
      outcome === 'live' ? 'live' : 'compensated',
    )
    : { state: 'settled', settled: true, authorityEmpty: true };
  const validOwnedLive =
    finalized.state === 'open'
    && !finalized.settled
    && !finalized.authorityEmpty;
  const validZeroAuthorityLive =
    finalized.state === 'settled'
    && finalized.settled
    && finalized.authorityEmpty;
  if (outcome === 'live' && !validOwnedLive && !validZeroAuthorityLive) {
    return { success: false, error: 'Paid role ensure intent did not become confirmed and idle' };
  }
  if (outcome === 'terminal' && (!finalized.settled || !finalized.authorityEmpty)) {
    return { success: false, error: 'Paid role terminal compensation did not settle' };
  }
  return {
    success: true,
    data: {
      actionId: payload.action_id,
      outcome: outcome === 'live' ? 'live_confirmed' : 'terminal_compensated',
    },
  };
}

// ── Receipt Delivery Handler ──────────────────────────
// Persistent re-delivery of a paid customer's receipt/license-key DM, queued
// by CommerceFulfillmentService when the initial DM attempt fails. Transient
// errors (network blips, Discord 5xx) are retryable and go through the
// queue's exponential backoff; permanent errors (DMs disabled, unknown user)
// fail immediately so retries aren't burned on a hopeless delivery. Final
// failures are dead-lettered + alerted in processAction below.

async function handleDeliverReceipt(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const p = payload as unknown as Partial<ReceiptDeliveryPayload>;
  if (!p.discord_id || !p.order_number || !p.product_name) {
    return {
      success: false,
      error: 'Missing required fields: discord_id, order_number, product_name',
      retryable: false,
    };
  }

  // A retried/DLQ-redelivered receipt must show the ORDER date, not the
  // date the retry finally succeeded. order_date is stamped into the payload
  // when the redelivery is queued; fall back to "now" only for legacy rows
  // queued before the field existed (where "now" is at most the retry lag
  // wrong, same as the old behavior).
  const parsedOrderDate = p.order_date ? new Date(p.order_date) : null;
  const orderDate =
    parsedOrderDate && !Number.isNaN(parsedOrderDate.getTime()) ? parsedOrderDate : new Date();

  try {
    // Buyer-facing receipt: framed with the owner's white-label kit (cached).
    const brandKit = await resolveBrandKit(supabase, guild.id, { fallbackName: guild.name });
    const user = await guild.client.users.fetch(p.discord_id);
    await deliverReceiptDM(
      user,
      {
        orderNumber: p.order_number,
        productName: p.product_name,
        amountCents: p.amount_cents ?? 0,
        currency: p.currency ?? 'USD',
        licenseKey: p.license_key_plaintext ?? null,
        date: orderDate,
      },
      brandKit,
    );
    return { success: true, data: { orderNumber: p.order_number, delivered: true } };
  } catch (err) {
    const kind = classifyDeliveryError(err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Receipt delivery ${kind === 'permanent' ? 'permanently ' : ''}failed: ${msg}`,
      retryable: kind === 'transient',
    };
  }
}

// ── Config Reload Handler ─────────────────────────────

async function handleConfigReload(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const section = payload.section as string;
  const changes = payload.changes as Record<string, unknown> | undefined;
  const changedBy = payload.changed_by as string | undefined;

  const rawAuditEvent = payload.audit_event;
  const auditEvent = rawAuditEvent === undefined
    ? null
    : parseConfigReloadAuditEvent(rawAuditEvent);
  if (rawAuditEvent !== undefined && auditEvent === null) {
    return {
      success: false,
      error: 'Malformed or disallowed config_reload audit event',
      retryable: false,
    };
  }

  // Prior values of the changed keys, when the enqueuing writer captured them
  // (audit before_state — the AuditService's own guild_config snapshot is the
  // fallback for payloads that don't carry one).
  const beforeValues =
    payload.before !== null && typeof payload.before === 'object' && !Array.isArray(payload.before)
      ? (payload.before as Record<string, unknown>)
      : undefined;
  // Stable per-change identity so a redelivered config_reload action cannot
  // double-write the config.updated audit row (occurrence dedupe).
  const occurrenceId =
    typeof payload.occurrence_id === 'string' && payload.occurrence_id !== ''
      ? payload.occurrence_id
      : undefined;

  // Emit config.changed so the bot reloads
  eventBus.emit('config.changed', guild.id, {
    section: section ?? 'unknown',
    changes: changes ?? {},
    changedBy: changedBy ?? 'dashboard',
    ...(beforeValues ? { before: beforeValues } : {}),
    ...(occurrenceId ? { occurrenceId } : {}),
  });

  // If the dashboard attached an audit event, emit it on the event bus
  // so AuditService can log automation/webhook CRUD operations (Finding #4).
  if (auditEvent) {
    eventBus.emit(auditEvent.type, guild.id, auditEvent.data);
  }

  return { success: true, data: { section, reloaded: true } };
}

// ── Send Embed Handler ────────────────────────────────

interface EmbedConfig {
  title: string | null;
  description: string | null;
  color: number | null;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  image_url: string | null;
  thumbnail_url: string | null;
  footer_text: string | null;
  footer_icon_url: string | null;
  author_name: string | null;
  author_url: string | null;
  author_icon_url: string | null;
  include_timestamp: boolean;
}

function replaceEmbedVariables(text: string, guild: Guild): string {
  return text
    .replace(/\{server\}/g, guild.name)
    .replace(/\{server\.name\}/g, guild.name)
    .replace(/\{members\}/g, String(guild.memberCount))
    .replace(/\{memberCount\}/g, String(guild.memberCount))
    .replace(/\{date\}/g, new Date().toLocaleDateString())
    .replace(/\{time\}/g, new Date().toLocaleTimeString())
    .replace(/\{timestamp\}/g, String(Math.floor(Date.now() / 1000)));
}

function buildEmbedFromConfig(cfg: EmbedConfig, guild: Guild): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (cfg.title) embed.setTitle(replaceEmbedVariables(cfg.title, guild));
  if (cfg.description) embed.setDescription(replaceEmbedVariables(cfg.description, guild));
  if (cfg.color != null) embed.setColor(cfg.color);
  if (cfg.image_url) embed.setImage(cfg.image_url);
  if (cfg.thumbnail_url) embed.setThumbnail(cfg.thumbnail_url);
  if (cfg.footer_text) embed.setFooter({
    text: replaceEmbedVariables(cfg.footer_text, guild),
    iconURL: cfg.footer_icon_url ?? undefined,
  });
  if (cfg.author_name) embed.setAuthor({
    name: replaceEmbedVariables(cfg.author_name, guild),
    url: cfg.author_url ?? undefined,
    iconURL: cfg.author_icon_url ?? undefined,
  });
  if (cfg.include_timestamp) embed.setTimestamp();
  if (cfg.fields?.length) {
    for (const field of cfg.fields) {
      embed.addFields({
        name: replaceEmbedVariables(field.name, guild),
        value: replaceEmbedVariables(field.value, guild),
        inline: field.inline ?? false,
      });
    }
  }
  return embed;
}

async function handleSendEmbed(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  // V52-L5: the dashboard embeds/send route puts `embed_config_id` in the
  // payload, but this handler was reading `embed_id` — accept both for
  // backward-compat with any older queued rows.
  const embedId = (payload.embed_config_id ?? payload.embed_id) as string;
  const channelId = payload.channel_id as string;
  if (!embedId) return { success: false, error: 'Missing embed_config_id / embed_id' };
  if (!channelId) return { success: false, error: 'Missing channel_id' };

  // Look up embed config (guild_id scoped for multi-guild safety)
  const { data, error: dbError } = await supabase
    .from('embed_configs')
    .select('*')
    .eq('id', embedId)
    .eq('guild_id', guild.id)
    .maybeSingle();

  if (dbError || !data) {
    return { success: false, error: `Embed config "${embedId}" not found` };
  }

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) {
    return { success: false, error: `Channel ${channelId} not found or not text-based` };
  }

  const embed = buildEmbedFromConfig(data as EmbedConfig, guild);
  const sent = await channel.send({ embeds: [embed] });

  log.info(`Embed "${data.name ?? embedId}" sent to #${channel.name}`);
  return { success: true, data: { messageId: sent.id, channelId, embedName: data.name } };
}

// ── Test Welcome Handler ──────────────────────────────

async function handleTestWelcome(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const channelId = payload.channel_id as string;
  const type = (payload.type as string) ?? 'welcome';
  if (!channelId) return { success: false, error: 'Missing channel_id' };

  const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) {
    return { success: false, error: `Channel ${channelId} not found or not text-based` };
  }

  // Load current welcome config
  const { data: configData } = await supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guild.id)
    .maybeSingle();

  // Build mock variables for the test message
  const botMember = guild.members.me;
  const mockVars: Record<string, string> = {
    user: `<@${botMember?.id ?? guild.client.user?.id ?? '0'}>`,
    'user.name': botMember?.displayName ?? 'TestUser',
    'user.tag': botMember?.user.tag ?? 'TestUser#0',
    'user.avatar': botMember?.user.displayAvatarURL({ size: 256 }) ?? '',
    server: guild.name,
    'server.icon': guild.iconURL({ size: 256 }) ?? '',
    memberCount: guild.memberCount.toLocaleString(),
    memberNumber: `#${guild.memberCount.toLocaleString()}`,
    level: '0',
    duration: '42 days',
  };

  function interpolate(template: string): string {
    return template.replace(/\{([^}]+)\}/g, (match, key: string) => {
      return mockVars[key.trim()] ?? match;
    });
  }

  const defaultWelcome = 'Welcome to {server}, {user}! 🎉 You\'re member {memberNumber}.';
  const defaultGoodbye = '{user.name} left. They were with us for {duration}. 👋';

  let messageText: string;
  if (type === 'goodbye') {
    messageText = interpolate(configData?.goodbye_message ?? defaultGoodbye);
  } else {
    messageText = interpolate(configData?.welcome_message ?? defaultWelcome);
  }

  const label = type === 'goodbye' ? '👋 Goodbye' : '🎉 Welcome';
  const sent = await channel.send(`**[TEST ${label} Preview]**\n${messageText}`);

  log.info(`Test ${type} message sent to #${channel.name}`);
  return { success: true, data: { messageId: sent.id, channelId, type } };
}

/**
 * Revoke Discord roles from a member (e.g., after a refund).
 */
const LIVE_ROLE_OWNER_STATUSES = ['active', 'pending', 'grace_period', 'suspended'];
const TEMP_ROLE_ID_PATTERN = /^\d{17,20}$/;
const MAX_TEMP_ROLE_DURATION_SECONDS = 315_360_000;

type RevokeOwnershipIdentity = {
  guildId: string;
  discordId: string;
  entitlementId: string;
  customerId: string;
  orderId: string;
  productId: string;
  terminalStatus: 'cancelled' | 'expired' | 'revoked';
};

type NonCommerceRevokeIdentity = {
  guildId: string;
  discordId: string;
  entitlementId: string;
  customerId: string;
  orderId: string | null;
  productId: string;
  entitlementType: 'one_time' | 'subscription';
  planId: string | null;
  entitlementSource: 'manual' | 'giveaway' | 'automation';
  entitlementStatus: 'cancelled' | 'expired';
};

type ClassifiedRoleOwnerTarget = {
  guildId: string;
  discordId: string;
  entitlementId: string;
};

type NonCommerceLiveIdentity = {
  guildId: string;
  newDiscordId: string;
  entitlementId: string;
  customerId: string;
  orderId: string | null;
  productId: string;
  entitlementType: 'one_time' | 'subscription';
  planId: string | null;
  entitlementSource: 'manual' | 'giveaway' | 'automation';
  entitlementStatus: 'active' | 'pending' | 'grace_period' | 'suspended';
};

type NonCommerceRelinkIdentity = NonCommerceLiveIdentity & {
  oldDiscordId: string;
  relinkGeneration: string;
  previousActivationGeneration: string | null;
};

type NonCommerceActivationIdentity = NonCommerceLiveIdentity & {
  activationGeneration: string;
};

type ClassifiedRoleOwnerState = 'confirmed' | 'pending' | 'none';
type ClassifiedRoleRepairState = ClassifiedRoleOwnerState | 'member_absent';

const NON_COMMERCE_REVOKE_SOURCE = 'noncommerce_entitlement_status_trigger';
const NON_COMMERCE_RELINK_SOURCE = 'noncommerce_entitlement_customer_relink_trigger';
const NON_COMMERCE_ACTIVATION_SOURCE = 'noncommerce_entitlement_activation_trigger';
const NON_COMMERCE_ENTITLEMENT_SOURCES = new Set(['manual', 'giveaway', 'automation']);
const LIVE_ENTITLEMENT_STATUSES = new Set(['active', 'pending', 'grace_period', 'suspended']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUnknownDiscordMember(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const rawError = record.rawError && typeof record.rawError === 'object'
    ? record.rawError as Record<string, unknown>
    : null;
  // HTTP 404 is shared by other Discord failures such as Unknown Guild
  // (10004). Only the exact Unknown Member code is authoritative absence.
  return String(record.code ?? rawError?.code ?? '') === '10007';
}

async function fetchCleanupMember(
  guild: Guild,
  discordId: string,
): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch({ user: discordId, force: true });
  } catch (error) {
    if (isUnknownDiscordMember(error)) return null;
    throw error;
  }
}

function exactSingleRpcRow(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === 'object' && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

const REVOKE_IDENTITY_FIELDS = [
  'entitlement_id',
  'customer_id',
  'order_id',
  'product_id',
] as const;

const REVOKE_ACTION_SOURCES = new Set([
  'entitlement_status_trigger',
  'entitlement_terminal_migration_backfill',
]);

const TERMINAL_REASON_TO_STATUS = {
  entitlement_cancelled: 'cancelled',
  entitlement_expired: 'expired',
  entitlement_revoked: 'revoked',
} as const;

function parseNonCommerceRevokeIdentity(
  payload: Record<string, unknown>,
  guildId: string,
  tempRoleGrantIds: string[],
): { identity: NonCommerceRevokeIdentity | null; error?: string } {
  if (payload.source !== NON_COMMERCE_REVOKE_SOURCE) return { identity: null };
  if (tempRoleGrantIds.length !== 0) {
    return { identity: null, error: 'Non-commerce revoke cannot carry temporary ownership' };
  }
  const required = [
    'discord_id',
    'entitlement_id',
    'customer_id',
    'product_id',
    'entitlement_type',
    'entitlement_source',
    'entitlement_status',
  ] as const;
  for (const field of required) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      return { identity: null, error: `Invalid non-commerce revoke ${field}` };
    }
  }
  if (
    payload.guild_id !== guildId
    || !NON_COMMERCE_ENTITLEMENT_SOURCES.has(payload.entitlement_source as string)
    || !['cancelled', 'expired'].includes(payload.entitlement_status as string)
    || !Object.hasOwn(payload, 'order_id')
    || (payload.order_id !== null
      && (typeof payload.order_id !== 'string' || !UUID_PATTERN.test(payload.order_id)))
    || !Object.hasOwn(payload, 'plan_id')
    || !['one_time', 'subscription'].includes(payload.entitlement_type as string)
    || (payload.plan_id !== null
      && (typeof payload.plan_id !== 'string' || !UUID_PATTERN.test(payload.plan_id)))
  ) {
    return { identity: null, error: 'Invalid non-commerce revoke identity payload' };
  }
  const expectedReason = `entitlement_${payload.entitlement_status as string}`;
  if (payload.reason !== expectedReason) {
    return { identity: null, error: 'Invalid non-commerce revoke terminal reason' };
  }
  return {
    identity: {
      guildId,
      discordId: payload.discord_id as string,
      entitlementId: payload.entitlement_id as string,
      customerId: payload.customer_id as string,
      orderId: payload.order_id as string | null,
      productId: payload.product_id as string,
      entitlementType: payload.entitlement_type as NonCommerceRevokeIdentity['entitlementType'],
      planId: payload.plan_id as string | null,
      entitlementSource: payload.entitlement_source as NonCommerceRevokeIdentity['entitlementSource'],
      entitlementStatus: payload.entitlement_status as NonCommerceRevokeIdentity['entitlementStatus'],
    },
  };
}

function parseNonCommerceRelinkIdentity(
  payload: Record<string, unknown>,
  guildId: string,
  tempRoleGrantIds: string[],
): { identity: NonCommerceRelinkIdentity | null; error?: string } {
  // `old_discord_id` is historical and cannot be reconstructed after commit.
  // The database permits this source only from its transaction-local relink
  // carrier trigger; the worker then revalidates every still-derivable field
  // and current customer mapping before either Discord mutation.
  if (payload.source !== NON_COMMERCE_RELINK_SOURCE) return { identity: null };
  if (tempRoleGrantIds.length !== 0) {
    return { identity: null, error: 'Non-commerce relink cannot carry temporary ownership' };
  }
  const allowed = new Set([
    'source',
    'guild_id',
    'old_discord_id',
    'discord_id',
    'entitlement_id',
    'customer_id',
    'order_id',
    'product_id',
    'entitlement_source',
    'entitlement_status',
    'entitlement_type',
    'plan_id',
    'role_ids',
    'temporary_role_grant_ids',
    'reason',
    'relink_generation',
    'previous_activation_generation',
  ]);
  if (Object.keys(payload).some((field) => !allowed.has(field))) {
    return { identity: null, error: 'Invalid non-commerce relink payload fields' };
  }
  const required = [
    'old_discord_id',
    'discord_id',
    'entitlement_id',
    'customer_id',
    'product_id',
    'entitlement_type',
    'entitlement_source',
    'entitlement_status',
    'relink_generation',
  ] as const;
  for (const field of required) {
    if (!isExactNonBlankString(payload[field])) {
      return { identity: null, error: `Invalid non-commerce relink ${field}` };
    }
  }
  if (
    payload.guild_id !== guildId
    || payload.old_discord_id === payload.discord_id
    || !NON_COMMERCE_ENTITLEMENT_SOURCES.has(payload.entitlement_source as string)
    || !LIVE_ENTITLEMENT_STATUSES.has(payload.entitlement_status as string)
    || payload.reason !== 'entitlement_customer_relinked'
    || !UUID_PATTERN.test(payload.relink_generation as string)
    || !Object.hasOwn(payload, 'previous_activation_generation')
    || (payload.previous_activation_generation !== null
      && (typeof payload.previous_activation_generation !== 'string'
        || !UUID_PATTERN.test(payload.previous_activation_generation)))
    || !Object.hasOwn(payload, 'order_id')
    || (payload.order_id !== null
      && (typeof payload.order_id !== 'string' || !UUID_PATTERN.test(payload.order_id)))
    || !Object.hasOwn(payload, 'plan_id')
    || !['one_time', 'subscription'].includes(payload.entitlement_type as string)
    || (payload.plan_id !== null
      && (typeof payload.plan_id !== 'string' || !UUID_PATTERN.test(payload.plan_id)))
  ) {
    return { identity: null, error: 'Invalid non-commerce relink identity payload' };
  }
  return {
    identity: {
      guildId,
      oldDiscordId: payload.old_discord_id as string,
      newDiscordId: payload.discord_id as string,
      entitlementId: payload.entitlement_id as string,
      customerId: payload.customer_id as string,
      orderId: payload.order_id as string | null,
      productId: payload.product_id as string,
      entitlementType: payload.entitlement_type as NonCommerceRelinkIdentity['entitlementType'],
      planId: payload.plan_id as string | null,
      entitlementSource: payload.entitlement_source as NonCommerceRelinkIdentity['entitlementSource'],
      entitlementStatus: payload.entitlement_status as NonCommerceRelinkIdentity['entitlementStatus'],
      relinkGeneration: payload.relink_generation as string,
      previousActivationGeneration: payload.previous_activation_generation as string | null,
    },
  };
}

function parseNonCommerceActivationIdentity(
  payload: Record<string, unknown>,
  guildId: string,
  tempRoleGrantIds: string[],
): { identity: NonCommerceActivationIdentity | null; error?: string } {
  if (payload.source !== NON_COMMERCE_ACTIVATION_SOURCE) return { identity: null };
  if (tempRoleGrantIds.length !== 0) {
    return { identity: null, error: 'Non-commerce activation cannot carry temporary ownership' };
  }
  const allowed = new Set([
    'source',
    'guild_id',
    'discord_id',
    'entitlement_id',
    'customer_id',
    'order_id',
    'product_id',
    'entitlement_source',
    'entitlement_status',
    'entitlement_type',
    'plan_id',
    'role_ids',
    'temporary_role_grant_ids',
    'reason',
    'activation_generation',
  ]);
  if (Object.keys(payload).some((field) => !allowed.has(field))) {
    return { identity: null, error: 'Invalid non-commerce activation payload fields' };
  }
  const required = [
    'discord_id',
    'entitlement_id',
    'customer_id',
    'product_id',
    'entitlement_type',
    'entitlement_source',
    'entitlement_status',
    'activation_generation',
  ] as const;
  for (const field of required) {
    if (!isExactNonBlankString(payload[field])) {
      return { identity: null, error: `Invalid non-commerce activation ${field}` };
    }
  }
  if (
    payload.guild_id !== guildId
    || !NON_COMMERCE_ENTITLEMENT_SOURCES.has(payload.entitlement_source as string)
    || !LIVE_ENTITLEMENT_STATUSES.has(payload.entitlement_status as string)
    || payload.reason !== 'entitlement_activated'
    || !UUID_PATTERN.test(payload.activation_generation as string)
    || !Object.hasOwn(payload, 'order_id')
    || (payload.order_id !== null
      && (typeof payload.order_id !== 'string' || !UUID_PATTERN.test(payload.order_id)))
    || !Object.hasOwn(payload, 'plan_id')
    || !['one_time', 'subscription'].includes(payload.entitlement_type as string)
    || (payload.plan_id !== null
      && (typeof payload.plan_id !== 'string' || !UUID_PATTERN.test(payload.plan_id)))
  ) {
    return { identity: null, error: 'Invalid non-commerce activation identity payload' };
  }
  return {
    identity: {
      guildId,
      newDiscordId: payload.discord_id as string,
      entitlementId: payload.entitlement_id as string,
      customerId: payload.customer_id as string,
      orderId: payload.order_id as string | null,
      productId: payload.product_id as string,
      entitlementType: payload.entitlement_type as NonCommerceActivationIdentity['entitlementType'],
      planId: payload.plan_id as string | null,
      entitlementSource: payload.entitlement_source as NonCommerceActivationIdentity['entitlementSource'],
      entitlementStatus: payload.entitlement_status as NonCommerceActivationIdentity['entitlementStatus'],
      activationGeneration: payload.activation_generation as string,
    },
  };
}

function parseRevokeOwnershipIdentity(
  payload: Record<string, unknown>,
  guildId: string,
): { identity: RevokeOwnershipIdentity | null; error?: string } {
  const hasCompleteCore = REVOKE_IDENTITY_FIELDS.every((field) => Object.hasOwn(payload, field));
  if (!hasCompleteCore) return { identity: null, error: 'Invalid revoke_roles identity payload' };

  if (typeof payload.source !== 'string' || !REVOKE_ACTION_SOURCES.has(payload.source)) {
    return { identity: null, error: 'Invalid revoke_roles action source' };
  }

  const terminalStatus = typeof payload.reason === 'string'
    ? TERMINAL_REASON_TO_STATUS[payload.reason as keyof typeof TERMINAL_REASON_TO_STATUS]
    : undefined;
  if (!terminalStatus) {
    return { identity: null, error: 'Invalid revoke_roles terminal reason' };
  }

  for (const field of REVOKE_IDENTITY_FIELDS) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      return { identity: null, error: `Invalid revoke_roles ${field}` };
    }
  }

  if (
    Object.hasOwn(payload, 'guild_id')
    && (
      typeof payload.guild_id !== 'string'
      || payload.guild_id.length === 0
      || payload.guild_id.trim() !== payload.guild_id
      || payload.guild_id !== guildId
    )
  ) {
    return { identity: null, error: 'revoke_roles guild_id does not match the action guild' };
  }
  return {
    identity: {
      guildId,
      discordId: payload.discord_id as string,
      entitlementId: payload.entitlement_id as string,
      customerId: payload.customer_id as string,
      orderId: payload.order_id as string,
      productId: payload.product_id as string,
      terminalStatus,
    },
  };
}

async function validateRevokeOrigin(
  supabase: SupabaseClient,
  identity: RevokeOwnershipIdentity,
  roleIds: string[],
  tempRoleGrantIds: string[],
): Promise<void> {
  const { data, error } = await supabase
    .from('entitlements')
    .select('id, guild_id, customer_id, order_id, product_id, plan_id, type, status, source, granted_role_ids')
    .eq('id', identity.entitlementId)
    .eq('guild_id', identity.guildId)
    .eq('customer_id', identity.customerId)
    .eq('order_id', identity.orderId)
    .eq('product_id', identity.productId)
    .maybeSingle();

  if (error) throw new Error(`revoke origin lookup failed: ${error.message}`);

  const origin = data as Record<string, unknown> | null;
  const grantedRoleIds = Array.isArray(origin?.granted_role_ids)
    ? origin.granted_role_ids
    : null;
  const grantedRoleIdSet = grantedRoleIds ? new Set(grantedRoleIds) : null;
  const hasExpectedStatus = origin?.status === identity.terminalStatus
    || (
      typeof origin?.status === 'string'
      && LIVE_ROLE_OWNER_STATUSES.includes(origin.status)
    );
  if (
    !origin
    || origin.id !== identity.entitlementId
    || origin.guild_id !== identity.guildId
    || origin.customer_id !== identity.customerId
    || origin.order_id !== identity.orderId
    || origin.product_id !== identity.productId
    || !hasExpectedStatus
    || (origin.source !== 'purchase' && origin.source !== null)
    || !grantedRoleIds
    || !grantedRoleIds.every((roleId) =>
      typeof roleId === 'string' && roleId.length > 0 && roleId.trim() === roleId)
    || grantedRoleIdSet?.size !== grantedRoleIds.length
  ) {
    throw new Error('revoke origin lookup returned a malformed or mismatched entitlement');
  }

  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('id, guild_id, customer_id, product_id, temporary_role_grants_snapshot, grant_snapshot_frozen_at')
    .eq('id', identity.orderId)
    .eq('guild_id', identity.guildId)
    .eq('customer_id', identity.customerId)
    .eq('product_id', identity.productId)
    .maybeSingle();
  if (orderError) throw new Error(`revoke order contract lookup failed: ${orderError.message}`);

  const order = orderData as Record<string, unknown> | null;
  const frozenAt = order?.grant_snapshot_frozen_at;
  const frozenSnapshot = order?.temporary_role_grants_snapshot;
  if (
    !order
    || order.id !== identity.orderId
    || order.guild_id !== identity.guildId
    || order.customer_id !== identity.customerId
    || order.product_id !== identity.productId
    || (
      frozenAt !== null
      && (
        typeof frozenAt !== 'string'
        || frozenAt.length === 0
        || !Number.isFinite(Date.parse(frozenAt))
      )
    )
    || !Array.isArray(frozenSnapshot)
  ) {
    throw new Error('revoke order contract lookup returned malformed or mismatched data');
  }

  const frozenDurations = new Map<string, number>();
  if (frozenAt === null) {
    if (frozenSnapshot.length !== 0) {
      throw new Error('legacy revoke order contains an unfrozen temporary-role snapshot');
    }
  } else {
    for (const entry of frozenSnapshot) {
      const snapshot = entry as Record<string, unknown> | null;
      if (
        !snapshot
        || typeof snapshot.role_id !== 'string'
        || !TEMP_ROLE_ID_PATTERN.test(snapshot.role_id)
        || !Number.isSafeInteger(snapshot.duration_seconds)
        || Number(snapshot.duration_seconds) <= 0
        || Number(snapshot.duration_seconds) > MAX_TEMP_ROLE_DURATION_SECONDS
        || frozenDurations.has(snapshot.role_id)
      ) {
        throw new Error('revoke order temporary-role snapshot is malformed');
      }
      frozenDurations.set(snapshot.role_id, Number(snapshot.duration_seconds));
    }
  }

  const { data: tempGrantData, error: tempGrantError } = await supabase
    .from('temp_role_grants')
    .select('id, guild_id, user_id, role_id, order_id, source, source_id, duration_seconds, grant_status, remove_on_expiry')
    .eq('order_id', identity.orderId)
    .eq('guild_id', identity.guildId)
    .order('id', { ascending: true });
  if (tempGrantError) {
    throw new Error(`revoke temporary-role provenance lookup failed: ${tempGrantError.message}`);
  }
  if (!Array.isArray(tempGrantData)) {
    throw new Error('revoke temporary-role provenance lookup returned malformed data');
  }

  if (frozenAt === null && tempGrantData.length !== 0) {
    throw new Error('legacy revoke order has unverified temporary-role provenance');
  }

  const expectedRoleIds = new Set<string>(grantedRoleIds as string[]);
  const capturedTempGrantIds = new Set(tempRoleGrantIds);
  const validatedCapturedGrantIds = new Set<string>();
  for (const rawGrant of tempGrantData) {
    const grant = rawGrant as Record<string, unknown> | null;
    if (
      !grant
      || typeof grant.id !== 'string'
      || grant.id.length === 0
      || grant.guild_id !== identity.guildId
      || grant.user_id !== identity.discordId
      || grant.order_id !== identity.orderId
      || (
        (grant.grant_status === 'removed' && grant.source !== 'commerce_reconciled')
        || (grant.grant_status !== 'removed' && grant.source !== 'commerce_purchase')
      )
      || grant.source_id !== identity.productId
      || typeof grant.remove_on_expiry !== 'boolean'
      || (
        grant.grant_status !== 'pending'
        && grant.grant_status !== 'applied'
        && grant.grant_status !== 'removed'
      )
      || typeof grant.role_id !== 'string'
      || frozenDurations.get(grant.role_id) !== grant.duration_seconds
    ) {
      throw new Error('revoke temporary-role provenance lookup returned a mismatched grant');
    }
    if (grant.remove_on_expiry && capturedTempGrantIds.has(grant.id)) {
      expectedRoleIds.add(grant.role_id);
      validatedCapturedGrantIds.add(grant.id);
    } else if (
      grant.remove_on_expiry
      && (grant.grant_status === 'pending' || grant.grant_status === 'applied')
    ) {
      // A live removal-owned row existing at action creation must have been
      // frozen into the payload. Removed rows not captured by a later refund
      // are historical tombstones and do not reclaim a manually re-added role.
      throw new Error('revoke payload omitted live temporary-role provenance');
    } else if (capturedTempGrantIds.has(grant.id)) {
      throw new Error('revoke payload captured temporary-role provenance without removal ownership');
    }
  }

  if (validatedCapturedGrantIds.size !== tempRoleGrantIds.length) {
    throw new Error('revoke temporary-role grant IDs do not match durable provenance');
  }

  if (
    expectedRoleIds.size !== roleIds.length
    || !roleIds.every((roleId) => expectedRoleIds.has(roleId))
  ) {
    throw new Error('revoke role set does not match the exact entitlement and temporary-role contract');
  }
}

async function classifyRoleOwner(
  supabase: SupabaseClient,
  identity: ClassifiedRoleOwnerTarget,
  roleId: string,
): Promise<ClassifiedRoleOwnerState> {
  const { data, error } = await supabase.rpc('commerce_classify_live_role_owner', {
    p_guild_id: identity.guildId,
    p_discord_id: identity.discordId,
    p_role_id: roleId,
    p_exclude_intent_id: null,
    // The terminal origin cannot qualify. Keeping it visible closes every
    // reactivation race: once it becomes live again, the same truth matrix
    // classifies it as pending/confirmed instead of deleting its access.
    p_exclude_entitlement_id: null,
    p_exclude_grant_ids: [],
  });
  if (error) throw new Error(`authoritative ownership classification failed: ${error.message}`);
  if (data !== 'confirmed' && data !== 'pending' && data !== 'none') {
    throw new Error('authoritative ownership classification returned malformed evidence');
  }
  return data;
}

async function removeClassifiedRepairAddedRole(
  guild: Guild,
  identity: ClassifiedRoleOwnerTarget,
  roleId: string,
  missingMemberIsAbsence = false,
): Promise<void> {
  let member = missingMemberIsAbsence
    ? await fetchCleanupMember(guild, identity.discordId)
    : await guild.members.fetch({ user: identity.discordId, force: true });
  if (!member) return;
  if (!member.roles.cache.has(roleId)) return;
  await member.roles.remove(roleId, 'SomniBot — compensate stale classified-owner repair');
  member = missingMemberIsAbsence
    ? await fetchCleanupMember(guild, identity.discordId)
    : await guild.members.fetch({ user: identity.discordId, force: true });
  if (!member) return;
  if (member.roles.cache.has(roleId)) {
    throw new Error('Discord did not confirm classified-owner repair compensation');
  }
}

async function repairConfirmedClassifiedRole(
  guild: Guild,
  supabase: SupabaseClient,
  identity: ClassifiedRoleOwnerTarget,
  roleId: string,
  reason: string,
  missingMemberIsAbsence = false,
): Promise<ClassifiedRoleRepairState> {
  let ownerState = await classifyRoleOwner(supabase, identity, roleId);
  if (ownerState !== 'confirmed') return ownerState;
  let member = missingMemberIsAbsence
    ? await fetchCleanupMember(guild, identity.discordId)
    : await guild.members.fetch({ user: identity.discordId, force: true });
  if (!member) return 'member_absent';
  if (member.roles.cache.has(roleId)) {
    return classifyRoleOwner(supabase, identity, roleId);
  }
  ownerState = await classifyRoleOwner(supabase, identity, roleId);
  if (ownerState !== 'confirmed') return ownerState;

  let addError: unknown = null;
  try {
    await member.roles.add(roleId, reason);
  } catch (error) {
    // A committed Discord add can lose its acknowledgement. Continue through
    // the post-add classifier so stale access is still compensated.
    addError = error;
  }
  try {
    ownerState = await classifyRoleOwner(supabase, identity, roleId);
  } catch (classificationError) {
    await removeClassifiedRepairAddedRole(
      guild,
      identity,
      roleId,
      missingMemberIsAbsence,
    );
    throw new Error(
      `post-repair ownership classification failed; added access was removed (${String(classificationError)})`,
    );
  }
  if (ownerState !== 'confirmed') {
    await removeClassifiedRepairAddedRole(
      guild,
      identity,
      roleId,
      missingMemberIsAbsence,
    );
    return ownerState;
  }
  member = missingMemberIsAbsence
    ? await fetchCleanupMember(guild, identity.discordId)
    : await guild.members.fetch({ user: identity.discordId, force: true });
  if (!member) return 'member_absent';
  if (!member.roles.cache.has(roleId)) {
    if (addError) {
      throw new Error(
        `Discord classified-owner repair add failed and read-back did not confirm ${roleId} (${String(addError)})`,
      );
    }
    throw new Error('Discord did not confirm classified retained role');
  }
  return 'confirmed';
}

async function handlePaidRevokeRoles(
  guild: Guild,
  supabase: SupabaseClient,
  identity: RevokeOwnershipIdentity,
  roleIds: string[],
  reason: string,
): Promise<ActionResult> {
  const target: ClassifiedRoleOwnerTarget = {
    guildId: identity.guildId,
    discordId: identity.discordId,
    entitlementId: identity.entitlementId,
  };
  const retained = new Set<string>();
  const memberAbsentResult = (): ActionResult => ({
    success: true,
    data: {
      discordId: identity.discordId,
      removed: [],
      retained: [],
      absent: [...roleIds],
      failed: [],
      reason,
    },
  });
  try {
    // Complete the full owner preflight before Discord access. The classifier
    // intentionally remains non-excluding so a reactivated origin is visible.
    for (const roleId of roleIds) {
      const ownerState = await classifyRoleOwner(supabase, target, roleId);
      if (ownerState === 'pending') {
        return {
          success: false,
          error: `Paid role ownership for ${roleId} is pending`,
          retryable: true,
          data: { discordId: identity.discordId, removed: [], retained: [], failed: roleIds, reason },
        };
      }
      if (ownerState === 'confirmed') retained.add(roleId);
    }
    for (const roleId of [...retained]) {
      const repairedState = await repairConfirmedClassifiedRole(
        guild,
        supabase,
        target,
        roleId,
        `SomniBot — repair confirmed paid role owner (${reason})`,
        true,
      );
      if (repairedState === 'member_absent') return memberAbsentResult();
      if (repairedState === 'pending') {
        return {
          success: false,
          error: `Paid role ownership for ${roleId} became pending`,
          retryable: true,
          data: { discordId: identity.discordId, removed: [], retained: [], failed: roleIds, reason },
        };
      }
      if (repairedState === 'none') retained.delete(roleId);
    }
  } catch (error) {
    return {
      success: false,
      error: `Role ownership verification failed: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      data: { discordId: identity.discordId, removed: [], retained: [], failed: roleIds, reason },
    };
  }

  let member: GuildMember | null;
  try {
    member = await fetchCleanupMember(guild, identity.discordId);
  } catch {
    return {
      success: false,
      error: `Member ${identity.discordId} could not be verified in guild`,
      retryable: true,
    };
  }
  if (!member) return memberAbsentResult();
  const removed: string[] = [];
  const absent: string[] = [];
  const failed: string[] = [];

  for (const roleId of roleIds) {
    try {
      const preRemovalState = await classifyRoleOwner(supabase, target, roleId);
      if (preRemovalState === 'pending') {
        failed.push(roleId);
        continue;
      }
      if (preRemovalState === 'confirmed') {
        const repairedState = await repairConfirmedClassifiedRole(
          guild,
          supabase,
          target,
          roleId,
          `SomniBot — repair concurrent paid role owner (${reason})`,
          true,
        );
        if (repairedState === 'member_absent') return memberAbsentResult();
        if (repairedState === 'pending') {
          failed.push(roleId);
          continue;
        }
        if (repairedState === 'confirmed') {
          retained.add(roleId);
          member = await fetchCleanupMember(guild, identity.discordId);
          if (!member) return memberAbsentResult();
          continue;
        }
      }
      retained.delete(roleId);
    } catch {
      failed.push(roleId);
      continue;
    }

    if (!member) return memberAbsentResult();
    const currentMember = member;
    if (currentMember.roles.cache.has(roleId)) {
      try {
        await currentMember.roles.remove(roleId, `SomniBot — ${reason}`);
        member = await fetchCleanupMember(guild, identity.discordId);
        if (!member) return memberAbsentResult();
        if (member.roles.cache.has(roleId)) {
          throw new Error('Discord still reports paid role after removal');
        }
        removed.push(roleId);
      } catch {
        // A rejected response may conceal a committed removal. Restore only
        // after a fresh confirmed proof, never from pending/error/unknown.
        try {
          const recoveryState = await repairConfirmedClassifiedRole(
            guild,
            supabase,
            target,
            roleId,
            `SomniBot — repair paid removal uncertainty for confirmed owner (${reason})`,
            true,
          );
          if (recoveryState === 'member_absent') return memberAbsentResult();
          if (recoveryState === 'confirmed') {
            retained.add(roleId);
            member = await fetchCleanupMember(guild, identity.discordId);
            if (!member) return memberAbsentResult();
            continue;
          }
        } catch {
          // Preserve a retry without speculatively adding access.
        }
        failed.push(roleId);
        continue;
      }
    } else {
      absent.push(roleId);
    }

    let postRemovalState: ClassifiedRoleRepairState;
    try {
      postRemovalState = await classifyRoleOwner(supabase, target, roleId);
    } catch {
      failed.push(roleId);
      continue;
    }
    if (postRemovalState === 'pending') {
      failed.push(roleId);
      continue;
    }
    if (postRemovalState === 'confirmed') {
      try {
        postRemovalState = await repairConfirmedClassifiedRole(
          guild,
          supabase,
          target,
          roleId,
          `SomniBot — repair post-removal paid role owner (${reason})`,
          true,
        );
      } catch {
        failed.push(roleId);
        continue;
      }
      if (postRemovalState === 'member_absent') return memberAbsentResult();
      if (postRemovalState === 'pending') {
        failed.push(roleId);
        continue;
      }
      if (postRemovalState === 'confirmed') {
        retained.add(roleId);
        const removedIndex = removed.indexOf(roleId);
        if (removedIndex >= 0) removed.splice(removedIndex, 1);
        const absentIndex = absent.indexOf(roleId);
        if (absentIndex >= 0) absent.splice(absentIndex, 1);
        member = await fetchCleanupMember(guild, identity.discordId);
        if (!member) return memberAbsentResult();
      }
    }
  }

  if (failed.length > 0) {
    return {
      success: false,
      error: `Failed to converge ${failed.length} paid role cleanup(s)`,
      retryable: true,
      data: { discordId: identity.discordId, removed, retained: [...retained], absent, failed, reason },
    };
  }
  return {
    success: true,
    data: { discordId: identity.discordId, removed, retained: [...retained], absent, failed, reason },
  };
}

async function handleNonCommerceActivationRoles(
  guild: Guild,
  supabase: SupabaseClient,
  identity: NonCommerceActivationIdentity,
  roleIds: string[],
  reason: string,
  context: ClaimedActionContext,
): Promise<ActionResult> {
  const service = new EntitlementService(guild, supabase, eventBus);
  const contract = {
    customerId: identity.customerId,
    productId: identity.productId,
    orderId: identity.orderId,
    planId: identity.planId,
    discordId: identity.newDiscordId,
    grantedRoleIds: roleIds,
    entitlementType: identity.entitlementType,
    entitlementSource: identity.entitlementSource,
    activationGeneration: identity.activationGeneration,
  };
  try {
    const begun = await service.beginNonCommerceRoleDeliveryAttempt(
      identity.entitlementId,
      contract,
      context,
    );
    if (begun.state === 'superseded' || begun.state === 'unproven') {
      return {
        success: true,
        data: {
          entitlementId: identity.entitlementId,
          activationGeneration: identity.activationGeneration,
          outcome: begun.state,
          reason,
        },
      };
    }
    if (begun.state === 'operator_held') {
      return {
        success: false,
        error: `Non-commerce activation intent ${begun.intentId} requires operator recovery`,
        retryable: true,
      };
    }
    if (begun.state === 'confirmed_live') {
      return {
        success: true,
        data: {
          entitlementId: identity.entitlementId,
          activationGeneration: identity.activationGeneration,
          deliveryIntentId: begun.intentId,
          outcome: 'live_confirmed_replay',
          reason,
        },
      };
    }
    if (begun.state === 'terminal') {
      if (begun.cleanupNeeded) {
        const cleanup = await service.executeOwnedPurchaseRoleCleanup(
          begun.intentId,
          context,
        );
        if (!cleanup.settled) {
          throw new Error('Non-commerce activation terminal cleanup remains unresolved');
        }
      }
      return {
        success: true,
        data: {
          entitlementId: identity.entitlementId,
          activationGeneration: identity.activationGeneration,
          deliveryIntentId: begun.intentId,
          outcome: 'terminal_noop',
          reason,
        },
      };
    }

    let outcome = await service.reconcileNonCommerceGrantedRoles(
      contract,
      begun.attempt,
    );
    let finalized = service.getActivePurchaseRoleDeliveryAttempt()?.intentId
      === begun.attempt.intentId
      ? await service.finishPurchaseRoleDeliveryAttempt(
        begun.attempt,
        outcome === 'live' ? 'live' : 'compensated',
      )
      : {
        state: 'settled',
        settled: true,
        authorityEmpty: true,
        disposition: 'settled' as const,
      };
    if (finalized.disposition === 'run_origin_cleanup') {
      const cleanup = await service.executeOwnedPurchaseRoleCleanup(
        begun.attempt.intentId,
        context,
      );
      if (!cleanup.settled) {
        throw new Error('Non-commerce activation origin cleanup remains unresolved');
      }
      outcome = 'terminal';
      finalized = {
        state: 'settled',
        settled: true,
        authorityEmpty: true,
        disposition: 'settled',
      };
    }
    const validOwnedLive = finalized.state === 'open'
      && !finalized.settled
      && !finalized.authorityEmpty;
    const validZeroAuthorityLive = finalized.state === 'settled'
      && finalized.settled
      && finalized.authorityEmpty;
    if (outcome === 'live' && !validOwnedLive && !validZeroAuthorityLive) {
      throw new Error('Non-commerce activation intent did not become confirmed and idle');
    }
    if (outcome === 'terminal' && (!finalized.settled || !finalized.authorityEmpty)) {
      throw new Error('Non-commerce activation terminal compensation did not settle');
    }
    return {
      success: true,
      data: {
        entitlementId: identity.entitlementId,
        activationGeneration: identity.activationGeneration,
        deliveryIntentId: begun.attempt.intentId,
        outcome: outcome === 'live' ? 'live_confirmed' : 'terminal_compensated',
        reason,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
      data: {
        entitlementId: identity.entitlementId,
        activationGeneration: identity.activationGeneration,
        reason,
      },
    };
  }
}

type NonCommerceCleanupDisposition =
  | 'ready'
  | 'settled_noop'
  | 'destination_pending'
  | 'destination_unproven'
  | 'superseded'
  | 'unproven'
  | 'operator_held';

async function requestNonCommerceRelinkActivation(
  supabase: SupabaseClient,
  context: ClaimedActionContext,
): Promise<{ activationActionId: string | null; disposition: 'enqueued' | 'superseded' }> {
  const { data, error } = await (
    supabase.rpc as (
      fn: string,
      params: Record<string, unknown>,
    ) => ReturnType<typeof supabase.rpc>
  )('commerce_request_noncommerce_relink_activation', {
    p_action_id: context.actionId,
    p_claim_token: context.claimToken,
  });
  if (error) throw new Error(`Non-commerce relink activation request failed: ${error.message}`);
  const row = exactSingleRpcRow(data);
  if (
    !row
    || (row.activation_action_id !== null && !isExactNonBlankString(row.activation_action_id))
    || (row.disposition !== 'enqueued' && row.disposition !== 'superseded')
    || (row.disposition === 'enqueued' && !isExactNonBlankString(row.activation_action_id))
  ) {
    throw new Error('Non-commerce relink activation request returned malformed evidence');
  }
  return {
    activationActionId: row.activation_action_id as string | null,
    disposition: row.disposition,
  };
}

async function prepareNonCommerceRoleCleanup(
  supabase: SupabaseClient,
  context: ClaimedActionContext,
): Promise<{ intentId: string | null; disposition: NonCommerceCleanupDisposition }> {
  const { data, error } = await (
    supabase.rpc as (
      fn: string,
      params: Record<string, unknown>,
    ) => ReturnType<typeof supabase.rpc>
  )('commerce_prepare_noncommerce_role_delivery_cleanup', {
    p_action_id: context.actionId,
    p_claim_token: context.claimToken,
  });
  if (error) throw new Error(`Non-commerce role cleanup preparation failed: ${error.message}`);
  const row = exactSingleRpcRow(data);
  const dispositions: NonCommerceCleanupDisposition[] = [
    'ready',
    'settled_noop',
    'destination_pending',
    'destination_unproven',
    'superseded',
    'unproven',
    'operator_held',
  ];
  if (
    !row
    || (row.intent_id !== null && !isExactNonBlankString(row.intent_id))
    || typeof row.disposition !== 'string'
    || !dispositions.includes(row.disposition as NonCommerceCleanupDisposition)
    || (['ready', 'settled_noop', 'operator_held'].includes(row.disposition)
      && !isExactNonBlankString(row.intent_id))
  ) {
    throw new Error('Non-commerce role cleanup preparation returned malformed evidence');
  }
  return {
    intentId: row.intent_id as string | null,
    disposition: row.disposition as NonCommerceCleanupDisposition,
  };
}

async function deferNonCommerceRelinkCleanup(
  supabase: SupabaseClient,
  context: ClaimedActionContext,
): Promise<'deferred' | 'stale_claim'> {
  const { data, error } = await (
    supabase.rpc as (
      fn: string,
      params: Record<string, unknown>,
    ) => ReturnType<typeof supabase.rpc>
  )('commerce_defer_noncommerce_relink_cleanup', {
    p_action_id: context.actionId,
    p_claim_token: context.claimToken,
  });
  if (error) throw new Error(`Non-commerce relink cleanup deferral failed: ${error.message}`);
  const row = exactSingleRpcRow(data);
  if (
    !row
    || typeof row.applied !== 'boolean'
    || (row.disposition !== 'deferred' && row.disposition !== 'stale_claim')
    || row.applied !== (row.disposition === 'deferred')
  ) {
    throw new Error('Non-commerce relink cleanup deferral returned malformed evidence');
  }
  return row.disposition;
}

async function handleNonCommerceCleanupCarrier(
  guild: Guild,
  supabase: SupabaseClient,
  identity: NonCommerceRevokeIdentity | NonCommerceRelinkIdentity,
  reason: string,
  context: ClaimedActionContext,
  kind: 'terminal' | 'relink',
): Promise<ActionResult> {
  try {
    let activationActionId: string | null = null;
    const prepared = await prepareNonCommerceRoleCleanup(supabase, context);
    if (prepared.disposition === 'destination_pending') {
      if (kind !== 'relink') {
        throw new Error('Terminal non-commerce cleanup returned a relink-only dependency');
      }
      const activation = await requestNonCommerceRelinkActivation(supabase, context);
      activationActionId = activation.activationActionId;
      if (activation.disposition === 'superseded') {
        return {
          success: true,
          data: {
            entitlementId: identity.entitlementId,
            outcome: 'superseded',
            reason,
          },
        };
      }
      const deferred = await deferNonCommerceRelinkCleanup(supabase, context);
      return {
        success: false,
        error: deferred === 'deferred'
          ? 'Waiting for current non-commerce destination activation'
          : 'Non-commerce cleanup claim was no longer current',
        retryable: true,
        claimTransition: 'deferred',
        data: {
          entitlementId: identity.entitlementId,
          activationActionId,
          outcome: deferred,
          reason,
        },
      };
    }
    if (prepared.disposition === 'operator_held') {
      return {
        success: false,
        error: `Non-commerce cleanup intent ${prepared.intentId} requires operator recovery`,
        retryable: true,
      };
    }
    if (
      prepared.disposition === 'settled_noop'
      || prepared.disposition === 'destination_unproven'
      || prepared.disposition === 'superseded'
      || prepared.disposition === 'unproven'
    ) {
      return {
        success: true,
        data: {
          entitlementId: identity.entitlementId,
          deliveryIntentId: prepared.intentId,
          activationActionId,
          outcome: prepared.disposition,
          reason,
        },
      };
    }
    if (!prepared.intentId) {
      throw new Error('Ready non-commerce cleanup omitted its exact delivery intent');
    }
    const service = new EntitlementService(guild, supabase, eventBus);
    const cleanup = await service.executeOwnedPurchaseRoleCleanup(
      prepared.intentId,
      context,
    );
    if (!cleanup.settled) {
      throw new Error('Non-commerce exact-owned role cleanup remains unresolved');
    }
    return {
      success: true,
      data: {
        entitlementId: identity.entitlementId,
        deliveryIntentId: prepared.intentId,
        activationActionId,
        outcome: 'settled_cleanup',
        reason,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
      data: { entitlementId: identity.entitlementId, reason },
    };
  }
}

export async function handleRevokeRoles(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  context: ClaimedActionContext = { actionId: '', claimToken: '' },
): Promise<ActionResult> {
  const discordId = payload.discord_id;
  const rawRoleIds = payload.role_ids;
  const rawTempRoleGrantIds = payload.temporary_role_grant_ids;
  const reason = typeof payload.reason === 'string' && payload.reason.length > 0
    ? payload.reason
    : 'Role revocation';

  if (typeof discordId !== 'string' || discordId.length === 0 || discordId.trim() !== discordId) {
    return { success: false, error: 'Missing required valid discord_id', retryable: false };
  }
  if (
    !Array.isArray(rawRoleIds)
    || rawRoleIds.length === 0
    || !rawRoleIds.every((roleId) =>
      typeof roleId === 'string' && roleId.length > 0 && roleId.trim() === roleId)
  ) {
    return { success: false, error: 'Missing required valid role_ids', retryable: false };
  }
  if (new Set(rawRoleIds as string[]).size !== rawRoleIds.length) {
    return { success: false, error: 'Duplicate role_ids are not allowed', retryable: false };
  }
  const roleIds = [...new Set(rawRoleIds as string[])];
  if (
    !Array.isArray(rawTempRoleGrantIds)
    || !rawTempRoleGrantIds.every((grantId) =>
      typeof grantId === 'string' && grantId.length > 0 && grantId.trim() === grantId)
    || new Set(rawTempRoleGrantIds).size !== rawTempRoleGrantIds.length
  ) {
    return { success: false, error: 'Missing required valid temporary_role_grant_ids', retryable: true };
  }
  const tempRoleGrantIds = rawTempRoleGrantIds as string[];

  const nonCommerceActivationIdentity = parseNonCommerceActivationIdentity(
    payload,
    guild.id,
    tempRoleGrantIds,
  );
  if (nonCommerceActivationIdentity.error) {
    return { success: false, error: nonCommerceActivationIdentity.error, retryable: false };
  }
  if (nonCommerceActivationIdentity.identity) {
    return handleNonCommerceActivationRoles(
      guild,
      supabase,
      nonCommerceActivationIdentity.identity,
      roleIds,
      reason,
      context,
    );
  }

  const nonCommerceRelinkIdentity = parseNonCommerceRelinkIdentity(
    payload,
    guild.id,
    tempRoleGrantIds,
  );
  if (nonCommerceRelinkIdentity.error) {
    return { success: false, error: nonCommerceRelinkIdentity.error, retryable: false };
  }
  if (nonCommerceRelinkIdentity.identity) {
    return handleNonCommerceCleanupCarrier(
      guild,
      supabase,
      nonCommerceRelinkIdentity.identity,
      reason,
      context,
      'relink',
    );
  }

  const nonCommerceIdentity = parseNonCommerceRevokeIdentity(
    payload,
    guild.id,
    tempRoleGrantIds,
  );
  if (nonCommerceIdentity.error) {
    return { success: false, error: nonCommerceIdentity.error, retryable: false };
  }
  if (nonCommerceIdentity.identity) {
    return handleNonCommerceCleanupCarrier(
      guild,
      supabase,
      nonCommerceIdentity.identity,
      reason,
      context,
      'terminal',
    );
  }

  const parsedIdentity = parseRevokeOwnershipIdentity(payload, guild.id);
  if (parsedIdentity.error) {
    return { success: false, error: parsedIdentity.error, retryable: true };
  }

  if (!parsedIdentity.identity) {
    return { success: false, error: 'Invalid revoke_roles identity payload', retryable: true };
  }
  try {
    await validateRevokeOrigin(
      supabase,
      parsedIdentity.identity,
      roleIds,
      tempRoleGrantIds,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Role ownership verification failed: ${detail}`,
      retryable: true,
      data: { discordId, removed: [], retained: [], failed: roleIds, reason },
    };
  }
  return handlePaidRevokeRoles(
    guild,
    supabase,
    parsedIdentity.identity,
    roleIds,
    reason,
  );
}

/**
 * Handle manual reconciliation trigger from the dashboard.
 */
async function handleRunReconciliation(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const trigger = (payload.trigger as string) || 'manual';
  try {
    await runReconciliation(guild, supabase, trigger as 'manual' | 'scheduled' | 'startup');
    return { success: true, data: { trigger } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Reconciliation failed: ${msg}` };
  }
}

// V53-M4: Retry failed inventory returns from market cancel/buy failures.
// Queued automatically when economy_upsert_inventory fails during market operations.
async function handleMarketItemReconcile(
  _guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const guildId = payload.guild_id as string;
  const userId = payload.user_id as string;
  const itemId = payload.item_id as string;
  const quantity = payload.quantity as number;

  if (!guildId || !userId || !itemId || !quantity) {
    return { success: false, error: 'Missing required fields for market item reconcile' };
  }

  const { error } = await supabase.rpc('economy_upsert_inventory', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  if (error) {
    return { success: false, error: `Inventory return still failing: ${error.message}` };
  }

  log.info(`market_item_reconcile: returned ${quantity}x ${payload.item_name ?? itemId} to ${userId}`);
  return { success: true, data: { userId, itemId, quantity } };
}

/**
 * Emit a platform event from the dashboard via the action queue.
 * Used for audit logging of dashboard-side operations (webhook CRUD, etc.)
 * where the PlatformEventBus is only available bot-side. (Finding #4)
 */
async function handleEmitAuditEvent(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const event = parseActionQueuePlatformEvent(payload);
  if (!event) {
    return {
      success: false,
      error: 'Malformed or disallowed action-queue platform event',
      retryable: false,
    };
  }

  eventBus.emit(event.type, guild.id, event.data);

  return { success: true, data: { eventType: event.type } };
}

/**
 * Bulk add a single role to a member (queued by dashboard bulk operations).
 */
async function handleBulkRoleAdd(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const memberId = payload.member_id as string;
  const roleId = payload.role_id as string;
  if (!memberId) return { success: false, error: 'Missing member_id' };
  if (!roleId) return { success: false, error: 'Missing role_id' };

  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return { success: false, error: `Member ${memberId} not found in guild` };

  if (member.roles.cache.has(roleId)) {
    return { success: true, data: { memberId, roleId, skipped: true } };
  }

  await member.roles.add(roleId, 'SomniBot dashboard — bulk role assign');
  return { success: true, data: { memberId, roleId } };
}

/**
 * Bulk remove a single role from a member (queued by dashboard bulk operations).
 */
async function handleBulkRoleRemove(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const memberId = payload.member_id as string;
  const roleId = payload.role_id as string;
  if (!memberId) return { success: false, error: 'Missing member_id' };
  if (!roleId) return { success: false, error: 'Missing role_id' };

  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return { success: false, error: `Member ${memberId} not found in guild` };

  if (!member.roles.cache.has(roleId)) {
    return { success: true, data: { memberId, roleId, skipped: true } };
  }

  await member.roles.remove(roleId, 'SomniBot dashboard — bulk role remove');
  return { success: true, data: { memberId, roleId } };
}

/**
 * Send a DM to a single member (queued by dashboard bulk operations).
 */
async function handleBulkSendDm(
  guild: Guild,
  _supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const memberId = payload.member_id as string;
  const message = payload.message as string;
  if (!memberId) return { success: false, error: 'Missing member_id' };
  if (!message) return { success: false, error: 'Missing message' };

  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return { success: false, error: `Member ${memberId} not found in guild` };

  await member.send(message);
  return { success: true, data: { memberId } };
}

function getQueuedDriftItem(payload: Record<string, unknown>): DriftItem | null {
  const driftItem = payload.driftItem;
  if (!driftItem || typeof driftItem !== 'object') return null;
  return driftItem as DriftItem;
}

function isPermissionOverwriteDrift(driftItem: DriftItem): boolean {
  return driftItem.type === 'PERMISSION_DRIFT' &&
    (driftItem.entityType === 'channel' || driftItem.entityType === 'category');
}

function stringDetail(driftItem: DriftItem, key: string): string | undefined {
  const detail = driftItem.details?.[key];
  const actual = detail?.actual;
  const expected = detail?.expected;
  if (typeof actual === 'string' && actual.trim()) return actual.trim();
  if (typeof expected === 'string' && expected.trim()) return expected.trim();
  return undefined;
}

function hasStructuredPermissionOverwriteDetails(driftItem: DriftItem): boolean {
  if (driftItem.entityType !== 'channel') return false;
  const rawTemplateKey = (driftItem as DriftItem & { template_key?: unknown }).template_key;
  const channelKey = driftItem.templateKey
    ?? (typeof rawTemplateKey === 'string' && rawTemplateKey.trim() ? rawTemplateKey.trim() : undefined)
    ?? stringDetail(driftItem, 'overrideChannelKey');
  const roleKey = stringDetail(driftItem, 'overrideRoleKey');
  const roleId = stringDetail(driftItem, 'overrideRoleId');
  return Boolean(
    driftItem.entityDiscordId &&
    channelKey &&
    roleKey &&
    (roleId || roleKey === 'everyone'),
  );
}

async function handleSyncRepairDrift(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const driftItem = getQueuedDriftItem(payload);
  if (!driftItem) return { success: false, error: 'Missing required driftItem' };
  if (
    driftItem.type === 'PERMISSION_DRIFT' &&
    (driftItem.entityType === 'channel' || driftItem.entityType === 'category')
  ) {
    return {
      success: false,
      error: `${driftItem.entityType} permission drift repair requires manual review`,
      retryable: false,
    };
  }
  return repairDriftItem(guild, supabase, driftItem);
}

async function handleSyncAcceptDrift(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const driftItem = getQueuedDriftItem(payload);
  if (!driftItem) return { success: false, error: 'Missing required driftItem' };
  if (isPermissionOverwriteDrift(driftItem) && !hasStructuredPermissionOverwriteDetails(driftItem)) {
    return {
      success: false,
      error: `${driftItem.entityType} permission drift accept requires structured permission overwrite details`,
      retryable: false,
    };
  }
  const result = await acceptDriftItem(guild, supabase, driftItem);
  if (isPermissionOverwriteDrift(driftItem) && !result.success) {
    return { ...result, retryable: false };
  }
  return result;
}

async function handleSyncIgnoreDrift(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const driftItem = getQueuedDriftItem(payload);
  if (!driftItem) return { success: false, error: 'Missing required driftItem' };
  return ignoreDriftItem(supabase, guild.id, driftItem);
}

async function handleSyncClearAllDrift(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<ActionResult> {
  await clearAllDrift(supabase, guild.id);
  return { success: true };
}

/**
 * Retry a failed trivia winner payout (X2/39). TriviaManager queues
 * `trivia_payout_retry` when the primary economy_add_balance credit fails —
 * this handler was MISSING, so every retry burned its budget on
 * "Unknown action", dead-lettered, and the owed winner was never paid.
 *
 * The credit is keyed with the SAME idempotency key the primary payout used
 * (trivia:${roundId}:${userId}), so a retry that lands after a
 * partial success (credit committed, response lost) replays as a no-op
 * instead of double-paying. Rows queued before round ids existed carry no
 * round_id and retry unkeyed — single-shot legacy rows, same as before —
 * and never auto-resolve alerts (no round-scoped match is possible).
 */
async function handleTriviaPayoutRetry(
  guild: Guild,
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
  if (!userId) return { success: false, error: 'Missing user_id', retryable: false };

  const rawAmount = payload.amount;
  const amount =
    typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.floor(rawAmount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: `Invalid payout amount: ${String(rawAmount)}`, retryable: false };
  }

  const roundId = typeof payload.round_id === 'string' && payload.round_id ? payload.round_id : null;

  const rpcArgs: Record<string, unknown> = {
    p_guild_id: guild.id,
    p_user_id: userId,
    p_amount: amount,
  };
  if (roundId) rpcArgs.p_idempotency_key = `trivia:${roundId}:${userId}`;

  const { error } = await supabase.rpc('economy_add_balance', rpcArgs as never);
  if (error) {
    return { success: false, error: `Trivia payout retry failed: ${error.message}` };
  }

  if (roundId) {
    // The winner is paid — resolve the matching payout-failed alert with a
    // recovery notice (#51). Best effort; resolveOwnerAlert never throws.
    await resolveOwnerAlert(
      supabase,
      guild.id,
      'trivia_payout_failed',
      { user_id: userId, round_id: roundId },
      {
        guild,
        notice: `The queued trivia payout of ${amount} to <@${userId}> succeeded on retry.`,
      },
    );
  } else {
    // Legacy pre-round_id row: a {user_id}-only contains-match could close a
    // DIFFERENT round's still-owed alert for the same user, so resolve
    // NOTHING — the owner clears any stale alert from the dashboard. These
    // rows also retry unkeyed (no idempotency key), so the single-shot
    // double-pay window (credit landed, response lost, retry replays) stays
    // accepted for them: they drain once and can never be re-queued.
    log.info(
      `Legacy trivia payout retry (no round_id) paid ${amount} to ${userId} in guild ${guild.id} — ` +
        `leaving any trivia_payout_failed alert for manual resolution`,
    );
  }

  return { success: true, data: { userId, amount, roundId } };
}

// Exported for tests: registration coverage (the X2/39 dead letter was an
// action queued with NO registered handler) + direct handler unit tests.
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  create_role: handleCreateRole,
  update_role: handleUpdateRole,
  delete_role: handleDeleteRole,
  create_channel: handleCreateChannel,
  update_channel: handleUpdateChannel,
  delete_channel: handleDeleteChannel,
  create_category: handleCreateCategory,
  delete_category: handleDeleteCategory,
  fulfill_purchase: handleFulfillment,
  fulfill_subscription: handleFulfillment,
  fulfill_cancellation: handleFulfillment,
  fulfill_suspension: handleFulfillment,
  [RECEIPT_DELIVERY_ACTION]: handleDeliverReceipt,
  config_reload: handleConfigReload,
  send_embed: handleSendEmbed,
  test_welcome: handleTestWelcome,
  fulfill_giveaway_prize: handleGiveawayPrizeFulfillment,
  notify_giveaway_winner: handleGiveawayWinnerNotification,
  run_reconciliation: handleRunReconciliation,
  reconcile_entitlement_roles: handleReconcileEntitlementRoles,
  revoke_roles: handleRevokeRoles,
  market_item_reconcile: handleMarketItemReconcile,
  bulk_role_add: handleBulkRoleAdd,
  bulk_role_remove: handleBulkRoleRemove,
  bulk_send_dm: handleBulkSendDm,
  emit_audit_event: handleEmitAuditEvent,
  trivia_payout_retry: handleTriviaPayoutRetry,
  sync_repair_drift: handleSyncRepairDrift,
  sync_accept_drift: handleSyncAcceptDrift,
  sync_ignore_drift: handleSyncIgnoreDrift,
  sync_clear_all_drift: handleSyncClearAllDrift,
};

// V5 Audit §6.5: in-process retry budget for transient handler failures
// (exponential backoff 30s → 60s → 120s — see processAction below).
const HANDLER_MAX_RETRIES = 3;

// Payload fields that must never be copied into audit_logs. Queue and DLQ
// rows intentionally keep the plaintext license key so a failed delivery
// stays retryable (license_keys stores only hash/prefix/suffix at rest),
// but audit_logs has long, guild-configurable retention (default 180 days)
// — the audit trail only needs to know the field was present, not its value.
const SENSITIVE_AUDIT_PAYLOAD_FIELDS = ['license_key_plaintext'] as const;

/**
 * Return a copy of the action payload safe for the audit trail: sensitive
 * fields (currently the plaintext license key carried by deliver_receipt and
 * fulfill_* payloads) are replaced with '[REDACTED]'. Never mutates the
 * original — the live payload must keep the key for retries.
 */
export function redactPayloadForAudit(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (payload == null || typeof payload !== 'object') return {};
  let redacted: Record<string, unknown> = payload;
  for (const field of SENSITIVE_AUDIT_PAYLOAD_FIELDS) {
    if (field in redacted && redacted[field] !== undefined) {
      if (redacted === payload) redacted = { ...payload };
      redacted[field] = '[REDACTED]';
    }
  }
  return redacted;
}

async function processAction(
  guild: Guild,
  supabase: SupabaseClient,
  action: ActionRow,
  scheduler: LaneScheduler,
): Promise<void> {
  // V48-C3: atomic claim. Two paths feed processAction (the startup
  // `pending` sweep and the Realtime INSERT subscription), and a third
  // path (`bot_action_queue_recover_stale`) re-queues rows that crashed
  // mid-process. Without an atomic claim, two of those paths can both
  // pick up the same row, double-creating Discord entities, double-
  // fulfilling orders, or duplicating role revokes. The RPC returns
  // the row iff status was still 'pending' when this caller flipped it.
  // V5 Audit §6.P3a: Use unknown-schema cast to call RPCs not in generated types.
  const { data: claimed, error: claimErr } = await (
    supabase.rpc as (fn: string, params: Record<string, unknown>) => ReturnType<typeof supabase.rpc>
  )('bot_action_queue_claim', {
    p_action_id: action.id,
    p_protocol_version: ACTION_QUEUE_CLAIM_PROTOCOL_VERSION,
  });
  if (claimErr) {
    log.error(`Claim RPC failed for ${action.id}:`, claimErr.message);
    return;
  }
  const claimedValue = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claimedValue) {
    log.info(`Skipping ${action.id} — already claimed by another worker`);
    return;
  }

  // Realtime and sweeps provide only a candidate id. The pre-claim row may
  // already be stale; action, payload, lane, retry generation, and token all
  // come exclusively from the atomic claim result.
  const claimedAction = parseClaimedActionRow(claimedValue, action.id, guild.id);
  if (!claimedAction) {
    log.error(`Claim RPC returned malformed or mismatched evidence for ${action.id}`);
    return;
  }

  log.info(`Processing: ${claimedAction.action} (${claimedAction.id})`);

  const handler = ACTION_HANDLERS[claimedAction.action];
  let result: ActionResult;

  if (!handler) {
    if (claimedAction.action === 'refresh_snapshot') {
      await writeGuildSnapshot(guild, supabase);
      result = { success: true };
    } else {
      result = { success: false, error: `Unknown action: ${claimedAction.action}` };
    }
  } else {
    try {
      result = await handler(guild, supabase, claimedAction.payload, {
        actionId: claimedAction.id,
        claimToken: claimedAction.claim_token,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Error processing ${claimedAction.action}:`, msg);
      result = { success: false, error: msg };
    }
  }

  // Some dependency waits atomically relinquish this exact claim in SQL and
  // return the row to pending without consuming its retry budget. The local
  // worker must not retry or finalize a claim token that the database already
  // retired; the periodic sweep will pick it up after next_retry_at.
  if (result.claimTransition === 'deferred') {
    log.info(`Deferred ${claimedAction.action} (${claimedAction.id}) to its durable dependency`);
    return;
  }

  // V5 Audit §6.5: On transient failures, schedule an immediate retry with
  // exponential backoff (30s → 60s → 120s) before giving up and marking as
  // failed. The stale-recovery sweep catches crash failures (5-min timeout),
  // but handler-level errors should retry sooner.
  let retryFinalDisposition: FinalClaimDisposition | null = null;
  if (!result.success) {
    const retryCount = claimedAction.retry_count + 1;
    const isTransient = result.retryable !== false &&
                        !result.error?.includes('Unknown action') &&
                        !result.error?.includes('Missing required');

    if (isTransient && retryCount <= HANDLER_MAX_RETRIES) {
      const backoffMs = Math.min(30_000 * Math.pow(2, retryCount - 1), 120_000);

      // next_retry_at persists the backoff schedule: the row goes back to
      // 'pending' for crash-safety, but sweeps must not pick it up before
      // the backoff elapses (the in-process setTimeout below is the primary
      // retry path; the periodic sweep is the catch-up if the process dies).
      const retryParams = {
        p_action_id: claimedAction.id,
        p_claim_token: claimedAction.claim_token,
        p_error: result.error ?? null,
        p_next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
      };
      let retryTransition: ReturnType<typeof parseRetryClaimTransition> = null;
      for (let transitionAttempt = 0; transitionAttempt < 2; transitionAttempt++) {
        const { data: retryEvidence, error: retryError } = await (
          supabase.rpc as (
            fn: string,
            params: Record<string, unknown>,
          ) => ReturnType<typeof supabase.rpc>
        )('bot_action_queue_retry_claim', retryParams);
        if (retryError) {
          log.warn(`Retry transition failed for ${claimedAction.id}: ${retryError.message}`);
          return;
        }
        retryTransition = parseRetryClaimTransition(retryEvidence);
        if (!retryTransition) {
          log.warn(`Retry transition returned malformed evidence for ${claimedAction.id}`);
          return;
        }
        if (retryTransition.disposition !== 'intent_raced') break;
      }

      if (!retryTransition || retryTransition.disposition === 'intent_raced') {
        log.warn(`Retry transition could not resolve an intent race for ${claimedAction.id}`);
        return;
      }
      if (retryTransition.disposition === 'stale_claim') {
        log.warn(`Retry claim was no longer current for ${claimedAction.id}`);
        return;
      }
      if (retryTransition.disposition === 'completed') {
        // The handler response was lost or stale, but exact durable delivery
        // evidence atomically completed the queue row. Do not call the claim
        // finalizer again against a row that is already terminal.
        retryFinalDisposition = 'completed_from_evidence';
      } else if (retryTransition.disposition === 'operator_held') {
        // SQL atomically failed/dead-lettered the unsafe claim and signalled
        // its durable operator hold. Preserve that final failure in audit.
        retryFinalDisposition = 'failed';
      } else {
        // `requeued` is the sole transition that permits a local retry timer.
        // Any false/stale/evidence disposition above deliberately bypasses it.
        log.info(
          `Scheduling retry #${retryCount} for ${claimedAction.id} `
          + `in ${backoffMs / 1000}s`,
        );
        setTimeout(() => {
          scheduler
            .run(claimedAction.lane, () => processAction(guild, supabase, claimedAction, scheduler))
            .catch((e) => {
              log.error(`Retry #${retryCount} failed for ${claimedAction.id}:`, e);
            });
        }, backoffMs);

        return; // Don't mark as failed yet — retry scheduled
      }
    }

    // This failure is FINAL. Token-aware finalization below must win before
    // any dead-letter/audit side effect is emitted.
  }

  // Mark completed/failed only if this exact claim generation remains
  // current. A successful paid delivery may retain a confirmed, idle OPEN
  // intent as long-lived removal authority; the SQL finalizer accepts that
  // exact state as well as a zero-authority settled tombstone.
  let finalDisposition: FinalClaimDisposition | null = retryFinalDisposition;
  if (finalDisposition === null) {
    const { data: finishApplied, error: finishError } = await (
      supabase.rpc as (
        fn: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof supabase.rpc>
    )('bot_action_queue_finish_claim', {
      p_action_id: claimedAction.id,
      p_claim_token: claimedAction.claim_token,
      p_success: result.success,
      p_result: result.data ?? null,
      p_error: result.error ?? null,
    });
    if (finishError) {
      log.warn(`Final claim transition failed for ${claimedAction.id}: ${finishError.message}`);
      return;
    }
    finalDisposition = parseFinalClaimTransition(finishApplied, result.success);
  }
  if (finalDisposition === null) {
    log.warn(`Final claim was no longer current for ${claimedAction.id}`);
    return;
  }
  const finalSuccess = finalDisposition !== 'failed';

  // Audit log. The payload is redacted first: deliver_receipt / fulfill_*
  // payloads carry the plaintext license key (by design, for retryability),
  // and audit_logs retention is far too long to hold a copy of it.
  // Category deliberately stays the 'system' default: these bot.* rows come
  // from a generic dispatcher, not any one feature bucket.
  await writeAuditLog(supabase, {
    guildId: guild.id,
    actorType: 'dashboard',
    actorId: 'action-queue',
    action: `bot.${claimedAction.action}`,
    details: {
      actionId: claimedAction.id,
      payload: redactPayloadForAudit(claimedAction.payload),
      result: result.data,
      finalDisposition,
    },
    success: finalSuccess,
    errorMessage: finalSuccess ? undefined : result.error,
  });

  // Always refresh snapshot after any mutation
  if (claimedAction.action !== 'refresh_snapshot') {
    await writeGuildSnapshot(guild, supabase);
  }

  log.info(
    `[ActionQueue] ${finalSuccess ? '✅' : '❌'} ${claimedAction.action}: ` +
      (finalSuccess ? JSON.stringify(result.data) : result.error),
  );
}

// ============================================================
// Listener Setup
// ============================================================

/**
 * Start listening for bot action queue items.
 *
 * 1. Process any existing pending actions (in case we missed them while offline)
 * 2. Subscribe to Realtime INSERT events and staged→pending UPDATE releases
 * 3. Once the subscription is SUBSCRIBED, sweep pending rows again — rows
 *    inserted between step 1's snapshot and the subscription going live
 *    (e.g. deliver_receipt re-delivery rows queued by step 1 itself) are
 *    invisible to both step 1 and Realtime.
 */
// V48-C3: how long an action can be stuck in 'processing' before we
// assume the worker crashed and re-queue it (or fail it if the retry
// budget is exhausted).
const STALE_PROCESSING_TIMEOUT_SECS = 300; // 5 minutes
const STALE_RECOVERY_INTERVAL_MS = 60_000; // sweep every minute
const ACTION_QUEUE_MAX_RETRIES = 5;

// Batch cap shared by the pending sweep and the stale-recovery re-fetch.
// Rows beyond the cap are NOT lost — they stay 'pending' and are picked up
// by the next periodic sweep (lane-ordered, commerce first).
const SWEEP_BATCH_LIMIT = 1000;
// Ids per .in() query in the recovery re-fetch — keeps the request URL
// bounded when a flood hands the recovery pass thousands of ids.
const RECOVERY_REFETCH_CHUNK = 200;

/**
 * Fetch up to `budget` full queue rows by id, in bounded .in() chunks.
 * A failed chunk is logged and skipped rather than aborting the pass — its
 * rows are already back in 'pending', so the next lane-ordered sweep picks
 * them up; nothing strands.
 */
async function fetchRecoveredRows(
  supabase: SupabaseClient,
  ids: string[],
  budget: number,
): Promise<ActionRow[]> {
  const capped = ids.slice(0, Math.max(budget, 0));
  const out: ActionRow[] = [];
  for (let i = 0; i < capped.length; i += RECOVERY_REFETCH_CHUNK) {
    const { data, error } = await supabase
      .from('bot_action_queue')
      .select('*')
      .in('id', capped.slice(i, i + RECOVERY_REFETCH_CHUNK));
    if (error) {
      log.error('Recovered-row re-fetch failed:', error.message);
      continue;
    }
    out.push(...((data ?? []) as ActionRow[]));
  }
  return out;
}

async function recoverStaleActions(
  guild: Guild,
  supabase: SupabaseClient,
  scheduler: LaneScheduler,
): Promise<void> {
  const { data: recovered, error } = await (
    supabase.rpc as (fn: string, params: Record<string, unknown>) => ReturnType<typeof supabase.rpc>
  )('bot_action_queue_recover_stale', {
    p_guild_id: guild.id,
    p_timeout_seconds: STALE_PROCESSING_TIMEOUT_SECS,
    p_max_retries: ACTION_QUEUE_MAX_RETRIES,
  });
  if (error) {
    log.error('Stale recovery failed:', error.message);
    return;
  }
  if (!Array.isArray(recovered)) {
    log.error('Stale recovery returned malformed evidence');
    return;
  }
  const rows: Array<{
    id: string;
    action: string;
    disposition: 'completed' | 'requeued' | 'failed' | 'operator_held';
  }> = [];
  const recoveredIds = new Set<string>();
  for (const value of recovered) {
    const row = value as Record<string, unknown> | null;
    if (
      !row
      || !isExactNonBlankString(row.id)
      || !isExactNonBlankString(row.action)
      || typeof row.disposition !== 'string'
      || !['completed', 'requeued', 'failed', 'operator_held'].includes(
        row.disposition,
      )
      || recoveredIds.has(row.id)
    ) {
      log.error('Stale recovery returned malformed or duplicate evidence');
      return;
    }
    recoveredIds.add(row.id);
    rows.push(row as unknown as (typeof rows)[number]);
  }
  if (rows.length === 0) return;

  const failedCount = rows.filter((row) => row.disposition === 'failed').length;
  const operatorHeldCount = rows.filter((row) => row.disposition === 'operator_held').length;
  const completedCount = rows.filter((row) => row.disposition === 'completed').length;
  const requeued = rows.filter((row) => row.disposition === 'requeued');
  const requeuedCount = requeued.length;
  if (failedCount > 0) {
    log.warn(`DLQ: ${failedCount} stale action(s) failed after exhausting retries`);
  }
  if (operatorHeldCount > 0) {
    log.warn(
      `Held ${operatorHeldCount} stale role-delivery action(s) for exact operator recovery`,
    );
  }
  if (completedCount > 0) {
    log.info(`Completed ${completedCount} stale action(s) from durable success evidence`);
  }
  if (requeuedCount > 0) {
    log.info(`Re-queued ${requeuedCount} stale action(s) for processing`);
    // The recovery RPC flipped them back to 'pending'. Realtime UPDATE now
    // observes that release too, but re-fetch and feed them explicitly so
    // recovery remains immediate even during a subscription outage; the
    // atomic claim deduplicates the two paths.
    //
    // Lane priority must hold at the QUERY level, not in memory: the RPC
    // returns EVERY stale row (uncapped), so a game flood can hand back more
    // ids than the re-fetch budget, and a single unordered capped fetch
    // could fill entirely with game rows — evicting every commerce row
    // before an in-memory sort ever saw them. The RPC returns each row's
    // action, and lane is a pure function of the action type (laneForAction
    // — the same classification the DB trigger stamps, pinned by a unit
    // test), so partition the ids by lane FIRST and spend the fetch budget
    // on commerce ids before any game id. Game rows left over stay
    // 'pending' and are picked up by the next lane-ordered sweep.
    const commerceIds: string[] = [];
    const gameIds: string[] = [];
    for (const r of requeued) {
      (laneForAction(r.action) === 'commerce' ? commerceIds : gameIds).push(r.id);
    }
    const commerceRows = await fetchRecoveredRows(supabase, commerceIds, SWEEP_BATCH_LIMIT);
    const gameRows = await fetchRecoveredRows(
      supabase,
      gameIds,
      SWEEP_BATCH_LIMIT - commerceRows.length,
    );
    // Commerce rows first by construction; the sequential awaits preserve
    // that order under the lane budgets shared with the Realtime path, so a
    // crash-recovered game backlog cannot delay a crash-recovered commerce
    // job.
    const recoveredRows = [...commerceRows, ...gameRows].filter((r) => r.status === 'pending');
    for (const r of recoveredRows) {
      await scheduler.run(laneOf(r), () => processAction(guild, supabase, r, scheduler));
    }
  }
}

/**
 * Fetch and process every row currently in 'pending' and due for this guild.
 * Used for the startup backlog sweep, re-run after the Realtime subscription
 * activates, and the periodic catch-up sweep (see startActionQueueListener)
 * — the atomic claim in processAction makes overlapping sweeps/Realtime
 * deliveries safe.
 *
 * Rows parked for backoff are excluded: processAction returns transiently
 * failed rows to 'pending' with next_retry_at set to the end of their
 * 30/60/120s backoff window, and sweeping those immediately (e.g. on every
 * Realtime reconnect) would defeat the backoff. They are retried by the
 * in-process timer, or — if the process died before it fired — by the
 * periodic sweep once next_retry_at has passed, so they never strand.
 */
async function sweepPendingActions(
  guild: Guild,
  supabase: SupabaseClient,
  scheduler: LaneScheduler,
): Promise<void> {
  const dueFilter = `next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`;
  // Lane priority: 'commerce' < 'game' lexicographically (the lane values
  // are chosen so ASC order IS priority order — pinned by a unit test).
  // This MUST happen in the query, not in memory: with a game flood deeper
  // than the batch limit, an in-memory sort would never even see the
  // commerce row and it would starve until the game backlog drained.
  let { data: pending, error } = await supabase
    .from('bot_action_queue')
    .select('*')
    .eq('guild_id', guild.id)
    .eq('status', 'pending')
    .or(dueFilter)
    .order('lane', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(SWEEP_BATCH_LIMIT);

  if (error) {
    // Lane ordering needs the lane column (migration 20260710020000). In a
    // manually-migrated environment the bot can briefly run ahead of the
    // migration — fall back rather than stranding the whole backlog (which
    // includes paid fulfillment rows). The fallback must uphold the same
    // query-level guarantee as the lane-ordered sweep: a single
    // created_at-ordered capped query would let a >LIMIT older game backlog
    // evict every commerce row from the batch. The lane column is missing
    // here, but lane is a pure function of the action type, so fetch
    // commerce rows first via the action list (own capped query) and fill
    // the remaining batch budget with game rows.
    log.error('Lane-ordered sweep failed, falling back to action-name lanes:', error.message);
    const commerceActions = [...COMMERCE_LANE_ACTIONS];
    const { data: commercePending, error: commerceError } = await supabase
      .from('bot_action_queue')
      .select('*')
      .eq('guild_id', guild.id)
      .eq('status', 'pending')
      .or(dueFilter)
      .in('action', commerceActions)
      .order('created_at', { ascending: true })
      .limit(SWEEP_BATCH_LIMIT);
    if (commerceError) {
      log.error('Pending sweep query failed:', commerceError.message);
      return;
    }

    const gameBudget = SWEEP_BATCH_LIMIT - (commercePending?.length ?? 0);
    let gamePending: typeof commercePending = [];
    if (gameBudget > 0) {
      const { data: gameRows, error: gameError } = await supabase
        .from('bot_action_queue')
        .select('*')
        .eq('guild_id', guild.id)
        .eq('status', 'pending')
        .or(dueFilter)
        .not('action', 'in', `(${commerceActions.join(',')})`)
        .order('created_at', { ascending: true })
        .limit(gameBudget);
      if (gameError) {
        // Commerce rows are already in hand — process them rather than
        // failing the whole sweep; game rows are retried next sweep.
        log.error('Game-lane fallback sweep failed:', gameError.message);
      } else {
        gamePending = gameRows;
      }
    }
    pending = [...(commercePending ?? []), ...(gamePending ?? [])];
  }

  if (pending && pending.length > 0) {
    log.info(`Processing ${pending.length} pending action(s)`);
    for (const action of pending) {
      const row = action as ActionRow;
      // Sequential await keeps the sweep itself single-file (commerce rows
      // sorted first), while counting against the lane budgets shared with
      // the Realtime path. If the game lane is saturated by a Realtime
      // flood, the sweep waits AFTER all commerce rows are already done.
      await scheduler.run(laneOf(row), () => processAction(guild, supabase, row, scheduler));
    }
  }
}

/**
 * Per-lane pending-depth alerts — replaces the old single ">100 pending"
 * queue-depth threshold. Runs from the periodic sweep timer. Exported for
 * tests.
 *
 * Commerce depth is checked against a much tighter threshold (>10, critical):
 * a commerce backlog means paying customers are waiting on fulfillment,
 * receipts, or revocations. Game depth keeps the old >100 bar (warning).
 *
 * Dedupe is atomic at the DB: insert first, and treat a 23505
 * unique-violation (uniq_alerts_unresolved_action_queue_depth — at most one
 * unresolved alert per guild per lane) as "already alerted", refreshing the
 * existing row instead. No check-then-insert race across bot restarts or
 * concurrent processes. Alerts auto-resolve once the lane drains back under
 * its threshold.
 */
export async function checkLanePendingDepthAlerts(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<void> {
  for (const lane of ACTION_QUEUE_LANES) {
    const threshold = LANE_PENDING_DEPTH_THRESHOLDS[lane];
    const alertType = laneDepthAlertType(lane);

    const { count, error } = await supabase
      .from('bot_action_queue')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', guild.id)
      .eq('lane', lane)
      .eq('status', 'pending');

    if (error) {
      // Unknown depth — neither fire nor resolve on bad data.
      log.error(`Lane depth check failed for ${lane}:`, error.message);
      continue;
    }

    const depth = count ?? 0;
    const now = new Date().toISOString();

    if (depth > threshold) {
      const severity = LANE_DEPTH_ALERT_SEVERITY[lane];
      const title =
        lane === 'commerce'
          ? `Commerce action queue backing up — ${depth} pending`
          : `Game action queue backing up — ${depth} pending`;
      const message =
        lane === 'commerce'
          ? `${depth} commerce-lane actions are pending (threshold: ${threshold}). ` +
            'Paid fulfillment, receipt delivery, or entitlement revocation is not keeping up — ' +
            'check for stuck processing rows (bot_action_queue_recover_stale) and the DLQ.'
          : `${depth} game-lane actions are pending (threshold: ${threshold}). ` +
            'Game-economy/infra jobs are backing up; commerce processing is unaffected (separate lane).';
      const metadata = { lane, depth, threshold };

      // X1/M2: raiseOwnerAlert writes the row AND posts the Discord notice.
      // A 23505 means the partial unique index
      // uniq_alerts_unresolved_action_queue_depth deduped us — refresh the
      // existing unresolved alert with the latest depth (any repeat ping is
      // bounded by raiseOwnerAlert's per-type throttle window).
      const alertResult = await raiseOwnerAlert(supabase, guild.id, {
        alertType,
        severity,
        title,
        message,
        metadata,
        guild,
      });
      if (alertResult.insertErrorCode === '23505') {
        const { error: refreshErr } = await supabase
          .from('alerts')
          .update({ severity, title, message, metadata, updated_at: now })
          .eq('guild_id', guild.id)
          .eq('alert_type', alertType)
          .eq('resolved', false);
        if (refreshErr) {
          log.error(`Failed to refresh ${alertType} alert:`, refreshErr.message);
        }
      }
    } else {
      // Lane drained — auto-resolve any outstanding alert (no-op otherwise)
      // and post the recovery notice (#51) when one was actually open.
      await resolveOwnerAlert(supabase, guild.id, alertType, undefined, {
        guild,
        notice: `The ${lane} action-queue lane has drained back under its pending threshold (${threshold}).`,
      });
    }
  }
}

export interface ActionQueueHandle {
  staleRecoveryTimer: ReturnType<typeof setInterval>;
  /**
   * Stop the Realtime subscription loop. Cancels any pending reconnect timer
   * and prevents further resubscribe attempts. Must be called on guild
   * teardown so a scheduled reconnect can't fire after the Supabase client is
   * torn down (which throws an uncaught error from realtime-js when it rejects
   * `.on()` bindings on a reused/non-closed channel).
   */
  stop: () => void;
}

export async function startActionQueueListener(
  guild: Guild,
  supabase: SupabaseClient,
): Promise<ActionQueueHandle> {
  log.info('Starting action queue listener');

  // Per-lane concurrency budgets shared by every processing path (sweeps,
  // Realtime events, in-process retries). One scheduler per guild listener.
  const scheduler = new LaneScheduler(LANE_CONCURRENCY);

  // V48-C3: before processing pending rows, recover anything stuck in
  // 'processing' from a previous bot crash. This is the DLQ-equivalent —
  // exhausted retries become 'failed', everything else flips back to
  // 'pending' and is picked up by the loop below.
  await recoverStaleActions(guild, supabase, scheduler);

  // Process any pending actions from while the bot was offline
  await sweepPendingActions(guild, supabase, scheduler);

  // Periodic sweep (runs in addition to the startup pass so long-running
  // deployments don't accumulate stuck rows). Three jobs:
  // 1. recoverStaleActions — rows stuck in 'processing' after a crash.
  // 2. sweepPendingActions — 'pending' rows whose backoff (next_retry_at)
  //    has elapsed. The in-process retry timer normally handles these, but
  //    it dies with the process; without this catch-up, a restart during a
  //    backoff window would strand the row (the startup/subscribe sweeps
  //    intentionally skip rows still inside their backoff window).
  // 3. checkLanePendingDepthAlerts — per-lane pending-depth alerting.
  //    All three run concurrently (fire-and-forget), so the depth check
  //    observes the instantaneous pending depth at tick time — deliberately
  //    NOT sequenced after the sweep: a sweep blocked on a saturated lane
  //    must never suppress depth alerting, which matters most during
  //    exactly such a backlog. A burst the sweep drains immediately may
  //    fire one alert that auto-resolves on the next tick.
  const staleRecoveryTimer = setInterval(() => {
    recoverStaleActions(guild, supabase, scheduler).catch((err) => {
      log.error('Stale recovery sweep error:', { error: String(err) });
    });
    sweepPendingActions(guild, supabase, scheduler).catch((err) => {
      log.error('Due-retry sweep error:', { error: String(err) });
    });
    checkLanePendingDepthAlerts(guild, supabase).catch((err) => {
      log.error('Lane depth alert check error:', { error: String(err) });
    });
  }, STALE_RECOVERY_INTERVAL_MS);
  staleRecoveryTimer.unref?.();

  // V11 Audit H-5: Subscribe to new inserts and pending-state releases with
  // automatic reconnection.
  // The Supabase Realtime subscription can silently disconnect (server
  // restart, network blip). On error/timeout/closed we resubscribe after
  // a delay, with exponential backoff capped at 30s.
  let reconnectDelay = 1_000;
  const MAX_RECONNECT_DELAY = 30_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      subscribeToQueue();
    }, reconnectDelay);
    reconnectTimer.unref?.();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function subscribeToQueue(): void {
    if (stopped) return;
    const dispatchPendingAction = async (payload: { new: Record<string, unknown> }) => {
      const action = payload.new as unknown as ActionRow;
      if (action.status !== 'pending') return;

      // A handler retry also UPDATEs a row back to pending, but with a future
      // next_retry_at. Do not let Realtime bypass its durable backoff. Staged
      // outbox releases have no future retry and dispatch immediately.
      const nextRetryAt = action.next_retry_at ? Date.parse(action.next_retry_at) : Number.NaN;
      if (Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) return;

      // Realtime callbacks are fire-and-forget, so admission goes through the
      // shared per-lane scheduler. The atomic claim deduplicates INSERT/UPDATE
      // deliveries against startup, reconnect, and periodic sweeps.
      await scheduler.run(laneOf(action), () =>
        processAction(guild, supabase, action, scheduler),
      );
    };

    // Build the channel + bindings defensively. realtime-js throws from
    // `.on('postgres_changes')` if the channel isn't in a 'closed' state
    // (e.g. a reused channel, or a client mid-teardown). Without this guard
    // the throw escapes the reconnect setTimeout as an uncaught exception.
    // On failure, fall back to the backoff-scheduled reconnect instead.
    let channel: ReturnType<typeof supabase.channel>;
    try {
      channel = supabase
        .channel(`bot-action-queue-${Date.now()}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'bot_action_queue',
            filter: `guild_id=eq.${guild.id}`,
          },
          dispatchPendingAction,
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'bot_action_queue',
            filter: `guild_id=eq.${guild.id}`,
          },
          dispatchPendingAction,
        );
    } catch (err) {
      log.warn(`Realtime subscribe setup failed, reconnecting in ${reconnectDelay}ms`, {
        error: String(err),
      });
      scheduleReconnect();
      return;
    }

    channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          log.info('Realtime subscription: SUBSCRIBED');
          reconnectDelay = 1_000; // reset backoff on success
          // Rows inserted after the startup sweep read its snapshot but
          // before this subscription became active are invisible to both
          // paths — Realtime only fires for future changes. The startup
          // sweep itself creates such rows: a fulfill_purchase processed
          // from the offline backlog whose receipt DM fails inserts a new
          // pending deliver_receipt row, which would otherwise sit pending
          // until the next restart. Re-sweep now that the subscription is
          // live; the atomic claim in processAction makes any overlap with
          // Realtime deliveries safe. This also heals INSERTs missed while
          // a dropped subscription was reconnecting.
          sweepPendingActions(guild, supabase, scheduler).catch((sweepErr) => {
            log.error('Post-subscribe pending sweep failed:', { error: String(sweepErr) });
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          log.warn(`Realtime subscription ${status}, reconnecting in ${reconnectDelay}ms`, {
            error: err ? String(err) : undefined,
          });
          scheduleReconnect();
        } else {
          log.info(`Realtime subscription: ${status}`);
        }
      });
  }

  subscribeToQueue();

  log.info('Action queue listener active');

  return {
    staleRecoveryTimer,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    },
  };
}
