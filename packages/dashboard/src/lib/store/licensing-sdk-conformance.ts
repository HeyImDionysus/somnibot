import { z } from 'zod';
import type { LicensingRails } from './licensing-rails';

export const acceptanceScenarioSchema = z.object({
  id: z.string().min(1),
  appliesWhen: z.array(z.string().min(1)),
  setup: z.string().min(1),
  action: z.string().min(1),
  expectedApi: z.string().min(1),
  expectedState: z.string().min(1),
  expectedUi: z.string().min(1),
  expected: z.string().min(1),
  forbidden: z.string().min(1),
  requiredEvidence: z.string().min(1),
});

export type AcceptanceScenario = z.infer<typeof acceptanceScenarioSchema>;

function scenario(id: string, appliesWhen: readonly string[], expected: string): AcceptanceScenario {
  return {
    id,
    appliesWhen: [...appliesWhen],
    setup: 'Use the real built artifact with a non-production test entitlement and isolated customer data.',
    action: 'Exercise the named behavior through the same entry point a customer uses.',
    expectedApi: 'Requests and responses match license-api.openapi.json and contain no secrets in evidence.',
    expectedState: expected,
    expectedUi: 'The customer sees a branded, actionable state that agrees with the authoritative verdict.',
    expected,
    forbidden: 'No access bypass, invented entitlement, destructive customer-data mutation, secret exposure, or hidden failure.',
    requiredEvidence: 'Record build identity, sanitized request class, HTTP/status verdict, state transition, and customer-visible result.',
  };
}

export function buildAcceptanceScenarios(rails: LicensingRails): AcceptanceScenario[] {
  const scenarios = [
    scenario('validate-active', ['runtimeLicensing'], 'Enable only the capability keys returned in features.'),
    scenario('heartbeat-recovers-after-outage', ['runtimeLicensing'], 'Keep heartbeats running across indeterminate failures and recover without restart.'),
    scenario('offline-grace-expires', ['runtimeLicensing'], 'Stop access at the authoritative offline or payment-grace deadline.'),
    scenario('terminal-revocation-disables-features', ['runtimeLicensing'], 'Clear the session and disable licensed capabilities without damaging customer data.'),
    scenario('capability-plan-grants', ['runtimeLicensing'], 'The entitlement plan_id grants exactly matching structured capabilities and satisfied dependencies.'),
    scenario('download-delivery-is-authorized', ['downloadableFiles'], 'SomniBot authorizes each expiring single-use delivery and never exposes an unprotected master.'),
    scenario('hosted-operation-is-authorized', ['hostedAccess'], 'Every privileged hosted operation checks current server entitlement.'),
    scenario('discord-role-is-fulfilled-by-somnibot', ['discordRoles'], 'Role grants and removals follow authoritative entitlement changes.'),
    scenario('update-is-signed-and-entitled', ['updates'], 'Updates require current entitlement and signature verification.'),
  ];
  return [
    scenario('build-and-behavior-preservation', ['all'], 'The original project builds and all pre-licensing behavior remains intact outside licensed gates.'),
    scenario('inactive-until-owner-activation', ['all'], 'The integration presents a clear not-yet-active state and cannot silently activate or sell the project.'),
    scenario('secret-and-pii-scan', ['all'], 'The artifact contains no provider secrets, owner credentials, customer identity, license keys, or sessions.'),
    ...scenarios.filter(({ appliesWhen }) => appliesWhen.some((rail) => Reflect.get(rails, rail) === true)),
    scenario('integration-receipt-emitted', ['all'], 'Emit somnibot-integration-receipt.json only after running every applicable conformance scenario.'),
  ];
}

export function buildConformanceMarkdown(scenarios: readonly AcceptanceScenario[]): string {
  const rows = scenarios.map((item) => `## ${item.id}\n\n- Applies when: ${item.appliesWhen.join(', ')}\n- Setup: ${item.setup}\n- Action: ${item.action}\n- Expected API: ${item.expectedApi}\n- Expected state: ${item.expectedState}\n- Expected UI: ${item.expectedUi}\n- Forbidden: ${item.forbidden}\n- Required evidence: ${item.requiredEvidence}\n- [ ] Result verified`);
  return `# SomniBot licensing conformance

Execute against the built project and authoritative SomniBot API. Record non-secret request class, response status, state transition, and licensed-feature result.

${rows.join('\n')}`;
}
