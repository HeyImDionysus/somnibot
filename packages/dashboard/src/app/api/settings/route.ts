import { NextResponse, type NextRequest } from 'next/server';
import { isSoleInstanceOperator } from '@/app/api/webhooks/scope';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { apiServerError } from '@/lib/api/response';
import { readInstallationSettings } from '@/lib/installation-settings';
import { createAdminSupabase } from '@/lib/supabase/admin';

const LAUNCHER_AUTHORITY_ERROR =
  'Installation connections are read-only in the dashboard. Use the SomniBot Launcher to change credentials, deployment, services, updates, or recovery settings.';

export async function GET() {
  try {
    const auth = await requireGuildOwner();
    if (!auth.ok) return auth.response;
    const admin = createAdminSupabase();
    if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
      return NextResponse.json(
        { error: 'Forbidden — installation operator access required' },
        { status: 403 },
      );
    }

    return NextResponse.json(await readInstallationSettings(admin));
  } catch (error) {
    return apiServerError(error, 'GET /api/settings');
  }
}

async function rejectInstallationMutation(request: NextRequest): Promise<NextResponse> {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const admin = createAdminSupabase();
  if (!(await isSoleInstanceOperator(admin, auth.ctx.discordId))) {
    return NextResponse.json(
      { error: 'Forbidden — installation operator access required' },
      { status: 403 },
    );
  }

  return NextResponse.json(
    { error: LAUNCHER_AUTHORITY_ERROR, authority: 'launcher' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return rejectInstallationMutation(request);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return rejectInstallationMutation(request);
}
