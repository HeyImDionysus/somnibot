function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: string) {
  return { description, content: { 'application/json': { schema: schemaRef(schema) } } };
}

export function buildStaticDeliveryOpenApiDocument(apiBase: string): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'SomniBot Static Delivery API', version: '2.0.0' },
    servers: [{ url: new URL(apiBase).origin }],
    'x-somnibot-protocol-kind': 'static_delivery',
    paths: {
      '/api/portal/download-link': {
        post: {
          operationId: 'authorizeStaticDownload',
          security: [{ PortalToken: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: schemaRef('StaticDownloadAuthorizationRequest') } } },
          responses: {
            '200': jsonResponse('A short-lived, single-use signed download URL.', 'StaticDownloadAuthorizationResponse'),
            '401': jsonResponse('Portal session is missing, invalid, expired, or revoked.', 'StaticDeliveryError'),
            '403': jsonResponse('No live entitlement authorizes this product delivery.', 'StaticDeliveryError'),
            '404': jsonResponse('The requested product file does not exist.', 'StaticDeliveryError'),
            '429': jsonResponse('Rate limited; honor Retry-After.', 'StaticDeliveryError'),
            '503': jsonResponse('Authorization or delivery history is temporarily indeterminate.', 'StaticDeliveryRetryableError'),
          },
        },
      },
      '/api/downloads/{productId}/{fileId}': {
        get: {
          operationId: 'deliverStaticDerivative',
          security: [],
          parameters: [
            { name: 'productId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            ...['cid', 'gid', 'eid', 'exp', 'nonce', 'sig'].map((name) => ({
              name, in: 'query', required: true, schema: { type: 'string', minLength: 1 },
            })),
          ],
          responses: {
            '200': {
              description: 'Buyer-specific derivative; the unprotected master is never returned.',
              content: { 'application/octet-stream': { schema: { type: 'string', contentEncoding: 'binary' } } },
              headers: {
                'X-SomniBot-Watermark-Manifest': { description: 'Base64url StaticDerivativeManifest.', schema: { type: 'string' } },
                'X-SomniBot-Watermark-Signature': { description: 'HMAC-SHA256 signature over the decoded manifest.', schema: { type: 'string' } },
                'Cache-Control': { description: 'Always private, no-store, max-age=0.', schema: { const: 'private, no-store, max-age=0' } },
              },
            },
            '401': { description: 'Signed parameters are invalid or expired.' },
            '403': { description: 'The entitlement was revoked or is no longer live.' },
            '409': { description: 'Unsupported source format or replayed delivery.' },
            '410': { description: 'The single-use signed link was already consumed.' },
            '503': { description: 'Derivative generation or durable delivery evidence is unavailable.' },
          },
        },
      },
    },
    components: {
      securitySchemes: { PortalToken: { type: 'apiKey', in: 'header', name: 'x-portal-token' } },
      schemas: {
        StaticDownloadAuthorizationRequest: {
          type: 'object', additionalProperties: false, required: ['productId', 'fileId'],
          properties: { productId: { type: 'string', format: 'uuid' }, fileId: { type: 'string', format: 'uuid' } },
        },
        StaticDownloadAuthorizationResponse: {
          type: 'object', additionalProperties: false, required: ['url'],
          properties: { url: { type: 'string', format: 'uri-reference', pattern: '^/api/downloads/' } },
        },
        SignedDownloadParameters: {
          type: 'object', additionalProperties: false,
          required: ['cid', 'gid', 'eid', 'exp', 'nonce', 'sig'],
          properties: {
            cid: { type: 'string' }, gid: { type: 'string' }, eid: { type: 'string', format: 'uuid' },
            exp: { type: 'integer' }, nonce: { type: 'string', minLength: 1 }, sig: { type: 'string', minLength: 1 },
          },
        },
        StaticDerivativeManifest: {
          type: 'object', additionalProperties: false,
          required: ['version', 'algorithm', 'productId', 'entitlementRef', 'masterSha256', 'derivativeSha256', 'fingerprint', 'mimeType', 'verificationHints'],
          properties: {
            version: { const: 'somnibot-static-v1' }, algorithm: { const: 'hmac-sha256' },
            productId: { type: 'string' }, entitlementRef: { type: 'string' },
            masterSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            derivativeSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            fingerprint: { type: 'string', pattern: '^[a-f0-9]{24}$' }, mimeType: { type: 'string' },
            verificationHints: { type: 'array', items: { type: 'string' } },
          },
        },
        StaticDeliveryRevocationPolicy: {
          type: 'object', additionalProperties: false, required: ['error', 'status', 'future_delivery'],
          properties: {
            error: { type: 'string' },
            status: { enum: ['revoked', 'refunded', 'expired', 'cancelled', 'suspended'] },
            future_delivery: { const: 'blocked' }, already_delivered_copy: { const: 'cannot_be_remotely_deleted' },
          },
        },
        StaticDeliveryError: { type: 'object', additionalProperties: false, required: ['error'], properties: { error: { type: 'string' } } },
        StaticDeliveryRetryableError: { type: 'object', additionalProperties: false, required: ['error', 'retryable'], properties: { error: { type: 'string' }, retryable: { const: true } } },
      },
    },
  };
}
