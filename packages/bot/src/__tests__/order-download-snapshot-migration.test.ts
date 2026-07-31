import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../supabase/migrations/20260731041000_final_exact_head_review_fixes.sql',
  ),
  'utf8',
);

describe('order download snapshot migration', () => {
  it('does not infer historical mixed-order requirements from the mutable current catalog', () => {
    const backfill = migration.slice(
      migration.indexOf('UPDATE public.orders AS sold_order'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.commerce_freeze_order_download_requirement'),
    );

    expect(backfill).toContain(
      "WHEN sold_order.delivery_type_snapshot = 'mixed' THEN NULL",
    );
    expect(backfill).not.toContain('public.product_files');
  });

  it('still freezes new checkout rows from order-time product evidence', () => {
    const trigger = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.commerce_freeze_order_download_requirement'),
    );

    expect(trigger).toContain("WHEN NEW.delivery_type_snapshot = 'mixed' THEN EXISTS");
    expect(trigger).toContain('FROM public.product_files AS product_file');
  });
});
