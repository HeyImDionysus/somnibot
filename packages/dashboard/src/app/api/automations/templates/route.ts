/**
 * /api/automations/templates — List and deploy automation templates.
 *
 * GET: List all available templates
 * POST: Deploy a template (creates an automation from a template)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { AUTOMATION_TEMPLATES } from '@somnibot/shared';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

export async function GET() {
  return NextResponse.json({ success: true, data: AUTOMATION_TEMPLATES });
}

export async function POST(req: NextRequest) {
  const supabase = createAdminSupabase();
  const body = await req.json();

  const { template_id, overrides } = body;

  const template = AUTOMATION_TEMPLATES.find((t) => t.id === template_id);
  if (!template) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 });
  }

  // Merge overrides (e.g., channel_id, role_id) into conditions and actions
  let conditions = template.conditions;
  let actions = template.actions;

  if (overrides) {
    // Apply action overrides
    if (overrides.actions && Array.isArray(overrides.actions)) {
      actions = overrides.actions;
    }
    // Apply condition overrides
    if (overrides.conditions && Array.isArray(overrides.conditions)) {
      conditions = overrides.conditions;
    }
  }

  const { data, error } = await supabase
    .from('automations')
    .insert({
      guild_id: GUILD_ID,
      name: overrides?.name ?? template.name,
      description: template.description,
      trigger_type: template.trigger_type,
      trigger_config: template.trigger_config,
      conditions,
      actions,
      enabled: true,
      target_user_ids: overrides?.target_user_ids ?? [],
      target_channel_ids: overrides?.target_channel_ids ?? [],
      exclude_user_ids: overrides?.exclude_user_ids ?? [],
      exclude_channel_ids: overrides?.exclude_channel_ids ?? [],
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, data });
}
