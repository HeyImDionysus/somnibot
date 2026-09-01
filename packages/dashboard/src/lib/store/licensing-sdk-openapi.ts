import { z } from 'zod';
import { buildStaticDeliveryOpenApiDocument } from './licensing-sdk-static-openapi';

const schemaReferenceSchema = z.object({ $ref: z.string().min(1) });
const jsonContentSchema = z.object({
  'application/json': z.object({ schema: schemaReferenceSchema }),
});
const operationResponseSchema = z.object({
  description: z.string().min(1),
  content: jsonContentSchema,
  headers: z.record(z.object({ schema: z.record(z.unknown()), description: z.string().min(1) })).optional(),
});
const operationSchema = z.object({
  operationId: z.string().min(1),
  security: z.tuple([]),
  'x-somnibot-body-credential': z.literal('license_key'),
  requestBody: z.object({ required: z.literal(true), content: jsonContentSchema }),
  responses: z.record(operationResponseSchema),
});

const staticAuthorizationOperationSchema = z.object({
  operationId: z.literal('authorizeStaticDownload'),
  security: z.tuple([z.object({ PortalToken: z.tuple([]) })]),
  requestBody: z.object({ required: z.literal(true), content: jsonContentSchema }),
  responses: z.record(operationResponseSchema),
});

const staticDownloadOperationSchema = z.object({
  operationId: z.literal('deliverStaticDerivative'),
  security: z.tuple([]),
  parameters: z.array(z.record(z.unknown())),
  responses: z.record(z.object({
    description: z.string().min(1),
    content: z.record(z.object({ schema: z.record(z.unknown()) })).optional(),
    headers: z.record(z.object({ schema: z.record(z.unknown()), description: z.string().min(1) })).optional(),
  })),
});

const openApiBaseShape = {
  openapi: z.literal('3.1.0'),
  info: z.object({ title: z.string().min(1), version: z.literal('2.0.0') }),
  servers: z.array(z.object({ url: z.string().min(1) })),
} as const;

const openApiComponentsSchema = z.object({
  securitySchemes: z.record(z.record(z.unknown())).optional(),
  schemas: z.record(z.record(z.unknown())),
});

const runtimeLicenseApiOpenApiSchema = z.object({
  ...openApiBaseShape,
  'x-somnibot-protocol-kind': z.literal('runtime_licensing'),
  paths: z.object({
    '/license/validate': z.object({ post: operationSchema }),
    '/license/heartbeat': z.object({ post: operationSchema }),
    '/license/deactivate': z.object({ post: operationSchema }),
  }).strict(),
  components: openApiComponentsSchema,
});

const staticLicenseApiOpenApiSchema = z.object({
  ...openApiBaseShape,
  'x-somnibot-protocol-kind': z.literal('static_delivery'),
  paths: z.object({
    '/api/portal/download-link': z.object({ post: staticAuthorizationOperationSchema }),
    '/api/downloads/{productId}/{fileId}': z.object({ get: staticDownloadOperationSchema }),
  }).strict(),
  components: z.object({
    securitySchemes: z.record(z.record(z.unknown())).optional(),
    schemas: z.record(z.record(z.unknown())),
  }),
});

export const licenseApiOpenApiSchema = z.discriminatedUnion('x-somnibot-protocol-kind', [
  runtimeLicenseApiOpenApiSchema,
  staticLicenseApiOpenApiSchema,
]);

export type LicenseApiOpenApi = z.infer<typeof licenseApiOpenApiSchema>;

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schema: string) {
  return {
    description,
    content: { 'application/json': { schema: schemaRef(schema) } },
  };
}

function rateLimitedResponse(schema: string) {
  return {
    ...jsonResponse('Rate limited; honor Retry-After without clearing a prior valid cache.', schema),
    headers: {
      'Retry-After': {
        description: 'Whole seconds to wait before retrying.',
        schema: { type: 'integer', minimum: 0 },
      },
    },
  };
}

function operation(operationId: string, request: string, response: string, badRequestResponse: string) {
  return {
    operationId,
    security: [],
    'x-somnibot-body-credential': 'license_key',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: schemaRef(request) } },
    },
    responses: {
      '200': jsonResponse('Authoritative operation result.', response),
      '400': jsonResponse('Malformed request or terminal client verdict.', badRequestResponse),
      '429': rateLimitedResponse(response),
      '503': jsonResponse('Status indeterminate; retry without inventing a verdict.', response),
    },
  };
}

export function buildLicenseApiOpenApi(
  apiBase: string,
  statuses: readonly string[],
  mode: 'dynamic' | 'static' = 'dynamic',
): LicenseApiOpenApi {
  if (mode === 'static') {
    return licenseApiOpenApiSchema.parse(buildStaticDeliveryOpenApiDocument(apiBase));
  }
  return licenseApiOpenApiSchema.parse({
    openapi: '3.1.0',
    info: { title: 'SomniBot License API', version: '2.0.0' },
    servers: [{ url: apiBase }],
    'x-somnibot-protocol-kind': 'runtime_licensing',
    paths: {
      '/license/validate': { post: operation('validateLicense', 'ValidationRequest', 'ValidationResponse', 'ValidationOrApiErrorResponse') },
      '/license/heartbeat': { post: operation('heartbeatLicense', 'HeartbeatRequest', 'HeartbeatResponse', 'HeartbeatOrApiErrorResponse') },
      '/license/deactivate': { post: operation('deactivateLicense', 'DeactivateRequest', 'DeactivateResponse', 'DeactivateOrApiErrorResponse') },
    },
    components: {
      schemas: {
        LicenseStatus: { type: 'string', enum: statuses },
        ValidationRequest: {
          type: 'object', additionalProperties: false, required: ['license_key', 'product_id'],
          properties: {
            license_key: { type: 'string', minLength: 1, maxLength: 512, description: 'Customer credential; JSON body only and never logged.' },
            product_id: { type: 'string', format: 'uuid' },
            device_fingerprint: { type: 'string', minLength: 1, maxLength: 256 },
            device_name: { type: 'string', maxLength: 128 },
            app_version: { type: 'string', maxLength: 32 },
          },
        },
        ValidationResponse: {
          oneOf: [schemaRef('ValidationLiveResponse'), schemaRef('ValidationTerminalResponse'), schemaRef('IndeterminateResponse')],
          discriminator: { propertyName: 'status' },
        },
        ValidationLiveResponse: {
          type: 'object', additionalProperties: false,
          required: [
            'valid', 'status', 'entitlement_id', 'features', 'tier', 'expires_at', 'grace_period_ends_at',
            'session_id', 'heartbeat_interval_seconds', 'sdk_cache_ttl_ms', 'offline_grace_period_seconds',
            'require_discord_guild_membership', 'license_mode',
          ],
          properties: {
            valid: { const: true }, status: { enum: ['active', 'grace_period'] },
            entitlement_id: { type: 'string', format: 'uuid' }, features: { type: 'array', items: { type: 'string' } },
            tier: { type: ['string', 'null'] }, session_id: { type: ['string', 'null'], format: 'uuid' },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
            grace_period_ends_at: { type: ['string', 'null'], format: 'date-time' },
            heartbeat_interval_seconds: { type: 'integer', minimum: 0 }, sdk_cache_ttl_ms: { type: 'integer', minimum: 1000 },
            offline_grace_period_seconds: { type: 'integer', minimum: 0 },
            require_discord_guild_membership: { type: 'boolean' }, license_mode: { type: 'string' }, error: { type: 'string' },
          },
        },
        ValidationTerminalResponse: {
          type: 'object', additionalProperties: false, required: ['valid', 'status'],
          properties: {
            valid: { const: false },
            status: {
              enum: [
                'pending_activation', 'pending', 'device_fingerprint_required', 'over_device_limit',
                'guild_membership_required', 'suspended', 'expired', 'revoked', 'cancelled',
                'session_invalidated',
              ],
            },
            error: { type: 'string' }, active_devices: { type: 'integer', minimum: 0 },
            max_devices: { type: 'integer', minimum: 1 }, evicted: { type: 'boolean' },
          },
        },
        IndeterminateResponse: {
          type: 'object', additionalProperties: false, required: ['valid', 'status'],
          properties: {
            valid: { const: false }, status: { enum: ['service_unavailable', 'rate_limited'] },
            retryable: { type: 'boolean' }, error: { type: 'string' }, next_heartbeat_seconds: { type: 'integer', minimum: 0 },
          },
        },
        ApiErrorResponse: {
          type: 'object', additionalProperties: false, required: ['success', 'error'],
          properties: {
            success: { const: false }, error: { type: 'string' },
            details: {
              type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['path', 'message'],
                properties: { path: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
        ValidationOrApiErrorResponse: {
          oneOf: [schemaRef('ValidationResponse'), schemaRef('ApiErrorResponse')],
        },
        HeartbeatRequest: {
          type: 'object', additionalProperties: false, required: ['license_key', 'session_id'],
          properties: { license_key: { type: 'string', minLength: 1, maxLength: 512 }, session_id: { type: 'string', format: 'uuid' } },
        },
        HeartbeatResponse: {
          oneOf: [schemaRef('HeartbeatLiveResponse'), schemaRef('HeartbeatTerminalResponse'), schemaRef('IndeterminateResponse')],
          discriminator: { propertyName: 'status' },
        },
        HeartbeatLiveResponse: {
          type: 'object', additionalProperties: false,
          required: ['valid', 'status', 'grace_period_ends_at', 'next_heartbeat_seconds'],
          properties: {
            valid: { const: true }, status: { enum: ['active', 'grace_period'] },
            grace_period_ends_at: { type: ['string', 'null'], format: 'date-time' },
            next_heartbeat_seconds: { type: 'integer', minimum: 0 },
          },
        },
        HeartbeatTerminalResponse: {
          type: 'object', additionalProperties: false, required: ['valid', 'status', 'next_heartbeat_seconds'],
          properties: {
            valid: { const: false },
            status: { enum: ['pending_activation', 'pending', 'suspended', 'expired', 'revoked', 'cancelled', 'session_invalidated'] },
            next_heartbeat_seconds: { const: 0 }, error: { type: 'string' },
          },
        },
        HeartbeatOrApiErrorResponse: {
          oneOf: [schemaRef('HeartbeatResponse'), schemaRef('ApiErrorResponse')],
        },
        DeactivateRequest: {
          type: 'object', additionalProperties: false, required: ['license_key', 'session_id'],
          properties: { license_key: { type: 'string', minLength: 1, maxLength: 512 }, session_id: { type: 'string', format: 'uuid' } },
        },
        DeactivateResponse: {
          type: 'object', additionalProperties: false, required: ['success'],
          properties: { success: { type: 'boolean' }, error: { type: 'string' } },
        },
        DeactivateOrApiErrorResponse: {
          oneOf: [schemaRef('DeactivateResponse'), schemaRef('ApiErrorResponse')],
        },
      },
    },
  });
}
