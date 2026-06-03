/**
 * /api/tutorial — Tutorial config and steps management.
 *
 * V53 Phase 3 (Finding 3.2)
 *
 * GET: Fetch config + steps
 * PUT: Save config + steps (upsert)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

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

  // Upsert config
  const { error: configError } = await supabase
    .from('tutorial_configs')
    .upsert(
      {
        guild_id: guildId,
        enabled: config.enabled,
        auto_trigger: config.auto_trigger,
        trigger_mode: config.trigger_mode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'guild_id' },
    );

  if (configError) {
    return dbError(configError, 'tutorial');
  }

  // Replace all steps: delete existing, insert new
  await supabase.from('tutorial_steps').delete().eq('guild_id', guildId);

  if (steps.length > 0) {
    const rows = steps.map((s, idx) => ({
      guild_id: guildId,
      step_order: idx,
      title: s.title,
      description: s.description,
      image_url: s.image_url || null,
      built_in_key: s.built_in_key || null,
      enabled: s.enabled,
    }));

    const { error: stepsError } = await supabase.from('tutorial_steps').insert(rows);
    if (stepsError) {
      return dbError(stepsError, 'tutorial');
    }
  }

  return NextResponse.json({ success: true });
}
