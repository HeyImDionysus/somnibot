/**
 * /api/tutorial — Tutorial config and steps management.
 *
 * V53 Phase 3 (Finding 3.2)
 *
 * GET: Fetch config + steps
 * PUT: Save config + steps (upsert)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';

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
      .order('step_order', { ascending: true }),
      .limit(500)
  ]);

  return NextResponse.json({
    success: true,
    config: configRes.data ?? { enabled: false, auto_trigger: false, trigger_mode: 'first_command' },
    steps: stepsRes.data ?? [],
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const body = await req.json();
  const { config, steps } = body as {
    config: { enabled: boolean; auto_trigger: boolean; trigger_mode: string };
    steps: Array<{
      id: string;
      step_order: number;
      title: string;
      description: string;
      image_url: string | null;
      built_in_key: string | null;
      enabled: boolean;
    }>;
  };

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
    return NextResponse.json({ success: false, error: configError.message }, { status: 500 });
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
      return NextResponse.json({ success: false, error: stepsError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
