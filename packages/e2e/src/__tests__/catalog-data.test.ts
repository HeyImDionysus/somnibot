import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_SPECS, DOMAIN_COUNT } from '../catalog.js';
import { parseCatalogJson, toCanonicalJson } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', '..', 'catalog');
const catalogPath = join(catalogDir, 'v1.json');
const fragmentsDir = join(catalogDir, 'fragments');

// Re-assemble the catalog from the authoring fragments exactly as
// build-catalog.mjs does, so an edited fragment that was not rebuilt into
// v1.json fails CI (the drift tripwire, mirroring the db-types check).
function assembleFromFragments(): string {
  const byCategory = new Map<string, unknown[]>(CATEGORY_SPECS.map((s) => [s.id, []]));
  for (const file of readdirSync(fragmentsDir).filter((f) => f.endsWith('.json')).sort()) {
    const fragment = JSON.parse(readFileSync(join(fragmentsDir, file), 'utf-8'));
    const bucket = byCategory.get(fragment.category);
    if (!bucket) throw new Error(`fragment ${file} has unknown category ${fragment.category}`);
    bucket.push(...fragment.domains);
  }
  const categories = CATEGORY_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    domains: (byCategory.get(spec.id) ?? []).slice().sort(
      (a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id),
    ),
  }));
  const catalog = {
    schemaVersion: '1.0.0',
    catalogVersion: '1.0.0',
    release: 'v1.0',
    scope: {
      platforms: { required: ['Windows', 'Linux'], excluded: ['macOS'] },
      deferments: [{ id: 'watch-together', name: 'Watch Together', disposition: 'deferred', targetRelease: 'v1.1' }],
    },
    categories,
  };
  return toCanonicalJson(parseCatalogJson(JSON.stringify(catalog), 'assembled')) + '\n';
}

// The REAL catalog data is a gated artifact: every contract rule the schema
// enforces (exact scenario/assertion classes, cross-references, placeholder
// rejection, category counts) must hold for the shipped v1 catalog, not just
// for synthetic fixtures.
describe('catalog/v1.json (shipped contract data)', () => {
  const raw = readFileSync(catalogPath, 'utf-8');
  const catalog = parseCatalogJson(raw, 'catalog/v1.json');

  it('carries all 46 domains in the locked category partition', () => {
    expect(catalog.categories).toHaveLength(CATEGORY_SPECS.length);
    for (const spec of CATEGORY_SPECS) {
      const category = catalog.categories.find((c) => c.id === spec.id);
      expect(category, spec.id).toBeDefined();
      expect(category!.domains, spec.id).toHaveLength(spec.domainCount);
    }
    const total = catalog.categories.reduce((n, c) => n + c.domains.length, 0);
    expect(total).toBe(DOMAIN_COUNT);
  });

  it('is stored in canonical form (stable diffs, deterministic ordering)', () => {
    expect(raw).toBe(toCanonicalJson(catalog) + '\n');
  });

  it('is pinned to the v1.0 release contract', () => {
    expect(catalog.release).toBe('v1.0');
    expect(catalog.scope.platforms.required).toEqual(['Windows', 'Linux']);
    expect(catalog.scope.deferments.map((d) => d.id)).toEqual(['watch-together']);
  });

  it('is in sync with the authoring fragments (rebuild is a no-op)', () => {
    expect(raw).toBe(assembleFromFragments());
  });
});
