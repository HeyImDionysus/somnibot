/**
 * GET /api/fraud/rules — List fraud detection rules.
 * POST /api/fraud/rules — Create a new rule.
 * PATCH /api/fraud/rules — Update a rule.
 * DELETE /api/fraud/rules — Delete a rule.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission } from '@/lib/rbac';

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.view_fraud');
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('fraud_rules')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const body = await request.json();
    const admin = createAdminSupabase();

    const { data, error } = await admin
      .from('fraud_rules')
      .insert({
        guild_id: ctx.guildId,
        name: body.name,
        description: body.description || null,
        rule_type: body.rule_type,
        enabled: body.enabled ?? true,
        config: body.config || {},
        auto_action: body.auto_action || 'flag',
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const body = await request.json();
    const admin = createAdminSupabase();

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.config !== undefined) updates.config = body.config;
    if (body.auto_action !== undefined) updates.auto_action = body.auto_action;

    const { data, error } = await admin
      .from('fraud_rules')
      .update(updates)
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requirePermission('dashboard.manage_fraud');
    const { searchParams } = new URL(request.url);
    const ruleId = searchParams.get('id');
    if (!ruleId) return NextResponse.json({ error: 'Missing rule ID' }, { status: 400 });

    const admin = createAdminSupabase();
    const { error } = await admin
      .from('fraud_rules')
      .delete()
      .eq('id', ruleId)
      .eq('guild_id', ctx.guildId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: msg === 'Unauthorized' ? 401 : 403 });
  }
}
