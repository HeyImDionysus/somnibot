export const PROOF_STATUSES = ['SYNTHETIC_PASS', 'LIVE_GATED', 'FAIL'] as const;

export type ProofStatus = (typeof PROOF_STATUSES)[number];

export const CAPACITY_DIMENSIONS = [
  'registered-members',
  'concurrently-active-members',
  'events-per-second',
  'interactions-per-second',
  'active-features',
  'active-guilds',
  'dashboard-requests-per-second',
  'payment-events-per-second',
  'queue-recovery-seconds',
  'database-latency-ms',
  'valkey-latency-ms',
  'cpu-percent',
  'memory-megabytes',
] as const;

export type CapacityDimension = (typeof CAPACITY_DIMENSIONS)[number];

export type ProofObservation = {
  readonly id: string;
  readonly status: ProofStatus;
  readonly evidenceMode: 'synthetic' | 'live';
  readonly observation: string;
  readonly requiredLiveEvidence: string | null;
};

export type ServiceObjective = {
  readonly id: string;
  readonly feature: string;
  readonly metric: string;
  readonly target: number;
  readonly unit: 'milliseconds' | 'seconds' | 'minutes' | 'hours';
  readonly percentile: 'p95' | 'p99' | 'maximum' | 'freshness';
};

export const SERVICE_OBJECTIVES: readonly ServiceObjective[] = [
  { id: 'discord-ack', feature: 'discord-interactions', metric: 'acknowledgement', target: 2_500, unit: 'milliseconds', percentile: 'p95' },
  { id: 'music-control', feature: 'music', metric: 'control-readback', target: 1_500, unit: 'milliseconds', percentile: 'p95' },
  { id: 'moderation-action', feature: 'moderation', metric: 'action-readback', target: 3_000, unit: 'milliseconds', percentile: 'p95' },
  { id: 'dashboard-response', feature: 'dashboard', metric: 'authenticated-response', target: 750, unit: 'milliseconds', percentile: 'p95' },
  { id: 'webhook-entitlement', feature: 'commerce', metric: 'webhook-to-entitlement', target: 30, unit: 'seconds', percentile: 'p99' },
  { id: 'fulfillment', feature: 'commerce', metric: 'entitlement-to-fulfillment', target: 60, unit: 'seconds', percentile: 'p99' },
  { id: 'queue-recovery', feature: 'operations', metric: 'queue-recovery', target: 5, unit: 'minutes', percentile: 'maximum' },
  { id: 'reconciliation', feature: 'commerce', metric: 'reconciliation-freshness', target: 15, unit: 'minutes', percentile: 'freshness' },
  { id: 'backup-age', feature: 'recovery', metric: 'backup-age', target: 24, unit: 'hours', percentile: 'maximum' },
  { id: 'alert-delivery', feature: 'operations', metric: 'critical-alert-delivery', target: 60, unit: 'seconds', percentile: 'p99' },
] as const;

export type ReliabilityProof = {
  readonly schemaVersion: '1.0.0';
  readonly memberTarget: 10_000;
  readonly capacityDimensions: readonly CapacityDimension[];
  readonly serviceObjectives: readonly ServiceObjective[];
  readonly observations: readonly ProofObservation[];
};
