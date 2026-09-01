import { z } from 'zod';

export const NotificationSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const NotificationAudienceSchema = z.enum([
  'owner',
  'administrator',
  'moderator',
  'finance',
  'support',
  'customer',
]);
export const NotificationChannelSchema = z.enum([
  'dashboard',
  'discord_channel',
  'discord_dm',
  'email',
]);

export const NotificationPolicySchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  minimumSeverity: NotificationSeveritySchema,
  audiences: z.array(NotificationAudienceSchema).min(1),
  channels: z.array(NotificationChannelSchema).min(1),
  cooldownSeconds: z.number().int().nonnegative(),
  quietHours: z.object({
    startHourUtc: z.number().int().min(0).max(23),
    endHourUtc: z.number().int().min(0).max(23),
    bypass: z.array(NotificationSeveritySchema),
  }).strict().nullable(),
  acknowledgementRequired: z.array(NotificationSeveritySchema),
  escalation: z.object({
    afterSeconds: z.number().int().positive(),
    audiences: z.array(NotificationAudienceSchema).min(1),
  }).strict().nullable(),
}).strict();

export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>;
export type NotificationDeliveryInput = {
  readonly severity: z.infer<typeof NotificationSeveritySchema>;
  readonly audience: z.infer<typeof NotificationAudienceSchema>;
  readonly occurredAt: string;
  readonly lastDeliveredAt: string | null;
};

export type NotificationDeliveryPlan =
  | { readonly kind: 'suppressed'; readonly reason: 'disabled' | 'severity' | 'audience' | 'quiet_hours' | 'cooldown' }
  | {
    readonly kind: 'deliver';
    readonly channels: readonly z.infer<typeof NotificationChannelSchema>[];
    readonly acknowledgementRequired: boolean;
    readonly escalation: NotificationPolicy['escalation'];
  };

const SEVERITY_RANK: Readonly<Record<z.infer<typeof NotificationSeveritySchema>, number>> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

function isQuietHour(hour: number, start: number, end: number): boolean {
  return start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end);
}

export function planNotificationDelivery(
  policyInput: NotificationPolicy,
  input: NotificationDeliveryInput,
): NotificationDeliveryPlan {
  const policy = NotificationPolicySchema.parse(policyInput);
  if (!policy.enabled) return { kind: 'suppressed', reason: 'disabled' };
  if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[policy.minimumSeverity]) {
    return { kind: 'suppressed', reason: 'severity' };
  }
  if (!policy.audiences.includes(input.audience)) {
    return { kind: 'suppressed', reason: 'audience' };
  }

  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new RangeError('Notification occurredAt must be a valid ISO timestamp');
  }
  const quiet = policy.quietHours;
  if (quiet && !quiet.bypass.includes(input.severity)
    && isQuietHour(occurredAt.getUTCHours(), quiet.startHourUtc, quiet.endHourUtc)) {
    return { kind: 'suppressed', reason: 'quiet_hours' };
  }
  if (input.lastDeliveredAt) {
    const lastDeliveredAt = new Date(input.lastDeliveredAt);
    if (!Number.isFinite(lastDeliveredAt.getTime())) {
      throw new RangeError('Notification lastDeliveredAt must be a valid ISO timestamp');
    }
    if (occurredAt.getTime() - lastDeliveredAt.getTime() < policy.cooldownSeconds * 1_000) {
      return { kind: 'suppressed', reason: 'cooldown' };
    }
  }
  return {
    kind: 'deliver',
    channels: policy.channels,
    acknowledgementRequired: policy.acknowledgementRequired.includes(input.severity),
    escalation: policy.escalation,
  };
}
