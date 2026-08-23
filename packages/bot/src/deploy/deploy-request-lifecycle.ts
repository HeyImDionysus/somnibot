import type { SomniClient } from '../client.js';
import type { DesiredState } from '@somnibot/shared';
import { z } from 'zod';

const desiredRoleSchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1),
  tier: z.string().default('member'),
  permissions: z.string().regex(/^\d+$/).default('0'),
  color: z.number().int().min(0).max(0xFFFFFF).default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
  position: z.number().int().min(0).default(0),
}).transform((role) => ({
  ...role,
  key: role.key ?? role.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
}));

const desiredChannelOverrideSchema = z.object({
  roleKey: z.string().min(1),
  allow: z.string().regex(/^\d+$/).default('0'),
  deny: z.string().regex(/^\d+$/).default('0'),
});

const desiredChannelSchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1),
  type: z.union([
    z.number().int().min(0),
    z.enum(['text', 'voice']).transform((type) => type === 'voice' ? 2 : 0),
  ]).default(0),
  categoryKey: z.string().min(1).nullable().default(null),
  position: z.number().int().min(0).default(0),
  topic: z.string().nullable().default(null),
  slowmode: z.number().int().min(0).default(0),
  nsfw: z.boolean().default(false),
  templateId: z.string().default('custom'),
  overrides: z.array(desiredChannelOverrideSchema).default([]),
}).transform((channel) => ({
  ...channel,
  key: channel.key ?? channel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
}));

const desiredCategorySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().min(0),
});

const deployRowBaseSchema = z.object({
  guild_id: z.string().min(1),
  deploy_request_id: z.string().uuid(),
  deploy_mode: z.enum(['safe', 'destructive']).default('safe'),
  applied_at: z.null(),
  roles: z.array(desiredRoleSchema),
  channels: z.array(desiredChannelSchema),
  categories: z.array(desiredCategorySchema).default([]),
});

const requestedDeployRowSchema = deployRowBaseSchema.extend({
  deploy_status: z.literal('requested'),
});

const claimedDeployRowSchema = deployRowBaseSchema.extend({
  deploy_status: z.literal('running'),
  deploy_claim_token: z.string().uuid(),
  deploy_lease_expires_at: z.string().datetime({ offset: true }),
});

const claimedDeployIdentitySchema = z.object({
  guild_id: z.string().min(1),
  deploy_request_id: z.string().uuid(),
  deploy_claim_token: z.string().uuid(),
  deploy_status: z.literal('running'),
});

export type RequestedDeployRow = z.infer<typeof requestedDeployRowSchema>;
export type ClaimedDeployRow = z.infer<typeof claimedDeployRowSchema>;

function withFallbackGuildId(value: unknown, fallbackGuildId: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const guildId = 'guild_id' in value && typeof value.guild_id === 'string'
    ? value.guild_id
    : fallbackGuildId;
  return { ...value, guild_id: guildId };
}

export function parseRequestedDeployRow(
  value: unknown,
  fallbackGuildId: string,
): RequestedDeployRow | null {
  const result = requestedDeployRowSchema.safeParse(withFallbackGuildId(value, fallbackGuildId));
  return result.success ? result.data : null;
}

export function desiredStateFromDeployRow(row: ClaimedDeployRow): DesiredState {
  const categories = [...row.categories];
  if (categories.length === 0) {
    const seen = new Set<string>();
    for (const channel of row.channels) {
      if (!channel.categoryKey || seen.has(channel.categoryKey)) continue;
      seen.add(channel.categoryKey);
      categories.push({
        key: channel.categoryKey,
        name: channel.categoryKey
          .replace(/^cat-/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (character) => character.toUpperCase()),
        position: categories.length,
      });
    }
  }
  return {
    everyonePermissions: '0',
    roles: row.roles,
    categories,
    channels: row.channels,
  };
}

export async function claimDeployRequest(
  client: SomniClient,
  request: RequestedDeployRow,
): Promise<ClaimedDeployRow | null> {
  const { data, error } = await client.supabase.rpc('claim_deploy_request', {
    p_guild_id: request.guild_id,
    p_request_id: request.deploy_request_id,
  });
  if (error) throw new Error(`Failed to claim deployment request: ${error.message}`);
  if (data === null) return null;
  const parsed = claimedDeployRowSchema.safeParse(data);
  if (!parsed.success) {
    const message = `Claimed deployment request is malformed: ${parsed.error.message}`;
    const identity = claimedDeployIdentitySchema.safeParse(data);
    if (identity.success) {
      const { error: settlementError } = await client.supabase.rpc('settle_deploy_request', {
        p_guild_id: identity.data.guild_id,
        p_request_id: identity.data.deploy_request_id,
        p_claim_token: identity.data.deploy_claim_token,
        p_success: false,
        p_error: message,
      });
      if (settlementError) {
        throw new Error(`${message}; failed to settle it: ${settlementError.message}`);
      }
    }
    throw new Error(message);
  }
  return parsed.data;
}

export async function settleDeployRequest(
  client: SomniClient,
  request: ClaimedDeployRow,
  success: boolean,
  errorMessage?: string,
): Promise<boolean> {
  const { data, error } = await client.supabase.rpc('settle_deploy_request', {
    p_guild_id: request.guild_id,
    p_request_id: request.deploy_request_id,
    p_claim_token: request.deploy_claim_token,
    p_success: success,
    p_error: errorMessage ?? null,
  });
  if (error) throw new Error(`Failed to settle deployment request: ${error.message}`);
  return z.boolean().parse(data);
}

export async function renewDeployRequestClaim(
  client: SomniClient,
  request: ClaimedDeployRow,
): Promise<boolean> {
  const { data, error } = await client.supabase.rpc('renew_deploy_request_claim', {
    p_guild_id: request.guild_id,
    p_request_id: request.deploy_request_id,
    p_claim_token: request.deploy_claim_token,
  });
  if (error) throw new Error(`Failed to renew deployment claim: ${error.message}`);
  return z.boolean().parse(data);
}

export async function failInterruptedDeployRequests(client: SomniClient): Promise<number> {
  const { data, error } = await client.supabase.rpc('fail_interrupted_deploy_requests');
  if (error) throw new Error(`Failed to reconcile interrupted deployments: ${error.message}`);
  return z.number().int().min(0).parse(data);
}
