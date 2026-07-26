/**
 * Bulk Member Operations API — Execute bulk actions on selected members.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 * Audit V2 Finding 3.4 — Added Zod validation via parseBody
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { enrichMembers } from '@/lib/api/member-enrichment';

export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'bulk');
  if (rateLimited) return rateLimited;

  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId } = auth.ctx;
  const parsed = await parseBody(req, schemas.bulk.memberOperation);
  if (!parsed.ok) return parsed.response;
  const { member_ids, action, params } = parsed.data;

  const admin = createAdminSupabase();

  switch (action) {
    case 'assign_role':
    case 'remove_role': {
      const roleId = params?.role_id as string;
      if (!roleId) {
        return NextResponse.json({ error: 'role_id required' }, { status: 400 });
      }

      // Queue through bot_action_queue for Discord API rate limit safety
      const { error } = await admin.from('bot_action_queue').insert(
        member_ids.map((memberId) => ({
          guild_id: guildId,
          action: action === 'assign_role' ? 'bulk_role_add' : 'bulk_role_remove',
          payload: { member_id: memberId, role_id: roleId },
          status: 'pending',
        })),
      );

      if (error) {
        return dbError(error, 'members/bulk');
      }

      // Audit log
      await admin.from('audit_logs').insert({
        guild_id: guildId,
        actor_type: 'dashboard',
        actor_id: auth.ctx.discordId,
        action: `bulk.${action}`,
        target_type: 'members',
        target_id: `bulk:${member_ids.length}`,
        details: { member_count: member_ids.length, role_id: roleId },
      });

      return NextResponse.json({
        success: true,
        message: `${member_ids.length} ${action.replace('_', ' ')} actions queued`,
        queued: member_ids.length,
      });
    }

    case 'reset_economy': {
      const { error } = await admin.rpc('bulk_reset_economy', {
        p_guild_id: guildId,
        p_member_ids: member_ids,
      });

      if (error) {
        return dbError(error, 'members/bulk');
      }

      await admin.from('audit_logs').insert({
        guild_id: guildId,
        actor_type: 'dashboard',
        actor_id: auth.ctx.discordId,
        action: 'bulk.reset_economy',
        target_type: 'members',
        target_id: `bulk:${member_ids.length}`,
        details: { member_count: member_ids.length },
      });

      return NextResponse.json({
        success: true,
        message: `Economy reset for ${member_ids.length} members`,
        affected: member_ids.length,
      });
    }

    case 'export': {
      // Identity from members; xp/level/wallet/bank/moderation state joined
      // from their real tables — selecting them here as members columns made
      // every export fail with "column does not exist".
      const { data: members, error } = await admin
        .from('members')
        .select('discord_id, username, joined_at, roles')
        .eq('guild_id', guildId)
        .in('discord_id', member_ids)
        .limit(1000);

      if (error) {
        return dbError(error, 'members/bulk');
      }

      const enriched = await enrichMembers(admin, guildId, members ?? []);

      return NextResponse.json({
        success: true,
        data: enriched,
        format: 'json',
      });
    }

    case 'send_dm': {
      const message = params?.message as string;
      if (!message || message.length > 2000) {
        return NextResponse.json(
          { error: 'Message required (max 2000 chars)' },
          { status: 400 },
        );
      }

      const { error } = await admin.from('bot_action_queue').insert(
        member_ids.map((memberId) => ({
          guild_id: guildId,
          action: 'bulk_send_dm',
          payload: { member_id: memberId, message },
          status: 'pending',
        })),
      );

      if (error) {
        return dbError(error, 'members/bulk');
      }

      await admin.from('audit_logs').insert({
        guild_id: guildId,
        actor_type: 'dashboard',
        actor_id: auth.ctx.discordId,
        action: 'bulk.send_dm',
        target_type: 'members',
        target_id: `bulk:${member_ids.length}`,
        details: { member_count: member_ids.length, message_length: message.length },
      });

      return NextResponse.json({
        success: true,
        message: `${member_ids.length} DM actions queued`,
        queued: member_ids.length,
      });
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }
}
