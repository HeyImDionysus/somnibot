import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withLaunchFixture, type LaunchTransaction } from './commerce-launch-fixtures.js';

async function productRevision(tx: LaunchTransaction, productId: string): Promise<string> {
  const [product] = await tx<{ revision: string }[]>`
    SELECT updated_at::text AS revision FROM public.products WHERE id = ${productId}
  `;
  if (!product) throw new Error('Product revision fixture is missing');
  return product.revision;
}

describe('real database material launch contract revisions', () => {
  it('advances file revisions for content changes and removal but not download analytics', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const fileId = randomUUID();
      const original = await productRevision(tx, fixture.productId);

      await tx`INSERT INTO public.product_files (id, product_id, guild_id, name, storage_path)
        VALUES (${fileId}, ${fixture.productId}, ${fixture.guildId}, 'Launch artifact', 'launch/original.zip')`;
      const inserted = await productRevision(tx, fixture.productId);
      expect(inserted).not.toBe(original);

      await tx`UPDATE public.product_files SET download_count = download_count + 1 WHERE id = ${fileId}`;
      expect(await productRevision(tx, fixture.productId)).toBe(inserted);

      await tx`UPDATE public.product_files SET storage_path = 'launch/replaced.zip', version = '2.0.0' WHERE id = ${fileId}`;
      const replaced = await productRevision(tx, fixture.productId);
      expect(replaced).not.toBe(inserted);

      await tx`DELETE FROM public.product_files WHERE id = ${fileId}`;
      expect(await productRevision(tx, fixture.productId)).not.toBe(replaced);
    });
  });

  it('invalidates old readiness after a same-transaction file replacement', async () => {
    await withLaunchFixture('free', async (tx, fixture) => {
      const fileId = randomUUID();
      await tx`INSERT INTO public.product_files (id, product_id, guild_id, name, storage_path)
        VALUES (${fileId}, ${fixture.productId}, ${fixture.guildId}, 'Launch artifact', 'launch/original.zip')`;
      const revision = await productRevision(tx, fixture.productId);
      await tx`UPDATE public.commerce_product_launch_runs
        SET state = 'ready', launch_receipt_hash = ${'a'.repeat(64)},
          launch_receipt = pg_catalog.jsonb_build_object('product_revision', ${revision}::text, 'policy_revision', NULL)
        WHERE id = ${fixture.runId}`;

      await tx`UPDATE public.product_files SET storage_path = 'launch/replaced.zip' WHERE id = ${fileId}`;

      await expect(tx.savepoint((savepoint) => savepoint`
        UPDATE public.products SET active = true WHERE id = ${fixture.productId}
      `)).rejects.toMatchObject({ code: '23514', message: 'product launch evidence is stale' });
      const [product] = await tx<{ active: boolean }[]>`SELECT active FROM public.products WHERE id = ${fixture.productId}`;
      expect(product?.active).toBe(false);
    });
  });

  it('advances subscription pricing contract revisions without relying on a new transaction clock', async () => {
    await withLaunchFixture('subscription', async (tx, fixture) => {
      const original = await productRevision(tx, fixture.productId);

      await tx`UPDATE public.plans SET price_cents = 750 WHERE id = ${fixture.planId}`;
      const repriced = await productRevision(tx, fixture.productId);

      expect(repriced).not.toBe(original);
      await tx`UPDATE public.plans SET updated_at = clock_timestamp() WHERE id = ${fixture.planId}`;
      expect(await productRevision(tx, fixture.productId)).toBe(repriced);
    });
  });
});
