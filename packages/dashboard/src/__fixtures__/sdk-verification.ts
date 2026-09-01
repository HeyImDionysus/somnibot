import {
  buildSdkEvidenceDigest,
  sdkVerificationPayloadSchema,
  signSdkVerificationPayload,
  type SdkVerificationAttestation,
} from '@/lib/store/licensing-sdk-verification';
import type { SdkContractIdentity } from '@/lib/store/sdk-contract-identity';

export const SDK_TEST_SIGNING_SECRET = 'test-signing-secret-with-at-least-32-bytes';

export async function signedSdkVerification(identity: SdkContractIdentity): Promise<SdkVerificationAttestation> {
  const criterionIds = [
    'compile_build', 'behavioral_preservation', 'activation_ux',
    'structural_capability_enforcement', 'bounded_offline_behavior', 'revocation',
    'deactivation', 'retry_rate_limit_handling', 'secret_leakage',
  ] as const;
  const criteria = criterionIds.map((criterionId) => ({
    criterionId, verdict: 'pass' as const, evidenceDigests: [`sha256:${'d'.repeat(64)}`],
  }));
  const payload = sdkVerificationPayloadSchema.parse({
    schemaVersion: 1,
    verificationId: 'verification-123',
    issuer: 'somnibot-conformance-runner',
    issuedAt: '2026-08-23T12:00:00.000Z',
    identity,
    targetProjectVersion: '2.4.0',
    targetProjectCommit: 'abc1234',
    verificationEnvironment: { kind: 'ci', description: 'Release verification job' },
    capabilitiesExercised: ['exports'],
    remainingUnverifiedRequirements: [],
    evidenceDigest: await buildSdkEvidenceDigest(criteria),
    criteria,
  });
  return { ...payload, signature: await signSdkVerificationPayload(payload, SDK_TEST_SIGNING_SECRET) };
}
