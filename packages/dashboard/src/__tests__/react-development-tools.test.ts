import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const diagnostics = vi.hoisted(() => ({
  reactGrabImport: vi.fn(),
  scan: vi.fn(),
}));

vi.mock('react-grab', () => {
  diagnostics.reactGrabImport();
  return {};
});

vi.mock('react-scan', () => ({ scan: diagnostics.scan }));

async function loadDevelopmentTools(nodeEnvironment: string, disableDevtools?: string) {
  vi.stubEnv('NODE_ENV', nodeEnvironment);
  vi.stubEnv('NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS', disableDevtools ?? '');

  vi.resetModules();
  return import('@/components/react-development-tools');
}

afterEach(() => {
  vi.unstubAllEnvs();
  diagnostics.reactGrabImport.mockReset();
  diagnostics.scan.mockReset();
  vi.resetModules();
});

describe('ReactDevelopmentTools', () => {
  it('renders nothing and does not activate diagnostics in production', async () => {
    // Given: a production dashboard bundle.
    const { ReactDevelopmentTools } = await loadDevelopmentTools('production');

    // When: the topmost diagnostics boundary renders.
    const markup = renderToStaticMarkup(createElement(ReactDevelopmentTools));
    await Promise.resolve();

    // Then: it has no DOM surface and neither dev diagnostic initializes.
    expect(markup).toBe('');
    expect(diagnostics.scan).not.toHaveBeenCalled();
    expect(diagnostics.reactGrabImport).not.toHaveBeenCalled();
  });

  it('does not activate diagnostics when the public opt-out is set', async () => {
    // Given: development with the explicit public opt-out.
    const { ReactDevelopmentTools } = await loadDevelopmentTools('development', '1');

    // When: the diagnostics boundary renders.
    const markup = renderToStaticMarkup(createElement(ReactDevelopmentTools));
    await Promise.resolve();

    // Then: it remains absent and avoids both diagnostic initializers.
    expect(markup).toBe('');
    expect(diagnostics.scan).not.toHaveBeenCalled();
    expect(diagnostics.reactGrabImport).not.toHaveBeenCalled();
  });

  it('activates the local diagnostics only in enabled development', async () => {
    // Given: development without the public opt-out.
    const { ReactDevelopmentTools } = await loadDevelopmentTools('development');

    // When: the diagnostics boundary loads and renders.
    const markup = renderToStaticMarkup(createElement(ReactDevelopmentTools));
    await vi.waitFor(() => expect(diagnostics.reactGrabImport).toHaveBeenCalledOnce());

    // Then: Scan uses the strict-CSP-safe local configuration and the boundary stays invisible.
    expect(markup).toBe('');
    expect(diagnostics.scan).toHaveBeenCalledWith({ enabled: true, useOffscreenCanvasWorker: false });
  });
});
