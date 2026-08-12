/**
 * Store — Product management dashboard page.
 *
 * Architecture doc §30 — Commerce & Universal Licensing Platform.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import ProductFiles from '@/components/store/product-files';
import StoreControlRoom from '@/components/store/store-control-room';
import { PayPalOnboardingStatusPanel } from '@/components/store/paypal-onboarding-status';
import { ProductIntegrationPanel } from '@/components/store/product-integration-panel';
import { SubscriptionPlanEditor } from '@/components/store/subscription-plan-editor';
import type {
  PayPalOnboardingStatus,
  SubscriptionPlan,
  SubscriptionPlanDraft,
} from '@/components/store/onboarding-types';
import { RolePicker } from '@/components/shared/role-picker';
import { ChannelPicker } from '@/components/shared/channel-picker';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useToast } from '@/components/shared/toast';
import { CardListSkeleton } from '@/components/shared/loading-skeleton';
import { Button } from '@/components/shared/button';
import { Input, Select, Toggle } from '@/components/shared/input';
import { getOperatorLicensingGuide } from '@/lib/store/operator-licensing-guide';
import {
  commercePlanRecoverySchema,
  readPlanRecovery,
  type CommercePlanRecovery,
} from '@/lib/store/commerce-plan-recovery';
import {
  defaultStoreProductFacets,
  evaluateStoreProductPolicy,
  storeProductFacetOptions,
  type StoreProductFacet,
} from '@/lib/store/store-product-policy';

// ── Types ─────────────────────────────────────────────────

interface Product {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  type: 'one_time' | 'subscription' | 'free';
  delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  paypal_product_id: string | null;
  price_cents: number;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  active: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  plans?: Plan[];
  product_license_config?: LicenseConfig[];
}

type Plan = SubscriptionPlan;

interface LicenseConfig {
  product_id: string;
  license_mode: string;
  key_prefix: string;
  max_devices: number;
  heartbeat_interval_seconds: number;
  sdk_cache_ttl_ms: number;
  offline_grace_period_seconds: number;
  feature_flags: string[];
  require_discord_guild_membership: boolean;
  store_keys_hashed: boolean;
  rotation_policy: 'rotate-and-invalidate' | 'disabled';
  self_service_device_removal: boolean;
}

const emptyForm: {
  name: string;
  description: string;
  type: 'one_time' | 'subscription' | 'free';
  delivery_type: 'file' | 'link' | 'access_pass' | 'license_key' | 'mixed';
  price_dollars: string;
  currency: string;
  granted_role_ids: string[];
  granted_channel_ids: string[];
  active: boolean;
} = {
  name: '',
  description: '',
  type: 'one_time',
  delivery_type: 'license_key',
  price_dollars: '',
  currency: 'USD',
  granted_role_ids: [],
  granted_channel_ids: [],
  active: true,
};

const emptyPlan: SubscriptionPlanDraft = {
  name: 'Standard monthly',
  interval_unit: 'MONTH',
  interval_count: 1,
  price_cents: 0,
  currency: 'USD',
  trial_days: 0,
  active: true,
};

const productTypeOptions = [
  { value: 'one_time', label: 'One-Time' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'free', label: 'Free' },
];

const deliveryTypeLabels: Record<Product['delivery_type'], string> = {
  license_key: 'Dynamic',
  file: 'Static',
  link: 'Static',
  access_pass: 'Static (legacy)',
  mixed: 'Static (legacy)',
};

// ── Helpers ───────────────────────────────────────────────

function formatPrice(cents: number, currency: string = 'USD'): string {
  return `$${(cents / 100).toFixed(2)} ${currency}`;
}

function typeBadge(type: string) {
  switch (type) {
    case 'one_time':
      return { label: 'One-Time', color: 'bg-discord-info/20 text-discord-info' };
    case 'subscription':
      return { label: 'Subscription', color: 'bg-[#FF1493]/20 text-[#FF1493]' };
    case 'free':
      return { label: 'Free', color: 'bg-emerald-500/20 text-emerald-300' };
    default:
      return { label: type, color: 'bg-discord-bg-tertiary text-discord-text-muted' };
  }
}

function deliveryBadge(type: string) {
  switch (type) {
    case 'file':
      return '📁 File';
    case 'link':
      return '🔗 Link';
    case 'access_pass':
      return '🔑 Access Pass';
    case 'mixed':
      return '📦 Mixed';
    default:
      return type;
  }
}

// ── Component ─────────────────────────────────────────────

export default function StorePage() {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filesProductId, setFilesProductId] = useState<string | null>(null);
  const [filesProductName, setFilesProductName] = useState<string>('');
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [storeEnabled, setStoreEnabled] = useState(false);
  const [paypalEnabled, setPaypalEnabled] = useState(false);
  const [togglingStore, setTogglingStore] = useState(false);
  const [togglingPaypal, setTogglingPaypal] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState(3);
  const [savingGrace, setSavingGrace] = useState(false);
  const [rotationPolicy, setRotationPolicy] = useState<'rotate-and-invalidate' | 'disabled'>('rotate-and-invalidate');
  const [selfServiceDeviceRemoval, setSelfServiceDeviceRemoval] = useState(true);
  const [licenseKeyPrefix, setLicenseKeyPrefix] = useState('SMNI');
  const [licenseMaxDevices, setLicenseMaxDevices] = useState(3);
  const [licenseHeartbeatMs, setLicenseHeartbeatMs] = useState(300000);
  const [licenseOfflineGraceSeconds, setLicenseOfflineGraceSeconds] = useState(86400);
  const [licenseSdkCacheTtlMs, setLicenseSdkCacheTtlMs] = useState(60000);
  const [licenseFeatureFlags, setLicenseFeatureFlags] = useState('');
  const [licenseRequireMembership, setLicenseRequireMembership] = useState(true);
  const [paypalLegacyTolerance, setPaypalLegacyTolerance] = useState(true);
  const [paypalEnvironment, setPaypalEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [paypalRefundStrategy, setPaypalRefundStrategy] = useState<'provider-first' | 'local-first'>('provider-first');
  const [paypalStaleMs, setPaypalStaleMs] = useState(300000);
  const [paypalVerifyAttempts, setPaypalVerifyAttempts] = useState(3);
  const [savingPaypalPolicy, setSavingPaypalPolicy] = useState(false);
  const [liveModeConfirmed, setLiveModeConfirmed] = useState(false);
  const [planDraft, setPlanDraft] = useState<SubscriptionPlanDraft>(emptyPlan);
  const [integrationProduct, setIntegrationProduct] = useState<Product | null>(null);
  const [integrationRecovery, setIntegrationRecovery] = useState<{ readonly kind: 'license' | 'plan'; readonly message: string } | null>(null);
  const [pendingPlanRecovery, setPendingPlanRecovery] = useState<CommercePlanRecovery | null>(null);
  const [paypalStatus, setPaypalStatus] = useState<PayPalOnboardingStatus | null>(null);
  const [storeControls, setStoreControls] = useState({
    product_types_enabled: [...defaultStoreProductFacets] as StoreProductFacet[],
    repeat_purchase_policy: 'unique' as 'unique' | 'stackable' | 'renewable' | 'seat-based',
    free_claim_policy: 'one-claim' as 'one-claim' | 'repeatable',
    gifting_enabled: true,
    public_celebration_enabled: false,
    celebration_channel_id: '',
    store_brand_source: 'guild-profile' as 'guild-profile' | 'custom',
    max_storefront_products: 9,
    portal_session_ttl_ms: 604800000,
    download_link_ttl_ms: 300000,
    self_service_cancellation: true,
    cancellation_timing: 'end-of-term' as 'end-of-term' | 'immediate',
    refund_requests_enabled: true,
    service_requests_enabled: true,
    portal_brand_source: 'guild-profile' as 'guild-profile' | 'custom',
  });
  const [savingControl, setSavingControl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [productsRes, guildRes] = await Promise.all([
        fetch('/api/store/products'),
        fetch('/api/guild'),
      ]);
      const productsJson = await productsRes.json();
      if (productsJson.success) {
        const loadedProducts: Product[] = productsJson.data;
        setProducts(loadedProducts);
        const recoverable = loadedProducts.find((product) => readPlanRecovery(product.metadata));
        if (recoverable) {
          setIntegrationProduct(recoverable);
          setPendingPlanRecovery(readPlanRecovery(recoverable.metadata));
          setIntegrationRecovery({
            kind: 'plan',
            message: 'This inactive product has a saved subscription-plan recovery. Retry reconciles PayPal and the local plan before reactivation.',
          });
        }
      }
      const guildJson = await guildRes.json();
      if (guildJson.config) {
        setStoreEnabled(guildJson.config.store_enabled ?? false);
        setPaypalEnabled(guildJson.config.paypal_enabled ?? false);
        setGracePeriodDays(guildJson.config.grace_period_days ?? 3);
        setPaypalLegacyTolerance(guildJson.config.paypal_legacy_usd_sale_tolerance ?? true);
        setPaypalEnvironment(guildJson.config.paypal_environment ?? 'sandbox');
        setPaypalRefundStrategy(guildJson.config.paypal_refund_strategy ?? 'provider-first');
        setPaypalStaleMs(guildJson.config.paypal_webhook_stale_processing_ms ?? 300000);
        setPaypalVerifyAttempts(guildJson.config.paypal_webhook_verify_attempts ?? 3);
        setStoreControls((prev) => ({
          ...prev,
          product_types_enabled: guildJson.config.product_types_enabled ?? prev.product_types_enabled,
          repeat_purchase_policy: guildJson.config.repeat_purchase_policy ?? prev.repeat_purchase_policy,
          free_claim_policy: guildJson.config.free_claim_policy ?? prev.free_claim_policy,
          gifting_enabled: guildJson.config.gifting_enabled ?? prev.gifting_enabled,
          public_celebration_enabled: guildJson.config.public_celebration_enabled ?? prev.public_celebration_enabled,
          celebration_channel_id: guildJson.config.celebration_channel_id ?? '',
          store_brand_source: guildJson.config.store_brand_source ?? prev.store_brand_source,
          max_storefront_products: guildJson.config.max_storefront_products ?? prev.max_storefront_products,
          portal_session_ttl_ms: guildJson.config.portal_session_ttl_ms ?? prev.portal_session_ttl_ms,
          download_link_ttl_ms: guildJson.config.download_link_ttl_ms ?? prev.download_link_ttl_ms,
          self_service_cancellation: guildJson.config.self_service_cancellation ?? prev.self_service_cancellation,
          cancellation_timing: guildJson.config.cancellation_timing ?? prev.cancellation_timing,
          refund_requests_enabled: guildJson.config.refund_requests_enabled ?? prev.refund_requests_enabled,
          service_requests_enabled: guildJson.config.service_requests_enabled ?? prev.service_requests_enabled,
          portal_brand_source: guildJson.config.portal_brand_source ?? prev.portal_brand_source,
        }));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleStoreEnabled = async (value: boolean) => {
    setTogglingStore(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_enabled: value }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setStoreEnabled(value);
        toast({ title: value ? 'Store enabled' : 'Store disabled', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to toggle store', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to toggle store', variant: 'error' });
    } finally {
      setTogglingStore(false);
    }
  };

  const savePaypalPolicy = async () => {
    if (paypalEnvironment === 'live' && !liveModeConfirmed) {
      toast({ title: 'Confirm Live mode before saving', variant: 'error' });
      return;
    }
    setSavingPaypalPolicy(true);
    try {
      const response = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paypal_legacy_usd_sale_tolerance: paypalLegacyTolerance,
          paypal_environment: paypalEnvironment,
          paypal_refund_strategy: paypalRefundStrategy,
          paypal_webhook_stale_processing_ms: Math.max(60000, Math.min(86400000, paypalStaleMs)),
          paypal_webhook_verify_attempts: Math.max(1, Math.min(10, paypalVerifyAttempts)),
        }),
      });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error ?? 'save failed');
      const readback = await fetch('/api/guild');
      const authoritative = await readback.json();
      if (!readback.ok || authoritative.config?.paypal_environment !== paypalEnvironment) {
        throw new Error('PayPal environment readback did not match');
      }
      setPaypalEnvironment(authoritative.config.paypal_environment);
      toast({ title: 'PayPal policy saved and verified', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save PayPal policy', variant: 'error' });
    } finally {
      setSavingPaypalPolicy(false);
    }
  };

  const togglePaypalEnabled = async (value: boolean) => {
    setTogglingPaypal(true);
    try {
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paypal_enabled: value }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setPaypalEnabled(value);
        toast({ title: value ? 'PayPal enabled' : 'PayPal disabled', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to toggle PayPal', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to toggle PayPal', variant: 'error' });
    } finally {
      setTogglingPaypal(false);
    }
  };

  const saveGracePeriod = async (value: number) => {
    setSavingGrace(true);
    try {
      const clamped = Math.max(1, Math.min(30, value));
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grace_period_days: clamped }),
      });
      const json = await res.json();
      if (json.success || !json.error) {
        setGracePeriodDays(clamped);
        toast({ title: 'Grace period saved', variant: 'success' });
      } else {
        toast({ title: json.error ?? 'Failed to save', variant: 'error' });
      }
    } catch {
      toast({ title: 'Failed to save grace period', variant: 'error' });
    } finally {
      setSavingGrace(false);
    }
  };

  const saveCommerceControl = async <K extends keyof typeof storeControls,>(key: K, value: typeof storeControls[K]) => {
    setSavingControl(String(key));
    try {
      const payload = key === 'celebration_channel_id' && value === '' ? null : value;
      const res = await fetch('/api/guild', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: payload }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        toast({ title: json.error ?? 'Failed to save commerce setting', variant: 'error' });
        return;
      }
      const readbackResponse = await fetch('/api/guild');
      const readback: { config?: Partial<typeof storeControls>; error?: string } = await readbackResponse.json();
      const authoritativeValue = readback.config?.[key];
      const matches = JSON.stringify(authoritativeValue ?? null) === JSON.stringify(payload ?? null);
      if (!readbackResponse.ok || !matches) {
        toast({ title: readback.error ?? 'Commerce setting saved, but authoritative readback did not match', variant: 'error' });
        return;
      }
      setStoreControls((prev) => ({ ...prev, [key]: value }));
      toast({ title: 'Commerce setting saved', variant: 'success' });
    } catch {
      toast({ title: 'Failed to save commerce setting', variant: 'error' });
    } finally {
      setSavingControl(null);
    }
  };

  const toggleProductType = (type: StoreProductFacet) => {
    const current = storeControls.product_types_enabled;
    const next = current.includes(type) ? current.filter((v) => v !== type) : [...current, type];
    if (next.length === 0) {
      toast({ title: 'Enable at least one product type', variant: 'error' });
      return;
    }
    const nextPolicy = evaluateStoreProductPolicy(next);
    if (nextPolicy.allowedDeliveryTypes.length === 0) {
      toast({ title: 'Enable at least one fulfillment path', variant: 'error' });
      return;
    }
    const typeAllowed = (form.type !== 'subscription' || next.includes('subscription'))
      && (form.type !== 'free' || next.includes('free'));
    if (!nextPolicy.allowedDeliveryTypes.includes(form.delivery_type) || !typeAllowed) {
      setForm((current) => ({
        ...current,
        type: typeAllowed ? current.type : 'one_time',
        delivery_type: nextPolicy.allowedDeliveryTypes[0] ?? 'license_key',
        granted_role_ids: nextPolicy.discordFulfillmentEnabled ? current.granted_role_ids : [],
        granted_channel_ids: nextPolicy.discordFulfillmentEnabled ? current.granted_channel_ids : [],
      }));
    }
    void saveCommerceControl('product_types_enabled', next);
  };

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm);
    setRotationPolicy('rotate-and-invalidate');
    setSelfServiceDeviceRemoval(true);
    setLicenseKeyPrefix('SMNI');
    setLicenseMaxDevices(3);
    setLicenseHeartbeatMs(300000);
    setLicenseOfflineGraceSeconds(86400);
    setLicenseSdkCacheTtlMs(60000);
    setLicenseFeatureFlags('');
    setLicenseRequireMembership(true);
    setPlanDraft(emptyPlan);
    setIntegrationRecovery(null);
    setPendingPlanRecovery(null);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (p: Product) => {
    setForm({
      name: p.name,
      description: p.description ?? '',
      type: p.type,
      delivery_type: p.delivery_type === 'license_key' ? 'license_key' : 'file',
      price_dollars: (p.price_cents / 100).toFixed(2),
      currency: p.currency,
      granted_role_ids: p.granted_role_ids,
      granted_channel_ids: p.granted_channel_ids ?? [],
      active: p.active,
    });
    const licenseConfig = p.product_license_config?.[0];
    setRotationPolicy(licenseConfig?.rotation_policy ?? 'rotate-and-invalidate');
    setSelfServiceDeviceRemoval(licenseConfig?.self_service_device_removal ?? true);
    setLicenseKeyPrefix(licenseConfig?.key_prefix ?? 'SMNI');
    setLicenseMaxDevices(licenseConfig?.max_devices ?? 3);
    setLicenseHeartbeatMs((licenseConfig?.heartbeat_interval_seconds ?? 300) * 1000);
    setLicenseOfflineGraceSeconds(licenseConfig?.offline_grace_period_seconds ?? 86400);
    setLicenseSdkCacheTtlMs(licenseConfig?.sdk_cache_ttl_ms ?? 60000);
    setLicenseFeatureFlags((licenseConfig?.feature_flags ?? []).join(', '));
    setLicenseRequireMembership(licenseConfig?.require_discord_guild_membership ?? true);
    setEditingId(p.id);
    setIntegrationProduct(p);
    setPlanDraft(p.plans?.[0] ?? { ...emptyPlan, currency: p.currency, price_cents: p.price_cents });
    setShowForm(true);
  };

  const readbackProduct = async (productId: string): Promise<Product | null> => {
    const response = await fetch('/api/store/products');
    const body: { success?: boolean; data?: Product[] } = await response.json();
    if (!response.ok || body.success === false || !body.data) return null;
    const product = body.data.find((candidate) => candidate.id === productId) ?? null;
    setProducts(body.data);
    if (product) setIntegrationProduct(product);
    return product;
  };

  const saveLicensePolicy = async (productId: string): Promise<string | null> => {
    const configRes = await fetch(`/api/license/config/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_prefix: licenseKeyPrefix,
        max_devices: licenseMaxDevices,
        heartbeat_interval_ms: licenseHeartbeatMs,
        sdk_cache_ttl_ms: licenseSdkCacheTtlMs,
        offline_grace_period_seconds: licenseOfflineGraceSeconds,
        feature_flags: licenseFeatureFlags.split(',').map((flag) => flag.trim()).filter(Boolean),
        require_discord_guild_membership: licenseRequireMembership,
        rotation_policy: rotationPolicy,
        self_service_device_removal: selfServiceDeviceRemoval,
      }),
    });
    if (configRes.ok) return null;
    const result: { error?: string } = await configRes.json();
    return result.error ?? 'The license policy could not be saved.';
  };

  const retryIntegrationRecovery = async () => {
    if (!integrationProduct || !integrationRecovery) return;
    try {
      if (integrationRecovery.kind === 'plan' && pendingPlanRecovery) {
        const response = await fetch('/api/store/products/recover-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id: pendingPlanRecovery.product_id }),
        });
        const result: { success?: boolean; error?: string } = await response.json();
        if (!response.ok || result.success === false) {
          setIntegrationRecovery({ kind: 'plan', message: result.error ?? 'The plan still could not be saved.' });
          return;
        }
        const verifiedProduct = await readbackProduct(integrationProduct.id);
        const verifiedPlan = verifiedProduct?.plans?.find(
          (plan) => plan.id === pendingPlanRecovery.id,
        );
        if (
          !verifiedProduct
          || verifiedProduct.active !== pendingPlanRecovery.product_active
          || readPlanRecovery(verifiedProduct.metadata)
          || !verifiedPlan
        ) {
          setIntegrationRecovery({
            kind: 'plan',
            message: 'Recovery completed, but authoritative product and plan readback did not match. Retry safely.',
          });
          return;
        }
        setIntegrationRecovery(null);
        setPendingPlanRecovery(null);
        toast({ title: 'Subscription plan saved and verified', variant: 'success' });
        return;
      }

      const policyError = await saveLicensePolicy(integrationProduct.id);
      setIntegrationRecovery(policyError ? { kind: 'license', message: policyError } : null);
      if (!policyError) {
        const verifiedProduct = await readbackProduct(integrationProduct.id);
        if (!verifiedProduct) {
          setIntegrationRecovery({
            kind: 'license',
            message: 'The license policy was saved, but authoritative product readback failed. Retry safely.',
          });
          return;
        }
        toast({ title: 'License policy saved and verified', variant: 'success' });
      }
    } catch {
      setIntegrationRecovery({
        kind: integrationRecovery.kind,
        message: 'The retry could not reach the dashboard API. The product remains preserved; try again.',
      });
    }
  };

  const save = async () => {
    // Client-side validation
    const priceCents = form.type === 'free' ? 0 : Math.round((parseFloat(form.price_dollars) || 0) * 100);
    if (priceCents < 0) {
      toast({ title: 'Price cannot be negative', variant: 'error' });
      return;
    }
    if (!form.currency.trim()) {
      toast({ title: 'Currency is required', variant: 'error' });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name,
        description: form.description || null,
        type: form.type,
        delivery_type: form.delivery_type,
        price_cents: priceCents,
        currency: form.currency.toUpperCase(),
        granted_role_ids: form.granted_role_ids,
        granted_channel_ids: form.granted_channel_ids,
        active: form.active,
        ...(form.type === 'subscription' && !editingId ? {
          plans: [{ ...planDraft, currency: form.currency.toUpperCase() }],
        } : {}),
      };

      const res = await fetch('/api/store/products', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      const productId = json.data?.id ?? editingId;
      if (!res.ok || json.success === false) {
        if (productId && typeof productId === 'string') {
          const preserved = await readbackProduct(productId);
          if (preserved) {
            const recoveryPlan = json.data?.recovery_plan;
            const parsedRecovery = json.code === 'PRODUCT_CREATED_PLAN_SAVE_FAILED'
              || json.code === 'PRODUCT_CREATED_PLAN_COMPENSATION_FAILED'
              ? commercePlanRecoverySchema.safeParse(recoveryPlan)
              : null;
            const planRecovery = parsedRecovery?.success ? parsedRecovery.data : null;
            setPendingPlanRecovery(planRecovery);
            setIntegrationRecovery({
              kind: planRecovery ? 'plan' : 'license',
              message: json.error ?? 'Product setup stopped after the product was created.',
            });
            setShowForm(false);
          }
        }
        toast({ title: json.error ?? 'Failed to save product', variant: 'error' });
        return;
      }

      if (productId && form.delivery_type === 'license_key') {
        const policyError = await saveLicensePolicy(productId);
        if (policyError) {
          await readbackProduct(productId);
          setIntegrationRecovery({ kind: 'license', message: policyError });
          setShowForm(false);
          toast({ title: 'Product saved, but license policy was not saved', variant: 'error' });
          return;
        }
      }
      if (!productId || !(await readbackProduct(productId))) {
        toast({ title: 'Product saved, but authoritative readback failed', variant: 'error' });
        return;
      }
      setIntegrationRecovery(null);
      setPendingPlanRecovery(null);
      setShowForm(false);
      toast({ title: editingId ? 'Product updated and verified' : 'Product created and verified', variant: 'success' });
    } catch {
      toast({ title: 'Network error — could not save product', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async (id: string) => {
    try {
      const res = await fetch(`/api/store/products?id=${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast({ title: json.error ?? 'Failed to delete product', variant: 'error' });
        return;
      }
      toast({ title: 'Product deleted', variant: 'success' });
      load();
    } catch {
      toast({ title: 'Network error — could not delete product', variant: 'error' });
    }
  };

  const toggleActive = async (p: Product) => {
    try {
      const res = await fetch('/api/store/products', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, active: !p.active }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        toast({ title: json.error ?? 'Failed to update product', variant: 'error' });
        return;
      }
      toast({ title: p.active ? 'Product deactivated' : 'Product activated', variant: 'success' });
      load();
    } catch {
      toast({ title: 'Network error — could not update product', variant: 'error' });
    }
  };

  // ── Stats ──

  const activeCount = products.filter((p) => p.active).length;
  const totalProducts = products.length;
  const oneTimeCount = products.filter((p) => p.type === 'one_time').length;
  const subCount = products.filter((p) => p.type === 'subscription').length;
  const operatorGuide = getOperatorLicensingGuide({
    type: form.type,
    deliveryType: form.delivery_type,
    grantedRoleCount: form.granted_role_ids.length,
  });
  const storePolicy = evaluateStoreProductPolicy(storeControls.product_types_enabled);
  const deliveryTypeOptions = storePolicy.allowedDeliveryTypes.map((value) => ({
    value,
    label: deliveryTypeLabels[value],
  }));
  const availableProductTypeOptions = productTypeOptions.filter((option) => (
    (option.value !== 'subscription' || storePolicy.enabledFacets.includes('subscription'))
    && (option.value !== 'free' || storePolicy.enabledFacets.includes('free'))
  ));

  // ── Render ──

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-discord-text-primary">Store</h1>
          <p className="text-sm text-discord-text-muted">
            Manage products, pricing, and delivery
          </p>
        </div>
        <Button onClick={openCreate}>New Product</Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Total Products', value: totalProducts },
          { label: 'Active', value: activeCount },
          { label: 'One-Time', value: oneTimeCount },
          { label: 'Subscriptions', value: subCount },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4 text-center"
          >
            <p className="text-2xl font-bold text-discord-text-primary">{s.value}</p>
            <p className="text-xs text-discord-text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      <StoreControlRoom />

      <PayPalOnboardingStatusPanel onStatus={setPaypalStatus} />

      {integrationProduct && (
        <ProductIntegrationPanel
          product={integrationProduct}
          apiBase={paypalStatus?.apiBase ?? '/api'}
          environment={paypalStatus?.environment ?? paypalEnvironment}
          recoveryMessage={integrationRecovery?.message}
          recoveryActionLabel={integrationRecovery?.kind === 'plan' ? 'Retry plan save' : 'Retry license policy'}
          onRetry={integrationRecovery ? () => { void retryIntegrationRecovery(); } : undefined}
        />
      )}

      {/* Commerce Toggles */}
      <div className="rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 space-y-4">
        <h2 className="text-lg font-semibold text-discord-text-primary">Commerce Settings</h2>
        <Toggle label="Store" description="Enable or disable /store commands and buy buttons." checked={storeEnabled} onChange={toggleStoreEnabled} disabled={togglingStore} />
        <Toggle label="PayPal payments" description="Requires PayPal API credentials in Settings." checked={paypalEnabled} onChange={togglePaypalEnabled} disabled={togglingPaypal} />
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-discord-text-primary">Subscription Grace Period</span>
            <p className="text-xs text-discord-text-muted">
              Days after a subscription expires before entitlements are revoked. Set to 0 for immediate revocation.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="subscription-grace-days"
              type="number"
              min={1}
              max={30}
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(parseInt(e.target.value) || 0)}
              className="w-20"
            />
            <span className="text-xs text-discord-text-muted">days</span>
            <Button
              size="sm"
              onClick={() => saveGracePeriod(gracePeriodDays)}
              disabled={savingGrace}
            >
              {savingGrace ? '…' : 'Save'}
            </Button>
          </div>
        </div>
        <section
          className="rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary/40 p-4 space-y-3"
          aria-labelledby="paypal-processing-policy-heading"
        >
          <div>
            <h3 id="paypal-processing-policy-heading" className="text-sm font-medium text-discord-text-primary">PayPal processing policy</h3>
            <p className="text-xs text-discord-text-muted">Sandbox is the default. These controls never expose credentials or initiate a live payment.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select id="paypal-environment" label="Environment" value={paypalEnvironment} onChange={(event) => { const environment = event.target.value === 'live' ? 'live' : 'sandbox'; setPaypalEnvironment(environment); if (environment === 'sandbox') setLiveModeConfirmed(false); }} options={[{ value: 'sandbox', label: 'Sandbox' }, { value: 'live', label: 'Live (real money)' }]} className="bg-discord-bg-primary" />
            <Select id="paypal-refund-strategy" label="Refund strategy" value={paypalRefundStrategy} onChange={(event) => setPaypalRefundStrategy(event.target.value === 'local-first' ? 'local-first' : 'provider-first')} options={[{ value: 'provider-first', label: 'Provider first' }, { value: 'local-first', label: 'Local first (manual review)' }]} className="bg-discord-bg-primary" />
            <Toggle label="Allow legacy USD sale tolerance" checked={paypalLegacyTolerance} onChange={setPaypalLegacyTolerance} />
            <Input id="paypal-stale-window" label="Stale processing window (ms)" type="number" min={60000} max={86400000} value={paypalStaleMs} onChange={(event) => setPaypalStaleMs(Number(event.target.value) || 60000)} className="bg-discord-bg-primary" />
            <Input id="paypal-verify-attempts" label="Webhook verify attempts" type="number" min={1} max={10} value={paypalVerifyAttempts} onChange={(event) => setPaypalVerifyAttempts(Number(event.target.value) || 1)} className="bg-discord-bg-primary" />
          </div>
          {paypalEnvironment === 'live' && <div className="rounded-input border border-discord-danger/50 bg-discord-danger/10 p-3"><Toggle label="I confirm this switches checkout to Live PayPal and can accept real customer money." description="Complete sandbox purchase, signed-webhook, fulfillment, license validation, and deactivation checks first." checked={liveModeConfirmed} onChange={setLiveModeConfirmed} /></div>}
          <Button size="sm" onClick={() => void savePaypalPolicy()} disabled={savingPaypalPolicy || (paypalEnvironment === 'live' && !liveModeConfirmed)}>{savingPaypalPolicy ? 'Saving…' : 'Save PayPal policy'}</Button>
        </section>

        <div className="border-t border-discord-border-subtle pt-4 space-y-4">
          <h3 className="text-sm font-semibold text-discord-text-primary">Storefront policy</h3>
          <div>
            <p className="mb-2 text-xs text-discord-text-muted">Choose which product and fulfillment paths owners can create and customers can see.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {storeProductFacetOptions.map((option) => (
                <Toggle
                  key={option.value}
                  label={option.label}
                  description={option.description}
                  checked={storeControls.product_types_enabled.includes(option.value)}
                  onChange={() => toggleProductType(option.value)}
                  disabled={savingControl === 'product_types_enabled'}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-discord-success" role="status">The database entitlement remains authoritative. Optional product roles and private channels mirror fulfillment and are removed after refund or revocation; the Discord server itself is never sold as a product.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select label="Repeat purchase policy" value={storeControls.repeat_purchase_policy} onChange={(e) => void saveCommerceControl('repeat_purchase_policy', e.target.value as typeof storeControls.repeat_purchase_policy)} options={[{ value: 'unique', label: 'Unique' }, { value: 'stackable', label: 'Stackable' }, { value: 'renewable', label: 'Renewable' }, { value: 'seat-based', label: 'Seat-based' }]} />
            <Select label="Free claim policy" value={storeControls.free_claim_policy} onChange={(e) => void saveCommerceControl('free_claim_policy', e.target.value as typeof storeControls.free_claim_policy)} options={[{ value: 'one-claim', label: 'One claim' }, { value: 'repeatable', label: 'Repeatable' }]} />
            <Input label="Max storefront products" type="number" min={1} max={9} value={storeControls.max_storefront_products} onChange={(e) => setStoreControls((p) => ({ ...p, max_storefront_products: Number(e.target.value) }))} onBlur={() => void saveCommerceControl('max_storefront_products', storeControls.max_storefront_products)} />
            <Select label="Store brand source" value={storeControls.store_brand_source} onChange={(e) => void saveCommerceControl('store_brand_source', e.target.value as typeof storeControls.store_brand_source)} options={[{ value: 'guild-profile', label: 'Guild profile' }, { value: 'custom', label: 'Custom brand kit' }]} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle label="Enable gifting" checked={storeControls.gifting_enabled} onChange={(checked) => void saveCommerceControl('gifting_enabled', checked)} />
            <Toggle label="Public purchase celebrations" checked={storeControls.public_celebration_enabled} onChange={(checked) => void saveCommerceControl('public_celebration_enabled', checked)} />
          </div>
          <Input label="Celebration channel ID (leave blank to keep celebrations private)" value={storeControls.celebration_channel_id} onChange={(e) => setStoreControls((p) => ({ ...p, celebration_channel_id: e.target.value }))} onBlur={() => void saveCommerceControl('celebration_channel_id', storeControls.celebration_channel_id)} placeholder="Discord channel ID" />

          <h3 className="border-t border-discord-border-subtle pt-4 text-sm font-semibold text-discord-text-primary">Customer portal policy</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Session TTL (ms)" type="number" min={3600000} max={2592000000} value={storeControls.portal_session_ttl_ms} onChange={(e) => setStoreControls((p) => ({ ...p, portal_session_ttl_ms: Number(e.target.value) }))} onBlur={() => void saveCommerceControl('portal_session_ttl_ms', storeControls.portal_session_ttl_ms)} />
            <Input label="Download link TTL (ms)" type="number" min={60000} max={3600000} value={storeControls.download_link_ttl_ms} onChange={(e) => setStoreControls((p) => ({ ...p, download_link_ttl_ms: Number(e.target.value) }))} onBlur={() => void saveCommerceControl('download_link_ttl_ms', storeControls.download_link_ttl_ms)} />
            <Select label="Cancellation timing" value={storeControls.cancellation_timing} onChange={(e) => void saveCommerceControl('cancellation_timing', e.target.value as typeof storeControls.cancellation_timing)} options={[{ value: 'end-of-term', label: 'End of term' }, { value: 'immediate', label: 'Immediate' }]} />
            <Select label="Portal brand source" value={storeControls.portal_brand_source} onChange={(e) => void saveCommerceControl('portal_brand_source', e.target.value as typeof storeControls.portal_brand_source)} options={[{ value: 'guild-profile', label: 'Guild profile' }, { value: 'custom', label: 'Custom brand kit' }]} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Toggle label="Self-service cancellation" checked={storeControls.self_service_cancellation} onChange={(checked) => void saveCommerceControl('self_service_cancellation', checked)} />
            <Toggle label="Refund requests" checked={storeControls.refund_requests_enabled} onChange={(checked) => void saveCommerceControl('refund_requests_enabled', checked)} />
            <Toggle label="Service requests" checked={storeControls.service_requests_enabled} onChange={(checked) => void saveCommerceControl('service_requests_enabled', checked)} />
          </div>
          {savingControl && <p className="text-xs text-discord-text-muted">Saving…</p>}
        </div>
      </div>

      {/* Product Form Modal */}
      {showForm && (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-6">
          <h2 className="mb-4 text-lg font-bold text-discord-text-primary">
            {editingId ? 'Edit Product' : 'New Product'}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input id="product-name" label="Name *" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Product name" />
            <Input id="product-price" label="Price ($) *" type="number" step="0.01" min="0" value={form.type === 'free' ? '0.00' : form.price_dollars} disabled={form.type === 'free'} onChange={(event) => setForm({ ...form, price_dollars: event.target.value })} placeholder="9.99" />
            <Select id="product-type" label="Type" value={form.type} onChange={(event) => { const type = event.target.value === 'subscription' ? 'subscription' : event.target.value === 'free' ? 'free' : 'one_time'; setForm({ ...form, type, price_dollars: type === 'free' ? '0.00' : form.price_dollars }); }} options={availableProductTypeOptions} />
            <Select id="product-delivery-type" label="Licensing mode" value={form.delivery_type} onChange={(event) => { const deliveryType = storePolicy.allowedDeliveryTypes.find((value) => value === event.target.value); if (deliveryType) setForm({ ...form, delivery_type: deliveryType }); }} options={deliveryTypeOptions} />
            <div
              className="sm:col-span-2 rounded-lg border border-discord-accent/40 bg-discord-accent/10 p-4"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-discord-text-primary">
                  {operatorGuide.title}
                </h3>
                <span className="rounded-full bg-discord-bg-tertiary px-2 py-0.5 text-xs text-discord-text-secondary">
                  {operatorGuide.keyRequired ? 'License key required' : 'No license key'}
                </span>
              </div>
              <p className="mt-1 text-sm text-discord-text-secondary">
                {operatorGuide.summary}
              </p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-discord-text-muted">
                {operatorGuide.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-discord-text-muted">
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none resize-none"
                placeholder="Product description"
              />
            </div>
            {form.delivery_type === 'license_key' && (
              <div className="sm:col-span-2 rounded-lg border border-discord-border-subtle bg-discord-bg-tertiary/40 p-4">
                <h3 className="text-sm font-semibold text-discord-text-primary">License recovery controls</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div data-control-id="key-prefix">
                    <Input
                      id="license-key-prefix"
                      label="Key prefix"
                      value={licenseKeyPrefix}
                      maxLength={8}
                      pattern="[A-Z]{2,8}"
                      onChange={(e) => setLicenseKeyPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8))}
                      className="bg-discord-bg-primary"
                      aria-describedby="license-key-prefix-help"
                    />
                    <span id="license-key-prefix-help" className="mt-1 block text-[11px] text-discord-text-muted">2–8 uppercase letters; applied to future keys and rotations.</span>
                  </div>
                  <div data-control-id="max-devices"><Input id="license-max-devices" label="Maximum devices" type="number" min={1} max={100} value={licenseMaxDevices} onChange={(event) => setLicenseMaxDevices(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} className="bg-discord-bg-primary" /></div>
                  <div data-control-id="heartbeat-interval-ms"><Input id="license-heartbeat-ms" label="Heartbeat interval (ms)" type="number" min={60000} max={86400000} step={1000} value={licenseHeartbeatMs} onChange={(event) => setLicenseHeartbeatMs(Math.max(60000, Math.min(86400000, Number(event.target.value) || 60000)))} className="bg-discord-bg-primary" /></div>
                  <div data-control-id="sdk-cache-ttl-ms"><Input id="license-cache-ttl" label="SDK cache TTL (ms)" type="number" min={1000} max={3600000} step={1000} value={licenseSdkCacheTtlMs} onChange={(event) => setLicenseSdkCacheTtlMs(Math.max(1000, Math.min(3600000, Number(event.target.value) || 1000)))} className="bg-discord-bg-primary" /></div>
                  <div data-control-id="offline-grace-period-seconds"><Input id="license-offline-grace" label="Offline grace (seconds)" type="number" min={0} max={604800} value={licenseOfflineGraceSeconds} onChange={(event) => setLicenseOfflineGraceSeconds(Math.max(0, Math.min(604800, Number(event.target.value) || 0)))} className="bg-discord-bg-primary" /></div>
                  <div data-control-id="feature-flags"><Input id="license-feature-flags" label="SDK feature flags" value={licenseFeatureFlags} onChange={(event) => setLicenseFeatureFlags(event.target.value)} placeholder="pro-mode, exports" className="bg-discord-bg-primary" /></div>
                  <div data-control-id="rotation-policy"><Select id="license-rotation-policy" label="Rotation policy" value={rotationPolicy} onChange={(event) => setRotationPolicy(event.target.value === 'disabled' ? 'disabled' : 'rotate-and-invalidate')} options={[{ value: 'rotate-and-invalidate', label: 'Rotate and invalidate old key' }, { value: 'disabled', label: 'Disable self-service rotation' }]} className="bg-discord-bg-primary" /></div>
                  <div data-control-id="self-service-device-removal" className="pt-5"><Toggle label="Allow buyers to remove their own devices" checked={selfServiceDeviceRemoval} onChange={setSelfServiceDeviceRemoval} /></div>
                  <div data-control-id="require-discord-guild-membership" className="pt-5"><Toggle label="Require Discord guild membership during validation" checked={licenseRequireMembership} onChange={setLicenseRequireMembership} /></div>
                  <div data-control-id="store-keys-hashed" className="rounded-input border border-discord-border-subtle bg-discord-bg-primary/60 px-3 py-2 text-xs text-discord-text-muted">
                    <strong className="text-discord-text-secondary">Store keys hashed: locked on</strong>
                    <p className="mt-1">Only SHA-256 hashes plus prefix/suffix are persisted. Plaintext is delivered once and never recoverable.</p>
                  </div>
                </div>
              </div>
            )}
            {form.type === 'subscription' && (
              <div className="sm:col-span-2">
                <SubscriptionPlanEditor
                  productId={editingId}
                  currency={form.currency.toUpperCase()}
                  draft={planDraft}
                  initialPlans={editingId ? (products.find((product) => product.id === editingId)?.plans ?? []) : []}
                  onDraftChange={setPlanDraft}
                  onReadback={(plans) => setProducts((current) => current.map((product) => product.id === editingId ? { ...product, plans: [...plans] } : product))}
                />
              </div>
            )}
            {storePolicy.discordFulfillmentEnabled && (
              <>
              <div>
                <RolePicker
                  label="Product roles (optional)"
                  hint="Granted after the entitlement is active and removed after refund or revocation. Roles mirror fulfillment but are not the licensing authority."
                  value={form.granted_role_ids}
                  onChange={(value) => setForm({ ...form, granted_role_ids: Array.isArray(value) ? value : [] })}
                  multi
                  hideManaged
                  requireAssignable
                  placeholder="Select product roles…"
                />
              </div>
              <div>
                <ChannelPicker
                  label="Product channels (optional)"
                  hint="Made visible after the entitlement is active and removed after refund or revocation. This is a benefit of this product, not a subscription to the server."
                  value={form.granted_channel_ids}
                  onChange={(value) => setForm({ ...form, granted_channel_ids: Array.isArray(value) ? value : [] })}
                  multi
                  channelTypes={['text', 'announcement', 'forum']}
                  requiredBotPermissions={['ManageChannels']}
                  placeholder="Select product channels…"
                />
              </div>
              </>
            )}
            <Input id="product-currency" label="Currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} placeholder="USD" />
            <div className="pt-5"><Toggle label="Active" checked={form.active} onChange={(active) => setForm({ ...form, active })} /></div>
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              variant="success"
              onClick={save}
              disabled={saving || !form.name}
            >
              {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Product List */}
      {loading ? (
        <CardListSkeleton cards={4} />
      ) : products.length === 0 ? (
        <div className="rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-12 text-center">
          <div className="text-4xl mb-3">🏪</div>
          <p className="text-discord-text-muted">No products yet. Create your first product to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {products.map((p) => {
            const badge = typeBadge(p.type);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-4"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`h-2 w-2 rounded-full ${p.active ? 'bg-discord-success' : 'bg-discord-text-muted'}`}
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-discord-text-primary">{p.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${badge.color}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-discord-text-muted">
                        {deliveryBadge(p.delivery_type)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-discord-text-muted">
                      <span className="font-semibold text-discord-text-secondary">
                        {formatPrice(p.price_cents, p.currency)}
                      </span>
                      {p.granted_role_ids.length > 0 && (
                        <span>{p.granted_role_ids.length} role(s)</span>
                      )}
                      {p.plans && p.plans.length > 0 && (
                        <span>{p.plans.length} plan(s)</span>
                      )}
                      {p.product_license_config && p.product_license_config.length > 0 && (
                        <span>🔑 Licensed</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={p.active ? 'success' : 'secondary'}
                    onClick={() => toggleActive(p)}
                  >
                    {p.active ? 'Active' : 'Inactive'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setFilesProductId(p.id); setFilesProductName(p.name); }}
                  >
                    📁 Files
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => openEdit(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* File Manager Drawer */}
      {filesProductId && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-white">Product Files</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFilesProductId(null)}
            >
              ✕ Close
            </Button>
          </div>
          <ProductFiles productId={filesProductId} productName={filesProductName} />
        </div>
      )}

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Product"
        description={`Delete "${confirmDelete?.name}"? This cannot be undone. All associated files and configurations will be removed.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteProduct(confirmDelete.id);
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
