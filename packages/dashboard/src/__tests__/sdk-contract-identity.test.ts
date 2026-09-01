import { describe, expect, it } from 'vitest';
import {
  buildSdkContractIdentity,
  buildSdkProductPolicyRevision,
  classifySdkIntegrationDrift,
  createSdkIntegrationReceipt,
  mergeSdkIntegrationReceiptMetadata,
  readSdkIntegrationReceiptMetadata,
  SDK_PROTOCOL_VERSION,
  SDK_SCHEMA_VERSION,
} from '@/lib/store/sdk-contract-identity';

const policyInput = {
  storeProductId: '11111111-1111-4111-8111-111111111111',
  billingModel: 'subscription' as const,
  plans: [{ key: 'pro', name: 'Pro', active: true, intervalUnit: 'MONTH', intervalCount: 1 }],
  rails: { runtimeLicensing: true, downloadableFiles: true, hostedAccess: false, discordRoles: true, updates: true },
  dynamicPolicy: {
    licenseMode: 'embedded', keyPrefix: 'SMNI', maxDevices: 3,
    heartbeatIntervalSeconds: 300, sdkCacheTtlMs: 60_000,
    offlineGracePeriodSeconds: 86_400, featureFlags: ['exports', 'reports'], tier: 'pro',
    requireDiscordGuildMembership: true, devicePolicy: 'reject',
    rotationPolicy: 'rotate-and-invalidate', selfServiceDeviceRemoval: true,
    watermarkConfig: null,
  },
  staticPolicy: null,
  capabilities: [{
    key: 'exports', behavioralMeaning: 'Export files', controlledFunctionality: 'export command',
    grantingPlans: ['pro'], unavailableBehavior: 'Export remains disabled', dependencyKeys: ['core'],
  }],
  discordGrants: { roleIds: ['role-2', 'role-1'], channelIds: ['channel-1'] },
};

const baseInput = {
  storeProductId: '11111111-1111-4111-8111-111111111111',
  deploymentOrigin: 'https://store.example.test/',
  productPolicyRevision: `sha256:${'a'.repeat(64)}`,
  contractHash: 'b'.repeat(64),
};

describe('SDK contract identity', () => {
  it('derives a deterministic policy revision from every integration-relevant policy surface', async () => {
    const first = await buildSdkProductPolicyRevision(policyInput);
    const reordered = await buildSdkProductPolicyRevision({
      ...policyInput,
      dynamicPolicy: { ...policyInput.dynamicPolicy, featureFlags: ['reports', 'exports'] },
      discordGrants: { ...policyInput.discordGrants, roleIds: ['role-1', 'role-2'] },
    });
    const changedCapability = await buildSdkProductPolicyRevision({
      ...policyInput,
      capabilities: [{ ...policyInput.capabilities[0], controlledFunctionality: 'export and publish commands' }],
    });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(changedCapability).not.toBe(first);
  });

  it('binds generated contract, policy, product, protocol, and deployment identity', () => {
    const identity = buildSdkContractIdentity(baseInput);
    expect(identity).toEqual({
      contractHash: 'b'.repeat(64),
      sdkSchemaVersion: SDK_SCHEMA_VERSION,
      sdkProtocolVersion: SDK_PROTOCOL_VERSION,
      productPolicyRevision: `sha256:${'a'.repeat(64)}`,
      storeProductId: baseInput.storeProductId,
      deploymentOrigin: 'https://store.example.test',
    });
  });

  it('classifies current, reintegration, unverified, and older-protocol receipts', () => {
    const identity = buildSdkContractIdentity(baseInput);
    const receipt = createSdkIntegrationReceipt(identity, '2026-08-23T12:00:00.000Z', {
      verificationId: 'verification-current',
      issuedBy: 'somnibot-server',
      targetProjectVersion: '2.4.0',
      targetProjectCommit: 'abc1234',
      verificationEnvironment: { kind: 'ci', description: 'Release verification job' },
      capabilitiesExercised: ['exports'],
      remainingUnverifiedRequirements: [],
      integrityResult: 'passed',
      authenticityResult: 'passed',
      conformanceResult: 'passed',
    });

    expect(classifySdkIntegrationDrift(identity, receipt)).toBe('current');
    expect(classifySdkIntegrationDrift(identity, null)).toBe('implementation_unverified');
    expect(classifySdkIntegrationDrift(identity, {
      ...receipt,
      productPolicyRevision: `sha256:${'c'.repeat(64)}`,
    })).toBe('reintegration_required');
    expect(classifySdkIntegrationDrift(identity, {
      ...receipt,
      sdkProtocolVersion: SDK_PROTOCOL_VERSION - 1,
    })).toBe('older_protocol');
    expect(classifySdkIntegrationDrift(identity, {
      ...receipt,
      conformanceResult: 'failed',
    })).toBe('implementation_unverified');
  });

  it('keeps target provenance, verification coverage, integrity, authenticity, and conformance distinct', () => {
    // Given: a receipt with complete target-project provenance and deliberately different proof results
    const identity = buildSdkContractIdentity(baseInput);
    const receipt = createSdkIntegrationReceipt(identity, '2026-08-23T12:00:00.000Z', {
      verificationId: 'verification-mixed',
      issuedBy: 'somnibot-server',
      targetProjectVersion: '2.4.0',
      targetProjectCommit: 'abc1234',
      verificationEnvironment: { kind: 'staging', description: 'Windows 11 integration host' },
      capabilitiesExercised: ['exports'],
      remainingUnverifiedRequirements: ['live payment recovery'],
      integrityResult: 'passed',
      authenticityResult: 'unverified',
      conformanceResult: 'failed',
    });

    // When: the receipt is parsed and its drift state is classified
    const parsed = readSdkIntegrationReceiptMetadata({ somnibot_sdk_integration_receipt: receipt });

    // Then: provenance and each proof dimension survive independently
    expect(parsed).toMatchObject({
      targetProjectVersion: '2.4.0', targetProjectCommit: 'abc1234',
      verificationEnvironment: { kind: 'staging', description: 'Windows 11 integration host' },
      capabilitiesExercised: ['exports'], remainingUnverifiedRequirements: ['live payment recovery'],
      integrityResult: 'passed', authenticityResult: 'unverified', conformanceResult: 'failed',
    });
    expect(classifySdkIntegrationDrift(identity, receipt)).toBe('implementation_unverified');
  });

  it('does not treat legacy self-attestation as current conformance', () => {
    const identity = buildSdkContractIdentity(baseInput);
    const receipt = createSdkIntegrationReceipt(identity, '2026-08-23T12:00:00.000Z', {
      appVersion: '2.4.0',
      appCommit: 'abc1234',
      conformanceResult: 'passed',
    });
    const metadata = mergeSdkIntegrationReceiptMetadata({
      completed_project_licensing: { policyPending: false },
      customer_visible_note: 'preserve me',
    }, receipt);

    expect(metadata).toMatchObject({
      completed_project_licensing: { policyPending: false },
      customer_visible_note: 'preserve me',
    });
    expect(readSdkIntegrationReceiptMetadata(metadata)).toEqual(receipt);
    expect(classifySdkIntegrationDrift(identity, receipt)).toBe('implementation_unverified');
    expect(JSON.stringify(receipt)).not.toMatch(/license[_ -]?key|secret|customer[_ -]?id/i);
  });
});
