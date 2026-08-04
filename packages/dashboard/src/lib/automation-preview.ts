import { createHash } from 'node:crypto';

export interface AutomationPreviewDefinition {
  name: string;
  description?: string | null;
  trigger_type: string;
  trigger_config?: Record<string, unknown>;
  conditions?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
  target_user_ids?: string[];
  target_channel_ids?: string[];
  exclude_user_ids?: string[];
  exclude_channel_ids?: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function automationPreviewHash(definition: AutomationPreviewDefinition): string {
  const payload = {
    name: definition.name,
    description: definition.description ?? null,
    trigger_type: definition.trigger_type,
    trigger_config: definition.trigger_config ?? {},
    conditions: definition.conditions ?? [],
    actions: definition.actions ?? [],
    target_user_ids: definition.target_user_ids ?? [],
    target_channel_ids: definition.target_channel_ids ?? [],
    exclude_user_ids: definition.exclude_user_ids ?? [],
    exclude_channel_ids: definition.exclude_channel_ids ?? [],
  };
  return createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
}

export function automationPreviewSummary(definition: AutomationPreviewDefinition) {
  return {
    actionCount: definition.actions?.length ?? 0,
    conditionCount: definition.conditions?.length ?? 0,
    trigger: definition.trigger_type,
    message: `Preview for ${definition.name}: when ${definition.trigger_type} fires, ${definition.actions?.length ?? 0} action(s) would run. Nothing has been executed.`,
  };
}
