import {
  isActionQueuePlatformEventType,
  isConfigReloadAuditEventType,
  parseInternalContractHeader,
  type ActionQueuePlatformEvent,
  type ActionQueuePlatformEventType,
  type ConfigReloadAuditEvent,
  type InternalContractHeader,
  type PlatformEventMap,
} from '@somnibot/shared';

export type ActionQueuePlatformEventContract = ActionQueuePlatformEvent & InternalContractHeader;
export type ConfigReloadAuditEventContract = ConfigReloadAuditEvent & InternalContractHeader;

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
  header: InternalContractHeader,
): ActionQueuePlatformEventContract | null {
  switch (type) {
    case 'automation.created':
      return isAutomationCreatedData(data) ? { ...header, type, data } : null;
    case 'automation.updated':
      return isAutomationUpdatedData(data) ? { ...header, type, data } : null;
    case 'automation.deleted':
      return isAutomationDeletedData(data) ? { ...header, type, data } : null;
    case 'webhook.received':
      return isWebhookReceivedData(data) ? { ...header, type, data } : null;
    case 'webhook.replayed':
      return isWebhookReplayedData(data) ? { ...header, type, data } : null;
    case 'subscription.expired':
      return isSubscriptionExpiredData(data) ? { ...header, type, data } : null;
  }
}

function parseIngressHeader(value: Record<string, unknown>): InternalContractHeader | null {
  return parseInternalContractHeader({
    schemaVersion: value.schema_version ?? value.schemaVersion ?? 1,
    operationId: value.operation_id ?? value.operationId ?? null,
    producer: 'bot',
  });
}

export function parseConfigReloadAuditEvent(
  value: unknown,
): ConfigReloadAuditEventContract | null {
  if (!isPlainRecord(value) || !isConfigReloadAuditEventType(value.type)) return null;
  const header = parseIngressHeader(value);
  if (!header) return null;
  const event = buildContract(value.type, value.data, header);
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
  const header = parseIngressHeader(payload);
  return header ? buildContract(payload.event_type, payload.event_data, header) : null;
}
