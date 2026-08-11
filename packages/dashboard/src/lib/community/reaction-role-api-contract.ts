import { z } from 'zod';

const reactionRoleSchema = z.object({
  id: z.string(),
  guild_id: z.string(),
  channel_id: z.string(),
  message_id: z.string(),
  emoji: z.string(),
  role_id: z.string(),
  exclusive_group: z.string().nullable(),
  require_role: z.string().nullable(),
  require_level: z.number().int().nullable(),
  max_per_group: z.number().int().nullable(),
  remove_on_unreact: z.boolean(),
  log_actions: z.boolean(),
  active: z.boolean(),
  created_at: z.string(),
});

const defaultsSchema = z.object({
  reaction_roles_enabled: z.boolean().optional(),
  default_style: z.enum(['buttons', 'reaction', 'select-menu']).optional(),
  default_max_per_group: z.number().int().min(0).optional(),
  default_require_level: z.number().int().min(0).optional(),
  default_remove_on_unreact: z.boolean().optional(),
}).passthrough();

const reactionRoleListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(reactionRoleSchema),
});

const reactionRoleMutationResponseSchema = z.object({
  success: z.literal(true),
  data: reactionRoleSchema,
});

const guildDefaultsResponseSchema = z.object({
  success: z.literal(true),
  config: defaultsSchema.nullable(),
});

const successResponseSchema = z.object({ success: z.literal(true) });
const errorResponseSchema = z.object({ error: z.string().min(1) });

export interface ReactionRole {
  readonly id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly emoji: string;
  readonly role_id: string;
  readonly exclusive_group: string | null;
  readonly require_role: string | null;
  readonly require_level: number | null;
  readonly max_per_group: number | null;
  readonly remove_on_unreact: boolean;
  readonly log_actions: boolean;
  readonly active: boolean;
  readonly created_at: string;
}

export interface ReactionRoleDefaults {
  readonly reaction_roles_enabled: boolean;
  readonly default_style: 'buttons' | 'reaction' | 'select-menu';
  readonly default_max_per_group: number;
  readonly default_require_level: number;
  readonly default_remove_on_unreact: boolean;
}

export interface GuildDefaultsReadback {
  readonly defaults: ReactionRoleDefaults;
  readonly configPresent: boolean;
}

export type ApiParseResult<T> =
  | { readonly kind: 'success'; readonly data: T }
  | { readonly kind: 'error'; readonly message: string };

export const DEFAULT_REACTION_ROLE_DEFAULTS: ReactionRoleDefaults = {
  reaction_roles_enabled: true,
  default_style: 'buttons',
  default_max_per_group: 0,
  default_require_level: 0,
  default_remove_on_unreact: true,
};

function errorMessage(value: unknown, fallback: string): string {
  const parsed = errorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data.error : fallback;
}

export function parseReactionRoleListResponse(value: unknown): ApiParseResult<readonly ReactionRole[]> {
  const parsed = reactionRoleListResponseSchema.safeParse(value);
  if (!parsed.success) return { kind: 'error', message: errorMessage(value, 'Reaction role response was invalid') };
  return { kind: 'success', data: parsed.data.data };
}

export function parseReactionRoleMutationResponse(value: unknown): ApiParseResult<ReactionRole> {
  const parsed = reactionRoleMutationResponseSchema.safeParse(value);
  if (!parsed.success) return { kind: 'error', message: errorMessage(value, 'Reaction role mutation response was invalid') };
  return { kind: 'success', data: parsed.data.data };
}

export function parseGuildDefaultsResponse(value: unknown): ApiParseResult<GuildDefaultsReadback> {
  const parsed = guildDefaultsResponseSchema.safeParse(value);
  if (!parsed.success) return { kind: 'error', message: errorMessage(value, 'Reaction role defaults response was invalid') };
  const config = parsed.data.config;
  return {
    kind: 'success',
    data: {
      configPresent: config !== null,
      defaults: {
        reaction_roles_enabled: config?.reaction_roles_enabled ?? DEFAULT_REACTION_ROLE_DEFAULTS.reaction_roles_enabled,
        default_style: config?.default_style ?? DEFAULT_REACTION_ROLE_DEFAULTS.default_style,
        default_max_per_group: config?.default_max_per_group ?? DEFAULT_REACTION_ROLE_DEFAULTS.default_max_per_group,
        default_require_level: config?.default_require_level ?? DEFAULT_REACTION_ROLE_DEFAULTS.default_require_level,
        default_remove_on_unreact: config?.default_remove_on_unreact ?? DEFAULT_REACTION_ROLE_DEFAULTS.default_remove_on_unreact,
      },
    },
  };
}

export function parseSuccessResponse(value: unknown, fallback: string): ApiParseResult<true> {
  const parsed = successResponseSchema.safeParse(value);
  if (!parsed.success) return { kind: 'error', message: errorMessage(value, fallback) };
  return { kind: 'success', data: true };
}

export function mappingMatchesRequest(
  observed: ReactionRole,
  requested: Pick<ReactionRole, 'id' | 'channel_id' | 'message_id' | 'emoji' | 'role_id' | 'exclusive_group' | 'require_role' | 'require_level' | 'max_per_group' | 'remove_on_unreact' | 'log_actions'>,
): boolean {
  return observed.id === requested.id
    && observed.channel_id === requested.channel_id
    && observed.message_id === requested.message_id
    && observed.emoji === requested.emoji
    && observed.role_id === requested.role_id
    && observed.exclusive_group === requested.exclusive_group
    && observed.require_role === requested.require_role
    && observed.require_level === requested.require_level
    && observed.max_per_group === requested.max_per_group
    && observed.remove_on_unreact === requested.remove_on_unreact
    && observed.log_actions === requested.log_actions;
}

export function defaultsMatchPatch(
  observed: GuildDefaultsReadback,
  requested: ReactionRoleDefaults,
  changedKeys: readonly (keyof ReactionRoleDefaults)[],
): boolean {
  return observed.configPresent
    && changedKeys.every((key) => observed.defaults[key] === requested[key]);
}
