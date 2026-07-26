/**
 * Brand voice — owner-selectable copy presets for stock member-facing lines.
 *
 * The 7 VoiceKeys cover the recurring stock phrasings across features
 * (outage notices, cooldowns, refusals, confirmations). Call sites render via
 * voice(kit.voicePreset, key, vars) so the owner's brand_voice_preset applies
 * everywhere at once.
 *
 * THE CONTRACT: the 'default' preset is BYTE-IDENTICAL to the dominant live
 * copy shipped today (see __tests__/branding-voice.test.ts, which pins each
 * template against its canonical call sites). That makes moving a call site
 * onto voice() provably behavior-neutral for every unconfigured guild. Do NOT
 * edit a 'default' template without updating the snapshot test AND accepting
 * the member-visible copy change.
 *
 * Templates use {slot} placeholders. Unknown placeholders are left intact
 * (never rendered as 'undefined') so a missing variable is diagnosable.
 */
import type { BrandVoicePreset } from './brand-kit.js';

/** The stock member-facing lines an owner's voice preset can restyle. */
export type VoiceKey =
  | 'unavailable'
  | 'disabled'
  | 'cooldown'
  | 'insufficient_funds'
  | 'success'
  | 'denied'
  | 'not_found';

/** All voice keys — handy for exhaustive iteration in tests/tooling. */
export const VOICE_KEYS: readonly VoiceKey[] = [
  'unavailable',
  'disabled',
  'cooldown',
  'insufficient_funds',
  'success',
  'denied',
  'not_found',
];

/** Substitution variables for a voice template ({brand}, {feature}, ...). */
export type VoiceVars = Record<string, string | number>;

/**
 * The preset × key template table.
 *
 * Slots per key (identical across presets):
 *   unavailable        — {brand}, {feature}
 *   disabled           — {feature}
 *   cooldown           — {time}, {action}
 *   insufficient_funds — {amount}, {currency}
 *   success            — {message}
 *   denied             — {action}
 *   not_found          — {thing}
 */
const VOICE_TABLE: Record<BrandVoicePreset, Record<VoiceKey, string>> = {
  // BYTE-IDENTICAL to current live copy — see the module doc block.
  default: {
    // store-command.ts:53, ticket-interactions.ts:52, lottery-manager.ts:241, ...
    unavailable: "⚠️ {brand}'s {feature} is temporarily unavailable — please try again in a moment.",
    // crafting-manager.ts:116, farming-manager.ts:114, lottery-manager.ts:318, ...
    disabled: '❌ {feature} is not enabled on this server.',
    // crafting-manager.ts:194, gathering-manager.ts:211
    cooldown: '⏳ You need to wait **{time}** before {action} again.',
    // pets-manager.ts:325 kernel, polls-manager.ts:559, lottery-manager.ts:367
    insufficient_funds: '❌ You need **{amount}** {currency}.',
    // ticket-interactions.ts:328 et al — the universal '✅ ' confirmation prefix.
    success: '✅ {message}',
    // moderation/commands.ts:165/315/430/536/675/748, purge-command.ts:67
    denied: '❌ You do not have permission to {action}.',
    // ticket-interactions.ts:297, moderation/commands.ts:330, polls-manager.ts:255
    not_found: '❌ {thing} not found.',
  },
  professional: {
    unavailable: "{brand}'s {feature} is temporarily unavailable. Please try again shortly.",
    disabled: '{feature} is not enabled on this server.',
    cooldown: 'Please wait **{time}** before {action} again.',
    insufficient_funds: 'Insufficient balance — this requires **{amount}** {currency}.',
    success: '{message}',
    denied: 'You do not have permission to {action}.',
    not_found: '{thing} could not be found.',
  },
  friendly: {
    unavailable: "⚠️ Oops — {brand}'s {feature} is taking a quick break. Please try again in a moment!",
    disabled: "❌ {feature} isn't enabled here yet.",
    cooldown: '⏳ Hang tight — wait **{time}** before {action} again!',
    insufficient_funds: "❌ Not quite enough — you'll need **{amount}** {currency}.",
    success: '✅ {message}',
    denied: "❌ Sorry, you don't have permission to {action}.",
    not_found: "❌ Hmm, we couldn't find {thing}.",
  },
  playful: {
    unavailable: "😴 {brand}'s {feature} is napping — poke it again in a moment!",
    disabled: "🚫 {feature} isn't switched on in this server (yet).",
    cooldown: '⏳ Whoa there! **{time}** to go before {action} again.',
    insufficient_funds: '💸 You need **{amount}** {currency} — time to grind!',
    success: '🎉 {message}',
    denied: "🙅 Nope — you don't have permission to {action}.",
    not_found: '🔍 {thing}? Nowhere to be found.',
  },
};

/**
 * Render a stock member-facing line in the guild's voice preset.
 *
 * Unknown presets fall back to 'default'. Placeholders without a matching
 * var are left intact so a missing variable is visible, not 'undefined'.
 */
export function voice(preset: BrandVoicePreset, key: VoiceKey, vars: VoiceVars = {}): string {
  const template = (VOICE_TABLE[preset] ?? VOICE_TABLE.default)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
