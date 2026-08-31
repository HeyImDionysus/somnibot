import type { createAdminSupabase } from '@/lib/supabase/admin';
import type {
  LaunchStageKey,
  LaunchStageState,
} from '@/lib/store/commerce-operations';

type LaunchAuditInput = {
  readonly guildId: string;
  readonly actorId: string;
  readonly action: string;
  readonly productId: string;
  readonly operationId: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export function defaultLaunchStages(): Record<LaunchStageKey, LaunchStageState> {
  return {
    product: 'pending',
    policy: 'pending',
    pricing: 'pending',
    integration: 'pending',
    sandbox_transaction: 'pending',
    webhook: 'pending',
    entitlement: 'pending',
    fulfillment: 'pending',
    reversal: 'pending',
  };
}

export async function writeLaunchAudit(
  admin: ReturnType<typeof createAdminSupabase>,
  input: LaunchAuditInput,
) {
  return admin.from('audit_logs').insert({
    guild_id: input.guildId,
    actor_type: 'user',
    actor_id: input.actorId,
    action: input.action,
    target_type: 'product',
    target_id: input.productId,
    details: { operation_id: input.operationId, ...input.details },
  });
}
