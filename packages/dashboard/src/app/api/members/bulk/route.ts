/**
 * Bulk Member Operations API — Execute bulk actions on selected members.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';

type BulkAction = 'assign_role' | 'remove_role' | 'reset_economy' | 'export' | 'send_dm';

interface BulkRequest {
  member_ids: string[];
  action: BulkAction;
  params?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;

  const { guildId } = auth.ctx;
  const body = (await req.json()) as BulkRequest;
  const { member_ids, action, params } = body;

  if (!member_ids?.length || member_ids.length > 200) {
    return NextResponse.json(
      { error: 'Provide 1–200 member IDs' },
      { status: 400 },
    );
  }

  if (!action) {
    return NextResponse.json({ error: 'Action required' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  switch (action) {
    case 'assign_role':
    case 'remove_role': {
      const roleId = params?.role_id as string;
      if (!roleId) {
        return NextResponse.json({ error: 'role_id required' }, { status: 400 });
      }

      // Queue through action queue for Discord API rate limit safety
      const { error } = await admin.from('action_queue').insert(
        member_ids.map((memberId) => ({
          guild_id: guildId,
          action_type: action === 'assign_role' ? 'role_add' : 'role_remove',
          payload: { member_id: memberId, role_id: roleId },
          status: 'pending',
          created_at: new Date().toISOString(),
        })),
      );

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
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
        return NextResponse.json({ error: error.message }, { status: 500 });
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
      const { data: members, error } = await admin
        .from('members')
        .select('discord_id, username, display_name, joined_at, xp, level, wallet, bank, roles')
        .eq('guild_id', guildId)
        .in('discord_id', member_ids);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        data: members,
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

      const { error } = await admin.from('action_queue').insert(
        member_ids.map((memberId) => ({
          guild_id: guildId,
          action_type: 'send_dm',
          payload: { member_id: memberId, message },
          status: 'pending',
          created_at: new Date().toISOString(),
        })),
      );

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
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
