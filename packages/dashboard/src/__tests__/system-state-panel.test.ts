import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SystemStatePanel } from '@/components/system-state/system-state-panel';

describe('system state panel', () => {
  it('announces deployment-state loading while authoritative readback is pending', () => {
    const html = renderToStaticMarkup(createElement(SystemStatePanel));

    expect(html).toContain('aria-label="Deployment state"');
    expect(html).toContain('aria-busy="true"');
  });
});
