/**
 * /api/economy/heist — Read heist history + heist config is part of guild config.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'standard');
  if (rateLimited) return rateLimited;

  try {
    const auth = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();

    // Get recent heists (last 50). Crew membership and the success chance are now
    // DERIVED from the participant ROWS (the single source of truth) +
    // base_success_chance — the denormalized participants[] array and the mutable
    // success_chance counter were dropped (migration 20260710180000). We embed the
    // participant rows and derive participants[] + success_chance here so the API
    // response shape the dashboard consumes is unchanged.
    const { data, error } = await supabase
      .from('economy_heists')
      .select('*, economy_heist_participants(user_id, joined_at)')
      .eq('guild_id', auth.guildId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return dbError(error, 'economy/heist');

    type ParticipantRow = { user_id: string; joined_at: string | null };
    const derived = (data ?? []).map((h) => {
      const rows = (h.economy_heist_participants ?? []) as ParticipantRow[];
      // Stable display order (join order), mirroring the bot's crew rendering.
      const participants = [...rows]
        .sort((a, b) => String(a.joined_at ?? '').localeCompare(String(b.joined_at ?? '')))
        .map((r) => r.user_id);
      // Derived, clamped chance: LEAST(95, GREATEST(0, base + (count - 1) * 7)).
      const base = (h.base_success_chance as number | null) ?? 0;
      const success_chance = Math.max(0, Math.min(95, base + (participants.length - 1) * 7));
      return { ...h, participants, success_chance };
    });

    return NextResponse.json({ data: derived });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AuthError') return authErrorResponse(err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
