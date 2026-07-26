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

/**
 * PostgREST silently truncates any response at max_rows (1000) WITHOUT an
 * error — the exact fabricated-data failure this module exists to prevent
 * (e.g. a 1000-member bulk export whose members hold >1000 active
 * infractions would silently report is_banned=false past the cap). Every
 * stats read pages with a stable order until a short page.
 */
const ENRICH_PAGE = 1000;

async function pagedRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  source: MemberEnrichmentError['source'],
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += ENRICH_PAGE) {
    const { data, error } = await buildQuery(from, from + ENRICH_PAGE - 1);
    if (error) throw new MemberEnrichmentError(source, error);
    all.push(...(data ?? []));
    if ((data ?? []).length < ENRICH_PAGE) break;
  }
  return all;
}

export async function enrichMembers(
  admin: SupabaseClient,
  guildId: string,
  rows: MemberIdentity[],
) {
  const ids = rows.map((r) => r.discord_id);
  if (ids.length === 0) return [];

  const [levelRows, walletRows, infractionRows] = await Promise.all([
    pagedRows(
      (from, to) =>
        admin
          .from('member_levels')
          .select('member_id, xp, level')
          .eq('guild_id', guildId)
          .in('member_id', ids)
          .order('member_id', { ascending: true })
          .range(from, to),
      'member_levels',
    ),
    pagedRows(
      (from, to) =>
        admin
          .from('economy_wallets')
          .select('user_id, wallet, bank, suspended')
          .eq('guild_id', guildId)
          .in('user_id', ids)
          .order('user_id', { ascending: true })
          .range(from, to),
      'economy_wallets',
    ),
    pagedRows(
      (from, to) =>
        admin
          .from('infractions')
          .select('member_id, type')
          .eq('guild_id', guildId)
          .eq('active', true)
          .in('type', ['mute', 'ban'])
          .in('member_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      'infractions',
    ),
  ]);

  const levels = new Map(
    (levelRows as Array<{ member_id: string; xp: number; level: number }>).map((l) => [l.member_id, l]),
  );
  const wallets = new Map(
    (walletRows as Array<{ user_id: string; wallet: number; bank: number; suspended: boolean }>).map(
      (w) => [w.user_id, w],
    ),
  );
  const typedInfractions = infractionRows as Array<{ member_id: string; type: string }>;
  const muted = new Set(typedInfractions.filter((i) => i.type === 'mute').map((i) => i.member_id));
  const banned = new Set(typedInfractions.filter((i) => i.type === 'ban').map((i) => i.member_id));

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
