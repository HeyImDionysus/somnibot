import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  toast: vi.fn(),
  useEffect: vi.fn<(effect: () => void) => void>(),
  useState: vi.fn<(initial: unknown) => [unknown, (value: unknown) => void]>(),
}));

let save: (() => Promise<void>) | undefined;

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useEffect: hooks.useEffect,
  useState: hooks.useState,
}));

vi.mock('@/components/shared/button', () => ({
  Button: ({ children, onClick }: { readonly children?: React.ReactNode; readonly onClick?: () => Promise<void> }) => {
    save = onClick;
    return React.createElement('button', { onClick }, children);
  },
}));

vi.mock('@/components/shared/toast', () => ({
  useToast: () => ({ toast: hooks.toast }),
}));

import { AdministrationControls } from '@/components/settings/administration-controls';

const renderState: { cursor: number; values: unknown[] } = { cursor: 0, values: [] };

function render(): string {
  renderState.cursor = 0;
  return renderToStaticMarkup(React.createElement(AdministrationControls));
}

function loadGuildControls(): void {
  render();
  const effect = hooks.useEffect.mock.calls[0]?.[0];
  if (!effect) throw new Error('Administration controls load effect was not registered');
  effect();
}

beforeEach(() => {
  vi.resetAllMocks();
  save = undefined;
  renderState.cursor = 0;
  renderState.values = [];
  vi.stubGlobal('React', React);
  hooks.useState.mockImplementation((initial) => {
    const index = renderState.cursor++;
    if (index >= renderState.values.length) renderState.values.push(initial);
    return [renderState.values[index], (value) => {
      renderState.values[index] = typeof value === 'function'
        ? value(renderState.values[index])
        : value;
    }];
  });
  vi.stubGlobal('fetch', hooks.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('administration controls authority', () => {
  it('renders Launcher-owned infrastructure as a read-only handoff', async () => {
    hooks.fetch.mockResolvedValueOnce(Response.json({ config: {} }));

    loadGuildControls();

    await vi.waitFor(() => expect(render()).toContain('Launcher and infrastructure'));
    const markup = render();
    expect(markup).toContain('managed in the SomniBot Launcher');
    expect(markup).toContain('cannot change Launcher settings');
    expect(markup).not.toContain('Install updates when quitting');
    expect(markup).not.toContain('VPS deploy path');
    expect(hooks.fetch).toHaveBeenCalledTimes(1);
    expect(hooks.fetch).toHaveBeenCalledWith('/api/guild');
  });

  it('saves server controls through the guild endpoint without a settings write', async () => {
    hooks.fetch
      .mockResolvedValueOnce(Response.json({ config: { audit_export_row_limit: 2500 } }))
      .mockResolvedValueOnce(Response.json({ success: true }));

    loadGuildControls();

    await vi.waitFor(() => expect(render()).toContain('Save server administration controls'));
    if (!save) throw new Error('Server administration save action was not registered');
    await save();

    expect(hooks.fetch).toHaveBeenNthCalledWith(1, '/api/guild');
    expect(hooks.fetch).toHaveBeenNthCalledWith(2, '/api/guild', expect.objectContaining({ method: 'PATCH' }));
    expect(hooks.fetch.mock.calls.flat().join(' ')).not.toContain('/api/settings');
    expect(hooks.toast).toHaveBeenCalledWith({ title: 'Server administration controls saved', variant: 'success' });
  });
});
