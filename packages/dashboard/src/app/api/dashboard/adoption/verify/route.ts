import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ADOPTION_TRACKS } from '@/lib/dashboard/adoption-map';
import { adoptionVerificationSchema } from '@/lib/dashboard/adoption-verification';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { readAdoptionServerContext } from '@/lib/dashboard/adoption-server-context';

const requestSchema = z.object({ trackId: z.string().refine((id) => ADOPTION_TRACKS.some((track) => track.id === id)) }).strict();
const keySchema = z.string().trim().min(1).max(200);

export async function POST(request: NextRequest) {
  try {
    const context = await requirePermission('dashboard.full_access');
    const limited = await checkAdminRateLimit(request, 'write', 'adoption-verification');
    if (limited) return limited;
    const bodyText = await request.text();
    if (bodyText.length > 200) return NextResponse.json({ error: 'Only a track selection is accepted.' }, { status: 400 });
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch (error) {
      if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid track selection.' }, { status: 400 });
      throw error;
    }
    const selection = requestSchema.safeParse(body);
    const key = keySchema.safeParse(request.headers.get('Idempotency-Key'));
    if (!selection.success || !key.success) return NextResponse.json({ error: 'A known track and Idempotency-Key are required; evidence cannot be supplied.' }, { status: 400 });
    const operationId = randomUUID();
    const result = await createAdminSupabase().rpc('check_dashboard_adoption_track', {
      p_guild_id: context.guildId, p_actor_id: context.discordId,
      p_track_id: selection.data.trackId, p_operation_id: operationId, p_idempotency_key: key.data,
      p_server_context: await readAdoptionServerContext(context.guildId),
    });
    if (result.error) return NextResponse.json({ error: 'Evidence check could not be recorded. No verification was granted.', operationId }, { status: 503 });
    const checked = adoptionVerificationSchema.extend({ operationId: z.string().uuid() }).safeParse(result.data);
    if (!checked.success) return NextResponse.json({ error: 'Evidence check returned an invalid result.', operationId }, { status: 502 });
    return NextResponse.json({ success: true, data: checked.data, operationId: checked.data.operationId });
  } catch (error) {
    return authErrorResponse(error);
  }
}
