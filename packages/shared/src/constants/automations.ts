/**
 * Automation engine constants — triggers, conditions, actions, templates.
 * §20 of the architecture doc.
 */

// ============================================================
// Limits
// ============================================================

export const AUTOMATION_LIMITS = {
  MAX_AUTOMATIONS_PER_GUILD: 100,
  MAX_ACTIONS_PER_AUTOMATION: 10,
  MAX_CONDITIONS_PER_AUTOMATION: 5,
  MAX_DELAY_SECONDS: 3600,
  MAX_FIRES_PER_USER_PER_MINUTE: 5,
  DM_COOLDOWN_SECONDS: 300,
  ROLE_GRANT_DELAY_MS: 1000,
  /** Maximum depth of automation chain reactions (e.g., action triggers another automation). */
  MAX_CHAIN_DEPTH: 3,
} as const;

// ============================================================
// Triggers
// ============================================================

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

export interface TriggerMeta {
  type: TriggerType;
  label: string;
  description: string;
  icon: string;
  /** Available variable placeholders for this trigger */
  variables: string[];
  /** Whether this trigger provides a channel context */
  hasChannel: boolean;
  /** Whether this trigger provides a user context */
  hasUser: boolean;
}

export const TRIGGER_META: TriggerMeta[] = [
  { type: 'member.joined', label: 'Member Joins', description: 'When a new member joins the server', icon: '👋', variables: ['{user}', '{user.name}', '{memberCount}', '{returning}'], hasChannel: false, hasUser: true },
  { type: 'member.left', label: 'Member Leaves', description: 'When a member leaves the server', icon: '👋', variables: ['{user}', '{user.name}', '{memberCount}', '{duration}'], hasChannel: false, hasUser: true },
  { type: 'member.verified', label: 'Member Verified', description: 'When a member completes onboarding', icon: '✅', variables: ['{user}', '{user.name}', '{memberNumber}'], hasChannel: false, hasUser: true },
  { type: 'message.sent', label: 'Sends a Message', description: 'When a member sends a message', icon: '💬', variables: ['{user}', '{channel}', '{message}', '{content}'], hasChannel: true, hasUser: true },
  { type: 'role.gained', label: 'Gains a Role', description: 'When a member gains a role', icon: '🏷️', variables: ['{user}', '{role}', '{role.name}', '{source}'], hasChannel: false, hasUser: true },
  { type: 'role.lost', label: 'Loses a Role', description: 'When a member loses a role', icon: '🏷️', variables: ['{user}', '{role}', '{role.name}', '{source}'], hasChannel: false, hasUser: true },
  { type: 'level.up', label: 'Reaches Level', description: 'When a member levels up', icon: '⬆️', variables: ['{user}', '{oldLevel}', '{newLevel}'], hasChannel: false, hasUser: true },
  { type: 'purchase.completed', label: 'Purchases Product', description: 'When a purchase is completed', icon: '🛒', variables: ['{user}', '{product}', '{order}', '{amount}'], hasChannel: false, hasUser: true },
  { type: 'subscription.activated', label: 'Subscription Activated', description: 'When a subscription starts', icon: '🔄', variables: ['{user}', '{plan}'], hasChannel: false, hasUser: true },
  { type: 'subscription.lapsed', label: 'Subscription Lapsed', description: 'When a subscription lapses', icon: '⚠️', variables: ['{user}', '{plan}'], hasChannel: false, hasUser: true },
  { type: 'ticket.opened', label: 'Ticket Opened', description: 'When a support ticket is created', icon: '🎫', variables: ['{user}', '{ticket}', '{category}'], hasChannel: true, hasUser: true },
  { type: 'ticket.closed', label: 'Ticket Closed', description: 'When a ticket is closed', icon: '🎫', variables: ['{ticket}', '{resolution}'], hasChannel: true, hasUser: false },
  { type: 'giveaway.ended', label: 'Giveaway Ended', description: 'When a giveaway concludes', icon: '🎁', variables: ['{giveaway}', '{winners}'], hasChannel: false, hasUser: false },
  { type: 'button.clicked', label: 'Button Clicked', description: 'When a user clicks a button', icon: '🔘', variables: ['{user}', '{buttonId}'], hasChannel: true, hasUser: true },
  { type: 'reaction.added', label: 'Reaction Added', description: 'When a reaction is added to a message', icon: '😀', variables: ['{user}', '{emoji}', '{channel}', '{message}'], hasChannel: true, hasUser: true },
  { type: 'voice.joined', label: 'Voice Channel Joined', description: 'When a member joins a voice channel', icon: '🔊', variables: ['{user}', '{channel}'], hasChannel: true, hasUser: true },
  { type: 'voice.left', label: 'Voice Channel Left', description: 'When a member leaves a voice channel', icon: '🔇', variables: ['{user}', '{channel}'], hasChannel: true, hasUser: true },
  { type: 'infraction.created', label: 'Infraction Created', description: 'When a moderation infraction is issued', icon: '🔨', variables: ['{user}', '{type}', '{reason}', '{count}'], hasChannel: false, hasUser: true },
];

// ============================================================
// Conditions
// ============================================================

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
  'is_returning_member',
  'is_new_member',
  'time_window',
  'user_is',
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

export interface ConditionMeta {
  type: ConditionType;
  label: string;
  description: string;
  /** What parameter this condition needs */
  paramType: 'role' | 'channel' | 'number' | 'text' | 'regex' | 'user' | 'product' | 'time_range' | 'none';
  paramLabel?: string;
}

export const CONDITION_META: ConditionMeta[] = [
  { type: 'has_role', label: 'User Has Role', description: 'Member has a specific role', paramType: 'role', paramLabel: 'Role' },
  { type: 'missing_role', label: 'User Missing Role', description: 'Member does NOT have a specific role', paramType: 'role', paramLabel: 'Role' },
  { type: 'min_level', label: 'Minimum Level', description: 'Member level is at or above threshold', paramType: 'number', paramLabel: 'Level' },
  { type: 'max_level', label: 'Maximum Level', description: 'Member level is below threshold', paramType: 'number', paramLabel: 'Level' },
  { type: 'in_channel', label: 'In Channel', description: 'Event happened in a specific channel', paramType: 'channel', paramLabel: 'Channel' },
  { type: 'not_in_channel', label: 'Not In Channel', description: 'Event did NOT happen in this channel', paramType: 'channel', paramLabel: 'Channel' },
  { type: 'has_entitlement', label: 'Has Entitlement', description: 'Member has an active product entitlement', paramType: 'product', paramLabel: 'Product' },
  { type: 'missing_entitlement', label: 'Missing Entitlement', description: 'Member does NOT have an entitlement', paramType: 'product', paramLabel: 'Product' },
  { type: 'message_contains', label: 'Message Contains', description: 'Message contains words/phrases (case insensitive)', paramType: 'text', paramLabel: 'Text' },
  { type: 'message_matches_regex', label: 'Message Matches Regex', description: 'Message matches a regex pattern', paramType: 'regex', paramLabel: 'Pattern' },
  { type: 'is_returning_member', label: 'Is Returning Member', description: 'Member has previously been in the server', paramType: 'none' },
  { type: 'is_new_member', label: 'Is New Member', description: 'Member has never been in the server', paramType: 'none' },
  { type: 'time_window', label: 'Time Window', description: 'Current time is within a range', paramType: 'time_range', paramLabel: 'Time Range' },
  { type: 'user_is', label: 'User Is', description: 'Triggered by a specific user', paramType: 'user', paramLabel: 'User ID' },
];

// ============================================================
// Actions
// ============================================================

export const ACTION_TYPES = [
  'send_message',
  'send_dm',
  'reply_to_message',
  'give_role',
  'remove_role',
  'add_reaction',
  'delete_message',
  'create_thread',
  'wait_delay',
  'grant_entitlement',
  'log_to_channel',
  'create_ticket',
  'ban_member',
  'kick_member',
  'mute_member',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionMeta {
  type: ActionType;
  label: string;
  description: string;
  icon: string;
  /** Parameters this action requires */
  params: ActionParam[];
}

export interface ActionParam {
  key: string;
  label: string;
  type: 'channel' | 'role' | 'text' | 'number' | 'emoji' | 'product';
  required: boolean;
  placeholder?: string;
  /** Whether the field supports template variables like {user} */
  supportsVariables?: boolean;
}

export const ACTION_META: ActionMeta[] = [
  {
    type: 'send_message', label: 'Send Message in Channel', description: 'Post a message in a specified channel', icon: '💬',
    params: [
      { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
      { key: 'message', label: 'Message', type: 'text', required: true, placeholder: 'Hello {user}!', supportsVariables: true },
    ],
  },
  {
    type: 'send_dm', label: 'Send DM', description: 'DM the triggering user', icon: '📩',
    params: [
      { key: 'message', label: 'Message', type: 'text', required: true, placeholder: 'Hey {user.name}, ...', supportsVariables: true },
    ],
  },
  {
    type: 'reply_to_message', label: 'Reply to Message', description: 'Reply to the triggering message', icon: '↩️',
    params: [
      { key: 'message', label: 'Message', type: 'text', required: true, placeholder: 'Thanks for your message!', supportsVariables: true },
    ],
  },
  {
    type: 'give_role', label: 'Give Role', description: 'Assign a role to the triggering user', icon: '🏷️',
    params: [
      { key: 'role_id', label: 'Role', type: 'role', required: true },
    ],
  },
  {
    type: 'remove_role', label: 'Remove Role', description: 'Remove a role from the triggering user', icon: '🏷️',
    params: [
      { key: 'role_id', label: 'Role', type: 'role', required: true },
    ],
  },
  {
    type: 'add_reaction', label: 'Add Reaction', description: 'React to the triggering message', icon: '😀',
    params: [
      { key: 'emoji', label: 'Emoji', type: 'emoji', required: true, placeholder: '⭐' },
    ],
  },
  {
    type: 'delete_message', label: 'Delete Message', description: 'Delete the triggering message', icon: '🗑️',
    params: [],
  },
  {
    type: 'create_thread', label: 'Create Thread', description: 'Create a thread on the triggering message', icon: '🧵',
    params: [
      { key: 'name', label: 'Thread Name', type: 'text', required: true, placeholder: 'Discussion', supportsVariables: true },
      { key: 'auto_archive_minutes', label: 'Auto-Archive (minutes)', type: 'number', required: false, placeholder: '1440' },
    ],
  },
  {
    type: 'wait_delay', label: 'Wait / Delay', description: 'Pause before the next action', icon: '⏳',
    params: [
      { key: 'seconds', label: 'Seconds', type: 'number', required: true, placeholder: '5' },
    ],
  },
  {
    type: 'grant_entitlement', label: 'Grant Entitlement', description: 'Grant a product entitlement (no payment)', icon: '🎁',
    params: [
      { key: 'product_id', label: 'Product', type: 'product', required: true },
    ],
  },
  {
    type: 'log_to_channel', label: 'Log to Channel', description: 'Post an audit entry to a log channel', icon: '📋',
    params: [
      { key: 'channel_id', label: 'Channel', type: 'channel', required: true },
      { key: 'message', label: 'Message', type: 'text', required: true, placeholder: '⚠️ Event logged: {user}', supportsVariables: true },
    ],
  },
  {
    type: 'create_ticket', label: 'Create Ticket', description: 'Open a support ticket for the user', icon: '🎫',
    params: [],
  },
  {
    type: 'ban_member', label: 'Ban Member', description: 'Ban the triggering user', icon: '🔨',
    params: [
      { key: 'reason', label: 'Reason', type: 'text', required: false, placeholder: 'Automated ban', supportsVariables: true },
    ],
  },
  {
    type: 'kick_member', label: 'Kick Member', description: 'Kick the triggering user', icon: '👢',
    params: [
      { key: 'reason', label: 'Reason', type: 'text', required: false, placeholder: 'Automated kick', supportsVariables: true },
    ],
  },
  {
    type: 'mute_member', label: 'Mute Member', description: 'Timeout the triggering user', icon: '🔇',
    params: [
      { key: 'duration_minutes', label: 'Duration (minutes)', type: 'number', required: true, placeholder: '10' },
      { key: 'reason', label: 'Reason', type: 'text', required: false, placeholder: 'Automated mute', supportsVariables: true },
    ],
  },
];

// ============================================================
// Automation Templates (§20.8)
// ============================================================

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'welcome' | 'moderation' | 'engagement' | 'commerce' | 'utility';
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

export interface AutomationCondition {
  type: ConditionType;
  config: Record<string, unknown>;
}

export interface AutomationAction {
  type: ActionType;
  config: Record<string, unknown>;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'welcome_dm',
    name: 'Welcome DM',
    description: 'Send a welcome DM when a member completes onboarding',
    icon: '👋',
    category: 'welcome',
    trigger_type: 'member.verified',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: 'Welcome to the server, {user.name}! 🎉 We\'re glad to have you here. Check out the channels and say hi!' } },
    ],
  },
  {
    id: 'level_role_reward',
    name: 'Level Role Reward',
    description: 'Grant a role when a member reaches a specific level',
    icon: '🏆',
    category: 'engagement',
    trigger_type: 'level.up',
    trigger_config: {},
    conditions: [
      { type: 'min_level', config: { value: 10 } },
    ],
    actions: [
      { type: 'give_role', config: { role_id: '' } },
      { type: 'send_message', config: { channel_id: '', message: '🎊 {user} just reached Level {newLevel}! Congrats!' } },
    ],
  },
  {
    id: 'purchase_announcement',
    name: 'Purchase Announcement',
    description: 'Announce a purchase in a channel and DM the buyer',
    icon: '🛒',
    category: 'commerce',
    trigger_type: 'purchase.completed',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_message', config: { channel_id: '', message: '🎉 {user} just purchased {product}! Thank you for your support!' } },
      { type: 'send_dm', config: { message: 'Thanks for your purchase of {product}! Your benefits are now active.' } },
    ],
  },
  {
    id: 'subscription_lapse_warning',
    name: 'Subscription Lapse Warning',
    description: 'DM a warning when a subscription lapses',
    icon: '⚠️',
    category: 'commerce',
    trigger_type: 'subscription.lapsed',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: 'Hey {user.name}, your subscription has lapsed. You have 3 days to renew before access is revoked.' } },
      { type: 'log_to_channel', config: { channel_id: '', message: '⚠️ Subscription lapsed: {user} — {plan}' } },
    ],
  },
  {
    id: 'vip_welcome',
    name: 'VIP Welcome',
    description: 'Post a welcome when someone gains the VIP role',
    icon: '⭐',
    category: 'welcome',
    trigger_type: 'role.gained',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_message', config: { channel_id: '', message: '🌟 Welcome to VIP, {user}! Enjoy your exclusive perks.' } },
    ],
  },
  {
    id: 'content_spotlight',
    name: 'Content Creator Spotlight',
    description: 'Auto-react with ⭐ to messages in a showcase channel',
    icon: '✨',
    category: 'engagement',
    trigger_type: 'message.sent',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'add_reaction', config: { emoji: '⭐' } },
    ],
  },
  {
    id: 'infraction_log',
    name: 'Infraction Logger',
    description: 'Log infraction details to a staff channel',
    icon: '🔨',
    category: 'moderation',
    trigger_type: 'infraction.created',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'log_to_channel', config: { channel_id: '', message: '🔨 Infraction: {type} for {user} — {reason} (total: {count})' } },
    ],
  },
  {
    id: 'voice_greeting',
    name: 'Voice Channel Greeting',
    description: 'DM a greeting when a user joins a voice channel',
    icon: '🔊',
    category: 'engagement',
    trigger_type: 'voice.joined',
    trigger_config: {},
    conditions: [],
    actions: [
      { type: 'send_dm', config: { message: 'Hey {user.name}! Have a great time in {channel}! 🎧' } },
    ],
  },
];
