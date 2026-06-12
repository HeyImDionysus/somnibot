import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVpsDeploymentPlan, VPS_DEPLOYMENT_BUILD_TIMEOUT_MS } from '../main/vps-deployment-plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

const completeVpsInput = {
  runtimeMode: 'vps',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
};

describe('VPS deployment plan generator', () => {
  it('generates a redacted dry-run plan for the selected VPS domain', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);

    expect(plan.status).toBe('ready');
    expect(plan.canApprove).toBe(true);
    expect(plan.target).toMatchObject({
      domain: 'somnibot.example.com',
      publicBaseUrl: 'https://somnibot.example.com',
      sshTarget: 'deploy@somnibot.example.com',
      envFilePath: '/opt/somnibot/.env',
      envFilePermissions: '0600',
      composeFilePath: '/opt/somnibot/docker-compose.prod.yml',
    });
    expect(plan.environment?.filePath).toBe('/opt/somnibot/.env');
    expect(plan.environment?.permissions).toBe('0600');
    expect(plan.environment?.redactedEnvFile).toContain('DOMAIN=somnibot.example.com');
    expect(plan.environment?.redactedEnvFile).toContain('DASHBOARD_URL=https://somnibot.example.com');
    expect(plan.environment?.redactedEnvFile).toContain('NEXT_PUBLIC_APP_URL=https://somnibot.example.com');
    expect(plan.environment?.redactedEnvFile).toContain('PAYPAL_WEBHOOK_URL=https://somnibot.example.com/api/paypal/webhook');
  });

  it('represents all secrets with placeholders and never emits concrete secret-looking values', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const variables = plan.environment?.variables ?? [];

    expect(variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DISCORD_TOKEN', value: '<DISCORD_TOKEN>', secret: true }),
      expect.objectContaining({ name: 'DISCORD_CLIENT_SECRET', value: '<DISCORD_CLIENT_SECRET>', secret: true }),
      expect.objectContaining({ name: 'SUPABASE_SECRET_KEY', value: '<SUPABASE_SECRET_KEY>', secret: true }),
      expect.objectContaining({ name: 'CSRF_SECRET', value: '<openssl-rand-hex-32>', secret: true }),
      expect.objectContaining({ name: 'NEXTAUTH_SECRET', value: '<openssl-rand-hex-32>', secret: true }),
      expect.objectContaining({ name: 'WEBHOOK_REPLAY_SECRET', value: '<openssl-rand-hex-32>', secret: true }),
      expect.objectContaining({ name: 'VALKEY_PASSWORD', value: '<openssl-rand-hex-16>', secret: true }),
      expect.objectContaining({ name: 'VALKEY_URL', value: 'redis://:<VALKEY_PASSWORD>@valkey:6379', secret: true }),
      expect.objectContaining({ name: 'LAVALINK_PASSWORD', value: '<openssl-rand-hex-16>', secret: true }),
      expect.objectContaining({ name: 'PAYPAL_CLIENT_SECRET', value: '<PAYPAL_CLIENT_SECRET>', secret: true }),
      expect.objectContaining({ name: 'PAYPAL_WEBHOOK_ID', value: '<PAYPAL_WEBHOOK_ID>', secret: true }),
    ]));
    expect(JSON.stringify(plan)).not.toContain('sb_secret_');
    expect(JSON.stringify(plan)).not.toContain('MTI');
  });

  it('includes production service layout, reverse proxy outline, private service URLs, and manual approval gates', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);

    expect(plan.serviceLayout).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'dashboard', exposure: 'public', endpoint: 'dashboard:3000 behind Caddy' }),
      expect.objectContaining({ name: 'caddy', exposure: 'public', endpoint: 'somnibot.example.com:80/443 -> dashboard:3000' }),
      expect.objectContaining({ name: 'lavalink', exposure: 'private', endpoint: 'http://lavalink:2333' }),
      expect.objectContaining({ name: 'valkey', exposure: 'private', endpoint: 'redis://:<VALKEY_PASSWORD>@valkey:6379' }),
    ]));
    expect(plan.reverseProxy).toMatchObject({
      filePath: 'services/caddy/Caddyfile',
      publicPorts: ['80/tcp', '443/tcp'],
      upstream: 'dashboard:3000',
    });
    expect(plan.approvalGates.map(gate => gate.id)).toEqual([
      'dns-domain',
      'env-file',
      'provider-callbacks',
      'compose-start',
    ]);
  });

  it('includes service commands and rollback commands as review-only plans', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);

    expect(plan.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'start-stack',
        executable: 'ssh',
        args: [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '--',
          'deploy@somnibot.example.com',
          'docker',
          'compose',
          '-f',
          '/opt/somnibot/docker-compose.prod.yml',
          'up',
          '-d',
          '--build',
        ],
        changesRemote: true,
        approvalRequired: true,
        executionTimeoutMs: VPS_DEPLOYMENT_BUILD_TIMEOUT_MS,
      }),
      expect.objectContaining({
        id: 'check-health',
        executable: 'curl',
        args: ['-fsS', 'https://somnibot.example.com/api/health'],
        changesRemote: false,
        approvalRequired: false,
      }),
    ]));
    expect(plan.rollback?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'rollback-checkout',
        executable: 'ssh',
        args: expect.arrayContaining(['deploy@somnibot.example.com', 'git', '-C', '/opt/somnibot', 'checkout', '<last-good-commit>']),
        approvalRequired: true,
      }),
      expect.objectContaining({
        id: 'rollback-rebuild',
        executable: 'ssh',
        args: expect.arrayContaining(['deploy@somnibot.example.com', 'docker', 'compose', '-f', '/opt/somnibot/docker-compose.prod.yml', 'up', '-d', '--build']),
        approvalRequired: true,
        executionTimeoutMs: VPS_DEPLOYMENT_BUILD_TIMEOUT_MS,
      }),
      expect.objectContaining({
        id: 'rollback-health',
        executable: 'curl',
        args: ['-fsS', 'https://somnibot.example.com/api/health'],
        approvalRequired: false,
      }),
    ]));
  });

  it('uses restrictive file permissions for env file steps', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);

    expect(plan.target?.envFilePermissions).toBe('0600');
    expect(plan.environment?.permissions).toBe('0600');
    expect(plan.commands).toContainEqual(expect.objectContaining({
      id: 'protect-env-file',
      executable: 'ssh',
      args: expect.arrayContaining(['deploy@somnibot.example.com', 'chmod', '0600', '/opt/somnibot/.env']),
      changesRemote: true,
      approvalRequired: true,
    }));
  });

  it('routes remote VPS commands through SSH so live runners cannot execute them locally', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const remoteCommands = [
      ...plan.commands.filter(command => command.id !== 'check-health'),
      ...(plan.rollback?.commands.filter(command => command.id !== 'rollback-health') ?? []),
    ];

    expect(remoteCommands).not.toHaveLength(0);
    expect(remoteCommands.every(command => command.executable === 'ssh')).toBe(true);
    for (const command of remoteCommands) {
      expect(command.args).toEqual(expect.arrayContaining(['--', 'deploy@somnibot.example.com']));
      expect(command.redactedDisplay).toContain('ssh ');
      expect(command.redactedDisplay).toContain('deploy@somnibot.example.com');
    }
  });

  it('blocks non-VPS mode and missing readiness fields without producing command plans', () => {
    const plan = buildVpsDeploymentPlan({ runtimeMode: 'regular-local' });

    expect(plan.status).toBe('blocked');
    expect(plan.canApprove).toBe(false);
    expect(plan.target).toBeNull();
    expect(plan.environment).toBeNull();
    expect(plan.commands).toEqual([]);
    expect(plan.blockedReasons).toContain('VPS deployment plans are only available in VPS mode.');
    expect(plan.blockedReasons).toContain('SSH host is required before preflight can be planned.');
    expect(plan.blockedReasons).toContain('SSH user is required before preflight can be planned.');
    expect(plan.blockedReasons).toContain('Deployment path is required before preflight can be planned.');
  });

  it('blocks invalid VPS domain and unsafe SSH target fields before any plan is ready', () => {
    const plan = buildVpsDeploymentPlan({
      runtimeMode: 'vps',
      vpsDomain: 'http://localhost:3000/nested',
      vpsSshHost: 'somnibot.example.com;touch',
      vpsSshUser: 'deploy;rm',
      vpsDeployPath: '/opt/somnibot;rm',
      credentialReady: true,
    });

    expect(plan.status).toBe('blocked');
    expect(plan.target).toBeNull();
    expect(plan.environment).toBeNull();
    expect(plan.blockedReasons).toContain('VPS public domain must use HTTPS.');
    expect(plan.blockedReasons).toContain('VPS public domain must be the dashboard base domain, not a nested path.');
    expect(plan.blockedReasons).toContain('VPS mode cannot use a localhost callback URL.');
    expect(plan.blockedReasons).toContain('SSH host must be a hostname or IPv4 address using only letters, numbers, dots, and hyphens.');
    expect(plan.blockedReasons).toContain('SSH user must be a simple account name.');
    expect(plan.blockedReasons).toContain('Deployment path must be an absolute path using safe path characters.');
  });

  it('blocks explicit public ports because the production Caddy plan owns 80 and 443', () => {
    const plan = buildVpsDeploymentPlan({
      ...completeVpsInput,
      vpsDomain: 'https://somnibot.example.com:3000',
    });

    expect(plan.status).toBe('blocked');
    expect(plan.target).toBeNull();
    expect(plan.blockedReasons).toContain('VPS deployment plan requires the public domain without an explicit port because Caddy owns ports 80 and 443.');
  });

  it('warns about incomplete credentials but still only emits placeholder env values', () => {
    const plan = buildVpsDeploymentPlan({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      credentialReady: false,
    });

    expect(plan.status).toBe('ready');
    expect(plan.warnings).toContain('Credential fields are not complete yet; the deployment plan will keep secret values as placeholders.');
    expect(plan.environment?.redactedEnvFile).toContain('DISCORD_TOKEN=<DISCORD_TOKEN>');
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_SECRET_KEY=<SUPABASE_SECRET_KEY>');
  });

  it('does not import child process execution APIs in the dry-run planner', () => {
    const source = readFileSync(path.join(srcDir, 'main', 'vps-deployment-plan.ts'), 'utf8');

    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn(');
  });
});
