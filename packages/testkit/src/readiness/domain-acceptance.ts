import type { DomainCatalog } from '@somnibot/e2e';

export type DomainAcceptanceContract = {
  readonly domainId: string;
  readonly primaryJourneys: readonly string[];
  readonly validStates: readonly string[];
  readonly invalidAndFailurePaths: readonly string[];
  readonly permissionBoundaries: readonly string[];
  readonly restartAndRecovery: readonly string[];
  readonly cleanupBehavior: string;
  readonly syntheticEvidence: readonly string[];
  readonly liveEvidence: readonly string[];
};

export function buildDomainAcceptanceContracts(
  catalog: DomainCatalog,
): readonly DomainAcceptanceContract[] {
  return catalog.categories.flatMap((category) =>
    category.domains.map((domain) => ({
      domainId: domain.id,
      primaryJourneys: domain.state.transitions.map((transition) => transition.expectedEffect),
      validStates: domain.state.values.map((state) => state.id),
      invalidAndFailurePaths: domain.failures.map((failure) => failure.expectedBehavior),
      permissionBoundaries: domain.permissions.map((permission) => permission.enforcement),
      restartAndRecovery: domain.scenarios
        .filter((scenario) => scenario.class === 'RESTART' || scenario.class === 'RETRY')
        .map((scenario) => scenario.expectedOutcome),
      cleanupBehavior: domain.scenarios.find((scenario) => scenario.class === 'CLEANUP')?.expectedOutcome ?? '',
      syntheticEvidence: domain.evidence
        .filter((evidence) => evidence.assertionClass === 'database-RLS' || evidence.assertionClass === 'replay-safety')
        .map((evidence) => evidence.artifact),
      liveEvidence: domain.evidence
        .filter((evidence) => evidence.assertionClass === 'Discord' || evidence.assertionClass === 'owner-notification')
        .map((evidence) => evidence.artifact),
    })),
  );
}
