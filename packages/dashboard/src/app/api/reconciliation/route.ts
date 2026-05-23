/**
 * GET  /api/reconciliation — Get recent reconciliation runs.
 * POST /api/reconciliation — Trigger a manual reconciliation run.
 *
 * Phase B.4: Admin-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { z } from 'zod';

export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Get the last 20 reconciliation runs for this guild
  const { data: runs } = await supabase
    .from('reconciliation_runs')
    .select('*')
    .eq('guild_id', guildId)
    .order('started_at', { ascending: false })
    .limit(20);

  // Get summary stats
  const lastCompleted = runs?.find(r => r.status === 'completed');
  const lastFailed = runs?.find(r => r.status === 'failed');
  const isRunning = runs?.some(r => r.status === 'running');

  return NextResponse.json({
    runs: runs ?? [],
    summary: {
      last_completed: lastCompleted?.completed_at ?? null,
      last_failed: lastFailed?.completed_at ?? null,
      is_running: isRunning ?? false,
      last_findings: lastCompleted?.findings ?? null,
    },
  });
}


const reconciliationTriggerSchema = z.object({
  trigger: z.enum(['manual', 'scheduled']).default('manual'),
}).strict().optional();

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  // Check if a run is already in progress for this guild
  const { data: running } = await supabase
    .from('reconciliation_runs')
    .select('id')
    .eq('guild_id', guildId)
    .eq('status', 'running')
    .maybeSingle();

  if (running) {
    return NextResponse.json(
      { success: false, error: 'A reconciliation run is already in progress' },
      { status: 409 },
    );
  }

  // Validate optional body
  let trigger = 'manual';
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = reconciliationTriggerSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return NextResponse.json(
          { success: false, error: 'Invalid request body', details: parsed.error.issues },
          { status: 400 },
        );
      }
      trigger = parsed.data?.trigger ?? 'manual';
    }
  } catch {
    // Empty body is fine — default to manual trigger
  }

  // Enqueue a reconciliation action for the bot to pick up
  await supabase.from('bot_action_queue').insert({
    guild_id: guildId,
    action: 'run_reconciliation',
    payload: { trigger },
    status: 'pending',
  });

  return NextResponse.json({ success: true, message: 'Reconciliation run queued' });
}
