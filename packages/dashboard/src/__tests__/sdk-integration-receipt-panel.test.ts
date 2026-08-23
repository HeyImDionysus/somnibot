import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SdkIntegrationReceiptPanel } from '@/components/store/sdk-integration-receipt-panel';

vi.mock('@/components/shared/button', () => ({
  Button: (props: ComponentProps<'button'>) => createElement('button', props),
}));

describe('SDK integration receipt product surface', () => {
  it('renders server-verified receipt readback and signed-evidence control', () => {
    const html = renderToStaticMarkup(createElement(SdkIntegrationReceiptPanel, {
      productId: '11111111-1111-4111-8111-111111111111',
    }));

    expect(html).toContain('SDK integration receipt');
    expect(html).toContain('owner cannot self-attest');
    expect(html).toContain('Paste signed SomniBot conformance verification');
    expect(html).toContain('Verify and record receipt');
    expect(html).toContain('Loading integration status');
  });
});
