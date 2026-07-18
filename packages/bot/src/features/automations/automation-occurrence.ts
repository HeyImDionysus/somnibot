import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTOMATION_LIMITS,
  createLogger,
  isTriggerType,
  type PlatformEvent,
  type TriggerType,
} from '@somnibot/shared';
import { deterministicUuidV8 } from '../../utils/deterministic-uuid.js';

const log = createLogger('AutomationOccurrence');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AutomationOccurrenceDescriptor =
  | {
      kind: 'immutable';
      triggerType: TriggerType;
      sourceKey: string;
      candidateOccurrenceId: string;
    }
  | {
      kind: 'transition';
      triggerType: TriggerType;
      transitionKey: string;
      transitionState: string;
    }
  | {
      kind: 'observation';
      transitionKey: string;
      transitionState: string;
    };

export type AutomationOccurrenceResolution =
  | { kind: 'event'; event: PlatformEvent }
  | { kind: 'observation' }
  | { kind: 'ignored' }
  | { kind: 'rejected'; reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactString(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    ? value
    : null;
}

function safeInteger(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return Number.isSafeInteger(value) ? String(value) : null;
}

function immutableDescriptor(
  event: PlatformEvent,
  triggerType: TriggerType,
  identityParts: string[],
): AutomationOccurrenceDescriptor {
  const candidateOccurrenceId = deterministicUuidV8(
    'somnibot:automation-occurrence:v1',
    [event.guildId, triggerType, ...identityParts],
  );
  return {
    kind: 'immutable',
    triggerType,
    sourceKey: `immutable:${candidateOccurrenceId}`,
    candidateOccurrenceId,
  };
}

function transitionKey(event: PlatformEvent, kind: string, identityParts: string[]): string {
  return `transition:${deterministicUuidV8(
    'somnibot:automation-transition:v1',
    [event.guildId, kind, ...identityParts],
  )}`;
}

/**
 * Convert every canonical trigger into either an immutable source identity or
 * a durable state-transition identity. Non-trigger observations advance the
 * same state head so a later remove/re-add or reopen/reclose remains distinct.
 */
export function describeAutomationOccurrence(
  event: PlatformEvent,
): AutomationOccurrenceDescriptor | null {
  if (!isPlainRecord(event.data)) return null;
  const data = event.data;

  if (event.type === 'reaction.removed') {
    const userId = exactString(data, 'discordId');
    const messageId = exactString(data, 'messageId');
    const emoji = exactString(data, 'emojiId') ?? exactString(data, 'emoji');
    if (!userId || !messageId || !emoji) return null;
    return {
      kind: 'observation',
      transitionKey: transitionKey(event, 'reaction', [userId, messageId, emoji]),
      transitionState: 'removed',
    };
  }

  if (event.type === 'ticket.reopened') {
    const ticketId = exactString(data, 'ticketId');
    if (!ticketId) return null;
    return {
      kind: 'observation',
      transitionKey: transitionKey(event, 'ticket', [ticketId]),
      transitionState: 'reopened',
    };
  }

  if (!isTriggerType(event.type)) return null;
  const triggerType = event.type;
  switch (triggerType) {
    case 'member.joined':
    case 'member.left':
    case 'member.verified': {
      const userId = exactString(data, 'discordId');
      if (!userId) return null;
      return {
        kind: 'transition',
        triggerType,
        transitionKey: transitionKey(event, 'member-lifecycle', [userId]),
        transitionState: triggerType,
      };
    }
    case 'message.sent': {
      const messageId = exactString(data, 'messageId');
      return messageId
        ? immutableDescriptor(event, triggerType, [messageId])
        : null;
    }
    case 'role.gained':
    case 'role.lost': {
      const userId = exactString(data, 'discordId');
      const roleId = exactString(data, 'roleId');
      if (!userId || !roleId) return null;
      return {
        kind: 'transition',
        triggerType,
        transitionKey: transitionKey(event, 'member-role', [userId, roleId]),
        transitionState: triggerType,
      };
    }
    case 'level.up': {
      const userId = exactString(data, 'discordId');
      const newLevel = safeInteger(data, 'newLevel');
      const totalXp = safeInteger(data, 'totalXp');
      return userId && newLevel && totalXp
        ? immutableDescriptor(event, triggerType, [userId, newLevel, totalXp])
        : null;
    }
    case 'purchase.completed': {
      const orderId = exactString(data, 'orderId');
      return orderId ? immutableDescriptor(event, triggerType, [orderId]) : null;
    }
    case 'subscription.activated':
    case 'subscription.lapsed':
    case 'subscription.expired': {
      const lifecycleId = exactString(data, 'lifecycleId');
      const status = exactString(data, 'status');
      const compatible = triggerType === 'subscription.activated'
        ? status === 'activated' || status === 'renewed'
        : triggerType === 'subscription.lapsed'
          ? status === 'lapsed' || status === 'cancelled'
          : status === 'expired';
      return lifecycleId && compatible
        ? immutableDescriptor(event, triggerType, [lifecycleId])
        : null;
    }
    case 'ticket.opened':
    case 'ticket.closed': {
      const ticketId = exactString(data, 'ticketId');
      if (!ticketId) return null;
      return {
        kind: 'transition',
        triggerType,
        transitionKey: transitionKey(event, 'ticket', [ticketId]),
        transitionState: triggerType,
      };
    }
    case 'giveaway.ended': {
      const giveawayId = exactString(data, 'giveawayId');
      return giveawayId ? immutableDescriptor(event, triggerType, [giveawayId]) : null;
    }
    case 'button.clicked': {
      const interactionId = exactString(data, 'interactionId');
      return interactionId ? immutableDescriptor(event, triggerType, [interactionId]) : null;
    }
    case 'reaction.added': {
      const userId = exactString(data, 'discordId');
      const messageId = exactString(data, 'messageId');
      const emoji = exactString(data, 'emojiId') ?? exactString(data, 'emoji');
      if (!userId || !messageId || !emoji) return null;
      return {
        kind: 'transition',
        triggerType,
        transitionKey: transitionKey(event, 'reaction', [userId, messageId, emoji]),
        transitionState: 'added',
      };
    }
    case 'voice.joined':
    case 'voice.left': {
      const userId = exactString(data, 'discordId');
      const channelId = exactString(data, 'channelId');
      if (!userId || !channelId) return null;
      return {
        kind: 'transition',
        triggerType,
        transitionKey: transitionKey(event, 'member-voice', [userId]),
        transitionState: `${triggerType}:${channelId}`,
      };
    }
    case 'infraction.created': {
      const infractionId = exactString(data, 'infractionId');
      return infractionId ? immutableDescriptor(event, triggerType, [infractionId]) : null;
    }
  }
}

function onlyRow(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value)
    && value.length === 1
    && isPlainRecord(value[0])
    ? value[0]
    : null;
}

export class AutomationOccurrenceStore {
  constructor(private supabase: SupabaseClient) {}

  async resolve(event: PlatformEvent): Promise<AutomationOccurrenceResolution> {
    const descriptor = describeAutomationOccurrence(event);
    if (!descriptor) {
      return isTriggerType(event.type)
        ? { kind: 'rejected', reason: `Missing durable source identity for ${event.type}` }
        : { kind: 'ignored' };
    }

    const rpc = this.supabase.rpc as unknown as (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;

    if (descriptor.kind === 'observation') {
      const { data, error } = await rpc('automation_observe_transition', {
        p_guild_id: event.guildId,
        p_transition_key: descriptor.transitionKey,
        p_transition_state: descriptor.transitionState,
      });
      const row = onlyRow(data);
      if (error || !row || !['observed', 'duplicate'].includes(String(row.disposition))) {
        log.error('Failed to persist automation transition observation:', error?.message ?? data);
        return { kind: 'rejected', reason: 'Durable transition observation failed' };
      }
      return { kind: 'observation' };
    }

    const depth = event._chainDepth ?? 0;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > AUTOMATION_LIMITS.MAX_CHAIN_DEPTH) {
      return { kind: 'rejected', reason: 'Invalid automation chain depth' };
    }

    const { data, error } = await rpc('automation_resolve_occurrence', {
      p_candidate_occurrence_id: descriptor.kind === 'immutable'
        ? descriptor.candidateOccurrenceId
        : null,
      p_guild_id: event.guildId,
      p_trigger_type: descriptor.triggerType,
      p_source_key: descriptor.kind === 'immutable' ? descriptor.sourceKey : null,
      p_transition_key: descriptor.kind === 'transition' ? descriptor.transitionKey : null,
      p_transition_state: descriptor.kind === 'transition' ? descriptor.transitionState : null,
      p_event_data: event.data,
      p_chain_depth: depth,
      p_parent_action_execution_id: event._parentActionExecutionId ?? null,
    });
    const row = onlyRow(data);
    if (
      error
      || !row
      || !UUID_PATTERN.test(String(row.occurrence_id))
      || !['registered', 'duplicate'].includes(String(row.disposition))
      || !isPlainRecord(row.event_data)
      || !Number.isSafeInteger(row.chain_depth)
    ) {
      log.error('Failed to resolve automation occurrence:', error?.message ?? data);
      return { kind: 'rejected', reason: 'Durable occurrence registration failed' };
    }

    return {
      kind: 'event',
      event: {
        ...event,
        occurrenceId: String(row.occurrence_id),
        data: row.event_data,
        _chainDepth: Number(row.chain_depth),
      },
    };
  }
}
