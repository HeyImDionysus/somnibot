import { readFile } from 'node:fs/promises';
import type { ZodIssue } from 'zod';

import {
  ASSERTION_CLASSES,
  CATEGORY_SPECS,
  DomainCatalogSchema,
  EXCLUDED_PLATFORMS,
  REQUIRED_PLATFORMS,
  SCENARIO_CLASSES,
  type DomainCatalog,
  type DomainContract,
  type JsonValue,
} from './catalog.js';

export class CatalogValidationError extends Error {
  readonly source: string;
  readonly issues: readonly ZodIssue[];

  constructor(source: string, issues: readonly ZodIssue[]) {
    const details = issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join('; ');
    super(`Invalid domain catalog from ${source}: ${details}`);
    this.name = 'CatalogValidationError';
    this.source = source;
    this.issues = issues;
  }
}

export class CatalogParseError extends Error {
  readonly source: string;

  constructor(source: string, cause: unknown) {
    super(`Domain catalog from ${source} is not valid JSON`, { cause });
    this.name = 'CatalogParseError';
    this.source = source;
  }
}

export function validateCatalog(input: unknown, source = 'value'): DomainCatalog {
  const result = DomainCatalogSchema.safeParse(input);
  if (!result.success) {
    throw new CatalogValidationError(source, result.error.issues);
  }
  return result.data;
}

export function parseCatalogJson(json: string, source = 'JSON input'): DomainCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new CatalogParseError(source, error);
  }
  return validateCatalog(parsed, source);
}

export async function loadCatalogFile(filePath: string): Promise<DomainCatalog> {
  const json = await readFile(filePath, 'utf8');
  return parseCatalogJson(json, filePath);
}

export function canonicalizeCatalog(input: unknown): DomainCatalog {
  const catalog = validateCatalog(input);
  const categoriesById = new Map(catalog.categories.map((category) => [category.id, category]));

  return {
    ...catalog,
    scope: {
      platforms: {
        required: [...REQUIRED_PLATFORMS],
        excluded: [...EXCLUDED_PLATFORMS],
      },
      deferments: [...catalog.scope.deferments],
    },
    categories: CATEGORY_SPECS.map((spec) => {
      const category = categoriesById.get(spec.id);
      if (!category) {
        throw new Error(`Validated catalog is missing category "${spec.id}"`);
      }
      return {
        ...category,
        domains: [...category.domains]
          .sort((left, right) => compareText(left.id, right.id))
          .map(canonicalizeDomain),
      };
    }),
  };
}

export function toCanonicalJson(input: unknown): string {
  return JSON.stringify(sortObjectKeys(canonicalizeCatalog(input)));
}

function canonicalizeDomain(domain: DomainContract): DomainContract {
  const assertionOrder = new Map(ASSERTION_CLASSES.map((value, index) => [value, index]));
  const scenarioOrder = new Map(SCENARIO_CLASSES.map((value, index) => [value, index]));

  return {
    ...domain,
    controls: sortBy(domain.controls, (entry) => entry.id),
    defaults: sortBy(domain.defaults, (entry) => entry.controlId),
    permissions: sortBy(domain.permissions, (entry) => entry.id),
    messages: sortBy(domain.messages, (entry) => entry.id).map((message) => ({
      ...message,
      variables: [...message.variables].sort(compareText),
    })),
    state: {
      ...domain.state,
      values: sortBy(domain.state.values, (entry) => entry.id),
      transitions: sortBy(domain.state.transitions, (entry) => entry.id),
    },
    failures: sortBy(domain.failures, (entry) => entry.id),
    evidence: [...domain.evidence].sort(
      (left, right) =>
        assertionOrder.get(left.assertionClass)! - assertionOrder.get(right.assertionClass)!,
    ),
    scenarios: [...domain.scenarios]
      .sort((left, right) => scenarioOrder.get(left.class)! - scenarioOrder.get(right.class)!)
      .map((scenario) => ({
        ...scenario,
        assertions: [...scenario.assertions].sort(
          (left, right) =>
            assertionOrder.get(left.assertionClass)! -
            assertionOrder.get(right.assertionClass)!,
        ),
      })),
  };
}

function sortBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareText(key(left), key(right)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortObjectKeys(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot contain a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareText)
        .map((key) => [key, sortObjectKeys(record[key])]),
    );
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

function formatPath(path: Array<string | number>): string {
  if (path.length === 0) {
    return '<root>';
  }
  return path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : `${index === 0 ? '' : '.'}${segment}`,
    )
    .join('');
}
