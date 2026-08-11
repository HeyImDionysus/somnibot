import { describe, expect, it } from 'vitest';
import { buildSetupStatus } from '../main/setup-flow';
import { buildVpsDeploymentPlan, buildVpsFunnelComposeOverride } from '../main/vps-deployment-plan';

const baseInput = {
  runtimeMode: 'vps',
  vpsSshHost: '203.0.113.10',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
  paypalReady: true,
  supabaseAccessTokenReady: true,
};

describe('VPS public access modes', () => {
  it('keeps the conventional domain and Caddy contract', () => {
    // Given a conventional domain VPS deployment.
    const input = { ...baseInput, vpsPublicAccessMode: 'domain', vpsDomain: 'bot.example.com' };

    // When the launcher builds its deployment plan.
    const plan = buildVpsDeploymentPlan(input);

    // Then Caddy remains the public edge and owns ports 80/443.
    expect(plan.status).toBe('ready');
    expect(plan.target?.publicBaseUrl).toBe('https://bot.example.com');
    expect(plan.reverseProxy?.publicPorts).toEqual(['80/tcp', '443/tcp']);
    expect(plan.serviceLayout).toContainEqual(expect.objectContaining({ name: 'caddy', exposure: 'public' }));
  });

  it('allows a missing purchased domain only when the exact Funnel URL was remotely verified', () => {
    // Given Funnel mode with an exact verified ts.net HTTPS origin.
    const input = {
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsDomain: '',
      vpsTailscaleFunnelUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
    };

    // When the launcher builds its deployment plan.
    const plan = buildVpsDeploymentPlan(input);

    // Then the plan derives callbacks from Funnel and excludes bundled Caddy.
    expect(plan.status).toBe('ready');
    expect(plan.target).toMatchObject({
      domain: 'somnibot-vps.tailbd9d28.ts.net',
      publicBaseUrl: 'https://somnibot-vps.tailbd9d28.ts.net',
      composeProjectName: 'somnibot-prod',
    });
    expect(plan.environment?.redactedEnvFile).toContain('DASHBOARD_URL=https://somnibot-vps.tailbd9d28.ts.net');
    expect(plan.environment?.redactedEnvFile).toContain('PAYPAL_WEBHOOK_URL=https://somnibot-vps.tailbd9d28.ts.net/api/paypal/webhook');
    expect(plan.environment?.redactedEnvFile).toContain('COMPOSE_PROJECT_NAME=somnibot-prod');
    expect(plan.environment?.redactedEnvFile).toContain('DOMAIN=');
    expect(plan.reverseProxy).toBeNull();
    expect(plan.serviceLayout).not.toContainEqual(expect.objectContaining({ name: 'caddy' }));
    expect(plan.serviceLayout).toContainEqual(expect.objectContaining({
      name: 'dashboard',
      exposure: 'private',
      endpoint: '127.0.0.1:3456 -> dashboard:3000',
    }));
    expect(plan.commands).toContainEqual(expect.objectContaining({ id: 'write-funnel-compose-override' }));
    expect(plan.commands.find(command => command.id === 'start-stack')?.args).toEqual(expect.arrayContaining([
      '-f',
      '/opt/somnibot/docker-compose.prod.yml',
      '-f',
      '/opt/somnibot/.somnibot/launcher-tailscale-funnel.compose.yml',
    ]));
    const composeOverride = buildVpsFunnelComposeOverride();
    expect(composeOverride).toContain('127.0.0.1:3456:3000');
    expect(composeOverride).toContain('profiles: ["somnibot-domain-edge"]');
    expect(composeOverride).not.toContain('0.0.0.0:3456');
  });

  it('blocks Funnel mode when the URL is invalid, unverified, or verified for a different host', () => {
    // Given three untrusted Funnel configurations.
    const invalid = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://example.com',
    });
    const decorated = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net?redirect=untrusted',
      vpsTailscaleFunnelVerifiedUrl: 'https://bot.example.ts.net',
    });
    const unverified = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net',
    });
    const stale = buildVpsDeploymentPlan({
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://new.example.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://old.example.ts.net',
    });

    // When the plans are inspected, then none can be approved.
    expect(invalid.status).toBe('blocked');
    expect(invalid.blockedReasons.join(' ')).toContain('*.ts.net');
    expect(unverified.status).toBe('blocked');
    expect(unverified.blockedReasons.join(' ')).toContain('remote Tailscale Funnel status');
    expect(stale.status).toBe('blocked');
    expect(stale.blockedReasons.join(' ')).toContain('current Funnel URL');
    expect(decorated.status).toBe('blocked');
    expect(decorated.blockedReasons.join(' ')).toContain('query or fragment');
  });

  it('does not call VPS setup complete before public HTTPS health proof passes', () => {
    // Given a remotely verified Funnel configuration but no public health result.
    const input = {
      ...baseInput,
      vpsPublicAccessMode: 'tailscale-funnel',
      vpsTailscaleFunnelUrl: 'https://bot.example.ts.net',
      vpsTailscaleFunnelVerifiedUrl: 'https://bot.example.ts.net',
      credentialReady: false,
    };

    // When setup status is built.
    const status = buildSetupStatus(input);

    // Then the public-edge step is clear and completion remains blocked on proof.
    expect(status.steps).toContainEqual(expect.objectContaining({
      id: 'vps-public-access',
      status: 'success',
    }));
    expect(status.completion.status).not.toBe('complete');
    expect(status.completion.requiredStepIds).toContain('vps-health-verification');
    expect(status.summary.authCallbackUrl).toBe('https://bot.example.ts.net/api/auth/callback');
    expect(status.summary.paypalWebhookUrl).toBe('https://bot.example.ts.net/api/paypal/webhook');
  });
});
