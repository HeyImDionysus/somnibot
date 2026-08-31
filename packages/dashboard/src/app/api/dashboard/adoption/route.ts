import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { assertSurfaceAuthority } from '@somnibot/shared';
import { z } from 'zod';
import {
  adoptionMapMutationSchema,
  adoptionStateErrors,
  defaultAdoptionMapState,
  withVerifiedTracks,
} from '@/lib/dashboard/adoption-map';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { adoptionVerificationSchema, currentVerifiedTrackIds } from '@/lib/dashboard/adoption-verification';
import { readAdoptionServerContext } from '@/lib/dashboard/adoption-server-context';

const adoptionRowSchema = z.object({
  mode: z.enum(['guided', 'expert']),
  tutorial_visible: z.boolean(),
  selected_track_ids: z.array(z.string()),
  track_states: z.unknown(),
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
});

const publishResultSchema = z.object({
  state: adoptionMapMutationSchema.extend({ verifiedTrackIds: z.array(z.string()) }),
  updatedAt: z.string().datetime({ offset: true }),
  revision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
  releaseId: z.string().uuid(),
});

const idempotencyKeySchema = z.string().trim().min(1).max(200);

function desiredFromRow(row: z.infer<typeof adoptionRowSchema> | null) {
  if (!row) {
    return adoptionMapMutationSchema.parse({
      mode: defaultAdoptionMapState.mode,
      tutorialVisible: defaultAdoptionMapState.tutorialVisible,
      selectedTrackIds: defaultAdoptionMapState.selectedTrackIds,
      trackStates: defaultAdoptionMapState.trackStates,
    });
  }
  return adoptionMapMutationSchema.parse({
    mode: row.mode,
    tutorialVisible: row.tutorial_visible,
    selectedTrackIds: row.selected_track_ids,
    trackStates: row.track_states,
  });
}

async function readAdoptionState(guildId: string, serverContext: Awaited<ReturnType<typeof readAdoptionServerContext>>) {
  const admin = createAdminSupabase();
  const [mapResult, evidenceResult] = await Promise.all([
    admin.from('dashboard_adoption_maps')
      .select('mode, tutorial_visible, selected_track_ids, track_states, revision, updated_at')
      .eq('guild_id', guildId)
      .maybeSingle(),
    admin.rpc('read_dashboard_adoption_verifications', { p_guild_id: guildId, p_server_context: serverContext }),
  ]);
  if (mapResult.error || evidenceResult.error) return null;
  const row = mapResult.data === null ? null : adoptionRowSchema.safeParse(mapResult.data);
  if (row !== null && !row.success) return null;
  const desired = desiredFromRow(row?.data ?? null);
  const verifications = z.array(adoptionVerificationSchema).max(13).safeParse(evidenceResult.data);
  if (!verifications.success) return null;
  return {
    state: withVerifiedTracks(desired, currentVerifiedTrackIds(evidenceResult.data, Date.now())),
    verifications: verifications.data,
    updatedAt: row?.data.updated_at ?? null,
    revision: row?.data.revision ?? 0,
  };
}

export async function GET() {
  try {
    const context = await requirePermission(null);
    const result = await readAdoptionState(context.guildId, await readAdoptionServerContext(context.guildId));
    if (!result) return NextResponse.json({ error: 'Adoption map could not be loaded.' }, { status: 500 });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await requirePermission('dashboard.full_access');
    assertSurfaceAuthority('configuration', 'dashboard');
    const body = adoptionMapMutationSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: 'Invalid adoption-map state.', fieldErrors: body.error.flatten().fieldErrors }, { status: 400 });
    }
    const serverContext = await readAdoptionServerContext(context.guildId);
    const current = await readAdoptionState(context.guildId, serverContext);
    if (!current) return NextResponse.json({ error: 'Adoption verification evidence could not be read.' }, { status: 500 });
    const requested = withVerifiedTracks(body.data, current.state.verifiedTrackIds);
    const transitionErrors = adoptionStateErrors(requested, current.state);
    if (transitionErrors.length > 0) {
      return NextResponse.json({ error: 'Adoption-map state violates track requirements.', transitionErrors }, { status: 409 });
    }

    const operationId = randomUUID();
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('Idempotency-Key'));
    if (!idempotencyKey.success) {
      return NextResponse.json({ error: 'A valid Idempotency-Key header is required.' }, { status: 400 });
    }
    const result = await createAdminSupabase().rpc('publish_dashboard_adoption_map', {
      p_operation_id: operationId,
      p_guild_id: context.guildId,
      p_actor_id: context.discordId,
      p_idempotency_key: idempotencyKey.data,
      p_state: body.data,
      p_server_context: serverContext,
    });
    if (result.error) return NextResponse.json({ error: 'Adoption map publication failed.', operationId }, { status: 500 });
    const published = publishResultSchema.safeParse(result.data);
    if (!published.success) return NextResponse.json({ error: 'Adoption map readback is malformed.', operationId }, { status: 500 });
    return NextResponse.json({ success: true, data: published.data });
  } catch (error) {
    return authErrorResponse(error);
  }
}
