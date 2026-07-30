export interface FeatureStatusDefinition {
  label: string;
  configKey: string | null;
}

const FEATURE_STATUS: Array<[prefix: string, definition: FeatureStatusDefinition]> = [
  ['/scheduled-messages', { label: 'Scheduled messages', configKey: 'scheduled_messages_enabled' }],
  ['/reaction-roles', { label: 'Reaction roles', configKey: null }],
  ['/stats-channels', { label: 'Stats channels', configKey: 'stats_enabled' }],
  ['/temp-channels', { label: 'Temporary channels', configKey: 'temp_channels_enabled' }],
  ['/onboarding', { label: 'Onboarding', configKey: 'onboarding_enabled' }],
  ['/moderation', { label: 'Moderation', configKey: null }],
  ['/automations', { label: 'Automations', configKey: null }],
  ['/giveaways', { label: 'Giveaways', configKey: 'giveaways_enabled' }],
  ['/customers', { label: 'Store and fulfillment', configKey: 'store_enabled' }],
  ['/licenses', { label: 'Store and licensing', configKey: 'store_enabled' }],
  ['/fraud', { label: 'Store and fraud controls', configKey: 'store_enabled' }],
  ['/economy', { label: 'Economy', configKey: 'economy_enabled' }],
  ['/welcome', { label: 'Welcome messages', configKey: 'welcome_enabled' }],
  ['/levels', { label: 'Levels and XP', configKey: 'levels_enabled' }],
  ['/tickets', { label: 'Tickets', configKey: null }],
  ['/music', { label: 'Music', configKey: 'music_enabled' }],
  ['/store', { label: 'Store and fulfillment', configKey: 'store_enabled' }],
  ['/polls', { label: 'Polls', configKey: 'polls_enabled' }],
  ['/sync', { label: 'Discord sync', configKey: 'sync_enabled' }],
  ['/embeds', { label: 'Embeds', configKey: null }],
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
}: {
  feature: FeatureStatusDefinition;
  config: Record<string, unknown> | null;
  botOnline: boolean | null;
  staleSecs: number | null;
}): FeatureReadiness {
  if (feature.configKey && config === null) {
    return {
      state: 'unavailable',
      heading: `${feature.label}: status unavailable`,
      detail: 'The saved feature configuration could not be read.',
    };
  }

  if (feature.configKey && config?.[feature.configKey] !== true) {
    return {
      state: 'disabled',
      heading: `${feature.label}: disabled`,
      detail: 'This feature will not process Discord events until it is enabled.',
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

  return {
    state: 'operational',
    heading: `${feature.label}: enabled and reachable`,
    detail: 'The feature is enabled and the bot heartbeat is current. This does not claim a member action that has not occurred.',
  };
}
