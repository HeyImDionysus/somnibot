/**
 * /api/economy/gathering — CRUD for loot table entries.
 *
 * GET    — List all loot table entries for the guild
 * POST   — Create a new loot entry
 * PUT    — Update an existing loot entry
 * DELETE — Delete a loot entry (by { id } in body)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError, dbConflictOr500, apiServerError} from '@/lib/api/response';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

const SOURCE_TYPES = ['hunt', 'dig', 'mine'] as const;
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

const lootEntrySchema = z.object({
  source_type: z.enum(SOURCE_TYPES),
  item_name: z.string().min(1).max(64),
  emoji: z.string().min(1).max(64).optional(),
  rarity: z.enum(RARITIES).optional(),
  min_qty: z.number().int().min(1).max(999).optional(),
  max_qty: z.number().int().min(1).max(999).optional(),
  weight: z.number().int().min(1).max(10000).optional(),
  tool_tier: z.number().int().min(0).max(10).optional(),
  sell_value: z.number().int().min(0).max(1000000).optional(),
  gives_item_id: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
});

// FIX #11: Cross-validate min_qty ≤ max_qty on create. Separated from
// the base schema so .partial() still works on PUT (updates). The refine
// prevents random(10, 5) which may return 0 or error.
const lootEntryCreateSchema = lootEntrySchema.refine(
  (data) => {
    if (data.min_qty !== undefined && data.max_qty !== undefined) {
      return data.min_qty <= data.max_qty;
    }
    return true;
  },
  { message: 'min_qty must be less than or equal to max_qty', path: ['min_qty'] },
);

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('economy_loot_tables')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('source_type')
      .order('rarity')
      .order('item_name')
      .limit(500);

    if (error) {
      return dbError(error, 'economy/gathering');
    }

    return NextResponse.json({ success: true, entries: data ?? [] });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/gathering');
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, lootEntryCreateSchema);
    if (!result.ok) return result.response;
    const parsed = result.data;

    const admin = createAdminSupabase();

    // Limit: max 200 loot entries per guild
    const { count } = await admin
      .from('economy_loot_tables')
      .select('*', { count: 'exact', head: true })
      .eq('guild_id', ctx.guildId);

    if ((count ?? 0) >= 200) {
      return NextResponse.json({ success: false, error: 'Maximum 200 loot entries reached.' }, { status: 400 });
    }

    const { data, error } = await admin
      .from('economy_loot_tables')
      .insert({
        ...parsed,
        guild_id: ctx.guildId,
      })
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/gathering', 'uq_economy_loot_tables_guild_source_lname_tier',
        'A loot entry with that item name already exists for this source and tool tier.');
    }

    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'created',
      action: 'economy.loot_table_created',
      table: 'economy_loot_tables',
      targetType: 'loot table',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: undefined,
      after: data as Record<string, unknown> | null,
    }, admin);
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/gathering');
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const putSchema = z.object({ id: z.string().uuid() }).merge(lootEntrySchema.partial());
    const result = await parseBody(request, putSchema);
    if (!result.ok) return result.response;
    const { id, ...parsed } = result.data;

    // FIX #11: Also validate min ≤ max on updates when both are provided
    if (parsed.min_qty !== undefined && parsed.max_qty !== undefined && parsed.min_qty > parsed.max_qty) {
      return NextResponse.json(
        { success: false, error: 'min_qty must be less than or equal to max_qty' },
        { status: 400 },
      );
    }

    const admin = createAdminSupabase();

    const before = await readRowBefore(admin, 'economy_loot_tables', { id: id, guild_id: ctx.guildId });

    const { data, error } = await admin
      .from('economy_loot_tables')
      .update({
        ...parsed,
      })
      .eq('id', id)
      .eq('guild_id', ctx.guildId)
      .select('*')
      .single();

    if (error) {
      return dbConflictOr500(error, 'economy/gathering', 'uq_economy_loot_tables_guild_source_lname_tier',
        'A loot entry with that item name already exists for this source and tool tier.');
    }

    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'updated',
      action: 'economy.loot_table_updated',
      table: 'economy_loot_tables',
      targetType: 'loot table',
      targetId: id,
      label: before?.name as string | undefined,

      before,
      after: parsed as Record<string, unknown>,
      match: { id: id, guild_id: ctx.guildId },
    }, admin);
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/gathering');
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const deleteSchema = z.object({ id: z.string().uuid() });
    const result = await parseBody(request, deleteSchema);
    if (!result.ok) return result.response;
    const { id } = result.data;

    const admin = createAdminSupabase();

    // Captured first: the row is hard-deleted, so this is the only copy left.
    const before = await readRowBefore(admin, 'economy_loot_tables', { id: id, guild_id: ctx.guildId });

    const { error } = await admin
      .from('economy_loot_tables')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);

    if (error) {
      return dbError(error, 'economy/gathering');
    }

    await notifyBot('economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'deleted',
      action: 'economy.loot_table_deleted',
      table: 'economy_loot_tables',
      targetType: 'loot table',
      targetId: id,
      label: before?.name as string | undefined,

      before,
      blastRadius: 'medium',
    }, admin);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return apiServerError(err, 'economy/gathering');
  }
}
