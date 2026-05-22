/**
 * Guilds API — List guilds owned by the authenticated user.
 *
 * V53 Phase 4 (Finding 4.3.2 — S-2)
 */
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { cookies } from 'next/headers';

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const meta = user.user_metadata;
  const discordId = (meta?.provider_id as string) || (meta?.sub as string) || null;
  if (!discordId) {
    return NextResponse.json({ error: 'No Discord identity' }, { status: 401 });
  }

  const admin = createAdminSupabase();
  const { data: guilds, error } = await admin
    .from('guild')
    .select('id, name')
    .eq('owner_discord_id', discordId);

  if (error || !guilds) {
    return NextResponse.json({ error: 'Failed to load guilds' }, { status: 500 });
  }

  const cookieStore = await cookies();
  const activeGuildId = cookieStore.get('active_guild_id')?.value ?? guilds[0]?.id;

  return NextResponse.json({
    success: true,
    guilds,
    active_guild_id: activeGuildId,
  });
}
