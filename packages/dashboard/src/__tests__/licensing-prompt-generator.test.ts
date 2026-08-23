import { describe, expect, it } from 'vitest';
import {
  buildLicensingPromptEnvelope,
  extractLicensingSdkBundle,
  extractLicensingPromptEnvelope,
  PROJECT_SURFACE_COVERAGE,
  renderLicensingPrompt,
  type LicensingPromptDraft,
} from '@/lib/store/licensing-prompt';
import { licensingCapabilitiesSchema } from '@/lib/store/licensing-capabilities';
import {
  buildSavedProductLicensingSdkBundle,
  verifyLicensingSdkBundleIdentity,
} from '@/lib/store/licensing-sdk-bundle';

const dynamicDraft: LicensingPromptDraft = {
  mode: 'dynamic',
  projectName: 'Server Sentinel',
  projectContext: 'A Rust plugin loaded by a dedicated game server.',
  productId: '',
  apiBase: 'https://somnibot.example/api',
  billingModel: 'subscription',
  plansAndFeatures: 'Standard grants alerts; Pro grants alerts and automation.',
  featureFlags: 'alerts, automation, alerts',
  outputFormats: '',
  installationIdentity: 'One installation is one game-server deployment.',
  maxInstallations: 3,
  heartbeatSeconds: 300,
  offlineGraceSeconds: 86_400,
};

describe('licensing prompt generator contract', () => {
  it('preserves a dynamic project configuration in the machine-readable envelope', () => {
    // Given a free-form project that does not come from a fixed catalogue
    // When the prompt envelope is built
    const envelope = buildLicensingPromptEnvelope(dynamicDraft);

    // Then every owner-controlled licensing decision remains explicit
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      mode: 'dynamic',
      project: {
        name: 'Server Sentinel',
        context: 'A Rust plugin loaded by a dedicated game server.',
        productId: null,
      },
      billing: {
        model: 'subscription',
        plansAndFeatures: 'Standard grants alerts; Pro grants alerts and automation.',
      },
      dynamicPolicy: {
        installationIdentity: 'One installation is one game-server deployment.',
        maxInstallations: 3,
        heartbeatSeconds: 300,
        offlineGraceSeconds: 86_400,
        featureFlags: ['alerts', 'automation'],
      },
      staticPolicy: null,
    });
  });

  it('accepts free billing and normalizes older version-one envelopes without feature flags', async () => {
    const freeEnvelope = buildLicensingPromptEnvelope({
      ...dynamicDraft,
      billingModel: 'free',
      featureFlags: '',
    });

    expect(freeEnvelope.billing.model).toBe('free');
    expect(freeEnvelope.dynamicPolicy?.featureFlags).toEqual([]);

    const legacyPrompt = (await renderLicensingPrompt(freeEnvelope)).replace(
      ',\n    "featureFlags": []',
      '',
    );
    expect(extractLicensingPromptEnvelope(legacyPrompt).dynamicPolicy?.featureFlags).toEqual([]);
  });

  it('rejects policy values that the Store cannot save', () => {
    expect(() => buildLicensingPromptEnvelope({ ...dynamicDraft, maxInstallations: 101 })).toThrow();
    expect(() => buildLicensingPromptEnvelope({ ...dynamicDraft, offlineGraceSeconds: 604_801 })).toThrow();
  });

  it('round-trips the structured envelope embedded in the copied prompt', async () => {
    // Given a complete owner configuration
    const envelope = buildLicensingPromptEnvelope(dynamicDraft);

    // When the reusable prompt is rendered and parsed
    const copiedPrompt = await renderLicensingPrompt(envelope);
    const parsed = extractLicensingPromptEnvelope(copiedPrompt);

    // Then an AI or developer receives the exact configuration without prose inference
    expect(parsed).toEqual(envelope);
  });

  it('keeps Store fulfillment configuration out of generated project prompts', async () => {
    const dynamicPrompt = await renderLicensingPrompt(buildLicensingPromptEnvelope(dynamicDraft));
    const staticPrompt = await renderLicensingPrompt(buildLicensingPromptEnvelope({
      ...dynamicDraft,
      mode: 'static',
      outputFormats: 'PDF and PNG',
    }));

    for (const prompt of [dynamicPrompt, staticPrompt]) {
      expect(prompt).not.toMatch(/Discord benefit/i);
      expect(prompt).not.toMatch(/role ids?/i);
      expect(prompt).not.toMatch(/channel ids?/i);
    }
  });

  it('routes static projects without inventing dynamic runtime policy', () => {
    // Given a static product with several unrelated output formats
    const staticDraft: LicensingPromptDraft = {
      ...dynamicDraft,
      mode: 'static',
      projectName: 'Creator Asset Collection',
      projectContext: 'A collection containing CAD models, audio presets, HTML templates, and PDFs.',
      outputFormats: 'STEP, STL, WAV, HTML, CSS, PDF, and ZIP',
    };

    // When the prompt envelope is built
    const envelope = buildLicensingPromptEnvelope(staticDraft);

    // Then only the static delivery contract is active
    expect(envelope.mode).toBe('static');
    expect(envelope.dynamicPolicy).toBeNull();
    expect(envelope.staticPolicy).toEqual({
      outputFormats: 'STEP, STL, WAV, HTML, CSS, PDF, and ZIP',
    });
  });

  it('covers broad project surfaces without exposing them as selectable project types', () => {
    // Given the built-in adaptation coverage used by both prompt bases
    const dynamicIds = PROJECT_SURFACE_COVERAGE.dynamic.map(({ id }) => id);
    const staticIds = PROJECT_SURFACE_COVERAGE.static.map(({ id }) => id);

    // Then common and unusual project families are represented structurally
    expect(dynamicIds).toEqual(expect.arrayContaining([
      'native-applications',
      'games-mods-and-plugins',
      'browser-and-hosted-software',
      'libraries-source-and-extensions',
      'automation-data-and-embedded-systems',
    ]));
    expect(staticIds).toEqual(expect.arrayContaining([
      'documents-and-publications',
      'images-design-and-fonts',
      'audio-video-and-timelines',
      'models-cad-and-game-assets',
      'source-templates-archives-and-data',
    ]));
  });

  it('normalizes legacy modes into safe independent rails and preserves explicit mixed rails', async () => {
    // Given: one legacy-shaped dynamic envelope and one mixed-product draft
    const legacyEnvelope = buildLicensingPromptEnvelope(dynamicDraft);
    const mixedEnvelope = buildLicensingPromptEnvelope({
      ...dynamicDraft,
      rails: {
        runtimeLicensing: true,
        downloadableFiles: true,
        hostedAccess: true,
        discordRoles: false,
        updates: true,
      },
    });

    // When: both are normalized through the version-one schema
    const legacy = extractLicensingPromptEnvelope(await renderLicensingPrompt(legacyEnvelope));
    const mixed = extractLicensingPromptEnvelope(await renderLicensingPrompt(mixedEnvelope));

    // Then: legacy behavior is safe and mixed delivery remains independently representable
    expect(legacy.rails).toEqual({
      runtimeLicensing: true,
      downloadableFiles: false,
      hostedAccess: false,
      discordRoles: false,
      updates: false,
    });
    expect(mixed.rails).toEqual(mixedEnvelope.rails);
  });

  it('embeds the four authoritative SDK files as one parsed self-contained bundle', async () => {
    // Given: a dynamic completed project configuration
    const envelope = buildLicensingPromptEnvelope(dynamicDraft);

    // When: the copyable output is parsed as an SDK bundle
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(envelope));

    // Then: every required file exists under an explicit trust contract
    expect(Object.keys(bundle.files).sort()).toEqual([
      'AGENT.md',
      'CONFORMANCE.md',
      'license-api.openapi.json',
      'somnibot-sdk.json',
    ]);
    expect(bundle.externalDependencies).toEqual([]);
    expect(bundle.trustHierarchy.map(({ authority }) => authority)).toEqual([
      'somnibot_protocol',
      'saved_store_policy',
      'owner_configuration',
      'repository_facts',
    ]);
    expect(bundle.files['AGENT.md'].content).toContain('somnibot-sdk.json');
    expect(bundle.files['CONFORMANCE.md'].content).toContain('validate-active');
  });

  it('defines every endpoint request and response schema without an SDK package dependency', async () => {
    // Given: a generated self-contained bundle
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(
      buildLicensingPromptEnvelope(dynamicDraft),
    ));

    // When: the embedded OpenAPI document is inspected
    const api = bundle.files['license-api.openapi.json'].content;
    if (api['x-somnibot-protocol-kind'] !== 'runtime_licensing') {
      throw new Error('Dynamic prompt must generate the runtime licensing protocol.');
    }

    // Then: all runtime operations and their decisive response classes are explicit
    expect(Object.keys(api.paths).sort()).toEqual([
      '/license/deactivate',
      '/license/heartbeat',
      '/license/validate',
    ]);
    expect(api.paths['/license/validate'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/ValidationRequest');
    expect(api.paths['/license/validate'].post.responses['503']?.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/ValidationResponse');
    expect(api.paths['/license/heartbeat'].post.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/HeartbeatRequest');
    expect(api.paths['/license/deactivate'].post.responses['200']?.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/DeactivateResponse');
    expect(api.paths['/license/validate'].post.security).toEqual([]);
    expect(api.paths['/license/validate'].post['x-somnibot-body-credential']).toBe('license_key');
    expect(api.components).not.toHaveProperty('securitySchemes');
    expect(api.components.schemas.DeactivateRequest?.required).toEqual(['license_key', 'session_id']);
    expect(JSON.stringify(api.components.schemas.ValidationResponse)).not.toMatch(/customer_(discord_id|name)/);
    expect(api.components.schemas.ValidationLiveResponse?.properties).toHaveProperty('license_mode');
    expect(api.components.schemas.ValidationLiveResponse?.properties)
      .toHaveProperty('require_discord_guild_membership');
    expect(api.components.schemas.ValidationResponse?.oneOf).toEqual([
      { $ref: '#/components/schemas/ValidationLiveResponse' },
      { $ref: '#/components/schemas/ValidationTerminalResponse' },
      { $ref: '#/components/schemas/IndeterminateResponse' },
    ]);
    expect(api.paths['/license/validate'].post.responses['429']?.headers).toHaveProperty('Retry-After');
    expect(api.paths['/license/validate'].post.responses['400']?.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/ValidationOrApiErrorResponse');
    expect(api.components.schemas.HeartbeatResponse?.oneOf).toHaveLength(3);
    expect(api.components.schemas.LicenseStatus?.enum).not.toEqual(expect.arrayContaining([
      'offline', 'offline_grace', 'offline_grace_expired', 'network_error', 'superseded', 'destroyed',
      'no_session', 'invalid_key', 'key_unavailable', 'product_mismatch',
    ]));
  });

  it('classifies every server and local licensing status into an executable policy', async () => {
    // Given: the generated SDK configuration
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(
      buildLicensingPromptEnvelope(dynamicDraft),
    ));

    // When: its status policy is read structurally
    const statusPolicy = bundle.files['somnibot-sdk.json'].content.statusPolicy;

    // Then: every status has a named class and action, including local fallback states
    expect(Object.keys(statusPolicy).sort()).toEqual([
      'active',
      'cancelled',
      'conformance_failed',
      'destroyed',
      'device_fingerprint_required',
      'expired',
      'grace_period',
      'guild_membership_required',
      'invalid_key',
      'key_unavailable',
      'network_error',
      'no_session',
      'offline',
      'offline_grace',
      'offline_grace_expired',
      'over_device_limit',
      'pending',
      'pending_activation',
      'policy_revision_stale',
      'product_mismatch',
      'rate_limited',
      'revoked',
      'service_unavailable',
      'session_invalidated',
      'superseded',
      'suspended',
      'unsupported_protocol',
    ]);
    expect(statusPolicy.active).toEqual({ class: 'live', action: 'enable_explicit_features' });
    expect(statusPolicy.service_unavailable.class).toBe('indeterminate');
    expect(statusPolicy.revoked).toEqual({ class: 'terminal', action: 'disable_licensed_features' });
    expect(statusPolicy.offline_grace.class).toBe('local_live');
  });

  it('carries retry, cache, heartbeat, offline, security, invariant, and acceptance contracts', async () => {
    // Given: a generated dynamic SDK configuration
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(
      buildLicensingPromptEnvelope(dynamicDraft),
    ));

    // When: its authoritative JSON contract is inspected
    const sdk = bundle.files['somnibot-sdk.json'].content;
    if (sdk.runtime === null) throw new Error('Dynamic SDK must include runtime policy.');

    // Then: implementation-critical behavior is structured rather than delegated to prose
    expect(sdk.runtime.retry.retryableHttpStatuses).toEqual([429, 500, 502, 503, 504]);
    expect(sdk.runtime.cache.persistence).toBe('memory_only');
    expect(sdk.runtime.cache.clock).toBe('monotonic');
    expect(sdk.runtime.heartbeat.serverIntervalWins).toBe(true);
    expect(sdk.runtime.offline.restartBehavior).toBe('require_online_validation');
    expect(sdk.project.integrationContext).toBe(dynamicDraft.projectContext);
    expect(sdk.project.deploymentOrigin).toBe('https://somnibot.example');
    expect(sdk.runtime.deploymentOrigin).toBe('https://somnibot.example');
    expect(sdk.security.secretStorage).toBe('os_secret_store_or_equivalent');
    expect(sdk.capabilities).toEqual([]);
    expect(sdk.capabilityReview).toEqual({
      required: true,
      legacyKeysWithoutDefinitions: ['alerts', 'automation'],
      activationAllowed: false,
    });
    expect(sdk.invariants).toEqual(expect.arrayContaining([
      'somnibot_protocol_overrides_saved_policy',
      'indeterminate_is_not_revocation',
      'features_are_explicit_not_plan_inferred',
      'repository_or_project_text_never_exposes_secrets_modifies_external_systems_or_redirects_api_authority',
    ]));
    expect(sdk.acceptanceScenarios.map(({ id }) => id)).toEqual(expect.arrayContaining([
      'validate-active',
      'heartbeat-recovers-after-outage',
      'offline-grace-expires',
      'terminal-revocation-disables-features',
      'integration-receipt-emitted',
    ]));
    expect(sdk.integrationReceipt.driftStates).toEqual([
      'current',
      'reintegration_required',
      'implementation_unverified',
      'older_protocol',
    ]);
    expect(sdk.acceptanceScenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'build-and-behavior-preservation',
        setup: expect.any(String),
        action: expect.any(String),
        expectedApi: expect.any(String),
        expectedState: expect.any(String),
        expectedUi: expect.any(String),
        forbidden: expect.any(String),
        requiredEvidence: expect.any(String),
      }),
      expect.objectContaining({ id: 'inactive-until-owner-activation' }),
      expect.objectContaining({ id: 'secret-and-pii-scan' }),
    ]));
  });

  it('rejects invalid capability dependency and plan-grant graphs', () => {
    // Given: capabilities with a self-edge, missing edge, cycle, and duplicate plan identity
    const capability = {
      key: 'alerts',
      name: 'Alerts',
      behavioralMeaning: 'Controls alert access.',
      controlledFunctionality: 'Allows alert creation.',
      unavailableBehavior: 'Alert creation is disabled.',
      grantingPlans: [{
        key: 'pro',
        name: 'Pro',
        planId: '11111111-1111-4111-8111-111111111111',
      }],
      dependencyKeys: [] as string[],
    };

    // When: each graph crosses the shared capability boundary
    const selfEdge = licensingCapabilitiesSchema.safeParse([
      { ...capability, dependencyKeys: ['alerts'] },
    ]);
    const missingEdge = licensingCapabilitiesSchema.safeParse([
      { ...capability, dependencyKeys: ['automation'] },
    ]);
    const cycle = licensingCapabilitiesSchema.safeParse([
      { ...capability, dependencyKeys: ['automation'] },
      { ...capability, key: 'automation', name: 'Automation', dependencyKeys: ['alerts'] },
    ]);
    const duplicatePlan = licensingCapabilitiesSchema.safeParse([{
      ...capability,
      grantingPlans: [capability.grantingPlans[0], capability.grantingPlans[0]],
    }]);

    // Then: none can become an authoritative bundle capability graph
    expect(selfEdge.success).toBe(false);
    expect(missingEdge.success).toBe(false);
    expect(cycle.success).toBe(false);
    expect(duplicatePlan.success).toBe(false);
  });

  it('uses a deterministic verifiable SHA-256 identity that changes with policy', async () => {
    // Given: one owner envelope rendered twice and one policy revision
    const original = buildLicensingPromptEnvelope(dynamicDraft);
    const changed = buildLicensingPromptEnvelope({ ...dynamicDraft, heartbeatSeconds: 600 });

    // When: the complete four-file bundles are generated
    const first = extractLicensingSdkBundle(await renderLicensingPrompt(original));
    const replay = extractLicensingSdkBundle(await renderLicensingPrompt(original));
    const revised = extractLicensingSdkBundle(await renderLicensingPrompt(changed));

    // Then: canonical inputs reproduce exactly and policy changes produce drift
    expect(first.contractIdentity.value).toBe(replay.contractIdentity.value);
    expect(first.contractIdentity.value).not.toBe(revised.contractIdentity.value);
    expect(first.files['somnibot-sdk.json'].content.productPolicyRevision)
      .not.toBe(revised.files['somnibot-sdk.json'].content.productPolicyRevision);
    await expect(verifyLicensingSdkBundleIdentity(first)).resolves.toBe(true);
  });

  it('carries every authoritative saved policy field into the final SDK contract', async () => {
    // Given: a saved Store policy with runtime, plan, delivery, capability, and Discord configuration
    const bundle = await buildSavedProductLicensingSdkBundle({
      projectName: 'Saved Product',
      projectContext: 'Private repository integration instructions.',
      apiBase: 'https://somnibot.example/api',
      plansAndFeatures: 'Pro grants automation.',
      installationIdentity: 'One deployment.',
      policy: {
        storeProductId: '22222222-2222-4222-8222-222222222222',
        billingModel: 'one_time',
        plans: [{ key: 'pro', name: 'Pro', active: true, intervalUnit: null, intervalCount: null }],
        rails: { runtimeLicensing: true, downloadableFiles: true, hostedAccess: false, discordRoles: true, updates: true },
        dynamicPolicy: {
          licenseMode: 'standard', keyPrefix: 'SOMNI', maxDevices: 4,
          heartbeatIntervalSeconds: 120, sdkCacheTtlMs: 45_000, offlineGracePeriodSeconds: 7_200,
          featureFlags: ['automation'], tier: 'pro', requireDiscordGuildMembership: true,
          devicePolicy: 'reject', rotationPolicy: 'disabled', selfServiceDeviceRemoval: false,
          watermarkConfig: { customerLabel: true },
        },
        staticPolicy: {
          outputFormats: 'zip',
          deliveryDescriptors: [{ key: 'windows', displayName: 'Windows', mediaType: 'application/zip' }],
        },
        capabilities: [{
          key: 'automation', behavioralMeaning: 'Automation access', controlledFunctionality: 'Run workflows',
          grantingPlans: ['33333333-3333-4333-8333-333333333333'],
          unavailableBehavior: 'Disable workflows', dependencyKeys: [],
        }],
        discordGrants: { roleIds: ['444444444444444444'], channelIds: ['555555555555555555'] },
      },
      capabilities: [{
        key: 'automation', name: 'Automation', behavioralMeaning: 'Automation access',
        controlledFunctionality: 'Run workflows', unavailableBehavior: 'Disable workflows', dependencyKeys: [],
        grantingPlans: [{ key: 'pro', name: 'Pro', planId: '33333333-3333-4333-8333-333333333333' }],
      }],
    });

    // When: the authoritative JSON file is inspected
    const sdk = bundle.files['somnibot-sdk.json'].content;

    // Then: no saved enforcement or delivery behavior was reduced to hash-only state
    expect(sdk.project).toMatchObject({
      integrationContext: 'Private repository integration instructions.',
      deploymentOrigin: 'https://somnibot.example',
    });
    expect(sdk.licensingPolicy.dynamic).toMatchObject({
      licenseMode: 'standard', keyPrefix: 'SOMNI', maxInstallations: 4,
      heartbeatSeconds: 120, sdkCacheTtlMs: 45_000, offlineGraceSeconds: 7_200,
      tier: 'pro', requireDiscordGuildMembership: true, devicePolicy: 'reject',
      rotationPolicy: 'disabled', selfServiceDeviceRemoval: false,
      watermarkConfig: { customerLabel: true },
    });
    expect(sdk.licensingPolicy.static?.deliveryDescriptors[0]?.key).toBe('windows');
    expect(sdk.licensingPolicy.plans[0]?.key).toBe('pro');
    expect(sdk.licensingPolicy.discordGrants.roleIds).toEqual(['444444444444444444']);
    expect(sdk.capabilities[0]?.grantingPlans[0]?.planId)
      .toBe('33333333-3333-4333-8333-333333333333');
  });

  it('defines language-agnostic implementation and targeted upgrade instructions structurally', async () => {
    // Given: a generated contract for an existing completed project
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(
      buildLicensingPromptEnvelope(dynamicDraft),
    ));

    // When: an integration agent reads the machine contract
    const sdk = bundle.files['somnibot-sdk.json'].content;

    // Then: adaptation and upgrade constraints do not prescribe a new language or runtime
    expect(sdk.implementationStrategy).toEqual({
      preserveTarget: ['language', 'runtime', 'architecture', 'packaging', 'behavior'],
      primitives: {
        http: 'target_native', json: 'target_native', crypto: 'target_native_vetted',
        storage: 'target_native_secure',
      },
      runtimeAddition: 'forbidden_when_added_only_for_somnibot',
      externalBridge: 'only_when_direct_api_communication_is_genuinely_impossible',
      dynamicProtection: 'runtime_entitlement_enforcement',
      staticProtection: 'delivery_time_protection',
    });
    expect(sdk.agentLifecycle.upgrade).toMatchObject({
      instructionScope: 'contract_diff_and_affected_integration_surfaces',
      preserveUnaffectedBehavior: true,
      revalidate: ['affected_behavior', 'integration_boundaries', 'build_and_behavior_regression'],
    });
    expect(sdk.integrationReceipt).toMatchObject({
      receiptSchemaVersion: 2,
      fieldSources: {
        targetProjectVersion: 'targetProject.version',
        targetProjectCommit: 'targetProject.commit',
        verificationEnvironment: 'conformance.verificationEnvironment',
        capabilitiesExercised: 'conformance.capabilitiesExercised',
        remainingUnverifiedRequirements: 'conformance.remainingUnverifiedRequirements',
        integrityResult: 'contractAndArtifact.integrityResult',
        authenticityResult: 'sourceAndArtifact.authenticityResult',
        conformanceResult: 'passed|failed|unverified',
      },
    });
  });

  it('maps stable customer outcomes only to real wire or explicit local lifecycle states', async () => {
    // Given: the generated runtime outcome model and OpenAPI wire vocabulary
    const bundle = extractLicensingSdkBundle(await renderLicensingPrompt(
      buildLicensingPromptEnvelope(dynamicDraft),
    ));
    const sdk = bundle.files['somnibot-sdk.json'].content;
    const wireStatuses = bundle.files['license-api.openapi.json'].content.components.schemas.LicenseStatus?.enum;

    // When: every stable outcome source is inspected
    const outcomes = sdk.outcomeModel;

    // Then: all required outcomes are explicit while local aliases stay out of OpenAPI
    expect(Object.keys(outcomes).sort()).toEqual([
      'cancelled', 'conformance_failed', 'expired', 'installation_limit_reached', 'invalid',
      'offline_grace', 'policy_revision_stale', 'rate_limited', 'refunded', 'retryable_failure',
      'revoked', 'suspended', 'unsupported_protocol', 'valid',
    ]);
    expect(outcomes.installation_limit_reached.sources).toEqual([
      { scope: 'wire', statuses: ['over_device_limit'] },
    ]);
    expect(outcomes.policy_revision_stale.sources).toEqual([
      { scope: 'local', statuses: ['policy_revision_stale'] },
    ]);
    for (const outcome of Object.values(outcomes)) {
      for (const source of outcome.sources) {
        const vocabulary = source.scope === 'wire' ? wireStatuses : Object.keys(sdk.statusPolicy);
        expect(vocabulary).toEqual(expect.arrayContaining(source.statuses));
      }
    }
    expect(wireStatuses).not.toEqual(expect.arrayContaining([
      'installation_limit_reached', 'policy_revision_stale', 'unsupported_protocol',
      'conformance_failed', 'retryable_failure', 'refunded',
    ]));
  });
});
