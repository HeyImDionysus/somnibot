import { z } from 'zod';

const criterionIdSchema = z.enum([
  'compile_build',
  'behavioral_preservation',
  'activation_ux',
  'structural_capability_enforcement',
  'bounded_offline_behavior',
  'revocation',
  'deactivation',
  'retry_rate_limit_handling',
  'secret_leakage',
]);

const identitySchema = z.object({
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  sdkSchemaVersion: z.number().int().positive(),
  sdkProtocolVersion: z.number().int().positive(),
  productPolicyRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  storeProductId: z.string().uuid(),
  deploymentOrigin: z.string().url(),
}).strict();

const sdkVerificationPayloadObjectSchema = z.object({
  schemaVersion: z.literal(1),
  verificationId: z.string().trim().min(1).max(100),
  issuer: z.literal('somnibot-conformance-runner'),
  issuedAt: z.string().datetime(),
  identity: identitySchema,
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
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  criteria: z.array(z.object({
    criterionId: criterionIdSchema,
    verdict: z.enum(['pass', 'fail', 'blocked']),
    evidenceDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1),
  }).strict()).length(9),
}).strict();

function verifyCriterionOrder(
  value: z.infer<typeof sdkVerificationPayloadObjectSchema>,
  context: z.RefinementCtx,
): void {
  const actual = value.criteria.map(({ criterionId }) => criterionId);
  criterionIdSchema.options.forEach((criterionId, index) => {
    if (actual[index] !== criterionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: 'Verification criteria must be complete and ordered.',
      });
    }
  });
}

export const sdkVerificationPayloadSchema = sdkVerificationPayloadObjectSchema
  .superRefine(verifyCriterionOrder);

export const sdkVerificationAttestationSchema = sdkVerificationPayloadObjectSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict().superRefine(verifyCriterionOrder);

export type SdkVerificationPayload = z.infer<typeof sdkVerificationPayloadSchema>;
export type SdkVerificationAttestation = z.infer<typeof sdkVerificationAttestationSchema>;
export type SdkVerificationCriterion = SdkVerificationPayload['criteria'][number];

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new TypeError('Verification payload contains a non-JSON value.');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): ArrayBuffer {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

async function hmacKey(secret: string, usages: readonly ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [...usages],
  );
}

export async function buildSdkEvidenceDigest(
  criteria: readonly SdkVerificationCriterion[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(criteria)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export async function signSdkVerificationPayload(
  payload: SdkVerificationPayload,
  secret: string,
): Promise<string> {
  const parsed = sdkVerificationPayloadSchema.parse(payload);
  const key = await hmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalJson(parsed)),
  );
  return base64Url(new Uint8Array(signature));
}

export async function verifySdkVerificationAttestation(
  attestation: SdkVerificationAttestation,
  secret: string,
): Promise<boolean> {
  const { signature, ...payload } = attestation;
  const key = await hmacKey(secret, ['verify']);
  return crypto.subtle.verify(
    'HMAC',
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(canonicalJson(sdkVerificationPayloadSchema.parse(payload))),
  );
}
