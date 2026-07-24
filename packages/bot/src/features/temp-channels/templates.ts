/**
 * Temp-channel branded message templates.
 *
 * The member-facing surfaces a temp channel produces are owner-brandable:
 *   - room_created    — the welcome posted into a room when it is created
 *   - control_applied — the confirmation shown when an owner control succeeds
 *   - control_denied  — the notice shown when a control is refused
 *
 * Each hub may store an override per surface (temp_channel_hubs.*_template). When
 * the override is null/blank the built-in default is used. Both paths run through
 * the same variable resolver so {owner-name} and friends behave identically
 * everywhere — this is the module that fixes the MED finding where {owner-name}
 * was rendered literally on these surfaces.
 */

export const TEMP_CHANNEL_TEMPLATE_KEYS = [
  'room_created',
  'control_applied',
  'control_denied',
] as const;

export type TempChannelTemplateKey = (typeof TEMP_CHANNEL_TEMPLATE_KEYS)[number];

/**
 * Built-in defaults, used when a hub has no override for the surface.
 *
 * control_applied / control_denied default to a bare pass-through of the status
 * detail ({action} / {reason}) — those variables already carry their own icon
 * and wording, so behaviour is unchanged until an owner wraps branding around
 * them (e.g. "🎧 {server} — {action}").
 */
export const DEFAULT_TEMP_CHANNEL_TEMPLATES: Record<TempChannelTemplateKey, string> = {
  room_created:
    "🔊 Welcome to your room, **{owner-name}**! It's yours to run — use `/voice` to lock it, rename it, set a user limit, or permit friends in.",
  control_applied: '{action}',
  control_denied: '{reason}',
};

/** The public catalog of variables each surface understands (for docs / UI). */
export const TEMP_CHANNEL_TEMPLATE_VARIABLES: Record<TempChannelTemplateKey, string[]> = {
  room_created: ['{owner-name}', '{room-name}', '{user}', '{server}'],
  control_applied: ['{action}', '{owner-name}', '{room-name}', '{user}', '{target}', '{server}'],
  control_denied: ['{reason}', '{owner-name}', '{room-name}', '{user}', '{server}'],
};

/** Values a template may reference. Keys are the bare token names (no braces). */
export type TemplateVars = Record<string, string | number | null | undefined>;

// A variable token: {owner-name}, {room-name}, {action}, {server}, … Letters,
// digits, hyphen and underscore only, so surrounding punctuation/JSON is safe.
const TOKEN = /\{([a-z0-9_-]+)\}/gi;

/**
 * Substitute {token} occurrences in `template` from `vars` (token names are
 * matched case-insensitively). Unknown tokens, and tokens whose value is
 * null/undefined, are left untouched so a typo surfaces visibly rather than
 * silently collapsing to an empty string.
 */
export function resolveTemplate(template: string, vars: TemplateVars): string {
  if (!template) return '';
  return template.replace(TOKEN, (match, rawKey: string) => {
    const value = vars[rawKey.toLowerCase()];
    return value === null || value === undefined ? match : String(value);
  });
}

/** The subset of hub columns this module reads. */
export interface TemplateSource {
  room_created_template?: string | null;
  control_applied_template?: string | null;
  control_denied_template?: string | null;
}

const COLUMN_FOR: Record<TempChannelTemplateKey, keyof TemplateSource> = {
  room_created: 'room_created_template',
  control_applied: 'control_applied_template',
  control_denied: 'control_denied_template',
};

/**
 * Return the effective template for a surface: the hub override when it is a
 * non-blank string, otherwise the built-in default. Does not substitute — used
 * by tests and previews that want the raw template.
 */
export function selectTemplate(
  source: TemplateSource | null | undefined,
  key: TempChannelTemplateKey,
): string {
  const override = source?.[COLUMN_FOR[key]];
  return typeof override === 'string' && override.trim().length > 0
    ? override
    : DEFAULT_TEMP_CHANNEL_TEMPLATES[key];
}

/**
 * Resolve the effective template for a surface (hub override or built-in
 * default) and substitute variables in a single call.
 */
export function renderTempChannelTemplate(
  source: TemplateSource | null | undefined,
  key: TempChannelTemplateKey,
  vars: TemplateVars,
): string {
  return resolveTemplate(selectTemplate(source, key), vars);
}
