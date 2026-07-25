/**
 * Admin change recording — makes bot-driven mutations visible and reversible.
 *
 * The dashboard already had a good story for changes IT made: `admin_changes`
 * rows carry a plain-English description, before/after state, a blast radius,
 * and an undo button. Mutations the BOT made had none of that. They went to
 * `audit_logs`, which the Audit page renders as a raw JSON dump — so the bot
 * creating roles and channels in someone's server was technically logged and
 * practically unexplained, with no way to reverse it from the dashboard.
 *
 * This records bot mutations into the same table, so both origins land on one
 * page that explains what happened and offers undo where undo is real.
 *
 * ── Why undo has three tiers ──────────────────────────────────────────────
 * The dashboard's undo route replays `undo_payload` as a Supabase row update.
 * That reverses a row edit; it cannot delete a Discord role or recreate a
 * channel. So `undo` here is deliberately a discriminated union:
 *
 *   { kind: 'db', ... }      → replayed as an update, exactly as before.
 *   { kind: 'discord', ... } → enqueued on bot_action_queue, whose handlers
 *                              already implement create/delete/update for
 *                              roles, channels and categories.
 *   omitted                  → `is_undoable` stays false and `undo_reason`
 *                              explains why, e.g. a deleted channel whose
 *                              messages and id are gone for good.
 *
 * The rule this file exists to enforce: never mark something undoable unless
 * the reversal actually executes against the system that was mutated. A button
 * that looks like it works and doesn't is the defect, not the missing button.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@somnibot/shared';

const log = createLogger('AdminChanges');

/** How much of the server a change touches — drives confirmation prompts. */
export type BlastRadius = 'low' | 'medium' | 'high' | 'critical';

/** Reverse a database row edit by replaying an update. */
export interface DbUndo {
  kind: 'db';
  table: string;
  data: Record<string, unknown>;
  match: Record<string, unknown>;
}

/**
 * Reverse a Discord mutation by enqueuing the inverse queue action.
 * Only the actions in REVERSIBLE_DISCORD_ACTIONS may be used.
 */
export interface DiscordUndo {
  kind: 'discord';
  action: string;
  payload: Record<string, unknown>;
}

export type UndoSpec = DbUndo | DiscordUndo;

/**
 * Queue actions the undo path is allowed to enqueue.
 *
 * Undo payloads are read back out of the database, so an attacker who could
 * write an admin_changes row must not be able to make undo run arbitrary bot
 * actions (fulfilment, DMs, role grants). Only the structural inverses below
 * are permitted; anything else is rejected at apply time.
 */
export const REVERSIBLE_DISCORD_ACTIONS = [
  'create_role',
  'delete_role',
  'update_role',
  'create_channel',
  'delete_channel',
  'update_channel',
  'create_category',
  'delete_category',
] as const;

export interface RecordAdminChangeInput {
  guildId: string;
  /** Discord id of whoever caused this, or a bot subsystem name. */
  actorId: string;
  /** Machine-readable verb, e.g. 'server_deploy.role_created'. */
  action: string;
  /** What kind of thing changed, e.g. 'role', 'channel', 'guild_config'. */
  targetType: string;
  targetId?: string | null;
  /** One sentence a server owner can read. Required — this is the point. */
  description: string;
  before?: unknown;
  after?: unknown;
  blastRadius?: BlastRadius;
  /** Omit when the change cannot honestly be undone. */
  undo?: UndoSpec;
  /** Why undo is unavailable. Shown to the operator when `undo` is omitted. */
  undoReason?: string;
}

/**
 * Write one admin_changes row.
 *
 * Never throws: a mutation that already happened must not be rolled back or
 * crash a handler because its bookkeeping failed. A failure is logged loudly
 * instead, because a silently missing row is the thing this file is fixing.
 */
export async function recordAdminChange(
  supabase: SupabaseClient,
  input: RecordAdminChangeInput,
): Promise<void> {
  const undoable = input.undo !== undefined;

  if (input.undo?.kind === 'discord'
    && !REVERSIBLE_DISCORD_ACTIONS.includes(
      input.undo.action as typeof REVERSIBLE_DISCORD_ACTIONS[number],
    )) {
    // Refuse to store an undo the apply path would reject anyway — better a
    // change with an honest "not undoable" than a button that errors.
    log.warn('Refusing non-reversible undo action', { action: input.undo.action });
    input = { ...input, undo: undefined, undoReason: 'No safe automatic reversal exists.' };
  }

  const description = input.undo === undefined && input.undoReason
    ? `${input.description} (cannot be undone: ${input.undoReason})`
    : input.description;

  try {
    const { error } = await supabase.from('admin_changes').insert({
      guild_id: input.guildId,
      actor_id: input.actorId,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      description,
      before_state: (input.before ?? null) as never,
      after_state: (input.after ?? null) as never,
      undo_payload: (input.undo ?? null) as never,
      is_undoable: input.undo !== undefined,
      blast_radius: input.blastRadius ?? 'low',
      // High-impact reversals get a confirmation step in the dashboard.
      requires_confirmation:
        undoable && (input.blastRadius === 'high' || input.blastRadius === 'critical'),
    });
    if (error) {
      log.warn('Could not record admin change', { action: input.action, error: error.message });
    }
  } catch (err) {
    log.warn('Could not record admin change', { action: input.action, error: String(err) });
  }
}

/**
 * Undo spec for a Discord object the bot created: delete it again.
 *
 * Safe to offer because it returns the server to a state it was demonstrably
 * in moments ago — nothing of the operator's is destroyed, since the object
 * did not exist before this change.
 */
export function undoByDeleting(
  kind: 'role' | 'channel' | 'category',
  discordId: string,
): DiscordUndo {
  // Field names must match what the queue handlers actually read —
  // handleDeleteRole/Channel/Category take roleId/channelId/categoryId and
  // reject anything else with "Missing <id>". A generic discord_id would have
  // produced an undo that always failed, which is the precise failure this
  // module exists to prevent.
  switch (kind) {
    case 'role':
      return { kind: 'discord', action: 'delete_role', payload: { roleId: discordId } };
    case 'channel':
      return { kind: 'discord', action: 'delete_channel', payload: { channelId: discordId } };
    case 'category':
      return { kind: 'discord', action: 'delete_category', payload: { categoryId: discordId } };
  }
}

/**
 * Undo spec for an edit to an existing Discord object: re-apply what it was.
 *
 * `before` must be the previous field values, not the whole object, so the
 * replay sets exactly what this change altered.
 */
export function undoByRestoring(
  kind: 'role' | 'channel',
  discordId: string,
  before: Record<string, unknown>,
): DiscordUndo {
  // handleUpdateRole reads roleId + name/color/hoist/mentionable/permissions;
  // handleUpdateChannel reads channelId + name/topic/nsfw/slowmode/parentId.
  return kind === 'role'
    ? { kind: 'discord', action: 'update_role', payload: { roleId: discordId, ...before } }
    : { kind: 'discord', action: 'update_channel', payload: { channelId: discordId, ...before } };
}
