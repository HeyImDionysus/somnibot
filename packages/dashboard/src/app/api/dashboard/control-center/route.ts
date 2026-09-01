import { type NextRequest, NextResponse } from 'next/server';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import {
  attentionForView,
  authorizedDestinations,
  availableAttentionViews,
  authorizedDynamicSearchKinds,
  parseDynamicSearchResults,
  searchStaticControlCenter,
} from '@/lib/dashboard/control-center';

export async function GET(request: NextRequest) {
  try {
    const ctx = await requirePermission(null);
    const supabase = createAdminSupabase();
    const query = new URL(request.url).searchParams.get('q')?.trim().slice(0, 80) ?? '';
    const dynamicKinds = authorizedDynamicSearchKinds(ctx.permissions);
    const [guildResult, diagnosticResult, searchResult] = await Promise.all([
      supabase.from('guild').select('id, name, setup_completed').eq('id', ctx.guildId).maybeSingle(),
      supabase
        .from('bot_diagnostics')
        .select('snapshot_at, boot_id')
        .eq('guild_id', ctx.guildId)
        .maybeSingle(),
      query.length >= 2 && dynamicKinds.length > 0
        ? supabase.rpc('search_dashboard_control_center', {
          p_guild_id: ctx.guildId,
          p_query: query,
          p_kinds: dynamicKinds,
          p_limit: 25,
        })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (guildResult.error || diagnosticResult.error) {
      return NextResponse.json({ error: 'Control-center context could not be loaded.' }, { status: 500 });
    }

    const views = availableAttentionViews(ctx.permissions);
    const searchResults = query === ''
      ? []
      : [...searchStaticControlCenter(ctx.permissions, query), ...parseDynamicSearchResults(searchResult.data, dynamicKinds)];
    return NextResponse.json({
      success: true,
      data: {
        guild: guildResult.data ?? null,
        permissions: ctx.permissions,
        attentionViews: views.map((view) => ({
          id: view,
          items: attentionForView(view, ctx.permissions),
        })),
        destinations: authorizedDestinations(ctx.permissions),
        searchResults,
        searchDegraded: searchResult.error !== null,
        canManageAdoption: ctx.isOwner,
        deployment: {
          version: process.env.npm_package_version ?? 'unknown',
          exactSha: process.env.SOMNIBOT_GIT_SHA ?? process.env.GITHUB_SHA ?? null,
          bootId: diagnosticResult.data?.boot_id ?? null,
          snapshotAt: diagnosticResult.data?.snapshot_at ?? null,
        },
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
