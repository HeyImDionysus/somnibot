import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { verifyLaunchSdkIntegration } from '@/lib/store/sdk-launch-integration';
import { resolveSdkDeploymentOrigin, SDK_RECEIPT_METADATA_KEY } from '@/lib/store/sdk-contract-identity';
import { readAdoptionStaffContext } from './adoption-staff-context';

const productSchema = z.object({ id: z.string().uuid(), updated_at: z.string().datetime({ offset: true }), delivery_type: z.string(), metadata: z.record(z.unknown()) }).passthrough();
const policySchema = z.object({ updated_at: z.string().datetime({ offset: true }) }).passthrough().nullable();
const epochSchema = z.array(z.object({ track_id: z.string(), revision: z.number().int() })).max(2);

export class AdoptionContextReadError extends Error {
  constructor() { super('Current adoption integration evidence could not be read.'); this.name = 'AdoptionContextReadError'; }
}

export async function readAdoptionServerContext(guildId: string) {
  const staff = await readAdoptionStaffContext(guildId);
  try {
    return { ...await readCommercialContext(guildId), staff };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { staff, commerceContextUnavailable: true };
  }
}

async function readCommercialContext(guildId: string) {
  const admin = createAdminSupabase();
  const epochs = await admin.from('dashboard_adoption_config_epochs').select('track_id,revision').eq('guild_id', guildId).in('track_id', ['store', 'licensing']).limit(2);
  if (epochs.error) throw new AdoptionContextReadError();
  const revisions = epochSchema.parse(epochs.data ?? []);
  const run = await admin.from('commerce_product_launch_runs').select('product_id').eq('guild_id', guildId).order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (run.error) throw new AdoptionContextReadError();
  if (!run.data) return {};
  const { product_id: productId } = z.object({ product_id: z.string().uuid() }).parse(run.data);
  const [productResult, policyResult, filesResult, plansResult] = await Promise.all([
    admin.from('products').select('*').eq('guild_id', guildId).eq('id', productId).maybeSingle(),
    admin.from('product_license_config').select('*').eq('product_id', productId).maybeSingle(),
    admin.from('product_files').select('*').eq('product_id', productId).limit(101),
    admin.from('plans').select('*').eq('product_id', productId).limit(101),
  ]);
  if ([productResult, policyResult, filesResult, plansResult].some((result) => result.error)) throw new AdoptionContextReadError();
  const product = productSchema.parse(productResult.data);
  const policy = policySchema.parse(policyResult.data);
  const files = z.array(z.unknown()).max(100).parse(filesResult.data ?? []);
  const plans = z.array(z.unknown()).max(100).parse(plansResult.data ?? []);
  const origin = resolveSdkDeploymentOrigin(process.env);
  const requiresSdk = product.delivery_type === 'license_key' || 'completed_project_licensing' in product.metadata || SDK_RECEIPT_METADATA_KEY in product.metadata;
  let integrationVerified = !requiresSdk;
  if (requiresSdk) {
    try {
      integrationVerified = await verifyLaunchSdkIntegration({ ...product, product_files: files, plans, product_license_config: policy }, origin);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      integrationVerified = false;
    }
  }
  return {
    productId, productRevision: product.updated_at,
    policyRevision: product.delivery_type === 'license_key' ? policy?.updated_at ?? null : null,
    storeRevision: revisions.find((row) => row.track_id === 'store')?.revision ?? 0,
    licensingRevision: revisions.find((row) => row.track_id === 'licensing')?.revision ?? 0,
    origin, requiresSdk, integrationVerified,
  };
}
