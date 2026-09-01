import {
  buildSdkEvidenceDigest,
  sdkVerificationAttestationSchema,
  verifySdkVerificationAttestation,
  type SdkVerificationAttestation,
} from './licensing-sdk-verification';
import {
  createSdkIntegrationReceipt,
  readSdkIntegrationReceiptMetadata,
  SDK_ATTESTATION_METADATA_KEY,
  type SdkIntegrationReceipt,
} from './sdk-integration-receipt';

export function createVerifiedSdkIntegrationReceipt(verification: SdkVerificationAttestation): SdkIntegrationReceipt {
  return createSdkIntegrationReceipt(verification.identity, verification.issuedAt, {
    verificationId: verification.verificationId,
    issuedBy: 'somnibot-server',
    targetProjectVersion: verification.targetProjectVersion,
    targetProjectCommit: verification.targetProjectCommit,
    verificationEnvironment: verification.verificationEnvironment,
    capabilitiesExercised: verification.capabilitiesExercised,
    remainingUnverifiedRequirements: verification.remainingUnverifiedRequirements,
    integrityResult: 'passed',
    authenticityResult: 'passed',
    conformanceResult: verification.criteria.every(({ verdict }) => verdict === 'pass')
      && verification.remainingUnverifiedRequirements.length === 0 ? 'passed' : 'unverified',
  });
}

export async function readVerifiedSdkIntegrationReceiptMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Promise<SdkIntegrationReceipt | null> {
  const receipt = readSdkIntegrationReceiptMetadata(metadata);
  const verification = sdkVerificationAttestationSchema.safeParse(metadata[SDK_ATTESTATION_METADATA_KEY]);
  const signingSecret = process.env.SDK_VERIFICATION_SIGNING_SECRET?.trim();
  if (!receipt || !verification.success || !signingSecret || signingSecret.length < 32) return null;
  if (!await verifySdkVerificationAttestation(verification.data, signingSecret)) return null;
  if (verification.data.evidenceDigest !== await buildSdkEvidenceDigest(verification.data.criteria)) return null;
  const verifiedReceipt = createVerifiedSdkIntegrationReceipt(verification.data);
  return JSON.stringify(receipt) === JSON.stringify(verifiedReceipt) ? verifiedReceipt : null;
}
