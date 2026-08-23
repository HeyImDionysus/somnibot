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

const adoptionRowSchema = z.object({
  mode: z.enum(['guided', 'expert']),
  tutorial_visible: z.boolean(),
  selected_track_ids: z.array(z.string()),
  track_states: z.unknown(),
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
});

const verificationRowSchema = z.object({
  track_id: z.string().min(1),
  verified_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }).nullable(),
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

function currentVerifiedTrackIds(rows: unknown, nowMs: number): readonly string[] {
  const parsed = z.array(verificationRowSchema).safeParse(rows ?? []);
  if (!parsed.success) return [];
  return [...new Set(parsed.data
    .filter((row) => row.expires_at === null || Date.parse(row.expires_at) > nowMs)
    .map((row) => row.track_id))];
}

async function readAdoptionState(guildId: string) {
  const admin = createAdminSupabase();
  const [mapResult, evidenceResult] = await Promise.all([
    admin.from('dashboard_adoption_maps')
      .select('mode, tutorial_visible, selected_track_ids, track_states, revision, updated_at')
      .eq('guild_id', guildId)
      .maybeSingle(),
    admin.from('dashboard_adoption_verifications')
      .select('track_id, verified_at, expires_at')
      .eq('guild_id', guildId)
      .eq('result', 'pass')
      .limit(100),
  ]);
  if (mapResult.error || evidenceResult.error) return null;
  const row = mapResult.data === null ? null : adoptionRowSchema.safeParse(mapResult.data);
  if (row !== null && !row.success) return null;
  const desired = desiredFromRow(row?.data ?? null);
  return {
    state: withVerifiedTracks(desired, currentVerifiedTrackIds(evidenceResult.data, Date.now())),
    updatedAt: row?.data.updated_at ?? null,
    revision: row?.data.revision ?? 0,
  };
}

export async function GET() {
  try {
    const context = await requirePermission(null);
    const result = await readAdoptionState(context.guildId);
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
    const current = await readAdoptionState(context.guildId);
    if (!current) return NextResponse.json({ error: 'Adoption verification evidence could not be read.' }, { status: 500 });
    const requested = withVerifiedTracks(body.data, current.state.verifiedTrackIds);
    const transitionErrors = adoptionStateErrors(requested);
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
    });
    if (result.error) return NextResponse.json({ error: 'Adoption map publication failed.', operationId }, { status: 500 });
    const published = publishResultSchema.safeParse(result.data);
    if (!published.success) return NextResponse.json({ error: 'Adoption map readback is malformed.', operationId }, { status: 500 });
    return NextResponse.json({ success: true, data: published.data });
  } catch (error) {
    return authErrorResponse(error);
  }
}
