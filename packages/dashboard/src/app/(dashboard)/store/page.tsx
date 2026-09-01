/**
 * Store — Product management dashboard page.
 *
 * Architecture doc §30 — Commerce & Universal Licensing Platform.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import ProductFiles from '@/components/store/product-files';
import StoreControlRoom from '@/components/store/store-control-room';
import { CommerceOperationsCenter } from '@/components/store/commerce-operations-center';
import { PayPalOnboardingStatusPanel } from '@/components/store/paypal-onboarding-status';
import { ProductIntegrationPanel } from '@/components/store/product-integration-panel';
import { StoreProductCard } from '@/components/store/store-product-card';
import { SubscriptionPlanEditor } from '@/components/store/subscription-plan-editor';
import type {
  PayPalOnboardingStatus,
  SubscriptionPlan,
  SubscriptionPlanDraft,
} from '@/components/store/onboarding-types';
import type { LicensingRails } from '@/lib/store/licensing-rails';
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
  buildLicensePolicySaveRequest,
  evaluateStoreProductPolicy,
  prepareStoreProductSave,
  storeProductFacetOptions,
  type StoreProductFacet,
} from '@/lib/store/store-product-policy';
import {
  LICENSING_STORE_HANDOFF_KEY,
  hasPendingCompletedProjectPolicy,
  licensingCapabilitiesSchema,
  parseLicensingStoreHandoff,
  promptEnvelopeToStorePrefill,
  readCompletedProjectPolicy,
  readCompletedProjectLicensingMetadata,
  resolveCapabilityPlanGrants,
  serializeLicensingStoreHandoff,
  type LicensingCapability,
  type LicensingStoreHandoffV1,
} from '@/lib/store/licensing-handoff';

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
  product_license_config?: LicenseConfig | LicenseConfig[] | null;
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

function licenseConfigForProduct(product: Product): LicenseConfig | null {
  const relation = product.product_license_config;
  return Array.isArray(relation) ? relation[0] ?? null : relation ?? null;
}

function licenseConfigMatchesDesiredPolicy(
  config: LicenseConfig,
  desired: NonNullable<ReturnType<typeof readCompletedProjectPolicy>>,
): boolean {
  return config.key_prefix === desired.keyPrefix
    && config.max_devices === desired.maxDevices
    && config.heartbeat_interval_seconds * 1000 === desired.heartbeatIntervalMs
    && config.sdk_cache_ttl_ms === desired.sdkCacheTtlMs
    && config.offline_grace_period_seconds === desired.offlineGracePeriodSeconds
    && JSON.stringify(config.feature_flags) === JSON.stringify(desired.featureFlags)
    && config.require_discord_guild_membership === desired.requireDiscordGuildMembership
    && config.rotation_policy === desired.rotationPolicy
    && config.self_service_device_removal === desired.selfServiceDeviceRemoval;
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
  active: false,
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

// ── Component ─────────────────────────────────────────────

export default function StorePage() {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [confirmPolicySave, setConfirmPolicySave] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingOriginalDeliveryType, setEditingOriginalDeliveryType] = useState<Product['delivery_type'] | null>(null);
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
  const [subscriptionPlanId, setSubscriptionPlanId] = useState('');
  const [integrationProduct, setIntegrationProduct] = useState<Product | null>(null);
  const [licensingHandoffActive, setLicensingHandoffActive] = useState(false);
  const [licensingHandoffMessage, setLicensingHandoffMessage] = useState('');
  const [licensingPlanNotes, setLicensingPlanNotes] = useState('');
  const [licensingPrivateContext, setLicensingPrivateContext] = useState('');
  const [licensingCapabilities, setLicensingCapabilities] = useState<LicensingCapability[]>([]);
  const [licensingRails, setLicensingRails] = useState<LicensingRails | null>(null);
  const [billingChoiceRequired, setBillingChoiceRequired] = useState(false);
  const [licensingHandoff, setLicensingHandoff] = useState<LicensingStoreHandoffV1 | null>(null);
  const [licenseRecoveryProductId, setLicenseRecoveryProductId] = useState<string | null>(null);
  const [pendingCreateRequestId, setPendingCreateRequestId] = useState<string | null>(null);
  const [integrationRecovery, setIntegrationRecovery] = useState<{ readonly kind: 'license' | 'plan'; readonly message: string } | null>(null);
  const [pendingPlanRecovery, setPendingPlanRecovery] = useState<CommercePlanRecovery | null>(null);
  const [paypalStatus, setPaypalStatus] = useState<PayPalOnboardingStatus | null>(null);
  const clearLicensingHandoff = useCallback(() => {
    window.sessionStorage.removeItem(LICENSING_STORE_HANDOFF_KEY);
    setLicensingHandoffActive(false);
    setLicensingHandoffMessage('');
    setLicensingPlanNotes('');
    setLicensingPrivateContext('');
    setLicensingCapabilities([]);
    setLicensingRails(null);
    setBillingChoiceRequired(false);
    setLicensingHandoff(null);
    setLicenseRecoveryProductId(null);
  }, []);
  const persistLicenseRecovery = useCallback((productId: string, kind: 'license' | 'setup' = 'license') => {
    setLicenseRecoveryProductId(productId);
    try {
      const stored = window.sessionStorage.getItem(LICENSING_STORE_HANDOFF_KEY);
      const handoff = stored ? parseLicensingStoreHandoff(stored) : null;
      if (!handoff) return;
      const recovery = { kind, productId };
      window.sessionStorage.setItem(
        LICENSING_STORE_HANDOFF_KEY,
        serializeLicensingStoreHandoff(
          handoff.envelope,
          handoff.guildId,
          recovery,
          handoff.creationRequestId,
          handoff.capabilities,
          (handoff.subscriptionPlanId ?? subscriptionPlanId) || undefined,
        ),
      );
      setLicensingHandoff({
        ...handoff,
        recovery,
        subscriptionPlanId: (handoff.subscriptionPlanId ?? subscriptionPlanId) || undefined,
      });
    } catch {
      setLicensingHandoffMessage('The product remains inactive, but this tab could not persist its policy-recovery identity. Retry the policy before leaving this page.');
    }
  }, [subscriptionPlanId]);
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
        } else {
          const licenseRecoverable = loadedProducts.find((product) => hasPendingCompletedProjectPolicy(product.metadata));
          if (licenseRecoverable) {
            setIntegrationProduct(licenseRecoverable);
            setLicenseRecoveryProductId(licenseRecoverable.id);
            setIntegrationRecovery({
              kind: 'license',
              message: 'This inactive product still needs its requested license policy. Retry and verify it before activation.',
            });
          }
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

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(LICENSING_STORE_HANDOFF_KEY);
    } catch {
      setLicensingHandoffMessage('The temporary licensing handoff could not be read. Store setup remains available manually.');
      return;
    }
    if (!stored) return;
    const handoff = parseLicensingStoreHandoff(stored);
    if (!handoff) {
      window.sessionStorage.removeItem(LICENSING_STORE_HANDOFF_KEY);
      setLicensingHandoffMessage('The temporary licensing handoff was invalid or outdated and was discarded. Store setup remains available manually.');
      return;
    }
    setLicensingHandoff(handoff);
    setLicensingHandoffActive(true);
    if (!paypalStatus?.guildId) return;
    if (handoff.guildId !== paypalStatus.guildId) {
      window.sessionStorage.removeItem(LICENSING_STORE_HANDOFF_KEY);
      setLicensingHandoff(null);
      setLicensingHandoffActive(false);
      setLicensingHandoffMessage('The temporary licensing handoff belonged to a different server and was discarded. Store setup remains available manually.');
      return;
    }
    if (handoff.recovery) {
      setLicenseRecoveryProductId(handoff.recovery.productId);
      setLicensingHandoffMessage('The preserved product was restored from this tab. Product creation is locked so retry cannot create a duplicate.');
      setShowForm(false);
      const restoreProduct = async () => {
        try {
          const response = await fetch('/api/store/products');
          const body: { success?: boolean; data?: Product[] } = await response.json();
          const product = body.data?.find((candidate) => candidate.id === handoff.recovery?.productId);
          if (!response.ok || body.success === false || !body.data || !product) {
            throw new Error('recovery product not found');
          }
          setProducts(body.data);
          setIntegrationProduct(product);
          const desiredPolicy = readCompletedProjectPolicy(product.metadata);
          const policyPending = hasPendingCompletedProjectPolicy(product.metadata);
          if (desiredPolicy) {
            setLicenseKeyPrefix(desiredPolicy.keyPrefix);
            setLicenseMaxDevices(desiredPolicy.maxDevices);
            setLicenseHeartbeatMs(desiredPolicy.heartbeatIntervalMs);
            setLicenseSdkCacheTtlMs(desiredPolicy.sdkCacheTtlMs);
            setLicenseOfflineGraceSeconds(desiredPolicy.offlineGracePeriodSeconds);
            setLicenseFeatureFlags(desiredPolicy.featureFlags.join(', '));
            setLicenseRequireMembership(desiredPolicy.requireDiscordGuildMembership);
            setRotationPolicy(desiredPolicy.rotationPolicy);
            setSelfServiceDeviceRemoval(desiredPolicy.selfServiceDeviceRemoval);
          }
          const planRecovery = readPlanRecovery(product.metadata);
          if (planRecovery) {
            setPendingPlanRecovery(planRecovery);
            setIntegrationRecovery({
              kind: 'plan',
              message: 'This inactive product still needs its subscription plan and license policy. Retry resumes the preserved setup without creating a duplicate.',
            });
          } else {
            const savedConfig = licenseConfigForProduct(product);
            if (!policyPending && desiredPolicy && savedConfig && licenseConfigMatchesDesiredPolicy(savedConfig, desiredPolicy)) {
              clearLicensingHandoff();
              setIntegrationRecovery(null);
              setLicensingHandoffMessage('The preserved product setup was already complete, so the stale recovery marker was cleared.');
              return;
            }
            if (!policyPending) {
              setIntegrationRecovery(null);
              setLicensingHandoffMessage('The saved product no longer reports a pending policy, but its authoritative policy could not be matched to this handoff. No automatic retry will overwrite it.');
              return;
            }
            setIntegrationRecovery({
              kind: 'license',
              message: 'This inactive product still needs its requested license policy. Retry and verify the saved policy before activation.',
            });
          }
        } catch {
          setLicensingHandoffMessage('The preserved product could not be reloaded. Creation remains locked; retry after the Store product list is available.');
        }
      };
      void restoreProduct();
      return;
    }
    let prefill: ReturnType<typeof promptEnvelopeToStorePrefill>;
    try {
      prefill = promptEnvelopeToStorePrefill(handoff.envelope, handoff.capabilities);
    } catch {
      window.sessionStorage.removeItem(LICENSING_STORE_HANDOFF_KEY);
      setLicensingHandoff(null);
      setLicensingHandoffActive(false);
      setLicensingHandoffMessage('The temporary licensing handoff contained values the Store cannot save and was discarded. Store setup remains available manually.');
      return;
    }
    setForm({
      ...emptyForm,
      name: prefill.name,
      description: prefill.customerDescription,
      type: prefill.billingType ?? 'one_time',
      delivery_type: prefill.deliveryType,
      price_dollars: prefill.billingType === 'free' ? '0.00' : '',
      active: false,
    });
    setLicenseMaxDevices(prefill.maxDevices);
    setLicenseHeartbeatMs(prefill.heartbeatIntervalMs);
    setLicenseOfflineGraceSeconds(prefill.offlineGracePeriodSeconds);
    setLicenseFeatureFlags(prefill.featureFlags.join(', '));
    setLicensingPlanNotes(prefill.planNotes);
    setLicensingPrivateContext(prefill.privateIntegrationContext);
    setLicensingCapabilities(prefill.capabilities);
    setLicensingRails(handoff.envelope.rails);
    const stablePlanId = handoff.subscriptionPlanId ?? crypto.randomUUID();
    setSubscriptionPlanId(stablePlanId);
    if (!handoff.subscriptionPlanId) {
      const persistedHandoff = {
        ...handoff,
        subscriptionPlanId: stablePlanId,
      };
      window.sessionStorage.setItem(
        LICENSING_STORE_HANDOFF_KEY,
        serializeLicensingStoreHandoff(
          handoff.envelope,
          handoff.guildId,
          handoff.recovery,
          handoff.creationRequestId,
          handoff.capabilities,
          stablePlanId,
        ),
      );
      setLicensingHandoff(persistedHandoff);
    }
    setBillingChoiceRequired(prefill.billingChoiceRequired);
    setLicensingHandoffMessage('Private integration context and capability controls were loaded from this tab. Write the separate customer-facing description before creating the inactive product.');
    setEditingId(null);
    setEditingOriginalDeliveryType(null);
    setShowForm(true);
  }, [clearLicensingHandoff, paypalStatus?.guildId]);

  const openCreate = () => {
    if (integrationRecovery || licenseRecoveryProductId) {
      toast({ title: 'Finish the preserved product setup before creating another product', variant: 'error' });
      return;
    }
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
    setSubscriptionPlanId(crypto.randomUUID());
    setIntegrationRecovery(null);
    setPendingCreateRequestId(null);
    setPendingPlanRecovery(null);
    setBillingChoiceRequired(false);
    setLicensingPlanNotes('');
    setLicensingPrivateContext('');
    setLicensingCapabilities([]);
    setLicensingRails(null);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (p: Product) => {
    setBillingChoiceRequired(false);
    setLicensingPlanNotes('');
    setLicensingHandoffActive(false);
    setLicensingHandoffMessage('');
    const completedProject = readCompletedProjectLicensingMetadata(p.metadata);
    setLicensingPrivateContext(
      completedProject?.privateIntegrationContext || completedProject?.projectContext || '',
    );
    setLicensingCapabilities(completedProject?.capabilities ?? []);
    setLicensingRails(completedProject?.rails ?? null);
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
    const licenseConfig = licenseConfigForProduct(p);
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
    setEditingOriginalDeliveryType(p.delivery_type);
    setIntegrationProduct(p);
    setPlanDraft(p.plans?.[0] ?? { ...emptyPlan, currency: p.currency, price_cents: p.price_cents });
    setSubscriptionPlanId(p.plans?.[0]?.id ?? crypto.randomUUID());
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

  const effectiveLicenseFeatureFlags = (): string[] => {
    const parsed = licensingCapabilitiesSchema.safeParse(licensingCapabilities);
    if (parsed.success && parsed.data.length > 0) {
      return parsed.data.map((capability) => capability.key);
    }
    return licenseFeatureFlags.split(',').map((flag) => flag.trim()).filter(Boolean);
  };

  const saveLicensePolicy = async (
    productId: string,
    desiredPolicy: NonNullable<ReturnType<typeof readCompletedProjectPolicy>> = {
      keyPrefix: licenseKeyPrefix,
      maxDevices: licenseMaxDevices,
      heartbeatIntervalMs: licenseHeartbeatMs,
      sdkCacheTtlMs: licenseSdkCacheTtlMs,
      offlineGracePeriodSeconds: licenseOfflineGraceSeconds,
      featureFlags: effectiveLicenseFeatureFlags(),
      requireDiscordGuildMembership: licenseRequireMembership,
      rotationPolicy,
      selfServiceDeviceRemoval,
    },
  ): Promise<string | null> => {
    const configRes = await fetch(`/api/license/config/${productId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLicensePolicySaveRequest(desiredPolicy)),
    });
    if (configRes.ok) return null;
    const result: { error?: string } = await configRes.json();
    return result.error ?? 'The license policy could not be saved.';
  };

  const licensePolicyMatches = (product: Product): boolean => {
    const config = licenseConfigForProduct(product);
    if (!config) return false;
    const expectedFlags = effectiveLicenseFeatureFlags();
    return product.active === false
      && config.key_prefix === licenseKeyPrefix
      && config.max_devices === licenseMaxDevices
      && config.heartbeat_interval_seconds * 1000 === licenseHeartbeatMs
      && config.sdk_cache_ttl_ms === licenseSdkCacheTtlMs
      && config.offline_grace_period_seconds === licenseOfflineGraceSeconds
      && JSON.stringify(config.feature_flags) === JSON.stringify(expectedFlags)
      && config.require_discord_guild_membership === licenseRequireMembership
      && config.rotation_policy === rotationPolicy
      && config.self_service_device_removal === selfServiceDeviceRemoval
      && !hasPendingCompletedProjectPolicy(product.metadata);
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
        setPendingPlanRecovery(null);
        if (hasPendingCompletedProjectPolicy(verifiedProduct.metadata)) {
          setLicenseRecoveryProductId(verifiedProduct.id);
          setIntegrationRecovery({
            kind: 'license',
            message: 'The subscription plan is saved. The preserved license policy still needs to be saved and verified before activation.',
          });
          toast({ title: 'Subscription plan saved; license policy retry remains', variant: 'success' });
          return;
        }
        setLicenseRecoveryProductId(null);
        setIntegrationRecovery(null);
        if (licensingHandoffActive) clearLicensingHandoff();
        toast({ title: 'Subscription plan saved and verified', variant: 'success' });
        return;
      }

      const desiredPolicy = readCompletedProjectPolicy(integrationProduct.metadata);
      if (!desiredPolicy) {
        setIntegrationRecovery({ kind: 'license', message: 'The saved product has no recoverable desired license policy. Reload the product before retrying.' });
        return;
      }
      const policyError = await saveLicensePolicy(integrationProduct.id, desiredPolicy);
      setIntegrationRecovery(policyError ? { kind: 'license', message: policyError } : null);
      if (!policyError) {
        const verifiedProduct = await readbackProduct(integrationProduct.id);
        const verifiedConfig = verifiedProduct ? licenseConfigForProduct(verifiedProduct) : null;
        if (!verifiedProduct || verifiedProduct.active || hasPendingCompletedProjectPolicy(verifiedProduct.metadata)
          || !verifiedConfig || !licenseConfigMatchesDesiredPolicy(verifiedConfig, desiredPolicy)) {
          setIntegrationRecovery({
            kind: 'license',
            message: 'The license policy save returned, but authoritative readback did not match. Retry safely.',
          });
          return;
        }
        setLicenseRecoveryProductId(null);
        if (licensingHandoffActive) clearLicensingHandoff();
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
    if (billingChoiceRequired && !editingId) {
      toast({ title: 'Choose a Store billing model before creating this product', variant: 'error' });
      return;
    }
    const priceCents = form.type === 'free' ? 0 : Math.round((parseFloat(form.price_dollars) || 0) * 100);
    if (priceCents < 0) {
      toast({ title: 'Price cannot be negative', variant: 'error' });
      return;
    }
    if (!form.currency.trim()) {
      toast({ title: 'Currency is required', variant: 'error' });
      return;
    }
    if (form.delivery_type === 'license_key' && !/^[A-Z]{2,8}$/.test(licenseKeyPrefix)) {
      toast({ title: 'License key prefix must contain 2 to 8 uppercase letters', variant: 'error' });
      return;
    }
    const parsedCapabilities = licensingCapabilitiesSchema.safeParse(licensingCapabilities);
    if (!parsedCapabilities.success) {
      toast({ title: parsedCapabilities.error.issues[0]?.message ?? 'Review the licensing capabilities', variant: 'error' });
      return;
    }
    let resolvedCapabilities: LicensingCapability[];
    try {
      resolvedCapabilities = resolveCapabilityPlanGrants(
        parsedCapabilities.data,
        form.type === 'subscription'
          ? [{ id: subscriptionPlanId, name: planDraft.name }]
          : [],
      );
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : 'Every capability grant must resolve to a saved plan',
        variant: 'error',
      });
      return;
    }
    const capabilityFeatureFlags = resolvedCapabilities.map((capability) => capability.key);
    const policyFeatureFlags = capabilityFeatureFlags.length > 0
      ? capabilityFeatureFlags
      : licenseFeatureFlags.split(',').map((flag) => flag.trim()).filter(Boolean);

    const convertingToDynamic = editingId !== null
      && editingOriginalDeliveryType !== 'license_key'
      && form.delivery_type === 'license_key';
    const existingCompletedProject = editingId
      ? readCompletedProjectLicensingMetadata(integrationProduct?.metadata)
      : null;
    const createRequestId = editingId
      ? null
      : licensingHandoff?.creationRequestId ?? pendingCreateRequestId ?? crypto.randomUUID();
    if (createRequestId) setPendingCreateRequestId(createRequestId);
    let preservedProductId: string | null = createRequestId;
    let productResponseReceived = false;
    setSaving(true);
    try {
      const payload = prepareStoreProductSave({
        ...(createRequestId ? { id: createRequestId } : {}),
        ...(editingId ? { id: editingId } : {}),
        name: form.name,
        description: form.description || null,
        type: form.type,
        delivery_type: form.delivery_type,
        price_cents: priceCents,
        currency: form.currency.toUpperCase(),
        granted_role_ids: form.granted_role_ids,
        granted_channel_ids: form.granted_channel_ids,
        active: editingId ? form.active : false,
        ...(form.type === 'subscription' && !editingId ? {
          plans: [{ id: subscriptionPlanId, ...planDraft, currency: form.currency.toUpperCase() }],
        } : {}),
        ...((form.delivery_type === 'license_key' || (!editingId && licensingHandoff) || convertingToDynamic) ? {
          metadata: {
            completed_project_licensing: {
              plansAndFeatures: licensingHandoff?.envelope.billing.plansAndFeatures ?? existingCompletedProject?.plansAndFeatures ?? '',
              privateIntegrationContext: licensingPrivateContext,
              outputFormats: licensingHandoff?.envelope.staticPolicy?.outputFormats ?? existingCompletedProject?.outputFormats ?? '',
              installationIdentity: licensingHandoff?.envelope.dynamicPolicy?.installationIdentity ?? existingCompletedProject?.installationIdentity ?? '',
              capabilities: resolvedCapabilities,
              rails: licensingRails ?? {
                runtimeLicensing: form.delivery_type === 'license_key',
                downloadableFiles: form.delivery_type === 'file' || form.delivery_type === 'mixed',
                hostedAccess: form.delivery_type === 'link' || form.delivery_type === 'access_pass',
                discordRoles: form.granted_role_ids.length > 0 || form.granted_channel_ids.length > 0,
                updates: false,
              },
              policyPending: form.delivery_type === 'license_key',
              ...(form.delivery_type === 'license_key' ? {
                desiredPolicy: {
                  keyPrefix: licenseKeyPrefix,
                  maxDevices: licenseMaxDevices,
                  heartbeatIntervalMs: licenseHeartbeatMs,
                  sdkCacheTtlMs: licenseSdkCacheTtlMs,
                  offlineGracePeriodSeconds: licenseOfflineGraceSeconds,
                  featureFlags: policyFeatureFlags,
                  requireDiscordGuildMembership: licenseRequireMembership,
                  rotationPolicy,
                  selfServiceDeviceRemoval,
                },
              } : {}),
            },
          },
        } : {}),
      });

      const res = await fetch('/api/store/products', {
        method: editingId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(createRequestId ? { 'x-request-id': createRequestId } : {}),
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      productResponseReceived = true;
      const productId = json.data?.id ?? editingId;
      preservedProductId = typeof productId === 'string' ? productId : null;
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
            persistLicenseRecovery(productId, planRecovery ? 'setup' : 'license');
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
          persistLicenseRecovery(productId);
          setIntegrationRecovery({ kind: 'license', message: policyError });
          setShowForm(false);
          toast({ title: 'Product saved, but license policy was not saved', variant: 'error' });
          return;
        }
      }
      const verifiedProduct = productId ? await readbackProduct(productId) : null;
      if (!productId || !verifiedProduct || (form.delivery_type === 'license_key' && !licensePolicyMatches(verifiedProduct))) {
        if (productId && form.delivery_type === 'license_key') {
          persistLicenseRecovery(productId);
          setIntegrationRecovery({
            kind: 'license',
            message: 'The license policy may have been saved, but authoritative product readback failed. Retry safely before activation.',
          });
          setShowForm(false);
        }
        toast({ title: 'Product saved, but authoritative readback failed', variant: 'error' });
        return;
      }
      setIntegrationRecovery(null);
      setPendingCreateRequestId(null);
      setPendingPlanRecovery(null);
      if (!editingId && licensingHandoffActive) clearLicensingHandoff();
      setShowForm(false);
      toast({ title: editingId
        ? form.delivery_type === 'license_key' ? 'Product updated and verified; activate it from the Store when ready' : 'Product updated and verified'
        : 'Product created and verified', variant: 'success' });
    } catch {
      if (preservedProductId && form.delivery_type === 'license_key' && productResponseReceived) {
        persistLicenseRecovery(preservedProductId);
        setIntegrationRecovery({
          kind: 'license',
          message: 'The product was saved, but policy verification lost contact with the dashboard API. Retry the preserved policy before activation.',
        });
        setShowForm(false);
        toast({ title: 'Product preserved; license policy needs a retry', variant: 'error' });
      } else if (preservedProductId) {
        toast({ title: 'The response was interrupted. Retry is safe and will reuse the same product request.', variant: 'error' });
      } else {
        toast({ title: 'Network error — could not save product', variant: 'error' });
      }
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
    if (!p.active && (licenseRecoveryProductId === p.id || hasPendingCompletedProjectPolicy(p.metadata))) {
      toast({ title: 'Retry and verify the requested license policy before activation', variant: 'error' });
      return;
    }
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
  const unresolvedHandoffBilling = billingChoiceRequired && editingId === null;
  const formProductTypeOptions = unresolvedHandoffBilling
    ? [{ value: '', label: 'Choose billing model' }, ...availableProductTypeOptions]
    : availableProductTypeOptions;
  const updateCapability = (index: number, values: Partial<LicensingCapability>) => {
    setLicensingCapabilities((current) => current.map((capability, capabilityIndex) => (
      capabilityIndex === index ? { ...capability, ...values } : capability
    )));
  };
  const addCapability = () => {
    const nextIndex = Array.from({ length: 101 }, (_, index) => index + 1)
      .find((index) => !licensingCapabilities.some((capability) => capability.key === `capability-${index}`))
      ?? licensingCapabilities.length + 1;
    setLicensingCapabilities((current) => [...current, {
      key: `capability-${nextIndex}`,
      name: `Capability ${nextIndex}`,
      behavioralMeaning: 'Describe the customer-visible value this capability unlocks.',
      controlledFunctionality: 'List the exact operations, screens, commands, or services controlled by this capability.',
      grantingPlans: [],
      unavailableBehavior: 'Keep unrelated features and customer data available; refuse only this capability.',
      dependencyKeys: [],
    }]);
  };
  const addGrantingPlan = (capabilityIndex: number) => {
    const capability = licensingCapabilities[capabilityIndex];
    if (!capability) return;
    const normalizedName = planDraft.name.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const planKey = /^[a-z]/.test(normalizedName) ? normalizedName : `plan-${normalizedName || 'standard'}`;
    updateCapability(capabilityIndex, {
      grantingPlans: [...capability.grantingPlans, {
        key: planKey,
        name: planDraft.name,
        ...(form.type === 'subscription' && subscriptionPlanId ? { planId: subscriptionPlanId } : {}),
      }],
    });
  };
  const cancelProductForm = () => {
    if (licensingHandoffActive) clearLicensingHandoff();
    setShowForm(false);
    setEditingOriginalDeliveryType(null);
  };

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
        <Button
          onClick={openCreate}
          disabled={integrationRecovery !== null || licenseRecoveryProductId !== null}
          title={integrationRecovery || licenseRecoveryProductId ? 'Finish the preserved product setup first' : undefined}
        >
          New Product
        </Button>
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
      <CommerceOperationsCenter />

      <PayPalOnboardingStatusPanel onStatus={setPaypalStatus} />

      {licensingHandoffMessage && (
        <p className={`rounded-input border p-3 text-sm ${licensingHandoffActive ? 'border-discord-accent/40 bg-discord-accent/10 text-discord-text-secondary' : 'border-discord-warning/40 bg-discord-warning/10 text-discord-warning'}`} role={licensingHandoffActive ? 'status' : 'alert'}>
          {licensingHandoffMessage}
        </p>
      )}

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
            <Select id="product-type" label="Type" value={unresolvedHandoffBilling ? '' : form.type} onChange={(event) => { const value = event.target.value; if (value !== 'one_time' && value !== 'subscription' && value !== 'free') return; setBillingChoiceRequired(false); setForm({ ...form, type: value, price_dollars: value === 'free' ? '0.00' : form.price_dollars }); }} options={formProductTypeOptions} />
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
              {(licensingHandoffActive || licensingPrivateContext) && (
                <div className="mb-4 rounded-card border border-discord-accent/40 bg-discord-bg-tertiary/60 p-4">
                  <label htmlFor="private-integration-context" className="block text-sm font-medium text-discord-text-primary">
                    Private integration context
                  </label>
                  <p id="private-integration-context-help" className="mt-1 text-xs text-discord-text-muted">
                    Internal agent and architecture guidance. Stored in product metadata for prompt regeneration; never shown as Store copy.
                  </p>
                  <textarea
                    id="private-integration-context"
                    aria-describedby="private-integration-context-help"
                    value={licensingPrivateContext}
                    onChange={(event) => setLicensingPrivateContext(event.target.value)}
                    rows={5}
                    className="mt-3 w-full resize-y rounded-input border border-discord-border-subtle bg-discord-bg-primary px-3 py-2 text-sm text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent"
                  />
                </div>
              )}
              <label htmlFor="product-description" className="mb-1 block text-xs font-medium text-discord-text-muted">
                Customer-facing Store description
              </label>
              <textarea
                id="product-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary outline-none resize-none"
                placeholder="Explain what the customer receives and why it is useful."
              />
              {licensingHandoffActive && <p className="mt-1 text-xs text-discord-warning" role="status">This starts blank intentionally. Write customer-facing copy here; private architecture notes are kept above.</p>}
            </div>
            {licensingPlanNotes && (
              <div className="sm:col-span-2 rounded-input border border-discord-warning/40 bg-discord-warning/10 p-3 text-sm text-discord-text-secondary">
                <strong className="text-discord-warning">Plan notes to review:</strong> {licensingPlanNotes}
              </div>
            )}
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
            {form.delivery_type === 'license_key' && (
              <section className="sm:col-span-2 space-y-3" aria-labelledby="licensing-capabilities-title">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="licensing-capabilities-title" className="text-sm font-semibold text-discord-text-primary">Licensed capabilities</h3>
                    <p className="mt-1 text-xs text-discord-text-muted">Each stable key controls explicit functionality. Plan grants resolve to the saved plan identity before activation; dependencies are never inferred from names or notes.</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={addCapability}>Add capability</Button>
                </div>
                {licensingCapabilities.length === 0 ? (
                  <p className="rounded-input border border-discord-border-subtle bg-discord-bg-primary/60 p-3 text-xs text-discord-text-muted">No structured capabilities. Add one for every independently licensed behavior, or keep the product all-or-nothing.</p>
                ) : licensingCapabilities.map((capability, capabilityIndex) => (
                  <article key={capabilityIndex} className="rounded-card border border-discord-border-subtle bg-discord-bg-primary/60 p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        id={`capability-key-${capabilityIndex}`}
                        label="Stable capability key"
                        value={capability.key}
                        disabled={editingId !== null}
                        onChange={(event) => updateCapability(capabilityIndex, { key: event.target.value.trim().toLowerCase() })}
                        placeholder="exports"
                      />
                      <Input
                        id={`capability-name-${capabilityIndex}`}
                        label="Customer-readable name"
                        value={capability.name}
                        onChange={(event) => updateCapability(capabilityIndex, { name: event.target.value })}
                        placeholder="Data exports"
                      />
                      <div className="sm:col-span-2">
                        <label htmlFor={`capability-meaning-${capabilityIndex}`} className="mb-1 block text-xs font-medium text-discord-text-muted">Behavioral meaning</label>
                        <textarea id={`capability-meaning-${capabilityIndex}`} value={capability.behavioralMeaning} onChange={(event) => updateCapability(capabilityIndex, { behavioralMeaning: event.target.value })} rows={2} className="w-full resize-y rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent" />
                      </div>
                      <div className="sm:col-span-2">
                        <label htmlFor={`capability-functionality-${capabilityIndex}`} className="mb-1 block text-xs font-medium text-discord-text-muted">Controlled functionality</label>
                        <textarea id={`capability-functionality-${capabilityIndex}`} value={capability.controlledFunctionality} onChange={(event) => updateCapability(capabilityIndex, { controlledFunctionality: event.target.value })} rows={2} className="w-full resize-y rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent" />
                      </div>
                      <div className="sm:col-span-2">
                        <label htmlFor={`capability-unavailable-${capabilityIndex}`} className="mb-1 block text-xs font-medium text-discord-text-muted">Unavailable behavior</label>
                        <textarea id={`capability-unavailable-${capabilityIndex}`} value={capability.unavailableBehavior} onChange={(event) => updateCapability(capabilityIndex, { unavailableBehavior: event.target.value })} rows={2} className="w-full resize-y rounded-input border border-discord-border-subtle bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent" />
                      </div>
                      <Input
                        id={`capability-dependencies-${capabilityIndex}`}
                        label="Dependency keys"
                        value={capability.dependencyKeys.join(', ')}
                        onChange={(event) => updateCapability(capabilityIndex, { dependencyKeys: event.target.value.split(',').map((key) => key.trim()).filter(Boolean) })}
                        placeholder="core-data, hosted-api"
                      />
                      <div className="flex items-end justify-end">
                        <Button size="sm" variant="danger" onClick={() => setLicensingCapabilities((current) => current.filter((_, index) => index !== capabilityIndex))}>Remove capability</Button>
                      </div>
                    </div>
                    <div className="mt-4 space-y-2 border-t border-discord-border-subtle pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-medium text-discord-text-secondary">Granting plans</h4>
                        <Button size="sm" variant="ghost" onClick={() => addGrantingPlan(capabilityIndex)}>Add granting plan</Button>
                      </div>
                      {capability.grantingPlans.length === 0 ? (
                        <p className="text-xs text-discord-text-muted">Available to every active entitlement. Add a granting plan to restrict this capability.</p>
                      ) : capability.grantingPlans.map((plan, planIndex) => (
                        <div key={planIndex} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                          <Input id={`capability-${capabilityIndex}-plan-key-${planIndex}`} label="Plan key" value={plan.key} onChange={(event) => updateCapability(capabilityIndex, { grantingPlans: capability.grantingPlans.map((currentPlan, index) => index === planIndex ? { ...currentPlan, key: event.target.value.trim().toLowerCase() } : currentPlan) })} placeholder="pro-annual" />
                          <Input id={`capability-${capabilityIndex}-plan-name-${planIndex}`} label="Plan name" value={plan.name} onChange={(event) => updateCapability(capabilityIndex, { grantingPlans: capability.grantingPlans.map((currentPlan, index) => index === planIndex ? { ...currentPlan, name: event.target.value } : currentPlan) })} placeholder="Pro annual" />
                          <div className="flex items-end"><Button size="sm" variant="ghost" onClick={() => updateCapability(capabilityIndex, { grantingPlans: capability.grantingPlans.filter((_, index) => index !== planIndex) })}>Remove</Button></div>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
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
            {editingId && form.delivery_type === 'license_key' ? (
              <p className="self-end rounded-input border border-discord-border-subtle bg-discord-bg-primary/60 px-3 py-2 text-xs text-discord-text-secondary">Saving integration settings pauses this product. It stays inactive while the requested license policy is saved and verified. Activate it separately from the Store after verification.</p>
            ) : editingId ? (
              <div className="pt-5"><Toggle label="Active" checked={form.active} onChange={(active) => setForm({ ...form, active })} /></div>
            ) : (
              <p className="self-end rounded-input border border-discord-border-subtle bg-discord-bg-primary/60 px-3 py-2 text-xs text-discord-text-secondary">New products are created inactive. Activate this product from the Store only after its saved policy is verified.</p>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <Button
              variant="success"
              onClick={() => {
                if (form.delivery_type === 'license_key' && products.some((product) => product.id === editingId && product.active)) {
                  setConfirmPolicySave(true);
                } else {
                  void save();
                }
              }}
              disabled={saving || !form.name || unresolvedHandoffBilling || integrationRecovery !== null || licenseRecoveryProductId !== null}
            >
              {saving ? 'Saving…' : editingId ? form.delivery_type === 'license_key' ? 'Save policy' : 'Update' : 'Create'}
            </Button>
            <Button
              variant="secondary"
              onClick={cancelProductForm}
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
            const activationLocked = !p.active
              && (licenseRecoveryProductId === p.id || hasPendingCompletedProjectPolicy(p.metadata));
            return (
              <StoreProductCard
                key={p.id}
                product={p}
                licensed={licenseConfigForProduct(p) !== null}
                activationLocked={activationLocked}
                actions={{
                  onToggleActive: () => toggleActive(p),
                  onOpenFiles: () => { setFilesProductId(p.id); setFilesProductName(p.name); },
                  onEdit: () => openEdit(p),
                  onDelete: () => setConfirmDelete({ id: p.id, name: p.name }),
                }}
              />
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

      <ConfirmDialog
        open={confirmPolicySave}
        title="Pause product and save integration settings?"
        description={`Saving changes to "${form.name}" stops new sales while its license policy is saved and verified. Existing entitlements are preserved. The product stays inactive until you activate it separately from the Store.`}
        confirmLabel="Pause and save"
        variant="warning"
        onConfirm={async () => {
          setConfirmPolicySave(false);
          await save();
        }}
        onCancel={() => setConfirmPolicySave(false)}
      />
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
