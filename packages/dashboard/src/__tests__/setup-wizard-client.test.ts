import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SetupHandoffPage from '@/app/(setup)/setup/page';

describe('setup handoff page', () => {
  const markup = renderToStaticMarkup(SetupHandoffPage());

  it('renders a safe handoff with dashboard navigation', () => {
    expect(markup).toContain('<main');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('href="/server-setup"');
  });

  it('contains no credential submission surface or setup API client', () => {
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('/api/setup');
  });
});
