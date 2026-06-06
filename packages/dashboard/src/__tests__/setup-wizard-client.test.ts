import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSetupRequestHeaders,
  SETUP_CSRF_UNAVAILABLE_MESSAGE,
} from '@/lib/setup-wizard-client';

describe('setup wizard client helpers', () => {
  it('requires and forwards the CSRF token for setup POSTs', () => {
    expect(buildSetupRequestHeaders({ 'X-CSRF-Token': 'token-123' })).toEqual({
      'X-CSRF-Token': 'token-123',
      'Content-Type': 'application/json',
    });
  });

  it('fails closed when no CSRF token is available', () => {
    expect(() => buildSetupRequestHeaders({})).toThrow(SETUP_CSRF_UNAVAILABLE_MESSAGE);
  });
});

describe('setup wizard page wiring', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../app/(setup)/setup/page.tsx'),
    'utf8',
  );

  it('uses the CSRF hook and setup request helper for setup POSTs', () => {
    expect(source).toContain("import { useCsrf } from '@/hooks/use-csrf'");
    expect(source).toContain('buildSetupRequestHeaders(activeHeaders)');
    expect(source).toContain("fetch('/api/setup'");
  });

  it('finalizes setup before showing the ready step', () => {
    expect(source).toContain("action: 'finalize'");
    expect(source).toContain('onClick={finalizeSetup}');
    expect(source).toContain('if (data.setupCompleted)');
    expect(source).toContain('setCurrentStep(3)');
    expect(source).not.toContain('onClick={() => setCurrentStep(4)}');
  });
});
