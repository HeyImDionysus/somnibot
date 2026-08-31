import { z } from 'zod';
import { OperationSourceSchema } from './contract.js';

export const SURFACE_CAPABILITIES = [
  'installation',
  'credentials',
  'deployment',
  'service_lifecycle',
  'configuration',
  'staff_operations',
  'commerce_operations',
  'community_behavior',
  'immediate_staff_action',
  'customer_self_service',
  'agent_contract',
] as const;

export const SurfaceCapabilitySchema = z.enum(SURFACE_CAPABILITIES);
export type SurfaceCapability = z.infer<typeof SurfaceCapabilitySchema>;

export const SurfaceAuthorityDefinitionSchema = z.object({
  capability: SurfaceCapabilitySchema,
  authority: OperationSourceSchema,
  allowedSources: z.array(OperationSourceSchema).min(1),
});
export type SurfaceAuthorityDefinition = z.infer<typeof SurfaceAuthorityDefinitionSchema>;

const SURFACE_AUTHORITY: Readonly<Record<SurfaceCapability, SurfaceAuthorityDefinition>> = {
  installation: { capability: 'installation', authority: 'launcher', allowedSources: ['launcher'] },
  credentials: { capability: 'credentials', authority: 'launcher', allowedSources: ['launcher'] },
  deployment: { capability: 'deployment', authority: 'launcher', allowedSources: ['launcher'] },
  service_lifecycle: { capability: 'service_lifecycle', authority: 'launcher', allowedSources: ['launcher'] },
  configuration: { capability: 'configuration', authority: 'dashboard', allowedSources: ['dashboard'] },
  staff_operations: { capability: 'staff_operations', authority: 'dashboard', allowedSources: ['dashboard', 'discord'] },
  commerce_operations: { capability: 'commerce_operations', authority: 'dashboard', allowedSources: ['dashboard', 'system'] },
  community_behavior: { capability: 'community_behavior', authority: 'discord', allowedSources: ['discord'] },
  immediate_staff_action: { capability: 'immediate_staff_action', authority: 'discord', allowedSources: ['discord'] },
  customer_self_service: { capability: 'customer_self_service', authority: 'portal', allowedSources: ['portal', 'system'] },
  agent_contract: { capability: 'agent_contract', authority: 'sdk', allowedSources: ['sdk', 'dashboard'] },
};

export class SurfaceAuthorityError extends Error {
  readonly name = 'SurfaceAuthorityError';

  constructor(
    readonly capability: SurfaceCapability,
    readonly source: z.infer<typeof OperationSourceSchema>,
    readonly authority: z.infer<typeof OperationSourceSchema>,
  ) {
    super(`${source} cannot own ${capability}; ${authority} is authoritative`);
  }
}

export function surfaceAuthorityFor(capability: SurfaceCapability): SurfaceAuthorityDefinition {
  return SurfaceAuthorityDefinitionSchema.parse(SURFACE_AUTHORITY[capability]);
}

export function assertSurfaceAuthority(
  capability: SurfaceCapability,
  source: z.infer<typeof OperationSourceSchema>,
): SurfaceAuthorityDefinition {
  const definition = surfaceAuthorityFor(capability);
  if (!definition.allowedSources.includes(source)) {
    throw new SurfaceAuthorityError(capability, source, definition.authority);
  }
  return definition;
}
