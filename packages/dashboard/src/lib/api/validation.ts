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
import { optionalHttpUrlSchema } from './discord-values';
import { NextRequest, NextResponse } from 'next/server';
import {
  ACTION_TYPES,
  AUTOMATION_LIMITS,
  CONDITION_TYPES,
  TRIGGER_TYPES,
} from '@somnibot/shared';

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
const embedColor = z.number().int().min(0).max(0xffffff).optional().nullable();
const urlString = z.string().url().max(2048).optional().nullable();
const snowflakeArray = z.array(snowflake).max(100).default([]);
const uniqueSnowflakeArray = snowflakeArray.refine(
  (values) => new Set(values).size === values.length,
  'Discord ID lists cannot contain duplicates',
);
// Update semantics: omitted lists must stay omitted (no default([]) wipe).
const optionalUniqueSnowflakeArray = z.array(snowflake).max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    'Discord ID lists cannot contain duplicates',
  )
  .optional();
const jsonObj = z.record(z.unknown()).default({});

// ── Automation schemas ──────────────────────────────

const automationCondition = z.object({
  type: z.enum(CONDITION_TYPES),
  config: jsonObj,
}).strict();

const automationAction = z.object({
  type: z.enum(ACTION_TYPES),
  config: jsonObj,
}).strict();

const automationCreate = z.object({
  name: safeName,
  description: safeDescription,
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger_config: jsonObj,
  conditions: z.array(automationCondition)
    .max(AUTOMATION_LIMITS.MAX_CONDITIONS_PER_AUTOMATION)
    .default([]),
  actions: z.array(automationAction)
    .max(AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION)
    .default([]),
  target_user_ids: uniqueSnowflakeArray,
  target_channel_ids: uniqueSnowflakeArray,
  exclude_user_ids: uniqueSnowflakeArray,
  exclude_channel_ids: uniqueSnowflakeArray,
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const automationUpdate = z.object({
  id: uuid,
  name: safeName.optional(),
  description: z.string().max(2000).trim().optional(),
  trigger_type: z.enum(TRIGGER_TYPES).optional(),
  trigger_config: jsonObj.optional(),
  conditions: z.array(automationCondition)
    .max(AUTOMATION_LIMITS.MAX_CONDITIONS_PER_AUTOMATION)
    .optional(),
  actions: z.array(automationAction)
    .max(AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION)
    .optional(),
  enabled: z.boolean().optional(),
  target_user_ids: optionalUniqueSnowflakeArray,
  target_channel_ids: optionalUniqueSnowflakeArray,
  exclude_user_ids: optionalUniqueSnowflakeArray,
  exclude_channel_ids: optionalUniqueSnowflakeArray,
  preview_hash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const automationTemplateDeploySchema = z.object({
  template_id: z.string().min(1).max(64),
  overrides: z.object({
    name: safeName.optional(),
    conditions: z.array(automationCondition)
      .max(AUTOMATION_LIMITS.MAX_CONDITIONS_PER_AUTOMATION)
      .optional(),
    actions: z.array(automationAction)
      .max(AUTOMATION_LIMITS.MAX_ACTIONS_PER_AUTOMATION)
      .optional(),
    target_user_ids: uniqueSnowflakeArray.optional(),
    target_channel_ids: uniqueSnowflakeArray.optional(),
    exclude_user_ids: uniqueSnowflakeArray.optional(),
    exclude_channel_ids: uniqueSnowflakeArray.optional(),
  }).strict().optional(),
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
  color: embedColor,
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
  color: embedColor,
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

const reservedCommerceMetadataKeys = [
  'grant_role_id',
  'historical_grant_role_ids',
  'role_duration_hours',
  'commerce_plan_recovery',
] as const;

const productMetadata = z.record(z.unknown()).superRefine((metadata, ctx) => {
  for (const key of reservedCommerceMetadataKeys) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      const message = key === 'commerce_plan_recovery'
        ? `Commerce metadata key "${key}" is reserved for server-managed state.`
        : `Legacy commerce metadata key "${key}" is not accepted. Put permanent product role benefits in granted_role_ids instead.`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message,
      });
    }
  }
});

const productPlanDefinition = z.object({
  name: safeName.optional(),
  interval_unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']).optional(),
  interval_count: z.number().int().min(1).max(12).optional(),
  price_cents: z.number().int().min(0).max(999999).optional(),
  trial_days: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
}).strict();

const productCreate = z.object({
  id: uuid.optional(),
  name: safeName,
  description: safeDescription,
  type: z.enum(['one_time', 'subscription', 'free']).default('one_time'),
  delivery_type: z.enum(['file', 'link', 'access_pass', 'license_key', 'mixed']),
  price_cents: z.number().int().min(0).max(999999).default(0),
  currency: z.string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default('USD'),
  granted_role_ids: snowflakeArray,
  granted_channel_ids: snowflakeArray,
  active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(999).default(0),
  metadata: productMetadata.optional(),
  plans: z.array(productPlanDefinition).max(1).optional(),
});

// STRICT update schema — mass-assignment guard.
//
// The store/products PUT route spreads every parsed key straight into the DB
// `.update()` payload. A permissive schema therefore lets a client write ANY
// column it names. `paypal_product_id` is the dangerous one: it is a PayPal
// Catalog identifier assigned once by the create route and TRUSTED by
// checkout/webhook routing to map a product to its PayPal entry, so a
// client-supplied value could repoint a product at an attacker-chosen catalog
// id.
//
// Build the update shape from the create schema's writable columns only:
//   - `.omit({ plans: true })` — `plans` is a create-only input (plan
//     definitions consumed by the POST route); it is NOT a `products` column,
//     so forwarding it to `.update()` would target a non-existent column.
//   - `.partial()` — every column is optional on update (and Zod strips the
//     create-time `.default()`s, so an omitted key is left untouched instead of
//     being reset to its default).
//   - `.strict()` — reject unknown keys (paypal_product_id, guild_id,
//     created_at, and anything else not in the writable set) rather than
//     passing them through. This is the ROOT fix: only the intended writable
//     columns can ever reach the DB, so the undo `products.data` allowlist is
//     correct by construction (paypal_product_id excluded from both).
const productUpdate = productCreate
  .omit({ plans: true, id: true })
  .partial()
  .extend({ id: uuid })
  .strict();

// ── Plan schemas ────────────────────────────────────

const planCreate = z.object({
  product_id: uuid,
  name: safeName,
  paypal_plan_id: z.string().trim().min(1).max(64).nullable().optional(),
  interval_unit: z.string().max(32),
  interval_count: z.number().int().min(1).max(12).default(1),
  price_cents: z.number().int().min(0).max(999999),
  currency: z.string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default('USD'),
  trial_days: z.number().int().min(0).max(365).optional(),
  active: z.boolean().default(true),
}).strict();

const planUpdate = planCreate
  .partial()
  .extend({ id: uuid })
  .strict();

// ── Promotion schemas ───────────────────────────────

const promotionCreate = z.object({
  name: safeName,
  type: z.enum(['percent', 'fixed']),
  value: z.number().min(0),  // max validated per-type via .refine() below
  coupon_code: z.string().min(1).max(32).optional(),
  applies_to_product_ids: z.array(uuid).optional(),
  applies_to_plan_ids: z.array(uuid).optional(),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable(),
  max_uses: z.number().int().min(0).max(99999).optional(),
  min_purchase_cents: z.number().int().min(0).optional(),
  first_purchase_only: z.boolean().optional(),
  active: z.boolean().default(true),
}).refine(
  (data) => data.type !== 'percent' || data.value <= 100,
  { message: 'Percent discount cannot exceed 100%', path: ['value'] },
);

// ── Entitlement schemas ─────────────────────────────

const entitlementGrant = z.object({
  // Reuse this UUID when retrying a request whose response was lost. The
  // atomic grant RPC uses it as the durable order identity and rejects any
  // replay whose contract differs.
  request_id: uuid,
  product_id: uuid,
  // Must mirror the entitlements table CHECK (type IN ('one_time','subscription'))
  // and EntitlementService.grant's 'one_time' | 'subscription' union. 'free' was
  // ungrantable — it passed zod, manufactured an order, then died on a raw DB
  // CHECK violation surfaced as a generic 500. Nothing grants a 'free'
  // entitlement (no UI/bot/docs/tests reference it), so it is removed here.
  type: z.enum(['one_time', 'subscription']).default('one_time'),
  // Subscription grants must identify the exact active product plan. Picking a
  // plan implicitly would make retries depend on mutable catalog ordering.
  plan_id: uuid.optional().nullable(),
  // This is the owner-only manual grant surface, not a payment finalizer.
  // Accepting `purchase` manufactured a zero-dollar completed order without
  // payment evidence or a paid role-delivery intent, so the route returned
  // success for access that the authoritative paid classifier could never
  // grant or repair. Real purchases enter through the PayPal finalizers;
  // admin grants must remain in the explicitly non-purchase sources.
  source: z.enum(['giveaway', 'manual', 'automation']).default('manual'),
  expires_at: z.string().datetime().optional().nullable(),
  granted_role_ids: uniqueSnowflakeArray,
  granted_channel_ids: uniqueSnowflakeArray,
}).superRefine((value, ctx) => {
  if (value.type === 'subscription' && !value.plan_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Subscription entitlement grants require plan_id',
      path: ['plan_id'],
    });
  }
  if (value.type === 'one_time' && value.plan_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'One-time entitlement grants cannot include plan_id',
      path: ['plan_id'],
    });
  }
});

const entitlementUpdate = z.object({
  entitlement_id: uuid,
  status: z.enum(['active', 'cancelled', 'expired', 'revoked', 'pending', 'grace_period']),
});

// ── Order refund schema ─────────────────────────────

const orderRefund = z.object({
  reason: z.string().trim().min(1).max(255).optional(),
  // A full owner refund always revokes the purchased access. Accepting false
  // while the finalizer revoked access anyway made the API contract lie.
  revoke_entitlements: z.literal(true).default(true),
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
  appeals_enabled: z.boolean().optional(),
  appeal_cooldown_hours: z.number().int().min(1).max(168).optional(),
  appeal_review_channel_id: snowflake.optional().nullable(),
  dm_on_action: z.boolean().optional(),
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
  ended_at: z.string().datetime().optional().nullable(),
});

// Guild-level giveaway defaults (catalog: community.json giveaways controls).
const giveawaySettings = z.object({
  giveaway_default_winner_count: z.number().int().min(1).max(100).optional(),
  giveaway_dm_winners: z.boolean().optional(),
  giveaway_entry_button_label: z.string().min(1).max(80).optional(),
  giveaway_winner_announcement_style: z.enum(['embed', 'plain']).optional(),
});

// ── Welcome/onboarding schemas ──────────────────────

const welcomeConfig = z.object({
  welcome_enabled: z.boolean().optional(),
  welcome_channel_id: snowflake.optional().nullable(),
  welcome_message: z.string().max(2000).nullable().optional(),
  welcome_card_enabled: z.boolean().optional(),
  welcome_card_background: optionalHttpUrlSchema,
  welcome_dm_enabled: z.boolean().optional(),
  welcome_dm_message: z.string().max(2000).nullable().optional(),
  welcome_auto_roles: z.array(snowflake).max(25).optional(),
  goodbye_enabled: z.boolean().optional(),
  goodbye_channel_id: snowflake.optional().nullable(),
  goodbye_message: z.string().max(2000).nullable().optional(),
});

const nativeOnboardingOption = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(100).optional(),
  emoji: z.string().trim().max(100).optional(),
  role_ids: z.array(snowflake).max(25).optional(),
  channel_ids: z.array(snowflake).max(25).optional(),
});

const nativeOnboardingPrompt = z.object({
  title: z.string().trim().min(1).max(100),
  type: z.enum(['multiple_choice', 'dropdown']),
  required: z.boolean(),
  single_select: z.boolean(),
  options: z.array(nativeOnboardingOption).min(1).max(12),
});

const nativeOnboardingConfig = z.object({
  enabled: z.boolean(),
  prompts: z.array(nativeOnboardingPrompt).max(5),
  default_channel_ids: z.array(snowflake).max(25),
});

const onboardingConfig = z.object({
  member_role_id: snowflake.optional().nullable(),
  onboarding_enabled: z.boolean().optional(),
  interest_role_mapping: z.record(snowflake).optional(),
  returning_member_skip_welcome_dm: z.boolean().optional(),
  returning_member_restore_entitlements: z.boolean().optional(),
  returning_member_restore_levels: z.boolean().optional(),
  onboarding_config: nativeOnboardingConfig.optional().nullable(),
  fallback_mode: z.enum(['grant-after-timeout', 'manual-review']).optional(),
  fallback_timeout_minutes: z.number().int().min(1).max(1440).optional(),
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
  missed_run_policy: z.enum(['skip-missed', 'send-latest']).optional(),
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
  missed_run_policy: z.enum(['skip-missed', 'send-latest']).optional(),
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

const namePlaceholder = (s: string) => s.includes('{value}') || s.includes('{count}');
const namePlaceholderMsg = 'name_format must contain {value} or {count}';

const statsChannelConfig = z.object({
  category_id: snowflake,
  value: z.string().max(128).optional(),
}).passthrough();

const statsChannelCreate = z.object({
  stat_type: z.string().min(1).max(64),
  name_format: z.string().max(128).refine(namePlaceholder, { message: namePlaceholderMsg }),
  stat_config: statsChannelConfig,
});

// ── Temp channel schemas ────────────────────────────

const tempChannelCreate = z.object({
  hub_channel_id: snowflake,
  category_id: snowflake.optional(),
  naming_format: z.string().max(100).optional(),
  default_user_limit: z.number().int().min(0).max(99).optional(),
  default_bitrate: z.number().int().min(8000).max(384000).optional(),
  keep_alive_minutes: z.number().int().min(0).max(1440).optional(),
  empty_grace_seconds: z.number().int().min(0).max(3600).optional(),
  allow_text_channel: z.boolean().optional(),
  allow_claim: z.boolean().optional(),
  moderator_roles: snowflakeArray,
  // Branded member-surface templates (blank/null ⇒ bot's built-in default).
  room_created_template: z.string().max(500).nullable().optional(),
  control_applied_template: z.string().max(500).nullable().optional(),
  control_denied_template: z.string().max(500).nullable().optional(),
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
  /** White-label key prefix; issuance still stores only SHA-256 hashes. */
  key_prefix: z.string().regex(/^[A-Z]{2,8}$/).optional(),
  max_devices: z.number().int().min(1).max(100).optional(),
  heartbeat_interval_seconds: z.number().int().min(0).max(86400).optional(),
  /** Convenience owner-surface unit; persisted canonically as seconds. */
  heartbeat_interval_ms: z.number().int().min(60000).max(86400000).refine((value) => value % 1000 === 0, 'heartbeat_interval_ms must be a whole number of seconds').optional(),
  sdk_cache_ttl_ms: z.number().int().min(1000).max(3600000).optional(),
  offline_grace_period_seconds: z.number().int().min(0).max(604800).optional(),
  // String-list is the shipped SDK contract. Accept the historical object
  // shape only for backwards-compatible reads/writes, normalizing it in the
  // route before it reaches the TEXT[] column.
  feature_flags: z.union([
    z.array(z.string().min(1).max(64)).max(100),
    z.record(z.unknown()),
  ]).optional(),
  tier: z.string().max(64).optional(),
  watermark_config: z.record(z.unknown()).optional().nullable(),
  require_discord_guild_membership: z.boolean().optional(),
  rotation_policy: z.enum(['rotate-and-invalidate', 'disabled']).optional(),
  self_service_device_removal: z.boolean().optional(),
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
    publishableKey: z.string().min(1),
  }),
  z.object({
    action: z.literal('generate-invite'),
    clientId: snowflake.optional(),
  }),
  z.object({
    action: z.literal('configure-auth'),
    clientId: snowflake.optional(),
    clientSecret: z.string().optional(),
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
  action: z.literal('deploy'),
  deployMode: z.enum(['safe', 'destructive']).default('safe'),
  confirmDestructive: z.literal(true).optional(),
  template_id: uuid.optional(),
  options: z.record(z.unknown()).optional(),
  roles: z.array(z.record(z.unknown())).optional(),
  channels: z.array(z.record(z.unknown())).optional(),
  categories: z.array(z.object({
    key: z.string().min(1).max(128),
    name: z.string().min(1).max(100),
    position: z.number().int().min(0).max(1000),
  }).passthrough()).optional(),
  permissionMap: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  if (value.deployMode === 'destructive' && value.confirmDestructive !== true) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmDestructive'],
      message: 'Destructive deployments require an explicit confirmation',
    });
  }
});

// ── Sync action schemas ─────────────────────────────

const syncAction = z.object({
  action: z.enum(['repair', 'accept', 'ignore', 'clear_all']),
  driftItem: z.object({
    entityType: z.string(),
    entityName: z.string(),
    entityDiscordId: z.string().optional(),
    type: z.string(),
    severity: z.enum(['critical', 'warning', 'info']).optional(),
    description: z.string().optional(),
    details: z.record(z.object({ expected: z.unknown(), actual: z.unknown() })).optional(),
    suggestedAction: z.enum(['repair', 'accept', 'ignore']).optional(),
    templateKey: z.string().optional(),
    template_key: z.string().optional(),
  }).passthrough().optional(),
});

const syncConfig = z.object({
  sync_enabled: z.boolean().optional(),
  sync_interval_minutes: z.number().int().min(5).max(1440).optional(),
  sync_auto_repair: z.boolean().optional(),
  sync_auto_repair_everyone: z.boolean().optional(),
}).refine(obj => Object.keys(obj).length > 0, 'At least one field required');

// ── Economy role-income schemas ─────────────────────
// Passive game currency paid for holding a Discord role. COMPLIANCE WALL:
// the route rejects any role granted by a paid product (real money must never
// buy wagerable currency) — see commerce-income-wall.ts.

const economyRoleIncomeUpsert = z.object({
  role_id: snowflake,
  // Must be POSITIVE: a zero-amount rule is not a real income rule, and at
  // collection time it would burn the per-role cooldown and then fail
  // `creditWallet` (which rejects non-positive amounts), so the user loses the
  // cooldown for no payout. Reject it at config; the bot also skips any
  // stray zero-amount rule defensively.
  amount: z.number().int().min(1).max(1_000_000_000),
  interval_minutes: z.number().int().min(1).max(525_600), // 1 min … 1 year
});

const economyRoleIncomeDelete = z.object({
  role_id: snowflake,
});

// ── Music schemas ───────────────────────────────────

const musicConfig = z.object({
  music_enabled: z.boolean().optional(),
  music_default_volume: z.number().int().min(0).max(150).optional(),
  dj_role_id: snowflake.optional().nullable(),
  // A timer of 0 is not a valid setting; reject it with a field-level error
  // instead of letting the dashboard route silently clamp it to 1.
  // auto_destroy caps at 120 to match the route's ceiling (Math.min(120, ...)).
  music_auto_leave_minutes: z.number().int().min(1).max(60).optional(),
  music_auto_destroy_minutes: z.number().int().min(1).max(120).optional(),
  // V5 Audit §6.P3a — validate max queue length (catalog default/hard cap 5 000)
  max_queue_length: z.number().int().min(1).max(5_000).optional(),
  allow_duplicates: z.boolean().optional(),
  per_user_queue_cap: z.number().int().min(1).max(500).optional(),
  // Fairness controls (catalog: music.json)
  vote_skip_threshold_percent: z.number().int().min(1).max(100).optional(),
  self_skip_enabled: z.boolean().optional(),
  requester_move_enabled: z.boolean().optional(),
  priority_voting_enabled: z.boolean().optional(),
});

// ── Product file schemas ────────────────────────────

const productFileCreate = z.object({
  name: safeName,
  description: z.string().max(500).optional(),
  file_path: z.string().max(512).optional(),
  external_url: urlString,
  file_size_bytes: z.number().int().min(0).optional(),
  mime_type: z.string().max(128).regex(
    /^(application\/(zip|x-zip-compressed|pdf|octet-stream|x-tar|gzip|json|xml)|text\/(plain|csv|html)|image\/(png|jpeg|gif|webp|svg\+xml)|audio\/(mpeg|ogg|wav)|video\/(mp4|webm))$/,
    'Unsupported file type',
  ).optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
});

// ── Bulk member operation schemas ───────────────────
// Audit V2 Finding 3.4 — Input validation on members/bulk

const bulkAction = z.enum(['assign_role', 'remove_role', 'reset_economy', 'export', 'send_dm']);

const bulkMemberOperation = z.object({
  member_ids: z.array(snowflake).min(1).max(200),
  action: bulkAction,
  params: z.record(z.unknown()).optional(),
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
  device_fingerprint: z.string().trim().min(1).max(256).optional(),
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
    update: planUpdate,
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
    settings: giveawaySettings,
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
  economyRoleIncome: {
    upsert: economyRoleIncomeUpsert,
    delete: economyRoleIncomeDelete,
  },
  productFile: {
    create: productFileCreate,
  },
  bulk: {
    memberOperation: bulkMemberOperation,
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
