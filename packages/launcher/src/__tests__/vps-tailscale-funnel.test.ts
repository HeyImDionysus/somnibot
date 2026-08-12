import { describe, expect, it } from 'vitest';
import {
  parseVpsTailscaleFunnelReadiness,
  VPS_TAILSCALE_FUNNEL_TARGET,
} from '../main/vps-tailscale-funnel';

function remoteOutput(status: object, funnel: string): string {
  return [
    'SOMNIBOT_TAILSCALE_STATUS_BEGIN',
    JSON.stringify(status),
    'SOMNIBOT_TAILSCALE_STATUS_END',
    'SOMNIBOT_TAILSCALE_FUNNEL_BEGIN',
    funnel,
    'SOMNIBOT_TAILSCALE_FUNNEL_END',
  ].join('\n');
}

describe('VPS Tailscale Funnel readiness', () => {
  it('returns a bounded manual login step without requesting an auth key', () => {
    // Given remote Tailscale is installed but needs login.
    const output = remoteOutput({ BackendState: 'NeedsLogin' }, 'No serve config');

    // When readiness is parsed.
    const result = parseVpsTailscaleFunnelReadiness(output, 'https://bot.example.ts.net');

    // Then the next action is manual login and contains no auth-key flow.
    expect(result).toMatchObject({ state: 'login-required', installed: true, loggedIn: false });
    expect(result.commandPreview).toEqual(['sudo', 'tailscale', 'up']);
    expect(JSON.stringify(result)).not.toMatch(/auth.?key|tskey-/i);
  });

  it('surfaces tailnet policy failure as an actionable non-ready state', () => {
    // Given Tailscale is logged in but Funnel is denied by policy.
    const output = remoteOutput(
      { BackendState: 'Running', Self: { DNSName: 'bot.example.ts.net.' } },
      'Funnel permission denied: node attribute policy missing',
    );

    // When readiness is parsed.
    const result = parseVpsTailscaleFunnelReadiness(output, 'https://bot.example.ts.net');

    // Then policy remediation is explicit and readiness is not verified.
    expect(result).toMatchObject({ state: 'policy-required', loggedIn: true, funnelEnabled: false });
    expect(result.nextAction).toContain('Tailscale admin policy');
  });

  it('distinguishes remote status permission failure from login-required state', () => {
    // Given the SSH user cannot read Tailscale service status.
    const output = remoteOutput({ Error: 'permission denied while connecting to local tailscaled' }, '');

    // When readiness is parsed.
    const result = parseVpsTailscaleFunnelReadiness(output, 'https://bot.example.ts.net');

    // Then the operator gets a permission action without auth-key guidance.
    expect(result).toMatchObject({ state: 'permission-required', installed: true, loggedIn: false });
    expect(result.nextAction).toContain('permission');
    expect(JSON.stringify(result)).not.toMatch(/tskey-|--auth-key/i);
  });

  it('verifies only the exact HTTPS Funnel URL and loopback dashboard target', () => {
    // Given remote status proves the expected public URL and loopback mapping.
    const funnel = JSON.stringify({
      Web: {
        'bot.example.ts.net:443': { Handlers: { '/': { Proxy: VPS_TAILSCALE_FUNNEL_TARGET } } },
      },
      AllowFunnel: { 'bot.example.ts.net:443': true },
    });
    const output = remoteOutput(
      { BackendState: 'Running', Self: { DNSName: 'bot.example.ts.net.' } },
      funnel,
    );

    // When readiness is parsed.
    const result = parseVpsTailscaleFunnelReadiness(output, 'https://bot.example.ts.net');

    // Then the mapping is verified for deployment planning.
    expect(result).toMatchObject({
      state: 'verified',
      funnelEnabled: true,
      publicUrl: 'https://bot.example.ts.net',
      target: VPS_TAILSCALE_FUNNEL_TARGET,
    });
  });

  it('redacts auth-key-shaped remote output from every returned field', () => {
    // Given a remote error contains an auth key shape.
    const output = remoteOutput({ BackendState: 'Running' }, 'permission denied tskey-auth-super-secret-value');

    // When readiness is parsed.
    const result = parseVpsTailscaleFunnelReadiness(output, 'https://bot.example.ts.net');

    // Then no returned status exposes the key.
    expect(JSON.stringify(result)).not.toContain('tskey-auth-super-secret-value');
  });
});
