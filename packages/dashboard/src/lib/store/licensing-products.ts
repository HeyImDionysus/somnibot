import { z } from 'zod';

const productSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['one_time', 'subscription', 'free']),
  delivery_type: z.enum(['file', 'link', 'access_pass', 'license_key', 'mixed']),
  active: z.boolean(),
  granted_role_ids: z.array(z.string()).default([]),
  granted_channel_ids: z.array(z.string()).default([]),
  plans: z.array(z.object({
    id: z.string().min(1),
    active: z.boolean(),
  }).passthrough()).default([]),
  product_files: z.array(z.object({ id: z.string().min(1) }).passthrough()).default([]),
  product_license_config: z.array(z.object({
    max_devices: z.number().int().min(1),
    heartbeat_interval_seconds: z.number().int().min(30),
    offline_grace_period_seconds: z.number().int().min(0),
  }).passthrough()).default([]),
}).passthrough();

const responseSchema = z.object({
  success: z.literal(true),
  data: z.array(productSchema),
});

export type LicensingProductSummary = {
  readonly id: string;
  readonly name: string;
  readonly mode: 'dynamic' | 'static';
  readonly billing: 'One-time' | 'Subscription' | 'Free';
  readonly active: boolean;
  readonly planCount: number;
  readonly fileCount: number;
  readonly discordBenefitCount: number;
  readonly maxInstallations: number | null;
  readonly heartbeatSeconds: number | null;
  readonly offlineGraceSeconds: number | null;
};

function billingLabel(type: z.infer<typeof productSchema>['type']): LicensingProductSummary['billing'] {
  switch (type) {
    case 'one_time': return 'One-time';
    case 'subscription': return 'Subscription';
    case 'free': return 'Free';
  }
}

export function parseLicensingProducts(payload: unknown): LicensingProductSummary[] {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Store product readback is invalid.');

  return parsed.data.data.map((product) => {
    const dynamicPolicy = product.product_license_config[0] ?? null;
    return {
      id: product.id,
      name: product.name,
      mode: product.delivery_type === 'license_key' ? 'dynamic' : 'static',
      billing: billingLabel(product.type),
      active: product.active,
      planCount: product.plans.filter((plan) => plan.active).length,
      fileCount: product.product_files.length,
      discordBenefitCount: product.granted_role_ids.length + product.granted_channel_ids.length,
      maxInstallations: dynamicPolicy?.max_devices ?? null,
      heartbeatSeconds: dynamicPolicy?.heartbeat_interval_seconds ?? null,
      offlineGraceSeconds: dynamicPolicy?.offline_grace_period_seconds ?? null,
    };
  });
}
