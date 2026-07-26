/**
 * Audit page constants — the COMPLETE set of categories written to
 * audit_logs across all three rails, so every row is filterable and renders
 * a real badge (previously 13 written categories fell through to the gray
 * 'system' fallback and could not be filtered).
 *
 * Verified writers per category:
 * - Event rail (bot AuditService EVENT_TO_AUDIT): members, moderation,
 *   tickets, commerce, subscriptions, levels, giveaways, sync, system,
 *   economy, music, polls, predictions, temp_channels, scheduled_messages,
 *   starboard, stats_channels, custom_commands, diagnostics, automations,
 *   webhooks.
 * - Direct rail (bot writeAuditLog callers): profiles, members, moderation,
 *   rbac, levels, custom_commands, temp_channels, sync, system.
 * - Dashboard service-role rail: rbac, commerce, incidents, music,
 *   scheduled_messages, giveaways.
 */

export const CATEGORIES = [
  { value: '', label: 'All Categories' },
  { value: 'members', label: 'Members' },
  { value: 'moderation', label: 'Moderation' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'commerce', label: 'Commerce' },
  { value: 'subscriptions', label: 'Subscriptions' },
  { value: 'levels', label: 'Levels' },
  { value: 'giveaways', label: 'Giveaways' },
  { value: 'economy', label: 'Economy' },
  { value: 'music', label: 'Music' },
  { value: 'polls', label: 'Polls' },
  { value: 'predictions', label: 'Predictions' },
  { value: 'temp_channels', label: 'Temp Channels' },
  { value: 'scheduled_messages', label: 'Scheduled Messages' },
  { value: 'starboard', label: 'Starboard' },
  { value: 'stats_channels', label: 'Stats Channels' },
  { value: 'custom_commands', label: 'Custom Commands' },
  { value: 'automations', label: 'Automations' },
  { value: 'webhooks', label: 'Webhooks' },
  { value: 'rbac', label: 'Roles & Permissions' },
  { value: 'incidents', label: 'Incidents' },
  { value: 'profiles', label: 'Profiles' },
  { value: 'diagnostics', label: 'Diagnostics' },
  { value: 'sync', label: 'Sync & Deploy' },
  { value: 'system', label: 'System' },
];

export const ACTOR_ICONS: Record<string, string> = {
  user: '👤',
  bot: '🤖',
  system: '⚙️',
  webhook: '🔄',
  automation: '⚡',
  // Direct-rail actor types (services/audit.ts writeAuditLog).
  discord: '💬',
  dashboard: '🖥️',
};

export const CATEGORY_COLORS: Record<string, string> = {
  members: 'bg-blue-500/20 text-blue-400',
  moderation: 'bg-red-500/20 text-red-400',
  tickets: 'bg-yellow-500/20 text-yellow-400',
  commerce: 'bg-green-500/20 text-green-400',
  subscriptions: 'bg-purple-500/20 text-purple-400',
  levels: 'bg-orange-500/20 text-orange-400',
  giveaways: 'bg-pink-500/20 text-pink-400',
  economy: 'bg-amber-500/20 text-amber-400',
  music: 'bg-violet-500/20 text-violet-400',
  polls: 'bg-sky-500/20 text-sky-400',
  predictions: 'bg-fuchsia-500/20 text-fuchsia-400',
  temp_channels: 'bg-teal-500/20 text-teal-400',
  scheduled_messages: 'bg-lime-500/20 text-lime-400',
  starboard: 'bg-rose-500/20 text-rose-400',
  stats_channels: 'bg-indigo-500/20 text-indigo-400',
  custom_commands: 'bg-emerald-500/20 text-emerald-400',
  automations: 'bg-orange-500/20 text-orange-400',
  webhooks: 'bg-cyan-500/20 text-cyan-400',
  rbac: 'bg-purple-500/20 text-purple-400',
  incidents: 'bg-red-500/20 text-red-400',
  profiles: 'bg-blue-500/20 text-blue-400',
  diagnostics: 'bg-slate-500/20 text-slate-400',
  sync: 'bg-cyan-500/20 text-cyan-400',
  system: 'bg-gray-500/20 text-gray-400',
};
