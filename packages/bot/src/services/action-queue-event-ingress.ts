import {
  isActionQueuePlatformEventType,
  isConfigReloadAuditEventType,
  type ActionQueuePlatformEvent,
  type ActionQueuePlatformEventType,
  type ConfigReloadAuditEvent,
  type PlatformEventMap,
} from '@somnibot/shared';

export type ActionQueuePlatformEventContract = ActionQueuePlatformEvent;
export type ConfigReloadAuditEventContract = ConfigReloadAuditEvent;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExactString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function hasExactStrings(data: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => isExactString(data[field]));
}

function isAutomationCreatedData(
  value: unknown,
): value is PlatformEventMap['automation.created'] {
  if (!isPlainRecord(value)) return false;
  return hasExactStrings(value, ['automationId', 'automationName', 'trigger', 'createdBy'])
    && typeof value.enabled === 'boolean'
    && Number.isSafeInteger(value.actionCount)
    && Number(value.actionCount) >= 0;
}

function isAutomationUpdatedData(
  value: unknown,
): value is PlatformEventMap['automation.updated'] {
  if (!isPlainRecord(value)) return false;
  return hasExactStrings(value, ['automationId', 'automationName', 'updatedBy'])
    && (value.before === undefined || isPlainRecord(value.before))
    && (value.after === undefined || isPlainRecord(value.after));
}

function isAutomationDeletedData(
  value: unknown,
): value is PlatformEventMap['automation.deleted'] {
  return isPlainRecord(value)
    && hasExactStrings(value, ['automationId', 'automationName', 'deletedBy']);
}

function isWebhookReceivedData(
  value: unknown,
): value is PlatformEventMap['webhook.received'] {
  return isPlainRecord(value)
    && hasExactStrings(value, ['eventId', 'eventType', 'provider', 'result']);
}

function isWebhookReplayedData(
  value: unknown,
): value is PlatformEventMap['webhook.replayed'] {
  return isPlainRecord(value)
    && hasExactStrings(value, ['eventId', 'eventType', 'replayedBy'])
    && Number.isSafeInteger(value.replayCount)
    && Number(value.replayCount) >= 0;
}

function isSubscriptionExpiredData(
  value: unknown,
): value is PlatformEventMap['subscription.expired'] {
  return isPlainRecord(value)
    && hasExactStrings(value, ['lifecycleId', 'discordId', 'productId', 'planId'])
    && value.status === 'expired';
}

function buildContract(
  type: ActionQueuePlatformEventType,
  data: unknown,
): ActionQueuePlatformEventContract | null {
  switch (type) {
    case 'automation.created':
      return isAutomationCreatedData(data) ? { type, data } : null;
    case 'automation.updated':
      return isAutomationUpdatedData(data) ? { type, data } : null;
    case 'automation.deleted':
      return isAutomationDeletedData(data) ? { type, data } : null;
    case 'webhook.received':
      return isWebhookReceivedData(data) ? { type, data } : null;
    case 'webhook.replayed':
      return isWebhookReplayedData(data) ? { type, data } : null;
    case 'subscription.expired':
      return isSubscriptionExpiredData(data) ? { type, data } : null;
  }
}

export function parseConfigReloadAuditEvent(
  value: unknown,
): ConfigReloadAuditEventContract | null {
  if (!isPlainRecord(value) || !isConfigReloadAuditEventType(value.type)) return null;
  const event = buildContract(value.type, value.data);
  if (!event) return null;
  switch (event.type) {
    case 'automation.created':
    case 'automation.updated':
    case 'automation.deleted':
      return event;
    default:
      return null;
  }
}

export function parseActionQueuePlatformEvent(
  payload: Record<string, unknown>,
): ActionQueuePlatformEventContract | null {
  if (!isActionQueuePlatformEventType(payload.event_type)) return null;
  return buildContract(payload.event_type, payload.event_data);
}
