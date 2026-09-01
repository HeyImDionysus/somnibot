import { z } from 'zod';
import type { SdkContractIdentity } from './sdk-contract-identity';

const receiptIdentitySchema = z.object({
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  sdkSchemaVersion: z.number().int().positive(),
  sdkProtocolVersion: z.number().int().positive(),
  productPolicyRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  storeProductId: z.string().uuid(),
  deploymentOrigin: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }),
});

const proofResultSchema = z.enum(['passed', 'failed', 'unverified']);

const currentReceiptSchema = receiptIdentitySchema.extend({
  receiptSchemaVersion: z.literal(2),
  verificationId: z.string().trim().min(1).max(100),
  issuedBy: z.literal('somnibot-server'),
  targetProjectVersion: z.string().trim().min(1).max(100),
  targetProjectCommit: z.string().trim().min(1).max(100),
  verificationEnvironment: z.object({
    kind: z.enum(['local', 'ci', 'staging', 'production', 'other']),
    description: z.string().trim().min(1).max(500),
    operatingSystem: z.string().trim().min(1).max(100).optional(),
    architecture: z.string().trim().min(1).max(100).optional(),
    runtime: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  capabilitiesExercised: z.array(z.string().trim().min(1).max(64)).max(100),
  remainingUnverifiedRequirements: z.array(z.string().trim().min(1).max(500)).max(100),
  integrityResult: proofResultSchema,
  authenticityResult: proofResultSchema,
  conformanceResult: proofResultSchema,
  integratedAt: z.string().datetime(),
}).strict();

const legacyReceiptSchema = receiptIdentitySchema.extend({
  appVersion: z.string().trim().min(1).max(100),
  appCommit: z.string().trim().min(1).max(100),
  conformanceResult: proofResultSchema,
  integratedAt: z.string().datetime(),
}).strict();

const normalizedLegacyReceiptSchema = currentReceiptSchema.extend({
  verificationId: z.literal('legacy-self-attestation'),
  issuedBy: z.literal('legacy-unverified'),
  integrityResult: z.literal('unverified'),
  authenticityResult: z.literal('unverified'),
}).strict();

export const sdkIntegrationReceiptSchema = z.union([
  currentReceiptSchema,
  normalizedLegacyReceiptSchema,
  legacyReceiptSchema.transform((legacy) => ({
    contractHash: legacy.contractHash,
    sdkSchemaVersion: legacy.sdkSchemaVersion,
    sdkProtocolVersion: legacy.sdkProtocolVersion,
    productPolicyRevision: legacy.productPolicyRevision,
    storeProductId: legacy.storeProductId,
    deploymentOrigin: legacy.deploymentOrigin,
    receiptSchemaVersion: 2 as const,
    verificationId: 'legacy-self-attestation',
    issuedBy: 'legacy-unverified' as const,
    targetProjectVersion: legacy.appVersion,
    targetProjectCommit: legacy.appCommit,
    verificationEnvironment: { kind: 'other' as const, description: 'Legacy receipt did not record its verification environment.' },
    capabilitiesExercised: [],
    remainingUnverifiedRequirements: ['Refresh this legacy receipt with explicit provenance and proof dimensions.'],
    integrityResult: 'unverified' as const,
    authenticityResult: 'unverified' as const,
    conformanceResult: legacy.conformanceResult,
    integratedAt: legacy.integratedAt,
  })),
]);

export type SdkIntegrationReceipt = z.infer<typeof sdkIntegrationReceiptSchema>;

export const SDK_RECEIPT_METADATA_KEY = 'somnibot_sdk_integration_receipt';
export const SDK_ATTESTATION_METADATA_KEY = 'somnibot_sdk_integration_attestation';
export const SDK_PROVENANCE_METADATA_KEYS = [SDK_RECEIPT_METADATA_KEY, SDK_ATTESTATION_METADATA_KEY] as const;

export function preserveSdkProvenanceMetadata(
  current: Readonly<Record<string, unknown>>,
  replacement: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const preserved = Object.fromEntries(SDK_PROVENANCE_METADATA_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(current, key))
    .map((key) => [key, current[key]]));
  return { ...replacement, ...preserved };
}

type ReceiptProvenance = Pick<SdkIntegrationReceipt,
  | 'verificationId' | 'issuedBy' | 'targetProjectVersion' | 'targetProjectCommit' | 'verificationEnvironment'
  | 'capabilitiesExercised' | 'remainingUnverifiedRequirements'
  | 'integrityResult' | 'authenticityResult' | 'conformanceResult'>;

type LegacyReceiptProvenance = {
  readonly appVersion: string;
  readonly appCommit: string;
  readonly conformanceResult: 'passed' | 'failed' | 'unverified';
};

export function createSdkIntegrationReceipt(
  identity: SdkContractIdentity,
  integratedAt: string,
  provenance: ReceiptProvenance | LegacyReceiptProvenance,
): SdkIntegrationReceipt {
  const receipt = 'targetProjectVersion' in provenance
    ? { ...identity, ...provenance, receiptSchemaVersion: 2, integratedAt }
    : { ...identity, ...provenance, integratedAt };
  return sdkIntegrationReceiptSchema.parse(receipt);
}

export function parseSdkIntegrationReceipt(value: unknown): SdkIntegrationReceipt | null {
  const parsed = sdkIntegrationReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readSdkIntegrationReceiptMetadata(
  metadata: Readonly<Record<string, unknown>>,
): SdkIntegrationReceipt | null {
  return parseSdkIntegrationReceipt(metadata[SDK_RECEIPT_METADATA_KEY]);
}

export function mergeSdkIntegrationReceiptMetadata(
  metadata: Readonly<Record<string, unknown>>,
  receipt: SdkIntegrationReceipt,
): Record<string, unknown> {
  return { ...metadata, [SDK_RECEIPT_METADATA_KEY]: receipt };
}
