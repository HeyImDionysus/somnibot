/**
 * Licence-delivery rail — a `license_key` product must be able to deliver a key.
 *
 * Finding 6. The capture webhook mints a key only when a `product_license_config`
 * row exists for the product:
 *
 *     const license = licenseConfig ? generateLicenseKey() : null;
 *     (app/api/paypal/webhook/handlers.ts)
 *
 * A product with `delivery_type = 'license_key'` and no config row therefore
 * charged the customer, granted the entitlement and roles, and delivered
 * nothing — the receipt DM rendered a null licence key.
 *
 * The authoritative rail is the database trigger added in
 * `20260727040000_license_delivery_requires_config.sql`, which auto-provisions
 * the config for ANY writer (dashboard, bot, seed, manual SQL). The helper here
 * is the store-route's verification of that rail: it confirms the config really
 * landed for the product this request just wrote and, if it somehow did not,
 * deactivates the product so it can never be sold in the broken state.
 *
 * Deactivate rather than delete: `products` are soft-deleted everywhere else in
 * commerce to preserve entitlement history, and an inactive product is not
 * purchasable (checkout selects `.eq('active', true)`).
 */
import type { createAdminSupabase } from '@/lib/supabase/admin';

type AdminSupabase = ReturnType<typeof createAdminSupabase>;

/** The one delivery type whose fulfilment depends on `product_license_config`. */
export const LICENSE_KEY_DELIVERY_TYPE = 'license_key';

/** True when the product's delivery promise is a licence key. */
export function requiresLicenseConfig(deliveryType: unknown): boolean {
  return deliveryType === LICENSE_KEY_DELIVERY_TYPE;
}

export const LICENSE_CONFIG_RAIL_MESSAGE =
  'Licence settings could not be created for this licence-key product, so it '
  + 'would have taken payment without delivering a key. The product has been '
  + 'deactivated — please try again.';

export type LicenseDeliveryRailResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Guarantee the product has a `product_license_config` row, or make it unsellable.
 *
 * Idempotent: the insert is a no-op when the trigger already provisioned the row
 * (and when this runs twice for the same product).
 */
export async function ensureLicenseDeliveryConfigOrDisable(
  supabase: AdminSupabase,
  guildId: string,
  productId: string,
): Promise<LicenseDeliveryRailResult> {
  const { error: insertError } = await supabase
    .from('product_license_config')
    .upsert({ product_id: productId }, { onConflict: 'product_id', ignoreDuplicates: true });

  // A duplicate is the expected outcome once the DB trigger has run; anything
  // else is only a warning here because the read below is the real verdict.
  if (insertError && insertError.code !== '23505') {
    console.warn(
      '[store/products] licence config provisioning returned an error:',
      insertError.message,
    );
  }

  const { data: config, error: readError } = await supabase
    .from('product_license_config')
    .select('product_id')
    .eq('product_id', productId)
    .maybeSingle();

  if (!readError && config) return { ok: true };

  if (readError) {
    console.error(
      '[store/products] licence config verification failed:',
      readError.message,
    );
  }

  // Cannot prove the product can deliver a key — take it off sale.
  const { error: disableError } = await supabase
    .from('products')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('guild_id', guildId);

  if (disableError) {
    console.error(
      '[store/products] failed to deactivate undeliverable licence product:',
      disableError.message,
    );
  }

  return { ok: false, message: LICENSE_CONFIG_RAIL_MESSAGE };
}
