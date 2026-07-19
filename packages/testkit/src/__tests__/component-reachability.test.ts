/**
 * Component prefix reachability (PR5, Check 2 — STATIC, fast lane).
 *
 * The dispatch manifest is the ROUTING side of the contract: every button /
 * select / modal customId prefix the production dispatcher matches
 * (`startsWith` / `===`). This test proves the OTHER direction for the component
 * lanes: that the bot actually PRODUCES a customId carrying each routed
 * prefix/literal somewhere in `packages/bot/src` — a button/modal/select builder
 * that emits it. A manifest key with a routing branch but no producing site is
 * an ORPHAN HANDLER: the dispatcher would route a customId the bot never mints.
 *
 * Method (as specified): a substring scan of the bot SOURCE tree for each
 * manifest value. Dynamic customIds still carry the literal prefix in source
 * (e.g. `btnrole:${roleId}` contains `btnrole:`; `econ_${action}` … well, the
 * ECON_BUTTON exact literals like `econ_daily` are emitted verbatim), so a
 * substring/startsWith search finds them. No DB, no gateway, no docker — this is
 * a fast UNIT test and rides the default `vitest run` lane.
 *
 * Two exclusions keep the check MEANINGFUL rather than vacuous:
 *   1. `events/dispatch-manifest.ts` — the routing source of truth; it holds
 *      every literal AS DATA, so counting it as a "producer" would make every
 *      assertion trivially pass. Excluded.
 *   2. Test files (`__tests__/**`, `*.test.ts`, `*.spec.ts`) — a test that
 *      mentions a customId is not a production site. Excluded.
 * The live interaction-handler.ts is deliberately NOT excluded: it now sources
 * its routing keys from the manifest CONSTANTS (not raw literals), so any literal
 * it does contain is a genuine reply-builder producing that customId.
 *
 * COVERAGE BOUNDARY: this validates only the manifested component lanes. The
 * ticket / modal-fallthrough / custom-command lanes match their controls
 * INTERNALLY with no dispatcher-level static key (see the manifest's COVERAGE
 * BOUNDARY note) and are out of scope of this static registry by construction.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BUTTON_PREFIX,
  SELECT_LITERAL,
  MODAL_PREFIX,
  ECON_BUTTON,
} from '@somnibot/bot/dist/events/dispatch-manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/testkit/src/__tests__ → packages/bot/src
const BOT_SRC = path.resolve(HERE, '../../../bot/src');

/** Basename of the routing manifest — excluded so the check is not vacuous. */
const MANIFEST_BASENAME = 'dispatch-manifest.ts';

function isTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/__tests__/') || /\.(?:test|spec)\.ts$/.test(norm);
}

/** Recursively collect the bot's production `.ts` sources to scan for producers. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.d.ts')) continue;
    if (entry === MANIFEST_BASENAME) continue; // routing data, not a producer
    if (isTestPath(full)) continue;
    out.push(full);
  }
  return out;
}

// Fail LOUD (never silently pass) if the bot source tree cannot be located —
// an empty corpus would make every reachability assertion vacuously "green".
let sourceFiles: string[] = [];
try {
  sourceFiles = collectSourceFiles(BOT_SRC);
} catch (err) {
  throw new Error(
    `component-reachability: cannot read bot source at ${BOT_SRC} ` +
      `(${err instanceof Error ? err.message : String(err)}). This static check needs ` +
      'the production source tree to scan for customId producers.',
  );
}
if (sourceFiles.length === 0) {
  throw new Error(
    `component-reachability: found NO production .ts sources under ${BOT_SRC} — ` +
      'refusing to run a vacuous check.',
  );
}

/** One concatenated corpus of all production source, searched by substring. */
const CORPUS = sourceFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

interface ManifestEntry {
  readonly group: string;
  readonly key: string;
  readonly value: string;
}

function entriesOf(group: string, obj: Readonly<Record<string, string>>): ManifestEntry[] {
  return Object.entries(obj).map(([key, value]) => ({ group, key, value }));
}

const COMPONENT_ENTRIES: ManifestEntry[] = [
  ...entriesOf('BUTTON_PREFIX', BUTTON_PREFIX),
  ...entriesOf('SELECT_LITERAL', SELECT_LITERAL),
  ...entriesOf('MODAL_PREFIX', MODAL_PREFIX),
  ...entriesOf('ECON_BUTTON', ECON_BUTTON),
];

/** Relative source paths (for the failure message) that contain `value`. */
function producingFiles(value: string): string[] {
  return sourceFiles
    .filter((f) => readFileSync(f, 'utf-8').includes(value))
    .map((f) => path.relative(BOT_SRC, f).replace(/\\/g, '/'));
}

describe('component prefix reachability: every routed customId is produced in bot source', () => {
  it('has a non-empty production corpus to scan (guards against a vacuous pass)', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(COMPONENT_ENTRIES.length).toBeGreaterThan(0);
  });

  it.each(COMPONENT_ENTRIES)(
    'produces a customId for $group.$key ("$value")',
    ({ group, key, value }) => {
      const produced = CORPUS.includes(value);
      // If this fails it is a REAL orphan-handler finding: the dispatcher routes
      // `${value}` but no bot source ever mints a customId carrying it.
      expect(
        produced,
        `ORPHAN HANDLER: manifest ${group}.${key} = "${value}" is routed by the ` +
          `dispatcher but no production source under packages/bot/src produces a ` +
          `customId containing it. Either the producing button/modal/select builder ` +
          `was removed (dead routing branch) or the manifest value drifted.`,
      ).toBe(true);
      // When present, prove at least one concrete producing site (documents it).
      expect(producingFiles(value).length).toBeGreaterThan(0);
    },
  );
});
