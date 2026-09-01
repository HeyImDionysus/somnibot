import type { ProofObservation } from './contracts.js';
import { InMemoryRuntimeStorage, RuntimeWorkflowExecutor } from './runtime-adapters.js';

export const CROSS_DOMAIN_JOURNEYS = [
  {
    id: 'onboarding-to-progression',
    domains: ['community-welcome-onboarding', 'community-levels', 'game-economy-achievements-prestige'],
    phases: ['member-onboarded', 'first-message', 'xp-awarded', 'level-reward-applied'],
    liveGate: 'Discord member join, message, role readback, and owner-visible audit',
  },
  {
    id: 'community-to-economy',
    domains: ['community-polls-predictions', 'game-economy-wallet-rewards'],
    phases: ['participation-recorded', 'reward-enqueued', 'wallet-settled', 'duplicate-replay-denied'],
    liveGate: 'Discord interaction plus wallet and audit readback in the disposable guild',
  },
  {
    id: 'moderation-to-appeal',
    domains: ['moderation-automod', 'moderation-infractions-appeals', 'administration-audit'],
    phases: ['infraction-created', 'appeal-opened', 'staff-decision', 'audit-linked'],
    liveGate: 'Discord moderation effect, staff decision, and member-visible appeal result',
  },
  {
    id: 'automation-with-moderation',
    domains: ['administration-automations', 'moderation-automod'],
    phases: ['event-received', 'recursion-fence-checked', 'moderation-action', 'single-audit-chain'],
    liveGate: 'Discord event and moderation readback with recursion protection',
  },
  {
    id: 'purchase-to-revocation',
    domains: ['commerce-paypal', 'commerce-licenses', 'commerce-portal'],
    phases: ['payment-captured', 'entitlement-created', 'access-fulfilled', 'refund-replayed', 'access-revoked'],
    liveGate: 'PayPal Sandbox webhook, delivery, portal, license heartbeat, and revocation readback',
  },
  {
    id: 'provider-failure-during-fulfillment',
    domains: ['commerce-paypal', 'commerce-product-store', 'administration-incidents'],
    phases: ['payment-accepted', 'provider-failure', 'durable-retry', 'exception-owned', 'fulfillment-converged'],
    liveGate: 'Sandbox provider failure and recovered fulfillment with operation history',
  },
  {
    id: 'restore-to-member-and-commerce',
    domains: ['infrastructure-launcher', 'community-profiles', 'commerce-portal'],
    phases: ['backup-selected', 'restore-completed', 'member-readback', 'commerce-readback', 'recovery-receipt'],
    liveGate: 'VPS restore rehearsal followed by Discord member and sandbox commerce checks',
  },
] as const;

export type CrossDomainJourney = (typeof CROSS_DOMAIN_JOURNEYS)[number];

function actionForDomain(domain: string): string {
  if (domain.startsWith('commerce-')) return 'fulfill_purchase';
  if (domain.startsWith('moderation-')) return 'automod_recheck';
  if (domain.startsWith('game-economy-')) return 'economy_reward';
  if (domain.startsWith('music-')) return 'music_queue_reconcile';
  if (domain.includes('automation')) return 'automation_dispatch';
  return 'config_reload';
}

export async function crossDomainJourneyObservations(): Promise<readonly ProofObservation[]> {
  return Promise.all(CROSS_DOMAIN_JOURNEYS.map(async (journey) => {
    const storage = new InMemoryRuntimeStorage();
    const executor = new RuntimeWorkflowExecutor(storage);
    const executions = [];
    for (const [index, phase] of journey.phases.entries()) {
      const domain = journey.domains[index % journey.domains.length];
      if (!domain) continue;
      executions.push(await executor.execute({
        id: `${journey.id}-${phase}`,
        guildId: 'guild-cross-domain',
        action: actionForDomain(domain),
        operationId: `${journey.id}:${phase}`,
      }));
    }
    await executor.close();
    const snapshot = storage.snapshot();
    const passed = executions.length === journey.phases.length
      && executions.every((execution) => execution.externalEffects === 1 && execution.auditEvents === 1)
      && snapshot.claims === journey.phases.length
      && snapshot.effects === journey.phases.length;
    return {
      id: `journey-${journey.id}`,
      status: passed ? 'SYNTHETIC_PASS' : 'FAIL',
      evidenceMode: 'synthetic',
      observation: `Production-scheduled adapters executed ${executions.length} ordered phases across ${journey.domains.length} domains with ${snapshot.audits} operation audits.`,
      requiredLiveEvidence: journey.liveGate,
    };
  }));
}
