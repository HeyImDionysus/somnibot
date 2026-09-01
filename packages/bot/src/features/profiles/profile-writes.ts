import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { writeAuditLog } from '../../services/audit.js';

const profileWriteRpcResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('applied') }),
  z.object({
    outcome: z.literal('replayed'),
    originalOutcome: z.enum(['applied', 'denied']),
  }),
  z.object({
    outcome: z.literal('denied'),
    reason: z.enum(['actor_target_mismatch', 'interaction_identity_mismatch']),
  }),
]);

export type ProfileWriteInput = {
  readonly guildId: string;
  readonly interactionId: string;
  readonly actorId: string;
  readonly targetId: string;
  readonly field: 'title' | 'bio';
  readonly value: string;
  readonly truncated: boolean;
};

export type ProfileWriteOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'replayed'; readonly originalOutcome: 'applied' | 'denied' }
  | {
      readonly kind: 'denied';
      readonly reason: 'actor_target_mismatch' | 'interaction_identity_mismatch';
    }
  | { readonly kind: 'unavailable' };

export class ProfileWrites {
  constructor(private readonly supabase: SupabaseClient) {}

  async apply(input: ProfileWriteInput): Promise<ProfileWriteOutcome> {
    const params = {
      p_guild_id: input.guildId,
      p_interaction_id: input.interactionId,
      p_actor_id: input.actorId,
      p_target_id: input.targetId,
      p_field: input.field,
      p_value: input.value,
      p_truncated: input.truncated,
    };
    let { data, error } = await this.supabase.rpc('apply_profile_write_atomic', params);
    let retried = false;
    if (error) {
      retried = true;
      await writeAuditLog(this.supabase, {
        guildId: input.guildId,
        actorType: 'system',
        actorId: 'profiles',
        action: 'profiles.write_retried',
        category: 'profiles',
        targetType: 'member',
        targetId: input.targetId,
        details: { field: input.field, interactionId: input.interactionId },
        success: false,
        errorMessage: error.message,
        occurrenceKey: `profiles.write_retried:${input.interactionId}`,
        correlationId: `profile:${input.guildId}:${input.targetId}`,
      });
      ({ data, error } = await this.supabase.rpc('apply_profile_write_atomic', params));
    }
    if (error) return { kind: 'unavailable' };

    const parsed = profileWriteRpcResultSchema.safeParse(data);
    if (!parsed.success) return { kind: 'unavailable' };

    switch (parsed.data.outcome) {
      case 'applied':
        return { kind: 'applied' };
      case 'replayed':
        if (retried && parsed.data.originalOutcome === 'applied') return { kind: 'applied' };
        return { kind: 'replayed', originalOutcome: parsed.data.originalOutcome };
      case 'denied':
        return { kind: 'denied', reason: parsed.data.reason };
    }
  }
}
