import { z } from 'zod';

/** Snowflake ID validation (Discord IDs) */
const snowflake = z.string().regex(/^\d{17,20}$/, 'Invalid Discord snowflake ID');

/** Optional snowflake */
const optionalSnowflake = snowflake.nullable().optional();

/**
 * Guild config validation schema.
 */
export const GuildConfigSchema = z.object({
  // Moderation
  mod_log_channel_id: optionalSnowflake,

  // Welcome
  welcome_enabled: z.boolean().default(false),
  welcome_channel_id: optionalSnowflake,
  welcome_message: z.string().max(2000).nullable().optional(),
  welcome_dm_enabled: z.boolean().default(false),
  welcome_dm_message: z.string().max(2000).nullable().optional(),
  goodbye_enabled: z.boolean().default(false),
  goodbye_channel_id: optionalSnowflake,
  goodbye_message: z.string().max(2000).nullable().optional(),

  // Levels
  levels_enabled: z.boolean().default(false),
  level_up_channel_id: optionalSnowflake,
  level_up_message: z.string().max(2000).nullable().optional(),
  xp_min: z.number().int().min(1).max(100).default(15),
  xp_max: z.number().int().min(1).max(200).default(25),
  xp_cooldown_seconds: z.number().int().min(0).max(600).default(60),
  voice_xp_enabled: z.boolean().default(false),
  voice_xp_per_interval: z.number().int().min(1).max(100).default(10),
  voice_xp_interval_minutes: z.number().int().min(1).max(60).default(5),

  // Music
  music_enabled: z.boolean().default(true),
  music_default_volume: z.number().int().min(0).max(150).default(50),
  dj_role_id: optionalSnowflake,

  // Commerce
  store_enabled: z.boolean().default(false),
  product_types_enabled: z.array(z.enum([
    'downloadable', 'license-key', 'discord-perk', 'subscription',
    'virtual-good', 'ticket-service', 'free',
  ])).default([
    'downloadable', 'license-key', 'discord-perk', 'subscription',
    'virtual-good', 'ticket-service', 'free',
  ]),
  repeat_purchase_policy: z.enum(['unique', 'stackable', 'renewable', 'seat-based']).default('unique'),
  free_claim_policy: z.enum(['one-claim', 'repeatable']).default('one-claim'),
  gifting_enabled: z.boolean().default(true),
  public_celebration_enabled: z.boolean().default(false),
  celebration_channel_id: optionalSnowflake,
  store_brand_source: z.enum(['guild-profile', 'custom']).default('guild-profile'),
  max_storefront_products: z.number().int().min(1).max(9).default(9),
  portal_session_ttl_ms: z.number().int().min(3_600_000).max(2_592_000_000).default(604_800_000),
  download_link_ttl_ms: z.number().int().min(60_000).max(3_600_000).default(300_000),
  self_service_cancellation: z.boolean().default(true),
  cancellation_timing: z.enum(['end-of-term', 'immediate']).default('end-of-term'),
  refund_requests_enabled: z.boolean().default(true),
  service_requests_enabled: z.boolean().default(true),
  portal_brand_source: z.enum(['guild-profile', 'custom']).default('guild-profile'),
});

export type GuildConfigInput = z.infer<typeof GuildConfigSchema>;

/**
 * Automation validation schema.
 */
export const AutomationSchema = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  trigger_type: z.string().min(1),
  trigger_config: z.record(z.unknown()).default({}),
  conditions: z.array(z.record(z.unknown())).max(5).default([]),
  actions: z.array(z.record(z.unknown())).min(1).max(10),
  target_user_ids: z.array(snowflake).default([]),
  target_channel_ids: z.array(snowflake).default([]),
  exclude_user_ids: z.array(snowflake).default([]),
  exclude_channel_ids: z.array(snowflake).default([]),
  rate_limit_per_user: z.number().int().nullable().optional(),
  rate_limit_window_seconds: z.number().int().nullable().optional(),
});

export type AutomationInput = z.infer<typeof AutomationSchema>;

/**
 * Product creation/update schema.
 */
export const ProductSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000),
  price: z.number().min(0),
  currency: z.string().length(3).default('USD'),
  product_type: z.enum(['one_time', 'subscription']),
  entitlement_role_id: optionalSnowflake,
  active: z.boolean().default(true),
  image_url: z.string().url().nullable().optional(),
});

export type ProductInput = z.infer<typeof ProductSchema>;

/**
 * Custom command schema.
 */
export const CustomCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[\w-]+$/, 'Command name must be alphanumeric with dashes/underscores'),
  description: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  actions: z.array(z.record(z.unknown())).min(1).max(5),
  required_role_ids: z.array(snowflake).default([]),
  allowed_channel_ids: z.array(snowflake).default([]),
  cooldown_seconds: z.number().int().min(0).max(3600).default(0),
  ephemeral: z.boolean().default(false),
});

export type CustomCommandInput = z.infer<typeof CustomCommandSchema>;

/**
 * Promotion/coupon schema.
 */
export const PromotionSchema = z.object({
  code: z.string().min(1).max(32).toUpperCase(),
  discount_type: z.enum(['percentage', 'fixed']),
  discount_value: z.number().positive(),
  product_ids: z.array(z.string().uuid()).nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
});

export type PromotionInput = z.infer<typeof PromotionSchema>;
