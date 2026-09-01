import { describe, expect, it } from 'vitest';
import { claimLaunchFree, withLaunchFixture, type LaunchFixture, type LaunchTransaction } from './commerce-launch-fixtures.js';

async function prepareProof(tx: LaunchTransaction, fixture: LaunchFixture): Promise<void> {
  await tx`INSERT INTO public.guild_config(guild_id) VALUES (${fixture.guildId}) ON CONFLICT DO NOTHING`;
  if (fixture.kind === 'free') await claimLaunchFree(tx, fixture);
  await tx`SELECT public.commerce_verify_product_launch(
    ${fixture.guildId},${fixture.ownerId},${fixture.runId}::uuid,launch.version,product.updated_at,NULL::timestamptz,
    stages.value,jsonb_build_object('operation_id',launch.operation_id,'product_id',product.id,
      'product_revision',product.updated_at,'policy_revision',NULL,'verification_started_at',launch.verification_started_at,
      'environment','sandbox','stages',stages.value),${'a'.repeat(64)},true)
    FROM public.commerce_product_launch_runs AS launch JOIN public.products AS product ON product.id=launch.product_id
    CROSS JOIN LATERAL (SELECT jsonb_build_object('product','verified','policy','verified','pricing','verified','integration','verified',
      'sandbox_transaction',CASE WHEN product.type='free' THEN 'not_applicable' ELSE 'verified' END,
      'webhook',CASE WHEN product.type='free' THEN 'not_applicable' ELSE 'verified' END,
      'entitlement','verified','fulfillment','verified','reversal',CASE WHEN product.type='free' THEN 'not_applicable' ELSE 'verified' END) AS value) AS stages
    WHERE launch.id=${fixture.runId}`;
}

async function context(tx: LaunchTransaction, fixture: LaunchFixture): Promise<Record<string, unknown>> {
  const [row] = await tx<{ value: Record<string, unknown> }[]>`SELECT jsonb_build_object(
    'productId',id,'productRevision',updated_at,'policyRevision',NULL,'integrationVerified',true,'requiresSdk',false,'origin',NULL,
    'storeRevision',(SELECT revision FROM public.dashboard_adoption_config_epochs WHERE guild_id=${fixture.guildId} AND track_id='store'),
    'licensingRevision',(SELECT revision FROM public.dashboard_adoption_config_epochs WHERE guild_id=${fixture.guildId} AND track_id='licensing')) AS value
    FROM public.products WHERE id=${fixture.productId}`;
  if (!row) throw new TypeError('Missing launch product fixture');
  return row.value;
}

describe('real database adoption reuse of authoritative commerce launch records', () => {
  it.each(['free','one_time'] as const)('accepts a current %s launch in ready and correctly activated live states', async (kind) => {
    await withLaunchFixture(kind, async (tx, fixture) => {
      await prepareProof(tx, fixture);
      const before = await context(tx, fixture);
      const [ready] = await tx<{ value: { id: string } | null }[]>`SELECT public.adoption_current_launch_proof(${fixture.guildId},'-infinity'::timestamptz,${JSON.stringify(before)}::jsonb) AS value`;
      expect(ready?.value?.id).toBe(fixture.runId);
      await tx`UPDATE public.products SET active=true WHERE id=${fixture.productId}`;
      const current = await context(tx, fixture);
      const [live] = await tx<{ value: { id: string } | null }[]>`SELECT public.adoption_current_launch_proof(${fixture.guildId},'-infinity'::timestamptz,${JSON.stringify(current)}::jsonb) AS value`;
      expect(live?.value?.id).toBe(fixture.runId);
    });
  });
  it('rejects a product revision/epoch race after the server derived integration context', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      await prepareProof(tx, fixture);
      const before = await context(tx, fixture);
      await tx`UPDATE public.products SET name='Changed after signature verification' WHERE id=${fixture.productId}`;
      const [row] = await tx<{ value: unknown }[]>`SELECT public.adoption_current_launch_proof(${fixture.guildId},'-infinity'::timestamptz,${JSON.stringify(before)}::jsonb) AS value`;
      expect(row?.value).toBeNull();
    });
  });
  it('rejects stale server context after the cryptographic verifier changes to false', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      await prepareProof(tx, fixture);
      const current = { ...await context(tx, fixture), integrationVerified: false };
      const [row] = await tx<{ value: unknown }[]>`SELECT public.adoption_current_launch_proof(${fixture.guildId},'-infinity'::timestamptz,${JSON.stringify(current)}::jsonb) AS value`;
      expect(row?.value).toBeNull();
    });
  });
});
