import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSERTION_CLASSES,
  CATALOG_SCHEMA_VERSION,
  CATEGORY_SPECS,
  DOMAIN_COUNT,
  EXCLUDED_PLATFORMS,
  REQUIRED_PLATFORMS,
  SCENARIO_CLASSES,
  type CategoryId,
  type DomainCatalog,
} from '../catalog.js';
import {
  CatalogParseError,
  CatalogValidationError,
  canonicalizeCatalog,
  loadCatalogFile,
  parseCatalogJson,
  toCanonicalJson,
  validateCatalog,
} from '../loader.js';

describe('domain catalog contract', () => {
  it('accepts a complete synthetic seven-category, 46-domain catalog', () => {
    const catalog = createValidCatalog();

    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(catalog.categories).toHaveLength(CATEGORY_SPECS.length);
    expect(catalog.categories.flatMap((category) => category.domains)).toHaveLength(DOMAIN_COUNT);
    expect(catalog.scope.platforms.required).toEqual(REQUIRED_PLATFORMS);
    expect(catalog.scope.platforms.excluded).toEqual(EXCLUDED_PLATFORMS);
    expect(catalog.scope.deferments).toEqual([
      {
        id: 'watch-together',
        name: 'Watch Together',
        disposition: 'deferred',
        targetRelease: 'v1.1',
      },
    ]);

    for (const category of catalog.categories) {
      const spec = CATEGORY_SPECS.find((candidate) => candidate.id === category.id)!;
      expect(category.domains).toHaveLength(spec.domainCount);
      for (const domain of category.domains) {
        expect(new Set(domain.scenarios.map((scenario) => scenario.class))).toEqual(
          new Set(SCENARIO_CLASSES),
        );
        for (const scenario of domain.scenarios) {
          expect(new Set(scenario.assertions.map((entry) => entry.assertionClass))).toEqual(
            new Set(ASSERTION_CLASSES),
          );
          expect(scenario.assertions.every((entry) => entry.expectedObservation.length > 0)).toBe(
            true,
          );
        }
        expect(new Set(domain.evidence.map((entry) => entry.assertionClass))).toEqual(
          new Set(ASSERTION_CLASSES),
        );
      }
    }
  });

  it('keeps the exported contract axes immutable at runtime', () => {
    expect(Object.isFrozen(CATEGORY_SPECS)).toBe(true);
    expect(CATEGORY_SPECS.every((spec) => Object.isFrozen(spec))).toBe(true);
    expect(Object.isFrozen(SCENARIO_CLASSES)).toBe(true);
    expect(Object.isFrozen(ASSERTION_CLASSES)).toBe(true);
    expect(Object.isFrozen(REQUIRED_PLATFORMS)).toBe(true);
    expect(Object.isFrozen(EXCLUDED_PLATFORMS)).toBe(true);
  });

  it('rejects unknown keys at top-level and nested strict-schema boundaries', () => {
    const topLevel = cloneCatalog();
    (topLevel as unknown as Record<string, unknown>).unexpected = true;
    expect(() => validateCatalog(topLevel)).toThrow(CatalogValidationError);

    const nested = cloneCatalog();
    (nested.categories[0].domains[0].controls[0] as unknown as Record<string, unknown>).unexpected =
      true;
    expect(() => validateCatalog(nested)).toThrow(CatalogValidationError);
  });

  it('rejects category count drift and a catalog total other than 46 domains', () => {
    const catalog = cloneCatalog();
    catalog.categories[0].domains.pop();

    expect(() => validateCatalog(catalog)).toThrow(/requires exactly 10 domains/);
    expect(() => validateCatalog(catalog)).toThrow(/requires exactly 46 domains/);
  });

  it('requires each exact category once with its stable name', () => {
    const duplicate = cloneCatalog();
    duplicate.categories[1].id = 'community';
    expect(() => validateCatalog(duplicate)).toThrow(/Duplicate category id "community"/);
    expect(() => validateCatalog(duplicate)).toThrow(/Missing category "game-economy"/);

    const renamed = cloneCatalog();
    renamed.categories[0].name = 'Communities';
    expect(() => validateCatalog(renamed)).toThrow(/must be named "Community"/);
  });

  it('requires 46 globally unique domain ids in matching category containers', () => {
    const duplicate = cloneCatalog();
    duplicate.categories[1].domains[0].id = duplicate.categories[0].domains[0].id;
    expect(() => validateCatalog(duplicate)).toThrow(/Duplicate domain id/);

    const mismatched = cloneCatalog();
    mismatched.categories[0].domains[0].category = 'music';
    expect(() => validateCatalog(mismatched)).toThrow(/does not match container "community"/);
  });

  it('requires each scenario class exactly once and globally unique scenario ids', () => {
    const duplicateClass = cloneCatalog();
    duplicateClass.categories[0].domains[0].scenarios.at(-1)!.class = 'DEF';
    expect(() => validateCatalog(duplicateClass)).toThrow(/Duplicate scenario class "DEF"/);
    expect(() => validateCatalog(duplicateClass)).toThrow(/Missing scenario class "CLEANUP"/);

    const duplicateId = cloneCatalog();
    duplicateId.categories[1].domains[0].scenarios[0].id =
      duplicateId.categories[0].domains[0].scenarios[0].id;
    expect(() => validateCatalog(duplicateId)).toThrow(/Duplicate scenario id/);
  });

  it('requires all seven evidence classes and expected assertions in every scenario', () => {
    const duplicateEvidence = cloneCatalog();
    duplicateEvidence.categories[0].domains[0].evidence.at(-1)!.assertionClass = 'Discord';
    expect(() => validateCatalog(duplicateEvidence)).toThrow(
      /Duplicate evidence assertion class "Discord"/,
    );
    expect(() => validateCatalog(duplicateEvidence)).toThrow(
      /Missing assertion class "cleanup"/,
    );

    const missingScenarioCoverage = cloneCatalog();
    const scenario = missingScenarioCoverage.categories[0].domains[0].scenarios[0];
    scenario.assertions = scenario.assertions.filter(
      (entry) => entry.assertionClass !== 'cleanup',
    );
    expect(() => validateCatalog(missingScenarioCoverage)).toThrow(
      /Missing scenario assertion class "cleanup"/,
    );
  });

  it('requires defaults to satisfy their declared control types and enum choices', () => {
    const wrongBoolean = cloneCatalog();
    wrongBoolean.categories[0].domains[0].defaults[0].value = 'yes';
    expect(() => validateCatalog(wrongBoolean)).toThrow(
      /Default does not satisfy control type "boolean"/,
    );

    const unknownEnumChoice = cloneCatalog();
    unknownEnumChoice.categories[0].domains[0].defaults[1].value = 'gamma';
    expect(() => validateCatalog(unknownEnumChoice)).toThrow(
      /Default does not satisfy control type "enum"/,
    );
  });

  it('requires message variables and template placeholders to match exactly', () => {
    const missingVariable = cloneCatalog();
    missingVariable.categories[0].domains[0].messages[0].variables = [];
    expect(() => validateCatalog(missingVariable)).toThrow(/Missing template placeholder "domain"/);

    const unusedVariable = cloneCatalog();
    unusedVariable.categories[0].domains[0].messages[0].variables.push('actor');
    expect(() => validateCatalog(unusedVariable)).toThrow(/Missing message variable "actor"/);
  });

  it.each(['TODO', '[TBD]', 'placeholder: decide later', 'mock-only'])(
    'rejects unresolved narrative placeholder text: %s',
    (placeholder) => {
      const catalog = cloneCatalog();
      catalog.categories[0].domains[0].promise = placeholder;
      expect(() => validateCatalog(catalog)).toThrow(/Unresolved placeholder text is forbidden/);
    },
  );

  it.each([
    ['unknown default control', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].defaults[0].controlId = 'missing-control';
    }, /Unknown control "missing-control"/],
    ['control without default', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].defaults.pop();
    }, /has no default/],
    ['unknown initial state', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].state.initial = 'missing-state';
    }, /Unknown initial state "missing-state"/],
    ['unknown transition source', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].state.transitions[0].from = 'missing-state';
    }, /Unknown state "missing-state"/],
    ['unknown failure state', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].failures[0].resultingState = 'missing-state';
    }, /Unknown state "missing-state"/],
    ['unknown failure message', (catalog: DomainCatalog) => {
      catalog.categories[0].domains[0].failures[0].messageId = 'missing-message';
    }, /Unknown message "missing-message"/],
  ] as const)('rejects broken domain references: %s', (_name, mutate, message) => {
    const catalog = cloneCatalog();
    mutate(catalog);
    expect(() => validateCatalog(catalog)).toThrow(message);
  });

  it('locks Windows and Linux as required and macOS as excluded', () => {
    const missingLinux = cloneCatalog();
    missingLinux.scope.platforms.required = ['Windows', 'Windows'];
    expect(() => validateCatalog(missingLinux)).toThrow(/Missing required platform "Linux"/);

    const macIncluded = cloneCatalog();
    (macIncluded.scope.platforms.required as string[])[1] = 'macOS';
    expect(() => validateCatalog(macIncluded)).toThrow(CatalogValidationError);

    const wrongExclusion = cloneCatalog();
    (wrongExclusion.scope.platforms.excluded as string[])[0] = 'Windows';
    expect(() => validateCatalog(wrongExclusion)).toThrow(CatalogValidationError);
  });

  it('allows only the exact Watch Together v1.1 deferment', () => {
    const wrongRelease = cloneCatalog();
    (wrongRelease.scope.deferments[0] as { targetRelease: string }).targetRelease = 'v1.0';
    expect(() => validateCatalog(wrongRelease)).toThrow(CatalogValidationError);

    const renamed = cloneCatalog();
    (renamed.scope.deferments[0] as { name: string }).name = 'Video';
    expect(() => validateCatalog(renamed)).toThrow(CatalogValidationError);

    const extra = cloneCatalog();
    extra.scope.deferments.push(structuredClone(extra.scope.deferments[0]));
    expect(() => validateCatalog(extra)).toThrow(CatalogValidationError);
  });

  it.each(['TODO', 'TBD', 'placeholder', 'skip', 'mock-only'])(
    'rejects the forbidden scenario disposition %s',
    (disposition) => {
      const catalog = cloneCatalog();
      (catalog.categories[0].domains[0].scenarios[0] as { disposition: string }).disposition =
        disposition;
      expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
    },
  );

  it('requires real-stack evidence instead of mock-only proof', () => {
    const catalog = cloneCatalog();
    (catalog.categories[0].domains[0].evidence[0] as { proofMode: string }).proofMode =
      'mock-only';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('does not confuse product wording with a forbidden disposition', () => {
    const catalog = cloneCatalog();
    catalog.categories[3].domains[0].messages[0].defaultTemplate =
      'A requester can skip their own track in {domain}.';
    expect(validateCatalog(catalog)).toBeDefined();
  });

  it('produces identical canonical JSON for semantically reordered catalogs', () => {
    const original = cloneCatalog();
    const reordered = cloneCatalog();
    reordered.categories.reverse();
    reordered.scope.platforms.required.reverse();
    for (const category of reordered.categories) {
      category.domains.reverse();
      for (const domain of category.domains) {
        domain.controls.reverse();
        domain.defaults.reverse();
        domain.permissions.reverse();
        domain.messages.reverse();
        domain.messages.forEach((message) => message.variables.reverse());
        domain.state.values.reverse();
        domain.state.transitions.reverse();
        domain.failures.reverse();
        domain.evidence.reverse();
        domain.scenarios.reverse();
        domain.scenarios.forEach((scenario) => scenario.assertions.reverse());
      }
    }

    const originalJson = toCanonicalJson(original);
    const reorderedJson = toCanonicalJson(reordered);

    expect(reorderedJson).toBe(originalJson);
    expect(originalJson).not.toMatch(/\n|\r|\t/);
    expect(canonicalizeCatalog(reordered).categories.map((category) => category.id)).toEqual(
      CATEGORY_SPECS.map((spec) => spec.id),
    );
  });

  it('parses valid JSON and reports syntax and schema origins', () => {
    const json = JSON.stringify(createValidCatalog());
    expect(parseCatalogJson(json, 'memory.json')).toEqual(createValidCatalog());

    expect(() => parseCatalogJson('{', 'broken.json')).toThrow(CatalogParseError);
    expect(() => parseCatalogJson('{', 'broken.json')).toThrow(/broken\.json/);

    const invalid = cloneCatalog();
    invalid.catalogVersion = 'v1';
    expect(() => parseCatalogJson(JSON.stringify(invalid), 'invalid.json')).toThrow(
      /invalid\.json/,
    );
  });

  it('loads and validates a catalog file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'somnibot-e2e-catalog-'));
    const filePath = join(directory, 'catalog.json');
    try {
      await writeFile(filePath, JSON.stringify(createValidCatalog()), 'utf8');
      await expect(loadCatalogFile(filePath)).resolves.toEqual(createValidCatalog());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createValidCatalog(): DomainCatalog {
  return validateCatalog({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalogVersion: '1.0.0',
    release: 'v1.0',
    scope: {
      platforms: {
        required: [...REQUIRED_PLATFORMS],
        excluded: [...EXCLUDED_PLATFORMS],
      },
      deferments: [
        {
          id: 'watch-together',
          name: 'Watch Together',
          disposition: 'deferred',
          targetRelease: 'v1.1',
        },
      ],
    },
    categories: CATEGORY_SPECS.map((spec) => ({
      id: spec.id,
      name: spec.name,
      domains: Array.from({ length: spec.domainCount }, (_value, index) =>
        createDomain(spec.id, index + 1),
      ),
    })),
  });
}

function createDomain(category: CategoryId, index: number) {
  const domainId = `${category}-synthetic-${String(index).padStart(2, '0')}`;
  return {
    id: domainId,
    name: `Synthetic ${category} domain ${index}`,
    category,
    promise: `Exercise the ${domainId} contract without encoding production behavior.`,
    controls: [
      {
        id: 'enabled',
        description: 'Synthetic enablement control.',
        valueType: 'boolean' as const,
        constraints: {},
      },
      {
        id: 'mode',
        description: 'Synthetic mode control.',
        valueType: 'enum' as const,
        constraints: { values: ['alpha', 'beta'] },
      },
    ],
    defaults: [
      { controlId: 'enabled', value: true, rationale: 'Synthetic deterministic default.' },
      { controlId: 'mode', value: 'alpha', rationale: 'Synthetic deterministic mode.' },
    ],
    permissions: [
      {
        id: 'operate',
        actor: 'Synthetic authorized actor',
        action: 'Operate the synthetic domain',
        defaultDecision: 'allow' as const,
        enforcement: 'Synthetic permission boundary.',
      },
      {
        id: 'administer',
        actor: 'Synthetic unauthorized actor',
        action: 'Administer the synthetic domain',
        defaultDecision: 'deny' as const,
        enforcement: 'Synthetic denied permission boundary.',
      },
    ],
    messages: [
      {
        id: 'failure',
        trigger: 'Synthetic dependency failure',
        surface: 'Synthetic surface',
        audience: 'Synthetic actor',
        defaultTemplate: 'Synthetic failure for {domain}.',
        variables: ['domain'],
      },
      {
        id: 'success',
        trigger: 'Synthetic success',
        surface: 'Synthetic surface',
        audience: 'Synthetic actor',
        defaultTemplate: 'Synthetic success for {actor} in {domain}.',
        variables: ['actor', 'domain'],
      },
    ],
    state: {
      initial: 'idle',
      values: [
        { id: 'idle', description: 'Synthetic initial state.' },
        { id: 'active', description: 'Synthetic active state.' },
        { id: 'failed', description: 'Synthetic failure state.' },
      ],
      transitions: [
        {
          id: 'activate',
          from: 'idle',
          to: 'active',
          trigger: 'Synthetic valid input',
          expectedEffect: 'Synthetic state becomes active.',
        },
        {
          id: 'fail',
          from: 'active',
          to: 'failed',
          trigger: 'Synthetic dependency failure',
          expectedEffect: 'Synthetic state records the failure.',
        },
      ],
    },
    failures: [
      {
        id: 'dependency-failure',
        trigger: 'Synthetic dependency is unavailable',
        expectedBehavior: 'Record the failure without partial state.',
        resultingState: 'failed',
        retry: 'automatic' as const,
        messageId: 'failure',
        auditEvent: 'synthetic.dependency_failed',
        ownerNotification: true,
      },
    ],
    evidence: ASSERTION_CLASSES.map((assertionClass) => ({
      assertionClass,
      proofMode: 'real-stack' as const,
      observer: `Synthetic ${assertionClass} observer`,
      expectedObservation: `Synthetic ${assertionClass} result is recorded.`,
      artifact: `evidence/${domainId}/${assertionClass}`,
    })),
    scenarios: SCENARIO_CLASSES.map((scenarioClass) => ({
      id: `${domainId}-${scenarioClass.toLowerCase()}`,
      class: scenarioClass,
      disposition: 'required' as const,
      promise: `Synthetic ${scenarioClass} promise.`,
      expectedOutcome: `Synthetic ${scenarioClass} outcome.`,
      assertions: ASSERTION_CLASSES.map((assertionClass) => ({
        assertionClass,
        expectedObservation: `Synthetic ${scenarioClass} ${assertionClass} observation.`,
      })),
    })),
  };
}

function cloneCatalog(): DomainCatalog {
  return structuredClone(createValidCatalog());
}
