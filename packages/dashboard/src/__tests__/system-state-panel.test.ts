import type { SystemState } from '@somnibot/shared/system-state/contract';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  useEffect: vi.fn<(effect: () => (() => void) | void) => void>(),
  useState: vi.fn<(initial: unknown) => [unknown, (value: unknown) => void]>(),
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useEffect: hooks.useEffect,
  useState: hooks.useState,
}));

import { SystemStatePanel } from '@/components/system-state/system-state-panel';

let stateValue: unknown;

function render(): string {
  return renderToStaticMarkup(createElement(SystemStatePanel));
}

function beginReadback(): void {
  render();
  const effect = hooks.useEffect.mock.calls[0]?.[0];
  if (!effect) throw new Error('SystemState readback effect was not registered');
  effect();
}

function recoveryState(): SystemState {
  return {
    schemaVersion: 1,
    observedAt: '2026-08-31T14:00:00.000Z',
    mode: 'normal',
    identity: {
      lifecycle: 'ready', version: '1.0.0', exactSha: 'a'.repeat(40),
      bootId: null, migrationHead: null, configurationGeneration: null,
      deploymentProfile: 'vps-single-guild',
    },
    providers: [], queues: [], features: [], credentials: [], guildConditions: [],
    backups: {
      database: {
        status: 'current', capturedAt: '2026-08-31T13:00:00.000Z',
        checksumSha256: 'b'.repeat(64), lastRestoreRehearsalAt: '2026-08-31T13:30:00.000Z',
      },
      valkey: {
        status: 'current', capturedAt: '2026-08-31T13:05:00.000Z',
        checksumSha256: 'c'.repeat(64), lastRestoreRehearsalAt: null,
      },
    },
    recovery: {
      status: 'ready', rehearsalScope: 'database',
      lastRehearsalAt: '2026-08-31T13:30:00.000Z',
      recoveryPointObjectiveMinutes: null, recoveryTimeObjectiveMinutes: null,
      evidenceRef: 'recovery:fixture',
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  stateValue = undefined;
  hooks.useState.mockImplementation((initial) => {
    stateValue ??= initial;
    return [stateValue, (value) => { stateValue = value; }];
  });
  vi.stubGlobal('fetch', hooks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('system state panel', () => {
  it('announces deployment-state loading while authoritative readback is pending', () => {
    const html = render();

    expect(html).toContain('aria-label="Deployment state"');
    expect(html).toContain('aria-busy="true"');
  });

  it('renders separate recovery checksums and database-only rehearsal without mutable controls', async () => {
    hooks.fetch.mockResolvedValueOnce(Response.json({ data: recoveryState() }));

    beginReadback();

    await vi.waitFor(() => expect(render()).toContain('Backup and recovery evidence'));
    const html = render();
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('b'.repeat(64));
    expect(html).toContain('c'.repeat(64));
    expect(html).toContain('2026-08-31T13:30:00.000Z');
    expect(html).toMatch(/Valkey restore rehearsal<\/dt><dd[^>]*>Unknown<\/dd>/);
    expect(html).toMatch(/Recovery point objective \(minutes\)<\/dt><dd[^>]*>Unknown<\/dd>/);
    expect(html).toMatch(/Recovery time objective \(minutes\)<\/dt><dd[^>]*>Unknown<\/dd>/);
    expect(html).toContain('does not prove a Valkey restore or restore Storage object files');
    expect(html).toContain('run isolated recovery rehearsals in Launcher');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(hooks.fetch).toHaveBeenCalledOnce();
    expect(hooks.fetch).toHaveBeenCalledWith('/api/system-state', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('keeps missing recovery evidence visibly unverified', async () => {
    const state = recoveryState();
    state.recovery = { ...state.recovery, status: 'unverified', rehearsalScope: undefined, lastRehearsalAt: null };
    hooks.fetch.mockResolvedValueOnce(Response.json({ data: state }));

    beginReadback();

    await vi.waitFor(() => expect(render()).toContain('Action required'));
    expect(render()).toContain('Backup and recovery evidence — unverified');
    expect(render()).toContain('Missing restore evidence or recovery objectives remain unknown.');
    expect(render()).not.toContain('The verified rehearsal covers');
  });

  it('rejects malformed authoritative readback before rendering a recovery success', async () => {
    hooks.fetch.mockResolvedValueOnce(Response.json({ data: { recovery: { status: 'ready' } } }));

    beginReadback();

    await vi.waitFor(() => expect(render()).toContain('role="alert"'));
    expect(render()).toContain('System state readback was malformed.');
    expect(render()).not.toContain('Backup and recovery evidence');
  });
});
