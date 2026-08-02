import { findDomain, loadDefaultCatalog } from '@somnibot/e2e';
import { beforeAll, describe, expect, it } from 'vitest';

import { ScenarioContextImpl } from '../scenario-runner/context.js';

let domain: NonNullable<ReturnType<typeof findDomain>>;

beforeAll(async () => {
  const catalog = await loadDefaultCatalog();
  const found = findDomain(catalog, 'game-economy-fishing');
  if (!found) throw new Error('game-economy-fishing is missing from the default catalog');
  domain = found;
});

function createContext(): ScenarioContextImpl {
  return new ScenarioContextImpl({
    domain,
    scenarioClass: 'DEF',
    runPrefix: 'status-test-',
    capabilities: {
      supabaseLocal: true,
      redis: true,
      discordReadback: false,
      paypalSandbox: false,
      anonKey: null,
    },
    guildScopedTables: [],
  });
}

describe('ScenarioContextImpl evidence status', () => {
  it('keeps a class gated when one record passes but another proof remains gated', () => {
    const context = createContext();
    context.pass('Discord', 'captured-reply', 'local behavior', 'captured locally');
    context.gate('Discord', 'discord-readback', 'live behavior', 'pending live readback');

    const discord = context.buildEvidence().classes.find((entry) => entry.assertionClass === 'Discord');
    expect(discord?.status).toBe('GATED');
  });

  it('keeps failure as the highest-precedence class status', () => {
    const context = createContext();
    context.pass('audit', 'audit-row', 'audit behavior', 'audit row found');
    context.gate('audit', 'discord-readback', 'audit display', 'pending live readback');
    context.fail('audit', 'audit-row', 'audit integrity', 'duplicate row found', 'duplicate audit effect');

    const audit = context.buildEvidence().classes.find((entry) => entry.assertionClass === 'audit');
    expect(audit?.status).toBe('FAIL');
  });
});
