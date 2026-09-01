import { z } from 'zod';
import { licenseApiOpenApiSchema } from './licensing-sdk-openapi';
import { sdkConfigSchema } from './licensing-sdk-protocol';

const BUNDLE_START = '<SOMNIBOT_SDK_BUNDLE>';
const BUNDLE_END = '</SOMNIBOT_SDK_BUNDLE>';

const bundleFileSchema = <Schema extends z.ZodTypeAny>(mediaType: string, content: Schema) => z.object({
  mediaType: z.literal(mediaType),
  content,
});

export const licensingSdkBundleSchema = z.object({
  bundleVersion: z.literal(1),
  protocolVersion: z.literal(2),
  contractIdentity: z.object({
    algorithm: z.literal('sha256'),
    canonicalization: z.literal('sorted-json-utf8-v1'),
    value: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  trustHierarchy: z.tuple([
    z.object({ rank: z.literal(1), authority: z.literal('somnibot_protocol') }),
    z.object({ rank: z.literal(2), authority: z.literal('saved_store_policy') }),
    z.object({ rank: z.literal(3), authority: z.literal('owner_configuration') }),
    z.object({ rank: z.literal(4), authority: z.literal('repository_facts') }),
  ]),
  externalDependencies: z.tuple([]),
  files: z.object({
    'somnibot-sdk.json': bundleFileSchema('application/json', sdkConfigSchema),
    'AGENT.md': bundleFileSchema('text/markdown', z.string().min(1)),
    'license-api.openapi.json': bundleFileSchema('application/vnd.oai.openapi+json', licenseApiOpenApiSchema),
    'CONFORMANCE.md': bundleFileSchema('text/markdown', z.string().min(1)),
  }),
});

export type LicensingSdkBundle = z.infer<typeof licensingSdkBundleSchema>;

export class LicensingSdkBundleError extends Error {
  readonly code = 'LICENSING_SDK_BUNDLE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'LicensingSdkBundleError';
  }
}

export function renderLicensingSdkBundle(bundle: LicensingSdkBundle): string {
  return `${BUNDLE_START}\n${JSON.stringify(bundle, null, 2)}\n${BUNDLE_END}`;
}

export function extractLicensingSdkBundle(prompt: string): LicensingSdkBundle {
  const start = prompt.indexOf(BUNDLE_START);
  const end = prompt.indexOf(BUNDLE_END);
  if (start < 0 || end <= start) {
    throw new LicensingSdkBundleError('The prompt does not contain a complete SomniBot SDK bundle.');
  }
  const json = prompt.slice(start + BUNDLE_START.length, end).trim();
  try {
    return licensingSdkBundleSchema.parse(JSON.parse(json));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new LicensingSdkBundleError('The SomniBot SDK bundle is invalid.');
    }
    throw error;
  }
}
