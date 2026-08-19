import { describe, expect, it } from 'vitest';
import {
  LICENSING_STORE_HANDOFF_KEY,
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
    const serialized = serializeLicensingStoreHandoff(envelope);

    expect(LICENSING_STORE_HANDOFF_KEY).toContain('v1');
    expect(parseLicensingStoreHandoff(serialized)).toEqual({
      schemaVersion: 1,
      envelope,
    });
    expect(parseLicensingStoreHandoff('{"schemaVersion":2}')).toBeNull();
    expect(parseLicensingStoreHandoff('not-json')).toBeNull();
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
    }, 'https://somnibot.example/api');

    expect(mapped).toMatchObject({
      mode: 'dynamic',
      projectName: 'Saved Sentinel',
      projectContext: 'Customer-facing saved description.',
      productId: '00000000-0000-4000-8000-000000000123',
      apiBase: 'https://somnibot.example/api',
      billingModel: 'free',
      maxInstallations: 5,
      heartbeatSeconds: 120,
      offlineGraceSeconds: 7200,
      featureFlags: 'exports, priority',
    });
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
