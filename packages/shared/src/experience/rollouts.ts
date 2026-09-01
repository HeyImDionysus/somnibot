import { z } from 'zod';

export const RolloutStateSchema = z.enum([
  'internal',
  'sandbox',
  'selected_deployment',
  'selected_guild',
  'general_availability',
  'emergency_disabled',
  'maintenance_paused',
  'retired',
]);

export const RolloutPolicySchema = z.object({
  state: RolloutStateSchema,
  guildIds: z.array(z.string().trim().min(1)),
  deploymentIds: z.array(z.string().trim().min(1)),
}).strict();

export type RolloutPolicy = z.infer<typeof RolloutPolicySchema>;
export type RolloutContext = {
  readonly guildId: string;
  readonly deploymentId: string;
  readonly internal?: boolean;
  readonly sandbox?: boolean;
};

export type RolloutDecision = {
  readonly enabled: boolean;
  readonly reason: z.infer<typeof RolloutStateSchema>;
};

export function evaluateRollout(policyInput: RolloutPolicy, context: RolloutContext): RolloutDecision {
  const policy = RolloutPolicySchema.parse(policyInput);
  switch (policy.state) {
    case 'internal':
      return { enabled: context.internal === true, reason: policy.state };
    case 'sandbox':
      return { enabled: context.sandbox === true, reason: policy.state };
    case 'selected_deployment':
      return { enabled: policy.deploymentIds.includes(context.deploymentId), reason: policy.state };
    case 'selected_guild':
      return { enabled: policy.guildIds.includes(context.guildId), reason: policy.state };
    case 'general_availability':
      return { enabled: true, reason: policy.state };
    case 'emergency_disabled':
    case 'maintenance_paused':
    case 'retired':
      return { enabled: false, reason: policy.state };
  }
}
