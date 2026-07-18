import type { SupabaseClient } from '@supabase/supabase-js';

export type LiveTemporaryRoleOwner = {
  id: string;
  guild_id: string;
  user_id: string;
  role_id: string;
  expires_at: string;
  grant_status: 'pending' | 'applied';
  remove_on_expiry: boolean;
  order_id: string | null;
};

type TemporaryRoleGrantInspectionBase = Omit<LiveTemporaryRoleOwner, 'grant_status'> & {
  duration_seconds: number;
  order_id: string;
  parent_order_status: string;
  entitlement_is_live: boolean;
};

export type TemporaryRoleGrantInspection = TemporaryRoleGrantInspectionBase & (
  | { grant_status: 'pending'; applied_at: null }
  | { grant_status: 'applied'; applied_at: string }
);

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * Resolve one DB-authoritative temporary-role owner. The RPC joins exact paid
 * parent state, so terminal order-backed grants are never returned as live.
 */
export async function findLiveTemporaryRoleOwner(
  supabase: SupabaseClient,
  input: {
    guildId: string;
    userId: string;
    roleId: string;
    excludeGrantId?: string | null;
    excludeGrantIds?: string[];
    excludeOrderId?: string | null;
  },
): Promise<LiveTemporaryRoleOwner | null> {
  if (
    input.excludeGrantIds !== undefined
    && (
      !Array.isArray(input.excludeGrantIds)
      || input.excludeGrantIds.some((grantId) => !isNonBlankString(grantId))
      || new Set(input.excludeGrantIds).size !== input.excludeGrantIds.length
      || input.excludeGrantId !== undefined
    )
  ) {
    throw new Error('temporary role ownership exclusion vector is malformed');
  }
  const exclusionParams = input.excludeGrantIds === undefined
    ? { p_exclude_grant_id: input.excludeGrantId ?? null }
    : { p_exclude_grant_ids: input.excludeGrantIds };
  const { data, error } = await supabase.rpc('commerce_find_live_temp_role_owner', {
    p_guild_id: input.guildId,
    p_user_id: input.userId,
    p_role_id: input.roleId,
    ...exclusionParams,
    p_exclude_order_id: input.excludeOrderId ?? null,
  });
  if (error) {
    throw new Error(`temporary role ownership lookup failed: ${error.message}`);
  }
  if (data === null) return null;
  if (!data || typeof data !== 'object') {
    throw new Error('temporary role ownership lookup returned a malformed result');
  }

  const owner = data as Partial<LiveTemporaryRoleOwner>;
  if (
    !isNonBlankString(owner.id)
    || owner.guild_id !== input.guildId
    || owner.user_id !== input.userId
    || owner.role_id !== input.roleId
    || !isNonBlankString(owner.expires_at)
    || !Number.isFinite(Date.parse(owner.expires_at))
    || (owner.grant_status !== 'pending' && owner.grant_status !== 'applied')
    || typeof owner.remove_on_expiry !== 'boolean'
    || (owner.order_id !== null && !isNonBlankString(owner.order_id))
    || (owner.grant_status === 'pending' && !isNonBlankString(owner.order_id))
    || (input.excludeGrantId != null && owner.id === input.excludeGrantId)
    || (input.excludeGrantIds?.includes(owner.id ?? '') ?? false)
    || (input.excludeOrderId != null && owner.order_id === input.excludeOrderId)
  ) {
    throw new Error('temporary role ownership lookup returned a mismatched grant');
  }
  if (
    owner.grant_status === 'applied'
    && Date.parse(owner.expires_at) <= Date.now()
  ) {
    // The DB selected this row before its deadline, but it crossed the boundary
    // in transit. Ordinary clock passage means "not live", not malformed data.
    return null;
  }
  return owner as LiveTemporaryRoleOwner;
}

export async function inspectTemporaryRoleGrant(
  supabase: SupabaseClient,
  grantId: string,
): Promise<TemporaryRoleGrantInspection | null> {
  const { data, error } = await supabase.rpc('commerce_inspect_temp_role_grant', {
    p_grant_id: grantId,
  });
  if (error) {
    throw new Error(`temporary role lifecycle inspection failed: ${error.message}`);
  }
  if (data === null) return null;
  if (!data || typeof data !== 'object') {
    throw new Error('temporary role lifecycle inspection returned malformed data');
  }
  const grant = data as Partial<TemporaryRoleGrantInspection>;
  const appliedAt = isNonBlankString(grant.applied_at)
    ? Date.parse(grant.applied_at)
    : Number.NaN;
  const expiresAt = isNonBlankString(grant.expires_at)
    ? Date.parse(grant.expires_at)
    : Number.NaN;
  if (
    grant.id !== grantId
    || !isNonBlankString(grant.guild_id)
    || !isNonBlankString(grant.user_id)
    || !isNonBlankString(grant.role_id)
    || !isNonBlankString(grant.expires_at)
    || !Number.isFinite(expiresAt)
    || !Number.isSafeInteger(grant.duration_seconds)
    || Number(grant.duration_seconds) <= 0
    || Number(grant.duration_seconds) > 315_360_000
    || (grant.grant_status !== 'pending' && grant.grant_status !== 'applied')
    || typeof grant.remove_on_expiry !== 'boolean'
    || (
      grant.grant_status === 'pending'
        ? grant.applied_at !== null
        : !Number.isFinite(appliedAt)
          || expiresAt - appliedAt !== Number(grant.duration_seconds) * 1_000
    )
    || !isNonBlankString(grant.order_id)
    || !isNonBlankString(grant.parent_order_status)
    || typeof grant.entitlement_is_live !== 'boolean'
  ) {
    throw new Error('temporary role lifecycle inspection returned a mismatched grant');
  }
  return grant as TemporaryRoleGrantInspection;
}
