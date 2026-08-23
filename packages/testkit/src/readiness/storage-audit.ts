import type { ProofObservation } from './contracts.js';

export const STORAGE_SURFACES = [
  'member-lists',
  'orders',
  'audit-history',
  'message-logs',
  'action-queues',
  'aggregate-analytics',
  'retention-jobs',
] as const;

export type StorageSurface = (typeof STORAGE_SURFACES)[number];

export type StorageAuditRequirement = {
  readonly surface: StorageSurface;
  readonly fixtureRows: number;
  readonly requiresPagination: boolean;
  readonly requiredLiveProof: string;
};

export const STORAGE_AUDIT_REQUIREMENTS: readonly StorageAuditRequirement[] = [
  { surface: 'member-lists', fixtureRows: 10_000, requiresPagination: true, requiredLiveProof: 'EXPLAIN ANALYZE for filtered and paginated member queries at 10,000 guild members' },
  { surface: 'orders', fixtureRows: 100_000, requiresPagination: true, requiredLiveProof: 'EXPLAIN ANALYZE for customer, status, product, and date order filters' },
  { surface: 'audit-history', fixtureRows: 1_000_000, requiresPagination: true, requiredLiveProof: 'EXPLAIN ANALYZE for guild, actor, operation, feature, and time-range audit filters' },
  { surface: 'message-logs', fixtureRows: 1_000_000, requiresPagination: true, requiredLiveProof: 'EXPLAIN ANALYZE for channel, member, and time-range log filters plus retention deletion' },
  { surface: 'action-queues', fixtureRows: 100_000, requiresPagination: true, requiredLiveProof: 'Queue claim and stale-recovery plans under mixed-lane backlog' },
  { surface: 'aggregate-analytics', fixtureRows: 1_000_000, requiresPagination: false, requiredLiveProof: 'Aggregate refresh latency and cache invalidation under write load' },
  { surface: 'retention-jobs', fixtureRows: 1_000_000, requiresPagination: true, requiredLiveProof: 'Bounded deletion batches, lock duration, and recovery after interruption' },
] as const;

export function storageAuditObservations(): readonly ProofObservation[] {
  return STORAGE_AUDIT_REQUIREMENTS.map((requirement) => ({
    id: `storage-${requirement.surface}`,
    status: 'LIVE_GATED',
    evidenceMode: 'live',
    observation: `${requirement.fixtureRows} rows required; synthetic cardinality alone does not prove query behavior.`,
    requiredLiveEvidence: requirement.requiredLiveProof,
  }));
}
