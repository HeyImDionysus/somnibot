import { z } from 'zod';

export const sdkIntegrationReceiptFieldSources = {
  verificationId: 'signedConformance.verificationId',
  issuedBy: 'somnibot-server',
  contractHash: 'bundle.contractIdentity.value',
  sdkSchemaVersion: 'somnibot-sdk.json.schemaVersion',
  sdkProtocolVersion: 'somnibot-sdk.json.protocolVersion',
  productPolicyRevision: 'somnibot-sdk.json.productPolicyRevision',
  storeProductId: 'somnibot-sdk.json.project.productId',
  deploymentOrigin: 'somnibot-sdk.json.project.deploymentOrigin',
  targetProjectVersion: 'targetProject.version',
  targetProjectCommit: 'targetProject.commit',
  verificationEnvironment: 'conformance.verificationEnvironment',
  capabilitiesExercised: 'conformance.capabilitiesExercised',
  remainingUnverifiedRequirements: 'conformance.remainingUnverifiedRequirements',
  integrityResult: 'contractAndArtifact.integrityResult',
  authenticityResult: 'sourceAndArtifact.authenticityResult',
  conformanceResult: 'passed|failed|unverified',
  integratedAt: 'ISO-8601 UTC datetime',
} as const;

export const sdkIntegrationReceiptContractSchema = z.object({
  fileName: z.literal('somnibot-integration-receipt.json'),
  receiptSchemaVersion: z.literal(2),
  requiredAfterConformance: z.literal(true),
  issuance: z.literal('somnibot_server_after_signed_conformance_verification'),
  ownerSelfAttestationAccepted: z.literal(false),
  fieldSources: z.object({
    verificationId: z.literal(sdkIntegrationReceiptFieldSources.verificationId),
    issuedBy: z.literal(sdkIntegrationReceiptFieldSources.issuedBy),
    contractHash: z.literal(sdkIntegrationReceiptFieldSources.contractHash),
    sdkSchemaVersion: z.literal(sdkIntegrationReceiptFieldSources.sdkSchemaVersion),
    sdkProtocolVersion: z.literal(sdkIntegrationReceiptFieldSources.sdkProtocolVersion),
    productPolicyRevision: z.literal(sdkIntegrationReceiptFieldSources.productPolicyRevision),
    storeProductId: z.literal(sdkIntegrationReceiptFieldSources.storeProductId),
    deploymentOrigin: z.literal(sdkIntegrationReceiptFieldSources.deploymentOrigin),
    targetProjectVersion: z.literal(sdkIntegrationReceiptFieldSources.targetProjectVersion),
    targetProjectCommit: z.literal(sdkIntegrationReceiptFieldSources.targetProjectCommit),
    verificationEnvironment: z.literal(sdkIntegrationReceiptFieldSources.verificationEnvironment),
    capabilitiesExercised: z.literal(sdkIntegrationReceiptFieldSources.capabilitiesExercised),
    remainingUnverifiedRequirements: z.literal(sdkIntegrationReceiptFieldSources.remainingUnverifiedRequirements),
    integrityResult: z.literal(sdkIntegrationReceiptFieldSources.integrityResult),
    authenticityResult: z.literal(sdkIntegrationReceiptFieldSources.authenticityResult),
    conformanceResult: z.literal(sdkIntegrationReceiptFieldSources.conformanceResult),
    integratedAt: z.literal(sdkIntegrationReceiptFieldSources.integratedAt),
  }),
  driftStates: z.tuple([
    z.literal('current'),
    z.literal('reintegration_required'),
    z.literal('implementation_unverified'),
    z.literal('older_protocol'),
  ]),
});

export function resolveSdkReceiptDeploymentOrigin(config: {
  readonly project: { readonly deploymentOrigin: string };
}): string {
  return config.project.deploymentOrigin;
}
