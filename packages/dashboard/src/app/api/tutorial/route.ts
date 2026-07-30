/**
 * /api/tutorial — Tutorial config and steps management.
 *
 * V53 Phase 3 (Finding 3.2)
 *
 * GET: Fetch config + steps
 * PUT: Save config + steps (upsert)
 *
 * ── Why one PUT writes TWO admin_changes rows ─────────────────────────────
 * This handler performs two independent mutations with different reversibility,
 * and folding them into a single row would make the undo button lie:
 *
 *   1. `tutorial_configs` is upserted. It IS on the undo allowlist and is keyed
 *      by guild_id, so restoring its previous values is a real, replayable undo.
 *   2. `tutorial_steps` is REPLACED — every row deleted, then re-inserted. The
 *      undo route replays a row `.update()`, which cannot resurrect deleted
 *      rows, so that half can never be undone. What it can do is keep the old
 *      list in `before_state`, so losing the steps does not also lose the record
 *      of what they were.
 *
 * Each row is written straight after ITS OWN write succeeds. If the steps
 * insert fails, the config upsert has still committed, so its row is still the
 * truth even though the request ends in a 500 — writing nothing there would
 * recreate exactly the silence this work exists to remove.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { readRowBefore, recordAdminChange, recordCrudChange } from '@/lib/admin-changes';

const tutorialPutSchema = z.object({
  config: z.object({
    enabled: z.boolean(),
    auto_trigger: z.boolean(),
    trigger_mode: z.string().min(1),
  }),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      step_order: z.number().int().min(0),
      title: z.string().min(1).max(200),
      description: z.string().max(2000),
      image_url: z.string().url().nullable().optional(),
      built_in_key: z.string().nullable().optional(),
      enabled: z.boolean(),
    }),
  ),
});

/**
 * Read the guild's current tutorial steps before the PUT wipes them.
 *
 * `readRowBefore` is single-row (maybeSingle); this list is what the delete is
 * about to destroy, so it needs all of them. Best-effort: a failed read leaves
 * the recorded change without a before-state rather than blocking the save.
 */
async function readTutorialSteps(
  supabase: ReturnType<typeof createAdminSupabase>,
  guildId: string,
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await supabase
      .from('tutorial_steps')
      .select('*')
      .eq('guild_id', guildId)
      .order('step_order', { ascending: true })
      .limit(1000);
    if (error || !Array.isArray(data)) return [];
    return data as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const [configRes, stepsRes] = await Promise.all([
    supabase
      .from('tutorial_configs')
      .select('enabled, auto_trigger, trigger_mode')
      .eq('guild_id', guildId)
      .maybeSingle(),
    supabase
      .from('tutorial_steps')
      .select('*')
      .eq('guild_id', guildId)
      .order('step_order', { ascending: true })
      .limit(1000),
  ]);

  return NextResponse.json({
    success: true,
    config: configRes.data ?? { enabled: false, auto_trigger: false, trigger_mode: 'first_command' },
    steps: stepsRes.data ?? [],
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const parsed = await parseBody(req, tutorialPutSchema);
  if (!parsed.ok) return parsed.response;
  const { config, steps } = parsed.data;

  const supabase = createAdminSupabase();

  // Both "before" reads happen before ANY write. Read them afterwards and they
  // are just the "after" under a misleading name.
  const configBefore = await readRowBefore(
    supabase,
    'tutorial_configs',
    { guild_id: guildId },
    'enabled, auto_trigger, trigger_mode',
  );
  const stepsBefore = await readTutorialSteps(supabase, guildId);

  const configUpdates = {
    enabled: config.enabled,
    auto_trigger: config.auto_trigger,
    trigger_mode: config.trigger_mode,
  };

  // Upsert config
  const { error: configError } = await supabase
    .from('tutorial_configs')
    .upsert(
      {
        guild_id: guildId,
        ...configUpdates,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'guild_id' },
    );

  if (configError) {
    return dbError(configError, 'tutorial');
  }

  // Restoring the three prior values is a real undo: `tutorial_configs` is on
  // the allowlist and is keyed by guild_id. On a guild's FIRST save there is no
  // prior row, so recordCrudChange records it as not undoable with that reason
  // — correct, since there is nothing to restore to.
  await recordCrudChange({
    guildId,
    actorId: auth.ctx.discordId,
    operation: 'updated',
    action: 'tutorial.config_updated',
    table: 'tutorial_configs',
    targetType: 'tutorial settings',
    targetId: guildId,
    before: configBefore,
    after: configUpdates,
    match: { guild_id: guildId },
    blastRadius: 'medium',
  }, supabase);

  // Replace all steps: delete existing, insert new
  await supabase.from('tutorial_steps').delete().eq('guild_id', guildId);

  const rows = steps.map((s, idx) => ({
    guild_id: guildId,
    step_order: idx,
    title: s.title,
    description: s.description,
    image_url: s.image_url || null,
    built_in_key: s.built_in_key || null,
    enabled: s.enabled,
  }));

  if (rows.length > 0) {
    const { error: stepsError } = await supabase.from('tutorial_steps').insert(rows);
    if (stepsError) {
      return dbError(stepsError, 'tutorial');
    }
  }

  // Skip the row when there were no steps before and none now — nothing was
  // replaced, and a "changed 0 steps to 0 steps" entry is just noise on a page
  // people are supposed to be able to read.
  if (stepsBefore.length > 0 || rows.length > 0) {
    await recordAdminChange({
      guildId,
      actorId: auth.ctx.discordId,
      action: 'tutorial.steps_replaced',
      targetType: 'tutorial steps',
      targetId: guildId,
      description: `Replaced the tutorial steps (${stepsBefore.length} before, ${rows.length} now)`,
      before: stepsBefore,
      after: rows,
      blastRadius: 'medium',
      undoReason:
        'the old steps were deleted outright and an undo cannot bring deleted rows back — the full list of what was removed is kept with this entry',
    }, supabase);
  }

  return NextResponse.json({ success: true });
}
