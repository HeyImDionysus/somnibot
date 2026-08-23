/**
 * Admin change recording for DASHBOARD mutations.
 *
 * The `admin_changes` table is what the Admin Changes page reads: a
 * plain-English description of what happened, the before/after state, a blast
 * radius, and an undo button where undo is real. The bot has recorded into it
 * since `bot/src/services/admin-changes.ts` landed.
 *
 * The dashboard did not. Its `/api/admin-changes` route only ever READ the
 * table and applied undos — so every change an owner made from the dashboard
 * (settings, shop items, moderation rules, ticket panels, giveaways) left no
 * row at all. The page that exists to explain "what changed in my server"
 * was blind to the surface owners actually use. This module closes that.
 *
 * It mirrors the bot's semantics deliberately, so both origins produce rows
 * that render and undo identically:
 *
 *   { kind: 'db', ... }      → replayed by the undo route as a row update.
 *   { kind: 'discord', ... } → enqueued on bot_action_queue.
 *   omitted                  → `is_undoable` false, `undo_reason` explains why.
 *
 * ── Why undo is validated HERE, at write time ─────────────────────────────
 * The undo route validates a payload when the button is CLICKED, against
 * `UNDO_TABLE_COLUMNS`. If a caller stores an undo for a table or column that
 * allowlist does not cover, the row still renders with a live undo button that
 * fails the moment an owner presses it. Validating with the same allowlist at
 * record time turns that into an honest "cannot be undone" up front. A button
 * that looks like it works and doesn't is the defect, not the missing button.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { validateUndoPayload, validateDiscordUndo } from '@/lib/api/undo-allowlist';

/** How much of the server a change touches — drives confirmation prompts. */
export type BlastRadius = 'low' | 'medium' | 'high' | 'critical';

/** Reverse a database row edit by replaying an update. */
export interface DbUndo {
  kind: 'db';
  table: string;
  data: Record<string, unknown>;
  match: Record<string, unknown>;
}

/** Reverse a Discord mutation by enqueuing the inverse queue action. */
export interface DiscordUndo {
  kind: 'discord';
  action: string;
  payload: Record<string, unknown>;
}

export type UndoSpec = DbUndo | DiscordUndo;

export interface RecordAdminChangeInput {
  guildId: string;
  /** Discord id of the dashboard user who made the change. */
  actorId: string;
  /** Machine-readable verb, e.g. 'settings.updated', 'shop.item_created'. */
  action: string;
  /** What kind of thing changed, e.g. 'guild_config', 'shop_item'. */
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
 * Write one `admin_changes` row for a dashboard mutation.
 *
 * NEVER THROWS and never returns a failure the caller must handle: the
 * mutation has already been committed by the time this runs, so a bookkeeping
 * failure must not turn a successful save into an error response. Failures are
 * logged loudly instead, because a silently missing row is the defect this
 * module exists to fix.
 *
 * Pass the same admin client the route already created so the write reuses the
 * request's service-role connection; omit it and one is created.
 */
export async function recordAdminChange(
  input: RecordAdminChangeInput,
  admin?: SupabaseClient,
): Promise<void> {
  try {
    const db = admin ?? createAdminSupabase();
    const { undo, undoReason } = sanitizeUndo(input);

    const description = undo === undefined && undoReason
      ? `${input.description} (cannot be undone: ${undoReason})`
      : input.description;

    const undoable = undo !== undefined;

    const { error } = await db.from('admin_changes').insert({
      guild_id: input.guildId,
      actor_id: input.actorId,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      description,
      before_state: (input.before ?? null) as never,
      after_state: (input.after ?? null) as never,
      undo_payload: (undo ?? null) as never,
      is_undoable: undoable,
      blast_radius: input.blastRadius ?? 'low',
      // High-impact reversals get a confirmation step in the dashboard.
      requires_confirmation:
        undoable && (input.blastRadius === 'high' || input.blastRadius === 'critical'),
    });

    if (error) {
      console.warn(
        `[adminChanges] Could not record change (action: ${input.action}):`,
        error.message,
      );
    }
  } catch (err) {
    console.warn(
      `[adminChanges] Could not record change (action: ${input.action}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Drop an undo the apply path would reject, replacing it with an honest
 * reason. Uses the SAME validators the undo route runs on click, so the two
 * can never disagree.
 */
function sanitizeUndo(
  input: RecordAdminChangeInput,
): { undo: UndoSpec | undefined; undoReason: string | undefined } {
  const { undo } = input;
  if (undo === undefined) return { undo: undefined, undoReason: input.undoReason };

  if (undo.kind === 'discord') {
    const check = validateDiscordUndo(undo);
    if (!check.ok) {
      console.warn(
        `[adminChanges] Refusing unreversible Discord undo (action: ${undo.action}): ${check.reason}`,
      );
      return { undo: undefined, undoReason: 'No safe automatic reversal exists.' };
    }
    return { undo, undoReason: undefined };
  }

  // The guild scope is checked again at click time against the session's guild;
  // passing this row's guild here proves the payload is well-formed for it.
  const check = validateUndoPayload(undo, { guildId: input.guildId });
  if (!check.ok) {
    console.warn(
      `[adminChanges] Refusing unreplayable undo (table: ${undo.table}): ${check.reason}`,
    );
    return { undo: undefined, undoReason: 'No safe automatic reversal exists.' };
  }
  return { undo, undoReason: undefined };
}

/**
 * Read the prior values of the columns a settings route is about to write.
 *
 * MUST be called before the write. Best-effort by design: a failed or missing
 * read never blocks the save — it downgrades the recorded change to
 * "not undoable" with the reason stated, which is honest, rather than
 * offering a restore button with nothing to restore.
 *
 * `columns` are guild_config column names taken from a `.strict()` Zod schema
 * in the calling route, never from raw request input.
 */
export async function readGuildConfigBefore(
  admin: SupabaseClient,
  guildId: string,
  columns: string[],
): Promise<Record<string, unknown> | undefined> {
  if (columns.length === 0) return undefined;
  try {
    const { data, error } = await admin
      .from('guild_config')
      .select(columns.join(', '))
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) return undefined;
    return (data as Record<string, unknown> | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a change to `guild_config` — the shape almost every settings route in
 * the dashboard has.
 *
 * Reads nothing itself: the caller passes the prior values it already read to
 * build its `notifyBot` before-state, so this adds no extra query.
 *
 * The undo restores exactly the columns this write touched. When the prior
 * read is missing (a guild with no `guild_config` row yet — the routes upsert),
 * there is nothing to restore TO, so the change is recorded as not undoable
 * with that stated rather than offering a button that would write nulls.
 */
export async function recordGuildConfigChange(
  opts: {
    guildId: string;
    actorId: string;
    /** Verb for the row, e.g. 'branding.updated'. */
    action: string;
    /** Human area name for the sentence, e.g. 'branding', 'welcome'. */
    area: string;
    /** The columns and values that were written. */
    updates: Record<string, unknown>;
    /** Those same columns' prior values, or undefined if not readable. */
    before?: Record<string, unknown> | null;
    revision?: Record<string, unknown>;
    blastRadius?: BlastRadius;
  },
  admin?: SupabaseClient,
): Promise<void> {
  // Several settings routes fold bookkeeping columns into their update object.
  // `guild_id` is the undo MATCH key and is rejected inside undo `data` (an
  // undo must never re-key a row), and neither is a setting the owner chose to
  // change — so both are excluded from the description and the restore.
  const keys = Object.keys(opts.updates).filter(
    (k) => k !== 'guild_id' && k !== 'updated_at',
  );
  if (keys.length === 0) return;

  // Restore only the columns this write actually touched.
  const priorForKeys = opts.before
    ? Object.fromEntries(keys.filter((k) => k in opts.before!).map((k) => [k, opts.before![k]]))
    : null;
  const canRestore = priorForKeys !== null && Object.keys(priorForKeys).length === keys.length;

  await recordAdminChange(
    {
      guildId: opts.guildId,
      actorId: opts.actorId,
      action: opts.action,
      targetType: 'guild_config',
      targetId: opts.guildId,
      description: `${describeSettingChange(keys)} in ${opts.area}`,
      before: priorForKeys ?? undefined,
      after: {
        ...Object.fromEntries(keys.map((k) => [k, opts.updates[k]])),
        ...(opts.revision ?? {}),
      },
      blastRadius: opts.blastRadius ?? 'low',
      ...(canRestore
        ? {
            undo: undoByRestoring('guild_config', { guild_id: opts.guildId }, priorForKeys),
          }
        : {
            undoReason: 'the previous values could not be read, so there is nothing to restore',
          }),
    },
    admin,
  );
}

/**
 * Undo spec that restores a row's previous column values.
 *
 * `before` must be the PRIOR values of exactly the columns this change wrote,
 * so the replay sets back what was altered and nothing else.
 */
export function undoByRestoring(
  table: string,
  match: Record<string, unknown>,
  before: Record<string, unknown>,
): DbUndo {
  return { kind: 'db', table, data: before, match };
}

/** What a CRUD route did to a row. */
export type CrudOperation = 'created' | 'updated' | 'deleted';

/**
 * Record a create/update/delete on a content row (shop item, moderation rule,
 * ticket panel, scheduled message…).
 *
 * Undo is only honest for UPDATES here. The undo route replays a payload as a
 * row `.update()`, which can restore changed columns but cannot resurrect a
 * deleted row or remove a created one. So:
 *
 *   updated → restore the previous values of exactly the columns written.
 *   created → not undoable; the owner deletes it from its own page.
 *   deleted → not undoable, but the ENTIRE deleted row is stored in
 *             `before_state`, so the page can still show exactly what was
 *             removed. Losing the row should not also lose the record of it.
 */
export async function recordCrudChange(
  opts: {
    guildId: string;
    actorId: string;
    operation: CrudOperation;
    /** Machine-readable verb, e.g. 'shop.item_created'. */
    action: string;
    /** Table the row lives in — used to build the update-restore undo. */
    table: string;
    /** Human noun for the sentence, e.g. 'shop item'. */
    targetType: string;
    targetId?: string | null;
    /** Human name of the specific row, e.g. the item name. */
    label?: string | null;
    /** Prior values (update), or the whole row (delete). */
    before?: Record<string, unknown> | null;
    /** Written values (create/update). */
    after?: Record<string, unknown> | null;
    /** Identity columns locating the row for an update-restore. */
    match?: Record<string, unknown>;
    blastRadius?: BlastRadius;
  },
  admin?: SupabaseClient,
): Promise<void> {
  const name = opts.label ? ` "${opts.label}"` : '';
  const verb = opts.operation === 'created'
    ? 'Created'
    : opts.operation === 'updated' ? 'Updated' : 'Deleted';

  const changedKeys = opts.operation === 'updated' && opts.after
    ? Object.keys(opts.after).filter((k) => k !== 'id' && k !== 'guild_id' && k !== 'updated_at')
    : [];
  const detail = changedKeys.length > 0
    ? ` (${changedKeys.map(humanizeColumn).join(', ')})`
    : '';

  const description = `${verb} the ${opts.targetType}${name}${detail}`;

  // Restore is only offered for an update whose prior values we hold for every
  // column written, and only when the row can be located.
  const restorable =
    opts.operation === 'updated'
    && opts.before != null
    && opts.match != null
    && changedKeys.length > 0
    && changedKeys.every((k) => k in opts.before!);

  const undoReason = opts.operation === 'created'
    ? `a newly created ${opts.targetType} cannot be removed by an undo — delete it from its page instead`
    : opts.operation === 'deleted'
      ? 'the row was permanently deleted, so there is nothing to restore it into'
      : 'the previous values could not be read, so there is nothing to restore';

  await recordAdminChange(
    {
      guildId: opts.guildId,
      actorId: opts.actorId,
      action: opts.action,
      targetType: opts.targetType,
      targetId: opts.targetId ?? null,
      description,
      before: opts.before ?? undefined,
      after: opts.after ?? undefined,
      blastRadius: opts.blastRadius ?? 'low',
      ...(restorable
        ? {
            undo: undoByRestoring(
              opts.table,
              opts.match!,
              Object.fromEntries(changedKeys.map((k) => [k, opts.before![k]])),
            ),
          }
        : { undoReason }),
    },
    admin,
  );
}

/**
 * Read a content row before a route updates or deletes it.
 *
 * Best-effort, exactly like `readGuildConfigBefore`: a failed read downgrades
 * the recorded change to "not undoable" rather than blocking the mutation.
 * `columns` defaults to the whole row, which is what a delete wants — the
 * record of what vanished is the only copy left.
 */
export async function readRowBefore(
  admin: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
  columns = '*',
): Promise<Record<string, unknown> | undefined> {
  try {
    let query = admin.from(table).select(columns);
    for (const [column, value] of Object.entries(match)) {
      query = query.eq(column, value as never);
    }
    const { data, error } = await query.maybeSingle();
    if (error) return undefined;
    return (data as Record<string, unknown> | null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Describe a change to guild settings in one readable sentence.
 *
 * Owners read this, not the JSON. "Changed 3 settings (level-up channel,
 * XP cooldown, welcome message)" beats "settings.updated".
 */
export function describeSettingChange(keys: string[]): string {
  const labels = keys.map(humanizeColumn);
  if (labels.length === 1) return `Changed the ${labels[0]} setting`;
  if (labels.length === 2) return `Changed the ${labels[0]} and ${labels[1]} settings`;
  const head = labels.slice(0, -1).join(', ');
  return `Changed ${labels.length} settings (${head} and ${labels[labels.length - 1]})`;
}

/** `economy_daily_amount` → `economy daily amount`. */
export function humanizeColumn(column: string): string {
  return column.replace(/_/g, ' ').trim();
}
