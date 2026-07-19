// Assembles the per-category fragments into the canonical v1 catalog file.
// The fragments are the authoring unit; catalog/v1.json is the single
// schema-validated artifact the proof suites and CI consume. Requires a
// prior package build (imports the compiled loader).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_SPECS } from '../dist/catalog.js';
import { parseCatalogJson, toCanonicalJson } from '../dist/loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'catalog');
const fragmentsDir = join(catalogDir, 'fragments');

// Fragments are grouped by their internal `category` field, not by filename —
// a category may be authored as one whole-category file, several sub-fragments,
// or one file per domain (large categories are split to keep each authoring
// unit small enough to stream reliably). Within a category, domains are
// ordered by their id for stable output.
const byCategory = new Map(CATEGORY_SPECS.map((s) => [s.id, []]));
for (const file of readdirSync(fragmentsDir).filter((f) => f.endsWith('.json')).sort()) {
  const fragment = JSON.parse(readFileSync(join(fragmentsDir, file), 'utf-8'));
  const bucket = byCategory.get(fragment.category);
  if (!bucket) {
    throw new Error(`fragment ${file} declares unknown category ${fragment.category}`);
  }
  bucket.push(...fragment.domains);
}

const categories = CATEGORY_SPECS.map((spec) => {
  const domains = (byCategory.get(spec.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
  if (domains.length === 0) {
    throw new Error(`no fragment file(s) found for category ${spec.id}`);
  }
  return { id: spec.id, name: spec.name, domains };
});

const catalog = {
  schemaVersion: '1.0.0',
  catalogVersion: '1.0.0',
  release: 'v1.0',
  scope: {
    platforms: { required: ['Windows', 'Linux'], excluded: ['macOS'] },
    deferments: [
      {
        id: 'watch-together',
        name: 'Watch Together',
        disposition: 'deferred',
        targetRelease: 'v1.1',
      },
    ],
  },
  categories,
};

// parseCatalogJson runs the full DomainCatalogSchema including every
// cross-reference rule — assembly fails loudly on any invalid fragment.
const validated = parseCatalogJson(JSON.stringify(catalog), 'assembled catalog');
writeFileSync(join(catalogDir, 'v1.json'), toCanonicalJson(validated) + '\n');
const domainCount = validated.categories.reduce((n, c) => n + c.domains.length, 0);
console.log(`catalog/v1.json written: ${domainCount} domains across ${validated.categories.length} categories`);
