/**
 * License key generation + fulfillment queue helper.
 *
 * V5 Audit §2.P3a: Extracted from the monolithic route.ts for maintainability.
 */

import { createHash, randomBytes } from 'crypto';
import { createAdminSupabase } from '@/lib/supabase/admin';

/**
 * Generate a SMNI-XXXX-XXXX-XXXX-XXXX license key with its SHA-256 hash.
 */
export function generateLicenseKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
  suffix: string;
} {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += charset[bytes[g * 4 + i]! % charset.length];
    }
    groups.push(group);
  }
  const plaintext = `SMNI-${groups.join('-')}`;
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix: 'SMNI', suffix: groups[3]! };
}

/**
 * Queue a fulfillment action for the bot process to pick up.
 * The bot has Discord access + event bus; this route does not.
 */
export async function queueFulfillment(
  supabase: ReturnType<typeof createAdminSupabase>,
  action: string,
  guildId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from('bot_action_queue').insert({
    guild_id: guildId,
    action,
    payload,
    status: 'pending',
  });

  if (error) {
    console.error(`[Webhook] Failed to queue ${action}:`, error.message);
    return false;
  }
  return true;
}
