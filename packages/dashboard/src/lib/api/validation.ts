/**
 * Centralized Zod schemas for all write endpoints.
 *
 * Usage in route handlers:
 * ```ts
 * import { parseBody, schemas } from '@/lib/api/validation';
 *
 * export async function POST(req: NextRequest) {
 *   const parsed = await parseBody(req, schemas.automation.create);
 *   if (!parsed.ok) return parsed.response;
 *   const { name, trigger_type, ... } = parsed.data;
 * }
 * ```
 */
import { z, type ZodSchema } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

// ── Parse helpers ───────────────────────────────────

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

export async function parseBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      ),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: 'Validation failed',
          details: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: result.data };
}

// ── Shared primitives ───────────────────────────────

const snowflake = z.string().regex(/^\d{17,20}$/, 'Must be a Discord snowflake ID');
const uuid = z.string().uuid();
const safeName = z.string().min(1).max(100).trim();
const safeDescription = z.string().max(2000).trim().optional().default('');
const colorHex = z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable();
const urlString = z.string().url().max(2048).optional().nullable();
const snowflakeArray = z.array(snowflake).max(100).default([]);
const jsonObj = z.record(z.unknown()).default({});

// ── Automation schemas ──────────────────────────────

const automationBase = {
  name: safeName,
  description: safeDescription,
  trigger_type: z.string().min(1).max(64),
  trigger_config: jsonObj,
  conditions: z.array(z.record(z.unknown())).max(50).default([]),
  actions: z.array(z.record(z.unknown())).max(50).default([]),
  target_user_ids: snowflakeArray,
  target_channel_ids: snowflakeArray,
  exclude_user_ids: snowflakeArray,
  exclude_channel_ids: snowflakeArray,
};

const automationCreate = z.object(automationBase);

const automationUpdate = z.object({
  id: uuid,
  ...Object.fromEntries(
    Object.entries(automationBase).map(([k, v]) => [k, v.optional()])
  ),
  enabled: z.boolean().optional(),
});

const automationTemplateDeploySchema = z.object({
  template_id: z.string().min(1).max(64),
  overrides: z.record(z.unknown()).optional(),
});

// ── Custom command schemas ──────────────────────────

const customCommandCreate = z.object({
  name: z.string().min(1).max(32).regex(/^[\w-]+$/, 'Only lowercase letters, numbers, and hyphens'),
  description: z.string().max(100).optional(),
  actions: z.array(z.record(z.unknown())).max(25).default([]),
  allowed_roles: snowflakeArray,
  allowed_channels: snowflakeArray,
  denied_roles: snowflakeArray,
  denied_channels: snowflakeArray,
  cooldown_seconds: z.number().int().min(0).max(86400).default(0),
  ephemeral: z.boolean().default(false),
});

const customCommandUpdate = z.object({
  id: uuid,
  name: z.string().min(1).max(32).regex(/^[\w-]+$/).optional(),
  description: z.string().max(100).optional(),
  actions: z.array(z.record(z.unknown())).max(25).optional(),
  allowed_roles: snowflakeArray.optional(),
  allowed_channels: snowflakeArray.optional(),
  denied_roles: snowflakeArray.optional(),
  denied_channels: snowflakeArray.optional(),
  cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  ephemeral: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

// ── Embed schemas ───────────────────────────────────

const embedCreate = z.object({
  name: safeName,
  title: z.string().max(256).optional().nullable(),
  description: z.string().max(4096).optional().nullable(),
  color: colorHex,
  fields: z.array(z.object({
    name: z.string().max(256),
    value: z.string().max(1024),
    inline: z.boolean().optional(),
  })).max(25).default([]),
  image_url: urlString,
  thumbnail_url: urlString,
  footer_text: z.string().max(2048).optional().nullable(),
  footer_icon_url: urlString,
  author_name: z.string().max(256).optional().nullable(),
  author_url: urlString,
  author_icon_url: urlString,
  include_timestamp: z.boolean().default(false),
  use_components_v2: z.boolean().default(false),
  components_v2_data: z.record(z.unknown()).optional().nullable(),
});

const embedUpdate = z.object({
  id: uuid,
}).merge(embedCreate.partial());

// ── Product schemas ─────────────────────────────────

const productCreate = z.object({
  name: safeName,
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  description: safeDescription,
  short_description: z.string().max(200).optional(),
  type: z.enum(['one_time', 'subscription', 'free']).default('one_time'),
  price_cents: z.number().int().min(0).max(999999).default(0),
  currency: z.string().length(3).default('USD'),
  image_url: urlString,
  granted_role_ids: snowflakeArray,
  granted_channel_ids: snowflakeArray,
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(999).default(0),
  requires_license: z.boolean().default(false),
  max_quantity: z.number().int().min(0).max(9999).default(0),
});

const productUpdate = z.object({
  id: uuid,
}).merge(productCreate.partial());

// ── Plan schemas ────────────────────────────────────

const planCreate = z.object({
  product_id: uuid,
  name: safeName,
  paypal_plan_id: z.string().max(64).optional(),
  interval: z.enum(['monthly', 'quarterly', 'yearly']),
  price_cents: z.number().int().min(0).max(999999),
  currency: z.string().length(3).default('USD'),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(999).default(0),
});

// ── Promotion schemas ───────────────────────────────

const promotionCreate = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Z0-9_-]+$/i),
  product_id: uuid.optional().nullable(),
  discount_type: z.enum(['percent', 'fixed']),
  discount_value: z.number().min(0).max(100),
  max_uses: z.number().int().min(0).max(99999).default(0),
  starts_at: z.string().datetime().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
  is_active: z.boolean().default(true),
});

// ── Entitlement schemas ─────────────────────────────

const entitlementGrant = z.object({
  product_id: uuid,
  type: z.enum(['one_time', 'subscription', 'free']).default('one_time'),
  source: z.enum(['manual', 'purchase', 'gift', 'promotion']).default('manual'),
  expires_at: z.string().datetime().optional().nullable(),
  granted_role_ids: snowflakeArray,
  granted_channel_ids: snowflakeArray,
});

const entitlementUpdate = z.object({
  entitlement_id: uuid,
  status: z.enum(['active', 'cancelled', 'expired', 'revoked', 'pending', 'grace_period']),
});

// ── Order refund schema ─────────────────────────────

const orderRefund = z.object({
  reason: z.string().max(500).optional(),
  revoke_entitlements: z.boolean().default(true),
});

// ── Moderation schemas ──────────────────────────────

const moderationRule = z.object({
  name: safeName,
  type: z.string().min(1).max(64),
  config: jsonObj,
  enabled: z.boolean().default(true),
  action: z.enum(['warn', 'mute', 'kick', 'ban', 'log', 'delete']),
  action_duration: z.number().int().min(0).optional(),
  exempt_roles: snowflakeArray,
  exempt_channels: snowflakeArray,
});

const moderationRuleUpdate = z.object({
  id: uuid,
}).merge(moderationRule.partial());

const escalationConfig = z.object({
  infraction_type: z.string().min(1).max(64),
  thresholds: z.array(z.object({
    count: z.number().int().min(1).max(100),
    action: z.enum(['warn', 'mute', 'kick', 'ban']),
    duration_minutes: z.number().int().min(0).max(525600).optional(),
  })).max(10),
  window_hours: z.number().int().min(1).max(8760).default(24),
  enabled: z.boolean().default(true),
});

// ── Giveaway schemas ────────────────────────────────

const giveawayCreate = z.object({
  title: safeName,
  description: safeDescription,
  prize: z.string().min(1).max(256),
  winner_count: z.number().int().min(1).max(100).default(1),
  channel_id: snowflake,
  duration_minutes: z.number().int().min(1).max(43200).optional(),
  ends_at: z.string().datetime().optional(),
  required_role_ids: snowflakeArray,
  bonus_role_entries: z.record(z.number().int().min(1).max(10)).default({}),
});

const giveawayAction = z.object({
  action: z.enum(['end', 'reroll', 'delete']),
  id: uuid,
  winner_count: z.number().int().min(1).max(100).optional(),
});

// ── Welcome/onboarding schemas ──────────────────────

const welcomeConfig = z.object({
  enabled: z.boolean().optional(),
  channel_id: snowflake.optional().nullable(),
  message: z.string().max(2000).optional(),
  embed: z.record(z.unknown()).optional().nullable(),
  dm_enabled: z.boolean().optional(),
  dm_message: z.string().max(2000).optional(),
  goodbye_enabled: z.boolean().optional(),
  goodbye_channel_id: snowflake.optional().nullable(),
  goodbye_message: z.string().max(2000).optional(),
  auto_roles: snowflakeArray.optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

const onboardingConfig = z.object({
  enabled: z.boolean().optional(),
  prompts: z.array(z.record(z.unknown())).max(25).optional(),
  default_channels: snowflakeArray.optional(),
  mode: z.enum(['default', 'advanced']).optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

// ── Reaction role schemas ───────────────────────────

const reactionRoleCreate = z.object({
  channel_id: snowflake,
  message_id: snowflake,
  emoji: z.string().min(1).max(64),
  role_id: snowflake,
  type: z.enum(['toggle', 'add_only', 'remove_only']).default('toggle'),
});

// ── Scheduled message schemas ───────────────────────

const scheduledMessageCreate = z.object({
  channel_id: snowflake,
  content: z.string().min(1).max(2000),
  embed: z.record(z.unknown()).optional().nullable(),
  cron_expression: z.string().max(128).optional(),
  send_at: z.string().datetime().optional(),
  repeat: z.boolean().default(false),
  timezone: z.string().max(64).default('UTC'),
  name: z.string().max(100).optional(),
});

const scheduledMessageUpdate = z.object({
  id: uuid,
}).merge(scheduledMessageCreate.partial()).merge(
  z.object({ enabled: z.boolean().optional() })
);

// ── Ticket panel schemas ────────────────────────────

const ticketPanelCreate = z.object({
  name: safeName,
  channel_id: snowflake,
  category_id: snowflake.optional(),
  message: z.string().max(2000).optional(),
  embed: z.record(z.unknown()).optional().nullable(),
  button_label: z.string().max(80).optional(),
  button_emoji: z.string().max(64).optional(),
  max_open_per_user: z.number().int().min(1).max(10).default(1),
  support_role_ids: snowflakeArray,
  auto_close_hours: z.number().int().min(0).max(720).default(0),
});

// ── Level reward schemas ────────────────────────────

const levelRewardCreate = z.object({
  level: z.number().int().min(1).max(200),
  role_id: snowflake,
  remove_previous: z.boolean().default(false),
});

// ── Stats channel schemas ───────────────────────────

const statsChannelCreate = z.object({
  channel_id: snowflake,
  type: z.enum(['member_count', 'online_count', 'role_count', 'channel_count', 'boost_count', 'custom']),
  template: z.string().max(128).default('{value}'),
  custom_value: z.string().max(128).optional(),
  update_interval_minutes: z.number().int().min(5).max(1440).default(10),
});

// ── Temp channel schemas ────────────────────────────

const tempChannelCreate = z.object({
  hub_channel_id: snowflake,
  category_id: snowflake.optional(),
  name_template: z.string().max(100).default("{user}'s Channel"),
  user_limit: z.number().int().min(0).max(99).default(0),
  bitrate: z.number().int().min(8000).max(384000).optional(),
  auto_delete_empty: z.boolean().default(true),
});

// ── Guild config (PATCH /api/guild) ─────────────────

const guildConfigUpdate = z.object({
  prefix: z.string().min(1).max(10).optional(),
  locale: z.string().max(10).optional(),
  timezone: z.string().max(64).optional(),
  log_channel_id: snowflake.optional().nullable(),
  mod_log_channel_id: snowflake.optional().nullable(),
  welcome_channel_id: snowflake.optional().nullable(),
  goodbye_channel_id: snowflake.optional().nullable(),
  level_up_channel_id: snowflake.optional().nullable(),
  ticket_category_id: snowflake.optional().nullable(),
  music_channel_id: snowflake.optional().nullable(),
  audit_log_channel_id: snowflake.optional().nullable(),
  features_enabled: z.record(z.boolean()).optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

// ── License config schemas ──────────────────────────

const licenseConfig = z.object({
  enabled: z.boolean().optional(),
  max_activations: z.number().int().min(1).max(100).optional(),
  expiration_days: z.number().int().min(0).max(3650).optional(),
  hardware_lock: z.boolean().optional(),
  heartbeat_interval_minutes: z.number().int().min(1).max(1440).optional(),
  heartbeat_grace_minutes: z.number().int().min(1).max(10080).optional(),
});

// ── Setup schemas ───────────────────────────────────

const setupAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('verify-discord'),
    token: z.string().min(1),
    clientId: snowflake,
    clientSecret: z.string().optional(),
  }),
  z.object({
    action: z.literal('verify-supabase'),
    url: z.string().url(),
    serviceRoleKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('generate-invite'),
    clientId: snowflake.optional(),
  }),
  z.object({
    action: z.literal('configure-auth'),
  }),
  z.object({
    action: z.literal('finalize'),
    credentials: z.record(z.string()).optional(),
  }),
  z.object({
    action: z.literal('unlock-maintenance'),
  }),
]);

// ── Deploy / server-setup schemas ───────────────────

const deployAction = z.object({
  action: z.enum(['deploy', 'preview']).default('deploy'),
  template_id: uuid.optional(),
  options: z.record(z.unknown()).optional(),
});

// ── Sync action schemas ─────────────────────────────

const syncAction = z.object({
  action: z.enum(['repair', 'accept', 'ignore', 'clear_all']),
  driftItem: z.object({
    entityType: z.string(),
    entityName: z.string(),
    entityDiscordId: z.string().optional(),
    type: z.string(),
  }).optional(),
});

const syncConfig = z.object({
  sync_enabled: z.boolean().optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
  sync_auto_repair: z.boolean().optional(),
  sync_auto_repair_everyone: z.boolean().optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');


// ── Export all schemas ──────────────────────────────

export const schemas = {
  automation: {
    create: automationCreate,
    update: automationUpdate,
    deployTemplate: automationTemplateDeploySchema,
  },
  customCommand: {
    create: customCommandCreate,
    update: customCommandUpdate,
  },
  embed: {
    create: embedCreate,
    update: embedUpdate,
  },
  product: {
    create: productCreate,
    update: productUpdate,
  },
  plan: {
    create: planCreate,
  },
  promotion: {
    create: promotionCreate,
  },
  entitlement: {
    grant: entitlementGrant,
    update: entitlementUpdate,
  },
  order: {
    refund: orderRefund,
  },
  moderation: {
    rule: moderationRule,
    ruleUpdate: moderationRuleUpdate,
    escalation: escalationConfig,
  },
  giveaway: {
    create: giveawayCreate,
    action: giveawayAction,
  },
  welcome: {
    config: welcomeConfig,
  },
  onboarding: {
    config: onboardingConfig,
  },
  reactionRole: {
    create: reactionRoleCreate,
  },
  scheduledMessage: {
    create: scheduledMessageCreate,
    update: scheduledMessageUpdate,
  },
  ticketPanel: {
    create: ticketPanelCreate,
  },
  levelReward: {
    create: levelRewardCreate,
  },
  statsChannel: {
    create: statsChannelCreate,
  },
  tempChannel: {
    create: tempChannelCreate,
  },
  guild: {
    configUpdate: guildConfigUpdate,
  },
  license: {
    config: licenseConfig,
  },
  setup: {
    action: setupAction,
  },
  deploy: {
    action: deployAction,
  },
  sync: {
    action: syncAction,
    config: syncConfig,
  },
};

// ── Additional schemas (late additions) ─────────────

const musicConfig = z.object({
  default_volume: z.number().int().min(0).max(100).optional(),
  max_queue_size: z.number().int().min(1).max(1000).optional(),
  allow_duplicates: z.boolean().optional(),
  dj_role_id: snowflake.optional().nullable(),
  auto_leave_empty: z.boolean().optional(),
  auto_leave_timeout_seconds: z.number().int().min(0).max(3600).optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

const productFileCreate = z.object({
  name: safeName,
  file_path: z.string().max(512).optional(),
  external_url: urlString,
  version: z.string().max(32).optional(),
  platform: z.string().max(32).optional(),
  file_size_bytes: z.number().int().min(0).optional(),
});

const infractionCreate = z.object({
  target_discord_id: snowflake,
  type: z.enum(['warn', 'mute', 'kick', 'ban', 'note']),
  reason: z.string().min(1).max(1000),
  duration_minutes: z.number().int().min(0).max(525600).optional(),
  evidence: z.string().max(2000).optional(),
});

const infractionPardon = z.object({
  infraction_id: uuid,
  reason: z.string().max(500).optional(),
});

const licenseKeyUpdate = z.object({
  status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  reason: z.string().max(500).optional(),
});

// Add to schemas export
Object.assign(schemas, {
  music: { config: musicConfig },
  productFile: { create: productFileCreate },
  infraction: { create: infractionCreate, pardon: infractionPardon },
  licenseKey: { update: licenseKeyUpdate },
});

// ── Public license SDK schemas ──────────────────────

const licenseValidate = z.object({
  key: z.string().min(1).max(64),
  hardware_id: z.string().max(256).optional(),
  product_id: uuid.optional(),
  app_version: z.string().max(32).optional(),
});

const licenseHeartbeat = z.object({
  key: z.string().min(1).max(64),
  session_id: uuid,
  hardware_id: z.string().max(256).optional(),
});

const licenseDeactivate = z.object({
  key: z.string().min(1).max(64),
  session_id: uuid.optional(),
  hardware_id: z.string().max(256).optional(),
});

Object.assign(schemas, {
  licenseSdk: {
    validate: licenseValidate,
    heartbeat: licenseHeartbeat,
    deactivate: licenseDeactivate,
  },
});
