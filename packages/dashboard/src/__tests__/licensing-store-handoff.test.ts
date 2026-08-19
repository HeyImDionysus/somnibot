import { describe, expect, it } from 'vitest';
import {
  LICENSING_STORE_HANDOFF_KEY,
  hasPendingCompletedProjectPolicy,
  parseLicensingStoreHandoff,
  promptEnvelopeToStorePrefill,
  savedProductToLicensingDraft,
  serializeLicensingStoreHandoff,
} from '@/lib/store/licensing-handoff';
import { buildLicensingPromptEnvelope, type LicensingPromptDraft } from '@/lib/store/licensing-prompt';

const draft: LicensingPromptDraft = {
  mode: 'dynamic',
  projectName: 'Completed Sentinel',
  projectContext: 'An already-completed Rust server plugin whose behavior must be preserved.',
  productId: '',
  apiBase: 'https://somnibot.example/api',
  billingModel: 'multiple',
  plansAndFeatures: 'Monthly Standard and annual Pro require owner review.',
  featureFlags: 'alerts, exports, alerts',
  outputFormats: '',
  installationIdentity: 'One dedicated server deployment',
  maxInstallations: 3,
  heartbeatSeconds: 300,
  offlineGraceSeconds: 86_400,
};

describe('completed project licensing Store handoff', () => {
  it('uses a fixed versioned browser-session contract', () => {
    const envelope = buildLicensingPromptEnvelope(draft);
    const serialized = serializeLicensingStoreHandoff(envelope, 'guild-qa');

    expect(LICENSING_STORE_HANDOFF_KEY).toContain('v1');
    expect(parseLicensingStoreHandoff(serialized)).toEqual({
      schemaVersion: 1,
      guildId: 'guild-qa',
      envelope,
    });
    expect(parseLicensingStoreHandoff('{"schemaVersion":2}')).toBeNull();
    expect(parseLicensingStoreHandoff(JSON.stringify({ schemaVersion: 1, envelope }))).toBeNull();
    expect(parseLicensingStoreHandoff('not-json')).toBeNull();
  });

  it('preserves the created product identity for reload-safe policy recovery', () => {
    const envelope = buildLicensingPromptEnvelope(draft);
    const recovery = { kind: 'license' as const, productId: 'product-preserved-after-create' };

    expect(parseLicensingStoreHandoff(serializeLicensingStoreHandoff(envelope, 'guild-qa', recovery))).toEqual({
      schemaVersion: 1,
      guildId: 'guild-qa',
      envelope,
      recovery,
    });
  });

  it('preserves one stable product-creation request across response-loss retries', () => {
    const envelope = buildLicensingPromptEnvelope(draft);
    const creationRequestId = '00000000-0000-4000-8000-000000000431';

    expect(parseLicensingStoreHandoff(
      serializeLicensingStoreHandoff(envelope, 'guild-qa', undefined, creationRequestId),
    )).toMatchObject({ creationRequestId });
  });

  it.each([
    ['dynamic', 'license_key'],
    ['static', 'file'],
  ] as const)('maps %s projects to %s delivery without policy unit drift', (mode, deliveryType) => {
    const envelope = buildLicensingPromptEnvelope({
      ...draft,
      mode,
      outputFormats: mode === 'static' ? 'PDF and ZIP' : '',
    });
    const prefill = promptEnvelopeToStorePrefill(envelope);

    expect(prefill).toMatchObject({
      name: 'Completed Sentinel',
      description: draft.projectContext,
      deliveryType,
      billingType: 'subscription',
      billingChoiceRequired: false,
      active: false,
      planNotes: draft.plansAndFeatures,
      maxDevices: 3,
      heartbeatIntervalMs: 300_000,
      offlineGracePeriodSeconds: 86_400,
      featureFlags: mode === 'dynamic' ? ['alerts', 'exports'] : [],
    });
  });

  it.each([
    ['one_time', 'one_time', false],
    ['subscription', 'subscription', false],
    ['multiple', 'subscription', false],
    ['free', 'free', false],
    ['undecided', null, true],
  ] as const)('maps %s billing to an explicit Store choice', (billingModel, billingType, billingChoiceRequired) => {
    const envelope = buildLicensingPromptEnvelope({ ...draft, billingModel });
    expect(promptEnvelopeToStorePrefill(envelope)).toMatchObject({ billingType, billingChoiceRequired });
  });

  it('maps authoritative saved product policy back into the final prompt draft', () => {
    const mapped = savedProductToLicensingDraft({
      id: '00000000-0000-4000-8000-000000000123',
      name: 'Saved Sentinel',
      description: 'Customer-facing saved description.',
      type: 'free',
      delivery_type: 'license_key',
      product_license_config: [{
        max_devices: 5,
        heartbeat_interval_seconds: 120,
        offline_grace_period_seconds: 7200,
        feature_flags: ['exports', 'priority'],
      }],
      plans: [{
        name: 'Annual Pro',
        interval_unit: 'YEAR',
        interval_count: 1,
        price_cents: 12000,
        currency: 'USD',
        trial_days: 14,
        active: true,
      }],
      metadata: {
        completed_project_licensing: {
          projectContext: 'Original Rust architecture and packaging constraints.',
          installationIdentity: 'One licensed production node',
        },
      },
    }, 'https://somnibot.example/api');

    expect(mapped).toMatchObject({
      mode: 'dynamic',
      projectName: 'Saved Sentinel',
      projectContext: 'Original Rust architecture and packaging constraints.',
      productId: '00000000-0000-4000-8000-000000000123',
      apiBase: 'https://somnibot.example/api',
      billingModel: 'free',
      maxInstallations: 5,
      heartbeatSeconds: 120,
      offlineGraceSeconds: 7200,
      featureFlags: 'exports, priority',
      installationIdentity: 'One licensed production node',
      plansAndFeatures: 'Annual Pro: 120.00 USD every 1 year(s), 14 trial day(s)',
    });
  });

  it('accepts the authoritative one-to-one license policy object shape', () => {
    const mapped = savedProductToLicensingDraft({
      id: '00000000-0000-4000-8000-000000000126',
      name: 'One-to-one policy',
      description: 'Saved dynamic product.',
      type: 'one_time',
      delivery_type: 'license_key',
      product_license_config: {
        max_devices: 4,
        heartbeat_interval_seconds: 180,
        offline_grace_period_seconds: 3600,
        feature_flags: ['priority'],
      },
    }, 'https://somnibot.example/api');

    expect(mapped).toMatchObject({
      maxInstallations: 4,
      heartbeatSeconds: 180,
      offlineGraceSeconds: 3600,
      featureFlags: 'priority',
    });
  });

  it('accepts a legacy saved heartbeat but refuses to hand that value into a new Store save', () => {
    const legacy = buildLicensingPromptEnvelope({ ...draft, heartbeatSeconds: 30 });
    expect(legacy.dynamicPolicy?.heartbeatSeconds).toBe(30);
    expect(() => promptEnvelopeToStorePrefill(legacy)).toThrow('at least 60 seconds');

    expect(savedProductToLicensingDraft({
      id: '00000000-0000-4000-8000-000000000127',
      name: 'Legacy heartbeat product',
      description: 'Saved before the current Store minimum.',
      type: 'one_time',
      delivery_type: 'license_key',
      product_license_config: {
        max_devices: 3,
        heartbeat_interval_seconds: 30,
        offline_grace_period_seconds: 3600,
        feature_flags: [],
      },
    }, 'https://somnibot.example/api').heartbeatSeconds).toBe(30);
  });

  it('uses saved file names and reviewed fallback formats without inventing static delivery details', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000124',
      name: 'Saved static project',
      description: 'Customer-facing saved description.',
      type: 'one_time',
      delivery_type: 'file',
      metadata: {
        completed_project_licensing: {
          plansAndFeatures: '',
          outputFormats: 'PDF and ZIP',
          policyPending: false,
        },
      },
    };

    expect(savedProductToLicensingDraft(base, 'https://somnibot.example/api').outputFormats).toBe('PDF and ZIP');
    expect(savedProductToLicensingDraft({
      ...base,
      product_files: [{ display_name: 'Owner Guide.pdf' }, { file_name: 'archive.zip' }],
    }, 'https://somnibot.example/api').outputFormats).toBe('Owner Guide.pdf, archive.zip');
  });

  it('rejects a dynamic product without an actual saved policy and detects pending activation state', () => {
    expect(() => savedProductToLicensingDraft({
      id: '00000000-0000-4000-8000-000000000125',
      name: 'Incomplete dynamic product',
      description: null,
      type: 'subscription',
      delivery_type: 'license_key',
      product_license_config: [],
    }, 'https://somnibot.example/api')).toThrow('authoritative saved license policy');
    expect(hasPendingCompletedProjectPolicy({
      completed_project_licensing: { policyPending: true },
    })).toBe(true);
  });

  it('rejects malformed authoritative product readback without manufacturing prompt values', () => {
    expect(() => savedProductToLicensingDraft({
      id: '00000000-0000-4000-8000-000000000123',
      name: 'Malformed product',
      type: 'subscription',
      delivery_type: 'license_key',
      product_license_config: [{ max_devices: 'three' }],
    }, 'https://somnibot.example/api')).toThrow();
  });
});
