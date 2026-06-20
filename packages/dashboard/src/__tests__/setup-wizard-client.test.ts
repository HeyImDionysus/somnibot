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
    expect(source).toContain('const discordReady = Boolean(data.discordClientId || data.discordCredentialsPresent)');
    expect(source).toContain('data.supabaseConnected && data.databaseInitialized && discordReady');
    expect(source).toContain('setCurrentStep(3)');
    expect(source).not.toContain('onClick={() => setCurrentStep(5)}');
  });

  it('keeps final setup disabled until owner-ready proof is present', () => {
    expect(source).toContain('const finalizeBlockedReason = getFinalizeBlockedReason();');
    expect(source).toContain('const canFinalizeSetup = !finalizeBlockedReason && !finalizing;');
    expect(source).toContain('disabled={!canFinalizeSetup}');
    expect(source).toContain('if (!status?.botOnline)');
    expect(source).toContain('if (!discordAuthConfigurableForSetup)');
    expect(source).toContain('if (!paypalCredentialsReadyForSetup)');
    expect(source).toContain('if (!paypalWebhookIdReadyForSetup)');
    expect(source).toContain('await fetchStatus();');
    expect(source).toContain("parsed.pathname.replace(/\\/$/, '') === '/api/paypal/webhook'");
    expect(source).toContain('data.guildDetected && data.guildId && data.botOnline');
  });
});
