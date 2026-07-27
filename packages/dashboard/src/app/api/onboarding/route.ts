/**
 * /api/onboarding — GET/PUT onboarding configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { typedPick } from '@/lib/api/typed-pick';
import { dbError } from '@/lib/api/response';
import { readGuildConfigBefore, recordGuildConfigChange } from '@/lib/admin-changes';
export async function GET() {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('guild_config')
    .select(
      'member_role_id, onboarding_enabled, interest_role_mapping, ' +
      'returning_member_skip_welcome_dm, returning_member_restore_entitlements, returning_member_restore_levels, ' +
      'onboarding_config',
    )
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    return dbError(error, 'onboarding');
  }

  return NextResponse.json({ success: true, data });
}

export async function PUT(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const { guildId } = auth.ctx;

  const supabase = createAdminSupabase();
  const parsed = await parseBody(req, schemas.onboarding.config);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Whitelist allowed fields
  const allowed = typedPick(body, ['member_role_id', 'onboarding_enabled', 'interest_role_mapping', 'returning_member_skip_welcome_dm', 'returning_member_restore_entitlements', 'returning_member_restore_levels']);

  const before = await readGuildConfigBefore(supabase, guildId, Object.keys(allowed));

  const { error } = await supabase
    .from('guild_config')
    .upsert({ guild_id: guildId, ...allowed }, { onConflict: 'guild_id' });

  if (error) {
    return dbError(error, 'onboarding');
  }

  await notifyBot('onboarding', allowed);

  await recordGuildConfigChange({
    guildId,
    actorId: auth.ctx.discordId,
    action: 'onboarding.updated',
    area: 'onboarding',
    updates: allowed,
    before,
  }, supabase);

  return NextResponse.json({ success: true });
}
