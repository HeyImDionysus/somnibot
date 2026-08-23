import { z } from 'zod';

const jsonSchemaFieldSchema = z.record(z.unknown());

export const staticDeliveryContractSchema = z.object({
  authorization: z.object({
    endpoint: z.literal('/api/portal/download-link'),
    method: z.literal('POST'),
    authenticationHeader: z.literal('x-portal-token'),
    requestSchema: z.object({
      productId: z.literal('uuid'),
      fileId: z.literal('uuid'),
    }).strict(),
    successSchema: z.object({ url: z.literal('signed_download_url') }).strict(),
    denialStatuses: z.tuple([
      z.literal(401), z.literal(403), z.literal(404), z.literal(429), z.literal(503),
    ]),
  }).strict(),
  signedDownload: z.object({
    endpointTemplate: z.literal('/api/downloads/{productId}/{fileId}'),
    method: z.literal('GET'),
    queryParameters: z.tuple([
      z.literal('cid'), z.literal('gid'), z.literal('eid'), z.literal('exp'),
      z.literal('nonce'), z.literal('sig'),
    ]),
    signature: z.literal('hmac_sha256_server_verified'),
    maximumTtlSeconds: z.literal(3600),
    nonce: z.literal('single_use_consumed_after_dependencies_pass'),
    cacheControl: z.literal('private_no_store'),
  }).strict(),
  derivative: z.object({
    executionBoundary: z.literal('somnibot_server_only'),
    masterHandling: z.literal('never_return_unprotected_master'),
    manifestVersion: z.literal('somnibot-static-v1'),
    signatureAlgorithm: z.literal('hmac-sha256'),
    responseHeaders: z.object({
      manifest: z.literal('X-SomniBot-Watermark-Manifest'),
      signature: z.literal('X-SomniBot-Watermark-Signature'),
    }).strict(),
    manifestSchema: z.object({
      version: z.literal('somnibot-static-v1'),
      algorithm: z.literal('hmac-sha256'),
      productId: z.literal('string'),
      entitlementRef: z.literal('non_secret_string'),
      masterSha256: z.literal('lowercase_hex_sha256'),
      derivativeSha256: z.literal('lowercase_hex_sha256'),
      fingerprint: z.literal('lowercase_hex_24'),
      mimeType: z.literal('string'),
      verificationHints: z.literal('string_array'),
    }).strict(),
  }).strict(),
  revocation: z.object({
    authority: z.literal('somnibot_entitlement_status'),
    blockedStatuses: z.tuple([
      z.literal('revoked'), z.literal('refunded'), z.literal('expired'),
      z.literal('cancelled'), z.literal('suspended'),
    ]),
    blocksFutureDelivery: z.literal(true),
    alreadyDeliveredCopies: z.literal('cannot_be_remotely_deleted'),
    replacementAndUpdateAccess: z.literal('denied_after_revocation'),
  }).strict(),
}).strict();

export type StaticDeliveryContract = z.infer<typeof staticDeliveryContractSchema>;

export const STATIC_DELIVERY_CONTRACT: StaticDeliveryContract = staticDeliveryContractSchema.parse({
  authorization: {
    endpoint: '/api/portal/download-link', method: 'POST', authenticationHeader: 'x-portal-token',
    requestSchema: { productId: 'uuid', fileId: 'uuid' },
    successSchema: { url: 'signed_download_url' },
    denialStatuses: [401, 403, 404, 429, 503],
  },
  signedDownload: {
    endpointTemplate: '/api/downloads/{productId}/{fileId}', method: 'GET',
    queryParameters: ['cid', 'gid', 'eid', 'exp', 'nonce', 'sig'],
    signature: 'hmac_sha256_server_verified', maximumTtlSeconds: 3600,
    nonce: 'single_use_consumed_after_dependencies_pass', cacheControl: 'private_no_store',
  },
  derivative: {
    executionBoundary: 'somnibot_server_only', masterHandling: 'never_return_unprotected_master',
    manifestVersion: 'somnibot-static-v1', signatureAlgorithm: 'hmac-sha256',
    responseHeaders: { manifest: 'X-SomniBot-Watermark-Manifest', signature: 'X-SomniBot-Watermark-Signature' },
    manifestSchema: {
      version: 'somnibot-static-v1', algorithm: 'hmac-sha256', productId: 'string',
      entitlementRef: 'non_secret_string', masterSha256: 'lowercase_hex_sha256',
      derivativeSha256: 'lowercase_hex_sha256', fingerprint: 'lowercase_hex_24',
      mimeType: 'string', verificationHints: 'string_array',
    },
  },
  revocation: {
    authority: 'somnibot_entitlement_status',
    blockedStatuses: ['revoked', 'refunded', 'expired', 'cancelled', 'suspended'],
    blocksFutureDelivery: true, alreadyDeliveredCopies: 'cannot_be_remotely_deleted',
    replacementAndUpdateAccess: 'denied_after_revocation',
  },
});

export const staticDeliveryOpenApiComponentSchema = jsonSchemaFieldSchema;
