/**
 * Bulk Member Operations API — Execute bulk actions on selected members.
 *
 * V53 Phase 4 (Finding 4.4 — S-3)
 * Audit V2 Finding 3.4 — Added Zod validation via parseBody
 *
 * ── Admin-change recording ────────────────────────────────────────────────
 * These are the highest-impact buttons in the dashboard: one click can change
 * roles on 200 members, wipe 200 economy balances, or DM 200 people. They
 * already wrote `audit_logs`, which the Audit page renders as a raw JSON dump;
 * they wrote nothing to `admin_changes`, so the page an owner actually reads to
 * understand their server never mentioned them.
 *
 * NONE of them is undoable, and each says why in its own words rather than
 * sharing one vague excuse. Role changes are queued as one bot action PER
 * MEMBER, so there is no single inverse to replay (and `bulk_role_add` /
 * `bulk_role_remove` are deliberately absent from the undo allowlist);
 * `reset_economy` destroys balances with no snapshot kept; a delivered DM
 * cannot be recalled. `export` changes nothing at all and is not recorded.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { dbError } from '@/lib/api/response';
import { enrichMembers, MemberEnrichmentError } from '@/lib/api/member-enrichment';
import { recordAdminChange } from '@/lib/admin-changes';

/** "1 member" / "25 members" — the sentence has to read for a human. */
function memberCount(n: number): string {
  return n === 1 ? '1 member' : `${n} members`;
}

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

      await recordAdminChange({
        guildId,
        actorId: auth.ctx.discordId,
        action: `members.bulk_${action}`,
        targetType: 'members',
        targetId: `bulk:${member_ids.length}`,
        description: `Queued ${
          action === 'assign_role' ? 'adding' : 'removing'
        } the role ${roleId} ${
          action === 'assign_role' ? 'to' : 'from'
        } ${memberCount(member_ids.length)}`,
        after: { action, role_id: roleId, member_ids },
        blastRadius: 'high',
        undoReason:
          'each member was queued as a separate role change, so there is no single action to reverse — use the Members page to change them back',
      }, admin);

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

      await recordAdminChange({
        guildId,
        actorId: auth.ctx.discordId,
        action: 'members.bulk_reset_economy',
        targetType: 'members',
        targetId: `bulk:${member_ids.length}`,
        description: `Reset the economy balances of ${memberCount(member_ids.length)}`,
        after: { member_ids },
        blastRadius: 'critical',
        undoReason:
          'the balances were wiped in place and no copy of them was kept, so there is nothing left to restore',
      }, admin);

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

      // A silently-zeroed export is indistinguishable from real data — fail
      // loudly when any stats query behind the enrichment errors (B4).
      let enriched;
      try {
        enriched = await enrichMembers(admin, guildId, members ?? []);
      } catch (err) {
        if (err instanceof MemberEnrichmentError) return dbError(err, 'members/bulk/enrichment');
        throw err;
      }

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

      await recordAdminChange({
        guildId,
        actorId: auth.ctx.discordId,
        action: 'members.bulk_send_dm',
        targetType: 'members',
        targetId: `bulk:${member_ids.length}`,
        description: `Queued a direct message to ${memberCount(member_ids.length)}`,
        after: { member_ids, message },
        blastRadius: 'high',
        undoReason:
          'a direct message cannot be recalled once the bot has delivered it',
      }, admin);

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
