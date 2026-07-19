/**
 * default-catalog — resolve + load the built-in v1 catalog data file.
 *
 * The catalog JSON (`packages/e2e/catalog/v1.json`) is DATA, not schema: this
 * helper only locates and loads it through the existing validated `loadCatalogFile`
 * path. It changes neither the catalog data nor the schema — it exists so consumers
 * (e.g. the testkit scenario runner) can obtain the validated catalog without
 * hard-coding a filesystem path relative to their own build output.
 */
import { fileURLToPath } from 'node:url';

import type { DomainCatalog, DomainContract } from './catalog.js';
import { loadCatalogFile } from './loader.js';

/**
 * Absolute path to the built-in v1 catalog data file. Resolved relative to THIS
 * module's compiled location (`dist/default-catalog.js`), so it is correct no
 * matter which package's working directory the process runs in.
 */
export function defaultCatalogPath(): string {
  return fileURLToPath(new URL('../catalog/v1.json', import.meta.url));
}

/** Load + validate the built-in v1 catalog. */
export function loadDefaultCatalog(): Promise<DomainCatalog> {
  return loadCatalogFile(defaultCatalogPath());
}

/**
 * Look a domain up by id in a loaded catalog. Returns undefined if absent so the
 * caller can decide whether a missing domain is a hard error for its use case.
 */
export function findDomain(
  catalog: DomainCatalog,
  domainId: string,
): DomainContract | undefined {
  for (const category of catalog.categories) {
    const match = category.domains.find((domain) => domain.id === domainId);
    if (match) return match;
  }
  return undefined;
}
