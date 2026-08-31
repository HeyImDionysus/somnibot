import type { SupabaseClient } from '@supabase/supabase-js';
import type { ButtonInteraction } from 'discord.js';
import { z } from 'zod';

const LAUNCH_BUTTON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const launchRunSchema = z.object({
  id: z.string().uuid(),
  verification_started_at: z.string().datetime({ offset: true }),
});

type LaunchTestContext = {
  readonly runId: string;
  readonly productId: string;
};

type LaunchTestIdentity = LaunchTestContext & { readonly guildId: string };
type AuthorizedLaunchTest = LaunchTestIdentity & { readonly verificationStartedAt: string };

export function parseLaunchTestButton(customId: string, action: 'buy' | 'claim'): LaunchTestContext | null {
  const prefix = `store:launch-${action}:`;
  if (!customId.startsWith(prefix)) return null;
  const [runId, productId, extra] = customId.slice(prefix.length).split(':');
  if (extra !== undefined || !runId || !productId
    || !LAUNCH_BUTTON_UUID.test(runId) || !LAUNCH_BUTTON_UUID.test(productId)) return null;
  return { runId, productId };
}

export async function authorizeLaunchTest(
  interaction: ButtonInteraction,
  supabase: SupabaseClient,
  context: LaunchTestIdentity,
): Promise<AuthorizedLaunchTest | null> {
  if (interaction.guild?.ownerId !== interaction.user.id) return null;
  const { data, error } = await supabase
    .from('commerce_product_launch_runs')
    .select('id, verification_started_at')
    .eq('id', context.runId)
    .eq('guild_id', context.guildId)
    .eq('product_id', context.productId)
    .eq('created_by', interaction.user.id)
    .eq('environment', 'sandbox')
    .in('state', ['draft', 'sandbox_verifying', 'ready'])
    .maybeSingle();
  if (error) return null;
  const run = launchRunSchema.safeParse(data);
  if (!run.success || run.data.id !== context.runId) return null;
  return { ...context, verificationStartedAt: run.data.verification_started_at };
}
