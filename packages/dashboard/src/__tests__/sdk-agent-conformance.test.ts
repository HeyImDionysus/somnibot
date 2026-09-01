import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPLETED_PROJECTS,
  agentTrialExportSchema,
  conformanceBundleSchema,
  exportConformanceTrial,
  generateConformanceBundle,
  gradingCriterionIdSchema,
  LiveAgentResultValidationError,
  parseAndValidateLiveAgentResult,
  parseLiveAgentResult,
  type FixtureId,
} from '@/__fixtures__/sdk-agent-conformance';
import {
  buildLicensingPromptEnvelope,
  extractLicensingSdkBundle,
  renderLicensingPrompt,
  type LicensingPromptDraft,
} from '@/lib/store/licensing-prompt';
import {
  referenceIntegrationFor,
  type ReferenceCommand,
} from '@/__fixtures__/sdk-agent-conformance/reference-integrations';

const EXPECTED_FIXTURES = [
  'electron-desktop',
  'rust-oxide-plugin',
  'python-service',
  'hosted-web-app',
  'command-line-tool',
  'static-files-site',
] as const;

const EXPECTED_CRITERIA = [
  'compile_build',
  'behavioral_preservation',
  'activation_ux',
  'structural_capability_enforcement',
  'bounded_offline_behavior',
  'revocation',
  'deactivation',
  'retry_rate_limit_handling',
  'secret_leakage',
] as const;

function readBundlePath(root: unknown, pointer: string): unknown {
  return pointer.split('/').slice(1).reduce<unknown>((value, encodedKey) => {
    const key = encodedKey.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof value !== 'object' || value === null || !(key in value)) {
      return undefined;
    }

    return Reflect.get(value, key);
  }, root);
}

function expectSupplied(value: unknown): void {
  expect(value).not.toBeUndefined();
  expect(value).not.toBeNull();
}

async function generateFixtureBundle(fixtureId: FixtureId) {
  const fixture = COMPLETED_PROJECTS.find((candidate) => candidate.fixtureId === fixtureId);
  if (fixture === undefined) {
    throw new Error(`Unknown test fixture: ${fixtureId}`);
  }
  const usesDeliveryTimeProtection = fixture.fixtureId === 'static-files-site';
  const draft: LicensingPromptDraft = {
    mode: usesDeliveryTimeProtection ? 'static' : 'dynamic',
    projectName: fixture.displayName,
    projectContext: fixture.stack,
    productId: '11111111-1111-4111-8111-111111111111',
    apiBase: 'https://somnibot.invalid/api',
    billingModel: usesDeliveryTimeProtection ? 'one_time' : 'subscription',
    plansAndFeatures: fixture.structuralCapabilities.join(', '),
    featureFlags: fixture.structuralCapabilities.join(','),
    outputFormats: usesDeliveryTimeProtection ? 'HTML, CSS, JavaScript, and ZIP' : '',
    installationIdentity: `One installation of ${fixture.displayName}`,
    maxInstallations: 2,
    heartbeatSeconds: 300,
    offlineGraceSeconds: fixture.offlinePolicy?.maximumSeconds ?? 0,
  };
  const prompt = await renderLicensingPrompt(buildLicensingPromptEnvelope(draft));
  return generateConformanceBundle(fixtureId, extractLicensingSdkBundle(prompt));
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen(Reflect.get(value, key));
  }
}

function runCommand(
  command: ReferenceCommand,
  cwd: string,
  credentialKind: 'runtime-license-key' | 'server-delivery-secret',
): Promise<string> {
  const executable = command.executable === 'node' ? process.execPath : command.executable;
  const credential = credentialKind === 'runtime-license-key'
    ? { SOMNI_TEST_LICENSE_KEY: 'SOMNI-SECRET-TEST-KEY' }
    : { SOMNI_TEST_DELIVERY_SECRET: 'SERVER-DELIVERY-SECRET' };
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...command.args], {
      cwd,
      shell: false,
      env: {
        ...process.env,
        ...credential,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command.executable} ${command.args.join(' ')} exited ${String(code)}\n${output}`));
    });
  });
}

async function materializeReference(fixtureId: FixtureId): Promise<{ root: string; bundle: Awaited<ReturnType<typeof generateFixtureBundle>> }> {
  const root = await mkdtemp(join(tmpdir(), `somnibot-${fixtureId}-`));
  const bundle = await generateFixtureBundle(fixtureId);
  const reference = referenceIntegrationFor(fixtureId);
  await Promise.all(Object.entries(reference.files).map(async ([relativePath, content]) => {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
  await writeFile(join(root, 'somnibot-sdk.json'), JSON.stringify(bundle.sdkBundle.files['somnibot-sdk.json'].content), 'utf8');
  await writeFile(join(root, 'license-api.openapi.json'), JSON.stringify(bundle.sdkBundle.files['license-api.openapi.json'].content), 'utf8');
  return { root, bundle };
}

describe('Given the frozen completed-project fixture catalog', () => {
  it('When the catalog is inspected Then it represents all six required stacks', () => {
    expect(COMPLETED_PROJECTS.map(({ fixtureId }) => fixtureId)).toEqual(EXPECTED_FIXTURES);

    for (const fixture of COMPLETED_PROJECTS) {
      expectDeepFrozen(fixture);
      expect(fixture.files.length).toBeGreaterThanOrEqual(2);
      expect(fixture.build.command).not.toHaveLength(0);
      expect(fixture.smoke.observable).not.toHaveLength(0);
    }
  });

  it('When the static-files fixture is generated Then protection stays on the delivery rail', async () => {
    const bundle = await generateFixtureBundle('static-files-site');
    const sdk = bundle.sdkBundle.files['somnibot-sdk.json'].content;

    expect(sdk.project.legacyMode).toBe('static');
    expect(sdk.rails).toEqual({
      runtimeLicensing: false,
      downloadableFiles: true,
      hostedAccess: false,
      discordRoles: false,
      updates: false,
    });
    expect(sdk.licensingPolicy.dynamic).toBeNull();
    expect(sdk.licensingPolicy.static).not.toBeNull();
    expect(sdk.runtime).toBeNull();
    expect(sdk.staticDelivery).toMatchObject({
      authorization: {
        endpoint: '/api/portal/download-link',
        authenticationHeader: 'x-portal-token',
      },
      signedDownload: {
        endpointTemplate: '/api/downloads/{productId}/{fileId}',
        nonce: 'single_use_consumed_after_dependencies_pass',
      },
      derivative: {
        executionBoundary: 'somnibot_server_only',
        manifestVersion: 'somnibot-static-v1',
        signatureAlgorithm: 'hmac-sha256',
      },
      revocation: {
        blocksFutureDelivery: true,
        alreadyDeliveredCopies: 'cannot_be_remotely_deleted',
      },
    });
    const openApi = bundle.sdkBundle.files['license-api.openapi.json'].content;
    expect(openApi['x-somnibot-protocol-kind']).toBe('static_delivery');
    expect(Object.keys(openApi.paths)).toEqual([
      '/api/portal/download-link',
      '/api/downloads/{productId}/{fileId}',
    ]);
    expect(openApi.components.schemas).toHaveProperty('StaticDerivativeManifest');
    expect(openApi.components.schemas).toHaveProperty('SignedDownloadParameters');
    expect(openApi.components.schemas).toHaveProperty('StaticDeliveryRevocationPolicy');
    expect(bundle.fixture.activationSurface.entrypoint).toBe('SomniBot customer portal delivery');
  });
});

describe('Given a requested SDK agent-conformance bundle', () => {
  it.each(EXPECTED_FIXTURES)('When %s is generated Then it is complete and schema-valid', async (fixtureId) => {
    const bundle = await generateFixtureBundle(fixtureId);

    expect(conformanceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.fixture.fixtureId).toBe(fixtureId);
    expect(bundle.grader.resultSchema.properties.fixtureId.const).toBe(fixtureId);
    expect(bundle.liveAgentExecution).toEqual({
      status: 'not_run',
      requiredLater: true,
      evidenceArtifact: null,
    });
    expect(bundle.deterministicReferenceExecution).toMatchObject({
      status: 'runnable',
      evidenceBoundary: 'reference_implementation_not_ai_agent',
    });
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
  });

  it.each(EXPECTED_FIXTURES)('When %s is graded Then every criterion input resolves from the bundle', async (fixtureId) => {
    const bundle = await generateFixtureBundle(fixtureId);

    for (const criterion of bundle.grader.criteria) {
      for (const inputPath of criterion.bundleInputs) {
        expectSupplied(readBundlePath(bundle, inputPath));
      }
    }
  });

  it.each(EXPECTED_FIXTURES)('When %s is serialized Then it has no obsolete SDK or external-document dependency', async (fixtureId) => {
    const bundle = await generateFixtureBundle(fixtureId);
    const serializedFixture = JSON.stringify(bundle.fixture).toLowerCase();

    expect(serializedFixture).not.toContain('@somnibot/license-sdk');
    expect(serializedFixture).not.toContain('packages/license-sdk');
    expect(bundle.sdkBundle.externalDependencies).toEqual([]);
  });
});

describe('Given canonical generated bundles and deterministic reference integrations', () => {
  it.each(EXPECTED_FIXTURES)('When %s is materialized Then its compile and behavior graders execute successfully without secret leakage', async (fixtureId) => {
    const { root, bundle } = await materializeReference(fixtureId);
    const reference = referenceIntegrationFor(fixtureId);
    try {
      const compileOutput = await runCommand(reference.compile, root, reference.credentialKind);
      const behaviorOutput = await runCommand(reference.behavior, root, reference.credentialKind);
      const observable = `${compileOutput}\n${behaviorOutput}`;

      expect(observable).not.toContain('SOMNI-SECRET-TEST-KEY');
      expect(observable).not.toContain('SERVER-DELIVERY-SECRET');
      expect(bundle.deterministicReferenceExecution.coveredCriteria).toEqual(EXPECTED_CRITERIA);
      expect(bundle.liveAgentExecution.status).toBe('not_run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('When static delivery is inspected Then it has no runtime key, heartbeat, or deactivation surface', () => {
    const reference = referenceIntegrationFor('static-files-site');
    const serialized = JSON.stringify(reference.files).toLowerCase();

    expect(serialized).not.toContain('license_key');
    expect(serialized).not.toContain('license-key');
    expect(serialized).not.toContain('heartbeat');
    expect(serialized).not.toContain('deactivate');
    expect(reference.credentialKind).toBe('server-delivery-secret');
    expect(serialized).toContain('delivery-time protection has no in-project activation');
  });
});

describe('Given the machine-readable grading contract', () => {
  it('When criteria are enumerated Then every required concern appears once and totals 100 points', async () => {
    const bundle = await generateFixtureBundle(EXPECTED_FIXTURES[0]);
    const criterionIds = bundle.grader.criteria.map(({ id }) => id);

    expect(gradingCriterionIdSchema.options).toEqual(EXPECTED_CRITERIA);
    expect(criterionIds).toEqual(EXPECTED_CRITERIA);
    expect(new Set<FixtureId>(EXPECTED_FIXTURES).size).toBe(EXPECTED_FIXTURES.length);
    expect(new Set(criterionIds).size).toBe(EXPECTED_CRITERIA.length);
    expect(bundle.grader.criteria.reduce((total, criterion) => total + criterion.weight, 0)).toBe(100);
    expect(bundle.grader.resultSchema.properties.results.prefixItems[0]?.properties.verdict.enum)
      .toEqual(['pass', 'fail', 'blocked']);
    expect(bundle.grader.resultSchema.properties.fixtureId.const).toBe(EXPECTED_FIXTURES[0]);
  });

  it('When the self-contained inputs are inspected Then build, behavior, UX, capability, offline, retry, and secret data are present', async () => {
    for (const fixtureId of EXPECTED_FIXTURES) {
      const bundle = await generateFixtureBundle(fixtureId);

      expect(bundle.fixture.files.length).toBeGreaterThanOrEqual(2);
      expect(bundle.fixture.preservedBehaviors.length).toBeGreaterThanOrEqual(2);
      expect(bundle.fixture.structuralCapabilities.length).toBeGreaterThan(0);
      if (bundle.fixture.protectionMode === 'runtime') {
        expect(bundle.fixture.offlinePolicy?.freshInstallFailsClosed).toBe(true);
      } else {
        expect(bundle.fixture.offlinePolicy).toBeNull();
      }
      expect(Object.keys(bundle.sdkBundle.files)).toEqual(expect.arrayContaining([
        'AGENT.md',
        'CONFORMANCE.md',
        'license-api.openapi.json',
        'somnibot-sdk.json',
      ]));
      expect(bundle.sdkBundle.externalDependencies).toEqual([]);
    }
  });

  it('When static grading is inspected Then every criterion evaluates delivery-time behavior', async () => {
    const bundle = await generateFixtureBundle('static-files-site');
    const serializedCriteria = JSON.stringify(bundle.grader.criteria);

    expect(serializedCriteria).toContain('Authorized delivery experience');
    expect(serializedCriteria).toContain('No runtime deactivation surface');
    expect(serializedCriteria).not.toContain('/runtime/offline');
    expect(serializedCriteria).not.toContain('/license/deactivate');
  });
});

describe('Given a clean reusable agent-trial export and strict result parser', () => {
  it('When a trial is exported Then the canonical bundle and exact ordered result schema round-trip', async () => {
    const bundle = await generateFixtureBundle('python-service');
    const exported = exportConformanceTrial('python-service', bundle.sdkBundle);
    const parsed = agentTrialExportSchema.parse(JSON.parse(exported));

    expect(parsed.fixture.fixtureId).toBe('python-service');
    expect(parsed.execution).toEqual({
      kind: 'clean_ai_agent',
      resultFile: 'result.json',
      evidenceDirectory: 'artifacts',
      referenceEvidenceReusable: false,
    });
    expect(exported).not.toContain('deterministicReferenceExecution');
    expect(exported).not.toContain('reference_implementation_not_ai_agent');
    expect(parsed.grader.resultSchema.properties.results.items).toBe(false);
    expect(parsed.grader.resultSchema.properties.results.prefixItems.map(
      ({ properties }) => properties.criterionId.const,
    )).toEqual(EXPECTED_CRITERIA);
  });

  it('When a complete result has matching executed commands and inspected security evidence Then validation passes', async () => {
    const serialized = JSON.stringify({
      fixtureId: 'python-service',
      liveAgentExecutionId: 'trial-2',
      results: EXPECTED_CRITERIA.map((criterionId) => ({
        criterionId,
        verdict: 'pass' as const,
        evidence: [`artifacts/${criterionId}.log`],
        notes: '',
      })),
    });
    const fixture = COMPLETED_PROJECTS.find(({ fixtureId }) => fixtureId === 'python-service');
    if (fixture === undefined) throw new Error('Missing Python fixture');
    const result = await parseAndValidateLiveAgentResult(serialized, fixture, {
      inspectArtifact: async (path) => ({
        exists: true,
        bytes: 64,
        content: path.includes('secret_leakage')
          ? JSON.stringify({
              kind: 'secret_scan', command: 'secret-scanner .', exitCode: 0,
              scannedPaths: ['src', 'dist'], findings: [],
            })
          : 'sanitized evidence',
      }),
      executeCommand: async (command) => ({
        command: command.command,
        exitCode: command.expectedExitCode,
        output: command.observable,
      }),
    });

    expect(result.results).toHaveLength(9);
  });

  it('When verdicts, ordering, fixture identity, or evidence are invalid Then the result fails closed', async () => {
    const validResults = EXPECTED_CRITERIA.map((criterionId) => ({
      criterionId,
      verdict: 'pass' as const,
      evidence: [`artifacts/${criterionId}.log`],
      notes: '',
    }));
    const invalidVerdict = JSON.stringify({
      fixtureId: 'python-service', liveAgentExecutionId: 'trial-2',
      results: validResults.map((item, index) => index === 0 ? { ...item, verdict: 'passed' } : item),
    });
    const wrongOrder = JSON.stringify({
      fixtureId: 'python-service', liveAgentExecutionId: 'trial-2',
      results: [validResults[1], validResults[0], ...validResults.slice(2)],
    });
    const wrongFixture = JSON.stringify({
      fixtureId: 'electron-desktop', liveAgentExecutionId: 'trial-2', results: validResults,
    });
    const escapedEvidence = JSON.stringify({
      fixtureId: 'python-service', liveAgentExecutionId: 'trial-2',
      results: validResults.map((item, index) => index === 0
        ? { ...item, evidence: ['../outside.log'] }
        : item),
    });

    expect(() => parseLiveAgentResult(invalidVerdict, 'python-service'))
      .toThrow(LiveAgentResultValidationError);
    expect(() => parseLiveAgentResult(wrongOrder, 'python-service'))
      .toThrow(LiveAgentResultValidationError);
    expect(() => parseLiveAgentResult(wrongFixture, 'python-service'))
      .toThrow(LiveAgentResultValidationError);
    expect(() => parseLiveAgentResult(escapedEvidence, 'python-service'))
      .toThrow(LiveAgentResultValidationError);
    const fixture = COMPLETED_PROJECTS.find(({ fixtureId }) => fixtureId === 'python-service');
    if (fixture === undefined) throw new Error('Missing Python fixture');
    await expect(parseAndValidateLiveAgentResult(
      JSON.stringify({ fixtureId: 'python-service', liveAgentExecutionId: 'trial-2', results: validResults }),
      fixture,
      {
        inspectArtifact: async () => ({ exists: true, bytes: 0, content: '' }),
        executeCommand: async (command) => ({ command: command.command, exitCode: 0, output: command.observable }),
      },
    )).rejects.toThrow(LiveAgentResultValidationError);
  });

  it('When build, smoke, or security evidence is not independently proven Then validation fails closed', async () => {
    const fixture = COMPLETED_PROJECTS.find(({ fixtureId }) => fixtureId === 'python-service');
    if (fixture === undefined) throw new Error('Missing Python fixture');
    const serialized = JSON.stringify({
      fixtureId: fixture.fixtureId,
      liveAgentExecutionId: 'trial-untrusted',
      results: EXPECTED_CRITERIA.map((criterionId) => ({
        criterionId,
        verdict: 'pass',
        evidence: [`artifacts/${criterionId}.log`],
        notes: '',
      })),
    });
    const evidence = {
      inspectArtifact: async () => ({ exists: true, bytes: 64, content: 'SOMNI-SECRET-TEST-KEY' }),
      executeCommand: async (command: { readonly command: string }) => ({ command: command.command, exitCode: 1, output: 'failed' }),
    };

    await expect(parseAndValidateLiveAgentResult(serialized, fixture, evidence))
      .rejects.toThrow(LiveAgentResultValidationError);
  });
});
