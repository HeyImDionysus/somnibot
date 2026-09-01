import { z } from 'zod';

const capabilityKeySchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'Use a stable lowercase capability key');

const licensingGrantingPlanSchema = z.object({
  key: capabilityKeySchema,
  name: z.string().trim().min(1).max(100),
  planId: z.string().uuid().optional(),
}).strict();

export const licensingCapabilitySchema = z.object({
  key: capabilityKeySchema,
  name: z.string().trim().min(1).max(100),
  behavioralMeaning: z.string().trim().min(1).max(1000),
  controlledFunctionality: z.string().trim().min(1).max(2000),
  grantingPlans: z.array(licensingGrantingPlanSchema).max(50).default([]),
  unavailableBehavior: z.string().trim().min(1).max(1000),
  dependencyKeys: z.array(capabilityKeySchema).max(50).default([]),
}).strict().superRefine((capability, context) => {
  if (new Set(capability.grantingPlans.map((plan) => plan.key)).size !== capability.grantingPlans.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['grantingPlans'],
      message: 'Granting plan keys must be unique within a capability',
    });
  }
  const planNames = capability.grantingPlans.map((plan) => plan.name.toLocaleLowerCase());
  if (new Set(planNames).size !== planNames.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['grantingPlans'],
      message: 'Granting plan names must be unique within a capability',
    });
  }
  const planIds = capability.grantingPlans.flatMap((plan) => plan.planId ? [plan.planId] : []);
  if (new Set(planIds).size !== planIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['grantingPlans'],
      message: 'Authoritative granting plan IDs must be unique within a capability',
    });
  }
  if (new Set(capability.dependencyKeys).size !== capability.dependencyKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dependencyKeys'],
      message: 'Dependency keys must be unique within a capability',
    });
  }
});

export const licensingCapabilitiesSchema = z.array(licensingCapabilitySchema).max(100)
  .superRefine((capabilities, context) => {
    const keys = capabilities.map((capability) => capability.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Capability keys must be unique',
      });
    }
    const knownKeys = new Set(keys);
    capabilities.forEach((capability, index) => {
      capability.dependencyKeys.forEach((dependencyKey) => {
        if (dependencyKey === capability.key) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'dependencyKeys'],
            message: 'A capability cannot depend on itself',
          });
        } else if (!knownKeys.has(dependencyKey)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'dependencyKeys'],
            message: `Unknown capability dependency: ${dependencyKey}`,
          });
        }
      });
    });

    const byKey = new Map(capabilities.map((capability) => [capability.key, capability]));
    const state = new Map<string, 'visiting' | 'visited'>();
    const visit = (key: string): void => {
      if (state.get(key) === 'visited') return;
      if (state.get(key) === 'visiting') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability dependency cycle includes ${key}`,
        });
        return;
      }
      const capability = byKey.get(key);
      if (!capability) return;
      state.set(key, 'visiting');
      capability.dependencyKeys.forEach(visit);
      state.set(key, 'visited');
    };
    keys.forEach(visit);
  });

export type LicensingCapability = z.infer<typeof licensingCapabilitySchema>;

export function normalizeLicensingCapabilities(
  featureFlags: readonly string[],
  capabilities?: readonly LicensingCapability[],
): LicensingCapability[] {
  if (capabilities !== undefined) return licensingCapabilitiesSchema.parse(capabilities);
  void featureFlags;
  return [];
}
