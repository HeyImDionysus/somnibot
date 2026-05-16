/**
 * Automation engine constants — triggers, conditions, actions.
 */

export const AUTOMATION_LIMITS = {
  MAX_AUTOMATIONS_PER_GUILD: 100,
  MAX_ACTIONS_PER_AUTOMATION: 10,
  MAX_CONDITIONS_PER_AUTOMATION: 5,
  MAX_DELAY_SECONDS: 3600,
  MAX_FIRES_PER_USER_PER_MINUTE: 5,
  DM_COOLDOWN_SECONDS: 300,
} as const;

export const TRIGGER_TYPES = [
  'member.joined',
  'member.left',
  'member.verified',
  'message.sent',
  'role.gained',
  'role.lost',
  'level.up',
  'purchase.completed',
  'subscription.activated',
  'subscription.lapsed',
  'ticket.opened',
  'ticket.closed',
  'giveaway.ended',
  'button.clicked',
  'reaction.added',
  'voice.joined',
  'voice.left',
  'infraction.created',
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const CONDITION_TYPES = [
  'has_role',
  'missing_role',
  'min_level',
  'max_level',
  'in_channel',
  'not_in_channel',
  'has_entitlement',
  'missing_entitlement',
  'message_contains',
  'message_matches_regex',
  'user_is',
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

export const ACTION_TYPES = [
  'send_message',
  'send_dm',
  'give_role',
  'remove_role',
  'send_in_channel',
  'create_ticket',
  'close_ticket',
  'ban_member',
  'kick_member',
  'mute_member',
  'grant_entitlement',
  'revoke_entitlement',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
