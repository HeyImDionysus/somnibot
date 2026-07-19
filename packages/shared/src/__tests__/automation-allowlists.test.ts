import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  CONDITION_TYPES,
  TRIGGER_TYPES,
  isActionType,
  isConditionType,
  isTriggerType,
} from '../constants/automations.js';
import {
  ACTION_QUEUE_PLATFORM_EVENT_TYPES,
  CONFIG_RELOAD_AUDIT_EVENT_TYPES,
  isActionQueuePlatformEventType,
  isConfigReloadAuditEventType,
} from '../types/events.js';

describe('automation runtime allowlists', () => {
  it('accepts every canonical trigger, condition, and action', () => {
    expect(TRIGGER_TYPES.every(isTriggerType)).toBe(true);
    expect(CONDITION_TYPES.every(isConditionType)).toBe(true);
    expect(ACTION_TYPES.every(isActionType)).toBe(true);
  });

  it.each([undefined, null, '', ' member.joined', 'entitlement.granted', 'totally.custom'])(
    'rejects noncanonical trigger %j',
    (value) => expect(isTriggerType(value)).toBe(false),
  );

  it.each([undefined, null, '', 'send-message', 'emit_audit_event', 'totally_custom'])(
    'rejects noncanonical action %j',
    (value) => expect(isActionType(value)).toBe(false),
  );

  it('keeps remote ingress narrower than the platform event map', () => {
    expect(CONFIG_RELOAD_AUDIT_EVENT_TYPES).toEqual([
      'automation.created',
      'automation.updated',
      'automation.deleted',
    ]);
    expect(ACTION_QUEUE_PLATFORM_EVENT_TYPES).toEqual([
      ...CONFIG_RELOAD_AUDIT_EVENT_TYPES,
      'webhook.received',
      'webhook.replayed',
      'subscription.expired',
    ]);
    expect(isConfigReloadAuditEventType('member.joined')).toBe(false);
    expect(isActionQueuePlatformEventType('member.joined')).toBe(false);
    expect(isActionQueuePlatformEventType('subscription.expired')).toBe(true);
  });
});
