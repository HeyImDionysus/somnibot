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

const automationCreate = z.object({
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
});

const automationUpdate = z.object({
  id: uuid,
  name: safeName.optional(),
  description: z.string().max(2000).trim().optional(),
  trigger_type: z.string().min(1).max(64).optional(),
  trigger_config: jsonObj.optional(),
  conditions: z.array(z.record(z.unknown())).max(50).optional(),
  actions: z.array(z.record(z.unknown())).max(50).optional(),
  enabled: z.boolean().optional(),
  target_user_ids: z.array(snowflake).max(100).optional(),
  target_channel_ids: z.array(snowflake).max(100).optional(),
  exclude_user_ids: z.array(snowflake).max(100).optional(),
  exclude_channel_ids: z.array(snowflake).max(100).optional(),
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
  allowed_roles: z.array(snowflake).max(100).optional(),
  allowed_channels: z.array(snowflake).max(100).optional(),
  denied_roles: z.array(snowflake).max(100).optional(),
  denied_channels: z.array(snowflake).max(100).optional(),
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
  name: safeName.optional(),
  title: z.string().max(256).optional().nullable(),
  description: z.string().max(4096).optional().nullable(),
  color: colorHex,
  fields: z.array(z.object({
    name: z.string().max(256),
    value: z.string().max(1024),
    inline: z.boolean().optional(),
  })).max(25).optional(),
  image_url: urlString,
  thumbnail_url: urlString,
  footer_text: z.string().max(2048).optional().nullable(),
  footer_icon_url: urlString,
  author_name: z.string().max(256).optional().nullable(),
  author_url: urlString,
  author_icon_url: urlString,
  include_timestamp: z.boolean().optional(),
  use_components_v2: z.boolean().optional(),
  components_v2_data: z.record(z.unknown()).optional().nullable(),
});

// ── Product schemas ─────────────────────────────────

const productCreate = z.object({
  name: safeName,
  description: safeDescription,
  type: z.enum(['one_time', 'subscription', 'free']).default('one_time'),
  delivery_type: z.string().max(32).optional(),
  price_cents: z.number().int().min(0).max(999999).default(0),
  currency: z.string().length(3).default('USD'),
  granted_role_ids: snowflakeArray,
  granted_channel_ids: snowflakeArray,
  active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(999).default(0),
  metadata: z.record(z.unknown()).optional(),
  plans: z.array(z.record(z.unknown())).optional(),
});

const productUpdate = z.object({
  id: uuid,
}).merge(productCreate.partial()).passthrough();

// ── Plan schemas ────────────────────────────────────

const planCreate = z.object({
  product_id: uuid,
  name: safeName,
  paypal_plan_id: z.string().max(64).optional(),
  interval_unit: z.string().max(32),
  interval_count: z.number().int().min(1).max(12).default(1),
  price_cents: z.number().int().min(0).max(999999),
  currency: z.string().length(3).default('USD'),
  trial_days: z.number().int().min(0).max(365).optional(),
  active: z.boolean().default(true),
});

// ── Promotion schemas ───────────────────────────────

const promotionCreate = z.object({
  name: safeName,
  type: z.enum(['percent', 'fixed']),
  value: z.number().min(0).max(100),
  coupon_code: z.string().min(1).max(32).optional(),
  applies_to_product_ids: z.array(uuid).optional(),
  applies_to_plan_ids: z.array(uuid).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
  max_uses: z.number().int().min(0).max(99999).optional(),
  min_purchase_cents: z.number().int().min(0).optional(),
  first_purchase_only: z.boolean().optional(),
  active: z.boolean().default(true),
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
  mute_duration_minutes: z.number().int().min(0).max(525600).optional(),
  exempt_roles: snowflakeArray,
  exempt_channels: snowflakeArray,
  log_to_mod_channel: z.boolean().optional(),
});

const moderationRuleUpdate = z.object({
  id: uuid,
  name: safeName.optional(),
  type: z.string().min(1).max(64).optional(),
  config: jsonObj.optional(),
  enabled: z.boolean().optional(),
  action: z.enum(['warn', 'mute', 'kick', 'ban', 'log', 'delete']).optional(),
  mute_duration_minutes: z.number().int().min(0).max(525600).optional(),
  exempt_roles: z.array(snowflake).max(100).optional(),
  exempt_channels: z.array(snowflake).max(100).optional(),
  log_to_mod_channel: z.boolean().optional(),
});

const escalationConfig = z.object({
  escalation_chain: z.array(z.record(z.unknown())).optional(),
  mod_log_channel_id: snowflake.optional().nullable(),
  infraction_expiry_days: z.number().int().min(0).max(3650).optional(),
});

// ── Giveaway schemas ────────────────────────────────

const giveawayCreate = z.object({
  channel_id: snowflake,
  prize: z.string().min(1).max(256),
  winner_count: z.number().int().min(1).max(100).optional(),
  ends_at: z.string().datetime().optional(),
  required_role_id: snowflake.optional().nullable(),
  required_level: z.number().int().min(0).optional().nullable(),
  prize_product_id: uuid.optional().nullable(),
  prize_license_count: z.number().int().min(1).max(100).optional(),
  created_by: z.string().max(128).optional(),
});

const giveawayAction = z.object({
  id: uuid,
  prize: z.string().min(1).max(256).optional(),
  winner_count: z.number().int().min(1).max(100).optional(),
  ends_at: z.string().datetime().optional().nullable(),
  required_role_id: snowflake.optional().nullable(),
  required_level: z.number().int().min(0).optional().nullable(),
  prize_product_id: uuid.optional().nullable(),
  prize_license_count: z.number().int().min(1).max(100).optional(),
  status: z.string().max(32).optional(),
  winners: z.array(z.unknown()).optional(),
});

// ── Welcome/onboarding schemas ──────────────────────

const welcomeConfig = z.object({
  welcome_enabled: z.boolean().optional(),
  welcome_channel_id: snowflake.optional().nullable(),
  welcome_message: z.string().max(2000).optional(),
  welcome_card_enabled: z.boolean().optional(),
  welcome_card_background: z.string().max(512).optional().nullable(),
  welcome_dm_enabled: z.boolean().optional(),
  welcome_dm_message: z.string().max(2000).optional(),
  welcome_auto_roles: z.array(snowflake).max(25).optional(),
  goodbye_enabled: z.boolean().optional(),
  goodbye_channel_id: snowflake.optional().nullable(),
  goodbye_message: z.string().max(2000).optional(),
});

const onboardingConfig = z.object({
  member_role_id: snowflake.optional().nullable(),
  onboarding_enabled: z.boolean().optional(),
  interest_role_mapping: z.record(z.unknown()).optional(),
  returning_member_skip_welcome_dm: z.boolean().optional(),
  returning_member_restore_entitlements: z.boolean().optional(),
  returning_member_restore_levels: z.boolean().optional(),
});

// ── Reaction role schemas ───────────────────────────

const reactionRoleCreate = z.object({
  channel_id: snowflake,
  message_id: snowflake,
  emoji: z.string().min(1).max(64),
  role_id: snowflake,
  exclusive_group: z.string().max(64).optional().nullable(),
  require_role: snowflake.optional().nullable(),
  require_level: z.number().int().min(0).optional().nullable(),
  max_per_group: z.number().int().min(0).max(100).optional().nullable(),
  remove_on_unreact: z.boolean().optional(),
  log_actions: z.boolean().optional(),
});

// ── Scheduled message schemas ───────────────────────

const scheduledMessageCreate = z.object({
  name: safeName,
  channel_id: snowflake,
  message: z.string().max(2000).optional(),
  embed_config_id: uuid.optional().nullable(),
  cron_expression: z.string().max(128).optional(),
  timezone: z.string().max(64).default('UTC'),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
  max_sends: z.number().int().min(0).optional().nullable(),
});

const scheduledMessageUpdate = z.object({
  id: uuid,
  name: safeName.optional(),
  channel_id: snowflake.optional(),
  message: z.string().max(2000).optional(),
  embed_config_id: uuid.optional().nullable(),
  cron_expression: z.string().max(128).optional(),
  timezone: z.string().max(64).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
  max_sends: z.number().int().min(0).optional().nullable(),
  active: z.boolean().optional(),
});

// ── Ticket panel schemas ────────────────────────────

const ticketPanelCreate = z.object({
  name: safeName,
  channel_id: snowflake,
  panel_message: z.string().max(2000).optional(),
  input_mode: z.string().max(32).optional(),
  ticket_types: z.array(z.record(z.unknown())).max(25).optional(),
  manager_roles: snowflakeArray,
  open_category_id: snowflake.optional().nullable(),
  closed_category_id: snowflake.optional().nullable(),
  transcript_channel_id: snowflake.optional().nullable(),
  dm_transcript_to_creator: z.boolean().optional(),
  max_open_per_user: z.number().int().min(1).max(10).default(1),
  introduction_message: z.string().max(2000).optional(),
});

// ── Level reward schemas ────────────────────────────

const levelRewardCreate = z.object({
  type: z.enum(['reward', 'multiplier']),
  level: z.number().int().min(1).max(200).optional(),
  role_id: snowflake.optional(),
  remove_at_level: z.number().int().min(0).max(200).optional().nullable(),
  announce: z.boolean().optional(),
  multiplier: z.number().min(0.1).max(10).optional(),
});

// ── Stats channel schemas ───────────────────────────

const statsChannelCreate = z.object({
  stat_type: z.string().min(1).max(64),
  name_format: z.string().max(128),
  stat_config: z.record(z.unknown()).optional(),
});

// ── Temp channel schemas ────────────────────────────

const tempChannelCreate = z.object({
  hub_channel_id: snowflake,
  category_id: snowflake.optional(),
  naming_format: z.string().max(100).optional(),
  default_user_limit: z.number().int().min(0).max(99).optional(),
  default_bitrate: z.number().int().min(8000).max(384000).optional(),
  keep_alive_minutes: z.number().int().min(0).max(1440).optional(),
  allow_text_channel: z.boolean().optional(),
  moderator_roles: snowflakeArray,
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
  features_enabled: z.record(z.boolean()).optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

// ── License config schemas ──────────────────────────

const licenseConfig = z.object({
  license_mode: z.string().max(32).optional(),
  max_devices: z.number().int().min(1).max(100).optional(),
  heartbeat_interval_seconds: z.number().int().min(0).max(86400).optional(),
  offline_grace_period_seconds: z.number().int().min(0).max(604800).optional(),
  feature_flags: z.record(z.unknown()).optional(),
  tier: z.string().max(64).optional(),
  watermark_config: z.record(z.unknown()).optional().nullable(),
  require_discord_guild_membership: z.boolean().optional(),
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
  roles: z.array(z.record(z.unknown())).optional(),
  channels: z.array(z.record(z.unknown())).optional(),
  permissionMap: z.record(z.unknown()).optional(),
  cleanExisting: z.boolean().optional(),
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

// ── Music schemas ───────────────────────────────────

const musicConfig = z.object({
  music_enabled: z.boolean().optional(),
  music_default_volume: z.number().int().min(0).max(150).optional(),
  dj_role_id: snowflake.optional().nullable(),
  music_auto_leave_minutes: z.number().int().min(0).max(60).optional(),
  music_auto_destroy_minutes: z.number().int().min(0).max(60).optional(),
});

// ── Product file schemas ────────────────────────────

const productFileCreate = z.object({
  name: safeName,
  description: z.string().max(500).optional(),
  file_path: z.string().max(512).optional(),
  external_url: urlString,
  file_size_bytes: z.number().int().min(0).optional(),
  mime_type: z.string().max(128).optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
});

// ── Infraction schemas ──────────────────────────────

const infractionCreate = z.object({
  member_id: snowflake,
  type: z.enum(['warn', 'mute', 'kick', 'ban', 'note']),
  reason: z.string().min(1).max(1000),
  moderator_id: snowflake.optional(),
  duration_minutes: z.number().int().min(0).max(525600).optional(),
});

const infractionPardon = z.object({
  action: z.enum(['pardon', 'delete']),
  id: uuid,
  pardoned_by: snowflake.optional(),
});

// ── License key schemas ─────────────────────────────

const licenseKeyUpdate = z.object({
  status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  revocation_reason: z.string().max(500).optional(),
});

// ── Public license SDK schemas ──────────────────────

const licenseValidate = z.object({
  license_key: z.string().min(1).max(512),
  product_id: uuid,
  device_fingerprint: z.string().max(256).optional(),
  device_name: z.string().max(128).optional(),
  app_version: z.string().max(32).optional(),
});

const licenseHeartbeat = z.object({
  license_key: z.string().min(1).max(512),
  session_id: uuid,
});

const licenseDeactivate = z.object({
  license_key: z.string().min(1).max(512),
  session_id: uuid.optional(),
});


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
  music: {
    config: musicConfig,
  },
  productFile: {
    create: productFileCreate,
  },
  infraction: {
    create: infractionCreate,
    pardon: infractionPardon,
  },
  licenseKey: {
    update: licenseKeyUpdate,
  },
  licenseSdk: {
    validate: licenseValidate,
    heartbeat: licenseHeartbeat,
    deactivate: licenseDeactivate,
  },
};
