import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  useState: vi.fn<(initial: unknown) => [unknown, (value: unknown) => void]>(),
  useEffect: vi.fn<(effect: () => void) => void>(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));

import { ConnectionSettings } from '@/components/settings/connection-settings';
import { CONNECTION_SECTIONS } from '@/components/settings/connection-settings-config';

const renderState: { cursor: number; values: unknown[] } = { cursor: 0, values: [] };

function render(): string {
  renderState.cursor = 0;
  return renderToStaticMarkup(React.createElement(ConnectionSettings));
}

function startReadback(): void {
  render();
  const effect = hooks.useEffect.mock.calls[0]?.[0];
  if (!effect) throw new Error('Connection readback effect was not registered');
  effect();
}

beforeEach(() => {
  vi.resetAllMocks();
  renderState.cursor = 0;
  renderState.values = [];
  hooks.useState.mockImplementation((initial) => {
    const index = renderState.cursor++;
    if (index >= renderState.values.length) renderState.values.push(initial);
    return [renderState.values[index], (value) => { renderState.values[index] = value; }];
  });
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', hooks.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('connection settings authoritative readback', () => {
  it.each(['transport', 'http', 'malformed'] as const)('keeps connection state unknown after a %s failure', async (failure) => {
    if (failure === 'transport') hooks.fetch.mockRejectedValueOnce(new Error('private transport detail'));
    else hooks.fetch.mockResolvedValueOnce(Response.json({}, { status: failure === 'http' ? 500 : 200 }));

    startReadback();

    await vi.waitFor(() => expect(render()).toContain('Connection status unavailable'));
    const markup = render();
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('connection sections configured');
    expect(markup).not.toContain('Not configured');
  });

  it('labels saved settings accurately and never renders a secret value', async () => {
    hooks.fetch.mockResolvedValueOnce(Response.json({
      values: { discord_application_id: '123456', discord_bot_token: 'do-not-render-secret' },
      sources: { discord_application_id: 'db', discord_bot_token: 'db' },
      statuses: Object.fromEntries(CONNECTION_SECTIONS.map((section) => [section.id, 'connected'])),
    }));

    startReadback();

    await vi.waitFor(() => expect(render()).toContain('123456'));
    const markup = render();
    expect(markup).toContain('Saved installation value');
    expect(markup).not.toContain('Encrypted saved value');
    expect(markup).not.toContain('do-not-render-secret');
  });
});
