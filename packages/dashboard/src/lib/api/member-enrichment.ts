/**
 * Join member identity rows with the tables that actually hold their stats.
 *
 * The members table stores identity only. XP and level live in member_levels,
 * wallet balances in economy_wallets, and "muted"/"banned" are ACTIVE
 * infractions. The members API used to select all of those as columns of
 * `members` — columns the schema has never had — so every request failed with
 * "column does not exist" and the Members page never rendered a single row.
 *
 * Three targeted IN-queries rather than PostgREST embeds, because
 * member_levels/economy_wallets key on (guild_id, member_id/user_id) without
 * declared foreign keys to members, so embedding is not available.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface MemberIdentity {
  discord_id: string;
  username: string | null;
  avatar_url?: string | null;
  roles: unknown;
  joined_at: string | null;
}

/**
 * A stats query failed. Thrown instead of returning fabricated zeros: a
 * silently-zeroed members page (or CSV export) is indistinguishable from real
 * data, so callers must catch this and fail the request loudly (dbError).
 */
export class MemberEnrichmentError extends Error {
  readonly source: 'member_levels' | 'economy_wallets' | 'infractions';

  constructor(source: MemberEnrichmentError['source'], cause: { message: string }) {
    super(`${source} enrichment query failed: ${cause.message}`);
    this.name = 'MemberEnrichmentError';
    this.source = source;
  }
}

export async function enrichMembers(
  admin: SupabaseClient,
  guildId: string,
  rows: MemberIdentity[],
) {
  const ids = rows.map((r) => r.discord_id);
  if (ids.length === 0) return [];

  const [levelsRes, walletsRes, infractionsRes] = await Promise.all([
    admin
      .from('member_levels')
      .select('member_id, xp, level')
      .eq('guild_id', guildId)
      .in('member_id', ids),
    admin
      .from('economy_wallets')
      .select('user_id, wallet, bank, suspended')
      .eq('guild_id', guildId)
      .in('user_id', ids),
    admin
      .from('infractions')
      .select('member_id, type')
      .eq('guild_id', guildId)
      .eq('active', true)
      .in('type', ['mute', 'ban'])
      .in('member_id', ids),
  ]);

  if (levelsRes.error) throw new MemberEnrichmentError('member_levels', levelsRes.error);
  if (walletsRes.error) throw new MemberEnrichmentError('economy_wallets', walletsRes.error);
  if (infractionsRes.error) throw new MemberEnrichmentError('infractions', infractionsRes.error);

  const levels = new Map((levelsRes.data ?? []).map((l) => [l.member_id as string, l]));
  const wallets = new Map((walletsRes.data ?? []).map((w) => [w.user_id as string, w]));
  const muted = new Set(
    (infractionsRes.data ?? []).filter((i) => i.type === 'mute').map((i) => i.member_id),
  );
  const banned = new Set(
    (infractionsRes.data ?? []).filter((i) => i.type === 'ban').map((i) => i.member_id),
  );

  return rows.map((r) => ({
    // The page keys rows on `id`; members has a composite primary key, so the
    // Discord id — unique within a guild — serves as the row id.
    id: r.discord_id,
    discord_id: r.discord_id,
    username: r.username,
    // Discord display names are not persisted; consumers fall back to username.
    display_name: null,
    avatar_url: r.avatar_url ?? null,
    roles: r.roles,
    joined_at: r.joined_at,
    xp: levels.get(r.discord_id)?.xp ?? 0,
    level: levels.get(r.discord_id)?.level ?? 0,
    wallet: wallets.get(r.discord_id)?.wallet ?? 0,
    bank: wallets.get(r.discord_id)?.bank ?? 0,
    is_muted: muted.has(r.discord_id),
    is_banned: banned.has(r.discord_id),
    suspended: wallets.get(r.discord_id)?.suspended ?? false,
  }));
}
