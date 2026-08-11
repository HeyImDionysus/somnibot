export type BillingInterval = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type SubscriptionPlan = {
  readonly id: string;
  readonly product_id: string;
  readonly name: string;
  readonly paypal_plan_id: string | null;
  readonly interval_unit: BillingInterval;
  readonly interval_count: number;
  readonly price_cents: number;
  readonly currency: string;
  readonly trial_days: number;
  readonly active: boolean;
};

export type SubscriptionPlanDraft = Omit<
  SubscriptionPlan,
  'id' | 'product_id' | 'paypal_plan_id'
>;

export type CommerceProductIdentity = {
  readonly id: string;
  readonly name: string;
  readonly type: 'one_time' | 'subscription' | 'free';
  readonly delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  readonly granted_role_ids: readonly string[];
  readonly paypal_product_id: string | null;
  readonly plans?: readonly SubscriptionPlan[];
};

export type PayPalOnboardingStatus = {
  readonly environment: 'sandbox' | 'live';
  readonly apiBase: string;
  readonly credentialsConfigured: boolean;
  readonly webhookIdConfigured: boolean;
  readonly webhookUrl: string | null;
  readonly webhookUrlReady: boolean;
  readonly lastWebhook: {
    readonly result: 'success' | 'error' | 'duplicate' | 'pending';
    readonly processedAt: string | null;
    readonly eventType: string;
  } | null;
  readonly checkedAt: string;
};
