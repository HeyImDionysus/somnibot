import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type CapabilitySurfaceInventory = {
  readonly dashboardRoutes: readonly string[];
  readonly portalRoutes: readonly string[];
  readonly botFeatures: readonly string[];
  readonly scenarioProofs: readonly string[];
  readonly discordCommands: readonly string[];
  readonly databaseTables: readonly string[];
};

function collectFiles(root: string, fileName: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, fileName));
    } else if (entry.name === fileName) {
      files.push(entryPath);
    }
  }
  return files;
}

function toApplicationRoute(applicationRoot: string, pagePath: string): string {
  const relativeDirectory = path.relative(applicationRoot, path.dirname(pagePath));
  const routeSegments = relativeDirectory
    .split(path.sep)
    .filter((segment) => segment.length > 0 && !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${routeSegments.join('/')}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export class CapabilitySurfaceDiscoveryError extends Error {
  readonly blockName: string;

  constructor(blockName: string) {
    super(`Could not discover the ${blockName} block in the bot dispatch manifest.`);
    this.name = 'CapabilitySurfaceDiscoveryError';
    this.blockName = blockName;
  }
}

function captureBlock(source: string, blockName: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  const block = match?.[1];
  if (!block) throw new CapabilitySurfaceDiscoveryError(blockName);
  return block;
}

function quotedValues(source: string): readonly string[] {
  return [...source.matchAll(/'([^']+)'/g)].flatMap((match) => {
    const value = match[1];
    return value ? [value] : [];
  });
}

function discoverDiscordCommands(repositoryRoot: string): readonly string[] {
  const manifestPath = path.join(repositoryRoot, 'packages', 'bot', 'src', 'events', 'dispatch-manifest.ts');
  const source = readFileSync(manifestPath, 'utf8');
  const slash = quotedValues(captureBlock(source, 'SLASH', /export const SLASH = \{([\s\S]*?)\} as const;/))
    .filter((command) => command !== 'setup');
  const commandBlocks = [
    ['MUSIC_COMMANDS', /export const MUSIC_COMMANDS[^=]*= new Set\(\[([\s\S]*?)\]\);/],
    ['ECONOMY_COMMANDS', /export const ECONOMY_COMMANDS[^=]*= new Set\(\[([\s\S]*?)\]\);/],
    ['GATHERING_COMMANDS', /export const GATHERING_COMMANDS[^=]*= new Set\(\[([\s\S]*?)\]\);/],
    ['CRAFTING_COMMANDS', /export const CRAFTING_COMMANDS[^=]*= new Set\(\[([\s\S]*?)\]\);/],
    ['GAME_COMMANDS', /export const GAME_COMMANDS[^=]*= \[([\s\S]*?)\];/],
    ['PROFILE_COMMANDS', /export const PROFILE_COMMANDS[^=]*= \[([\s\S]*?)\];/],
    ['REGISTRY_COMMAND_NAMES', /export const REGISTRY_COMMAND_NAMES[^=]*= \[([\s\S]*?)\];/],
  ] as const;
  const commands = commandBlocks.flatMap(([blockName, pattern]) =>
    quotedValues(captureBlock(source, blockName, pattern))
  );
  return sortedUnique([...slash, ...commands].map((command) => `/${command}`));
}

function discoverDatabaseTables(repositoryRoot: string): readonly string[] {
  const migrationRoot = path.join(repositoryRoot, 'packages', 'supabase', 'migrations');
  const migrations = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'));
  const tables = migrations.flatMap((migration) => {
    const source = readFileSync(path.join(migrationRoot, migration.name), 'utf8');
    return [...source.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z][a-z0-9_]*)/gi)]
      .flatMap((match) => match[1] ? [match[1].toLowerCase()] : []);
  });
  return sortedUnique(tables);
}

export function discoverCapabilitySurfaces(repositoryRoot: string): CapabilitySurfaceInventory {
  const applicationRoot = path.join(repositoryRoot, 'packages', 'dashboard', 'src', 'app');
  const routes = collectFiles(applicationRoot, 'page.tsx')
    .map((pagePath) => toApplicationRoute(applicationRoot, pagePath))
    .filter((route) => route !== '/');
  const portalRoutes = routes.filter((route) => route === '/portal' || route.startsWith('/portal/'));
  const dashboardRoutes = routes.filter((route) => route !== '/portal' && !route.startsWith('/portal/'));

  const botFeatureRoot = path.join(repositoryRoot, 'packages', 'bot', 'src', 'features');
  const botFeatures = readdirSync(botFeatureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const proofRoot = path.join(repositoryRoot, 'packages', 'testkit', 'src', 'scenario-runner', 'scripts');
  const scenarioProofs = readdirSync(proofRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'all-proofs.ts')
    .map((entry) => entry.name.slice(0, -3));

  return {
    dashboardRoutes: sortedUnique(dashboardRoutes),
    portalRoutes: sortedUnique(portalRoutes),
    botFeatures: sortedUnique(botFeatures),
    scenarioProofs: sortedUnique(scenarioProofs),
    discordCommands: discoverDiscordCommands(repositoryRoot),
    databaseTables: discoverDatabaseTables(repositoryRoot),
  };
}
