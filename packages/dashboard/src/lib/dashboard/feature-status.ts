export interface FeatureStatusDefinition {
  label: string;
  configKey: string | null;
  /**
   * The guild_runtime_features row this feature's per-guild manager writes at
   * boot. When set and absent from the runtime rows, an enabled feature is
   * NOT running (enabled after boot; no manager exists until restart).
   */
  runtimeKey?: string;
  requiredConfigKeys?: readonly string[];
}

const FEATURE_STATUS: Array<[prefix: string, definition: FeatureStatusDefinition]> = [
  ['/economy/analytics', { label: 'Economy analytics', configKey: 'economy_enabled' }],
  ['/economy/shop', { label: 'Coin shop items', configKey: 'economy_enabled' }],
  ['/economy/gathering', { label: 'Gathering', configKey: 'economy_gathering_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/crafting', { label: 'Crafting', configKey: 'economy_crafting_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/farming', { label: 'Farming', configKey: 'economy_farming_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/fishing', { label: 'Fishing', configKey: 'economy_fishing_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/adventures', { label: 'Adventures', configKey: 'economy_adventures_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/market', { label: 'Member market', configKey: 'economy_market_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/trivia', { label: 'Trivia', configKey: 'economy_trivia_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/heist', { label: 'Heists', configKey: 'economy_heist_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/games', { label: 'Games and lottery', configKey: 'economy_games_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/pets', { label: 'Pets', configKey: 'economy_pets_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/quests', { label: 'Quests', configKey: 'economy_quests_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/economy/achievements', { label: 'Achievements', configKey: 'economy_achievements_enabled', requiredConfigKeys: ['economy_enabled'] }],
  ['/scheduled-messages', { label: 'Scheduled messages', configKey: 'scheduled_messages_enabled', runtimeKey: 'scheduled_messages' }],
  ['/reaction-roles', { label: 'Reaction roles', configKey: null }],
  ['/stats-channels', { label: 'Stats channels', configKey: 'stats_enabled', runtimeKey: 'stats_channels' }],
  ['/temp-channels', { label: 'Temporary channels', configKey: 'temp_channels_enabled', runtimeKey: 'temp_channels' }],
  ['/onboarding', { label: 'Onboarding', configKey: 'onboarding_enabled' }],
  ['/moderation', { label: 'Moderation', configKey: null }],
  ['/automations', { label: 'Automations', configKey: null }],
  ['/webhook-relays', { label: 'Webhook relays', configKey: null }],
  ['/giveaways', { label: 'Giveaways', configKey: 'giveaways_enabled', runtimeKey: 'giveaways' }],
  ['/customers', { label: 'Store and fulfillment', configKey: 'store_enabled', runtimeKey: 'commerce' }],
  ['/licenses', { label: 'Store and licensing', configKey: 'store_enabled', runtimeKey: 'commerce' }],
  ['/fraud', { label: 'Store and fraud controls', configKey: 'store_enabled', runtimeKey: 'commerce' }],
  ['/economy', { label: 'Economy', configKey: 'economy_enabled' }],
  ['/welcome', { label: 'Welcome messages', configKey: 'welcome_enabled' }],
  ['/levels', { label: 'Levels and XP', configKey: 'levels_enabled' }],
  ['/tickets', { label: 'Tickets', configKey: null }],
  ['/music', { label: 'Music', configKey: 'music_enabled', runtimeKey: 'music' }],
  ['/store', { label: 'Store and fulfillment', configKey: 'store_enabled', runtimeKey: 'commerce' }],
  ['/polls', { label: 'Polls', configKey: 'polls_enabled' }],
  ['/sync', { label: 'Discord sync', configKey: 'sync_enabled' }],
  ['/embeds', { label: 'Embeds', configKey: null }],
  ['/roles', { label: 'Roles and permissions', configKey: null }],
  ['/server-setup', { label: 'Server structure', configKey: null }],
  ['/branding', { label: 'Branding', configKey: null }],
  ['/members', { label: 'Member management', configKey: null }],
  ['/commands', { label: 'Custom commands', configKey: null }],
  ['/action-queue', { label: 'Failed-action recovery', configKey: null }],
  ['/tutorial', { label: 'Command tutorial', configKey: null }],
  ['/workflows', { label: 'Operational workflows', configKey: null }],
  ['/audit', { label: 'Audit log', configKey: null }],
  ['/admin-changes', { label: 'Admin change history', configKey: null }],
  ['/diagnostics', { label: 'Diagnostics', configKey: null }],
];

export type FeatureReadiness =
  | { state: 'operational'; heading: string; detail: string }
  | { state: 'disabled'; heading: string; detail: string }
  | { state: 'blocked'; heading: string; detail: string }
  | { state: 'unavailable'; heading: string; detail: string };

export function featureForPath(pathname: string): FeatureStatusDefinition | null {
  return FEATURE_STATUS.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? null;
}

export function deriveFeatureReadiness({
  feature,
  config,
  botOnline,
  staleSecs,
  runtimeFeatures,
}: {
  feature: FeatureStatusDefinition;
  config: Record<string, unknown> | null;
  botOnline: boolean | null;
  staleSecs: number | null;
  /** guild_runtime_features rows for this guild; null when unreadable. */
  runtimeFeatures?: string[] | null;
}): FeatureReadiness {
  if ((feature.configKey || feature.requiredConfigKeys?.length) && config === null) {
    return {
      state: 'unavailable',
      heading: `${feature.label}: status unavailable`,
      detail: 'The saved feature configuration could not be read.',
    };
  }

  const disabledConfigKey = [feature.configKey, ...(feature.requiredConfigKeys ?? [])]
    .filter((key): key is string => key !== null)
    .find((key) => config?.[key] !== true);
  if (disabledConfigKey) {
    return {
      state: 'disabled',
      heading: `${feature.label}: disabled`,
      detail: disabledConfigKey === feature.configKey
        ? 'This feature will not process Discord events until it is enabled.'
        : 'Its parent system is disabled, so this feature cannot run even though its own settings are saved.',
    };
  }

  if (botOnline === null) {
    return {
      state: 'unavailable',
      heading: `${feature.label}: status unavailable`,
      detail: 'The bot heartbeat could not be verified.',
    };
  }

  if (!botOnline) {
    return {
      state: 'blocked',
      heading: `${feature.label}: cannot run`,
      detail: staleSecs === null
        ? 'No bot heartbeat has been recorded.'
        : `The bot heartbeat is ${Math.max(0, Math.round(staleSecs))} seconds old.`,
    };
  }

  if (feature.runtimeKey && Array.isArray(runtimeFeatures)) {
    if (!runtimeFeatures.includes(feature.runtimeKey)) {
      // Enabled in config, heartbeat current — but THIS boot never
      // constructed the manager (the feature was enabled after startup). A
      // green panel here would claim a service that does not exist.
      return {
        state: 'blocked',
        heading: `${feature.label}: enabled, awaiting bot restart`,
        detail: 'The feature was enabled after the bot started; its service has not been initialized yet. Restart the bot to activate it.',
      };
    }
  }
  return {
    state: 'operational',
    heading: `${feature.label}: enabled and reachable`,
    detail: 'The feature is enabled and the bot heartbeat is current. This does not claim a member action that has not occurred.',
  };
}
