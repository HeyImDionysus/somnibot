import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFailedVpsQuiesceCommand, buildVpsDeploymentPlan, buildVpsRollbackPlan, VPS_DEPLOYMENT_BUILD_TIMEOUT_MS } from '../main/vps-deployment-plan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

const completeVpsInput = {
  runtimeMode: 'vps',
  vpsDomain: 'somnibot.example.com',
  vpsSshHost: 'somnibot.example.com',
  vpsSshUser: 'deploy',
  vpsDeployPath: '/opt/somnibot',
  credentialReady: true,
  paypalReady: true,
  supabaseAccessTokenReady: true,
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
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_ACCESS_TOKEN=<SUPABASE_ACCESS_TOKEN>');
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=false');
  });

  it('represents all secrets with placeholders and never emits concrete secret-looking values', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const variables = plan.environment?.variables ?? [];

    expect(variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DISCORD_TOKEN', value: '<DISCORD_TOKEN>', secret: true }),
      expect.objectContaining({ name: 'DISCORD_CLIENT_SECRET', value: '<DISCORD_CLIENT_SECRET>', secret: true }),
      expect.objectContaining({ name: 'SUPABASE_SECRET_KEY', value: '<SUPABASE_SECRET_KEY>', secret: true }),
      expect.objectContaining({ name: 'SUPABASE_ACCESS_TOKEN', value: '<SUPABASE_ACCESS_TOKEN>', secret: true }),
      expect.objectContaining({ name: 'CSRF_SECRET', value: '<node-scripts-gen-secret-mjs>', secret: true }),
      expect.objectContaining({ name: 'NEXTAUTH_SECRET', value: '<node-scripts-gen-secret-mjs>', secret: true }),
      expect.objectContaining({ name: 'WEBHOOK_REPLAY_SECRET', value: '<node-scripts-gen-secret-mjs>', secret: true }),
      expect.objectContaining({ name: 'VALKEY_PASSWORD', value: '<node-scripts-gen-secret-mjs-16>', secret: true }),
      expect.objectContaining({ name: 'VALKEY_URL', value: 'redis://:<VALKEY_PASSWORD>@valkey:6379', secret: true }),
      expect.objectContaining({ name: 'LAVALINK_PASSWORD', value: '<node-scripts-gen-secret-mjs-16>', secret: true }),
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
      'ssh-host-key',
      'dns-domain',
      'env-file',
      'auth-provider',
      'provider-callbacks',
      'compose-start',
    ]);
  });

  it('includes service commands and rollback commands as review-only plans', () => {
    const plan = buildVpsDeploymentPlan(completeVpsInput);
    const lastGoodCommit = 'a'.repeat(40);
    const rollbackPlan = buildVpsRollbackPlan({ ...completeVpsInput, lastGoodCommit });

    expect(plan.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'write-env-file',
        executable: 'ssh',
        args: expect.arrayContaining([
          'deploy@somnibot.example.com',
          'sh',
          '/opt/somnibot/scripts/write-production-env.sh',
          '/opt/somnibot/.env',
        ]),
        approvalRequired: true,
      }),
      expect.objectContaining({
        id: 'start-stack',
        executable: 'ssh',
        args: [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'StrictHostKeyChecking=yes',
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
        id: 'install-health-recovery',
        executable: 'ssh',
        args: expect.arrayContaining([
          'deploy@somnibot.example.com',
          'sudo',
          '-n',
          'sh',
          '/opt/somnibot/scripts/install-production-health-recovery.sh',
          '/opt/somnibot',
        ]),
        changesRemote: true,
        approvalRequired: true,
      }),
      expect.objectContaining({
        id: 'check-dashboard',
        executable: 'curl',
        args: ['-fsS', '-o', '/dev/null', 'https://somnibot.example.com'],
        changesRemote: false,
        approvalRequired: false,
      }),
      expect.objectContaining({
        id: 'check-health',
        executable: 'curl',
        args: ['-fsS', 'https://somnibot.example.com/api/health'],
        changesRemote: false,
        approvalRequired: false,
        expectedHealthStatus: 'healthy',
      }),
      expect.objectContaining({
        id: 'check-lavalink',
        executable: 'ssh',
        args: expect.arrayContaining(['deploy@somnibot.example.com', 'sh', '-lc']),
        changesRemote: false,
        approvalRequired: false,
      }),
    ]));
    expect(plan.rollback?.commands).toEqual([]);
    expect(rollbackPlan.commands).toEqual([
      expect.objectContaining({
        id: 'rollback-fetch',
        approvalRequired: false,
      }),
      expect.objectContaining({
        id: 'rollback-restore-env',
        executable: 'ssh',
        args: expect.arrayContaining([
          'deploy@somnibot.example.com',
          'sh',
          '/opt/somnibot/scripts/restore-production-env.sh',
          '/opt/somnibot/.env',
        ]),
        approvalRequired: true,
      }),
      expect.objectContaining({
        id: 'rollback-checkout',
        executable: 'ssh',
        args: expect.arrayContaining(['deploy@somnibot.example.com', 'git', '-C', '/opt/somnibot', 'checkout', lastGoodCommit]),
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
        expectedHealthStatus: 'healthy',
      }),
    ]);
    expect(rollbackPlan.commands.map(command => command.id)).toEqual([
      'rollback-fetch',
      'rollback-restore-env',
      'rollback-checkout',
      'rollback-rebuild',
      'rollback-health',
    ]);
    expect(JSON.stringify(plan)).not.toContain('<last-good-commit>');
  });

  it('blocks rollback plans unless the last-good commit is an exact SHA and never emits a placeholder', () => {
    const plan = buildVpsRollbackPlan({ ...completeVpsInput, lastGoodCommit: '<last-good-commit>' });

    expect(plan.status).toBe('blocked');
    expect(plan.commands).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('<last-good-commit>');
    expect(plan.blockedReasons).toContain('Rollback requires an exact 40-character hexadecimal last-good commit SHA.');
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
      ...plan.commands.filter(command => !['check-dashboard', 'check-health'].includes(command.id)),
      ...buildVpsRollbackPlan({ ...completeVpsInput, lastGoodCommit: 'b'.repeat(40) }).commands.filter(command => command.id !== 'rollback-health'),
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
      supabaseAccessTokenReady: true,
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

  it('blocks VPS deployment when no auth-provider setup path is available', () => {
    const plan = buildVpsDeploymentPlan({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      credentialReady: true,
    });

    expect(plan.status).toBe('blocked');
    expect(plan.canApprove).toBe(false);
    expect(plan.commands).toEqual([]);
    expect(plan.blockedReasons).toContain('Supabase Discord auth provider setup requires a Management API token or manual provider confirmation before VPS deployment.');
  });

  it('warns about incomplete credentials but still only emits placeholder env values', () => {
    const plan = buildVpsDeploymentPlan({
      runtimeMode: 'vps',
      vpsDomain: 'somnibot.example.com',
      vpsSshHost: 'somnibot.example.com',
      vpsSshUser: 'deploy',
      vpsDeployPath: '/opt/somnibot',
      credentialReady: false,
      supabaseDiscordAuthProviderConfigured: true,
    });

    expect(plan.status).toBe('ready');
    expect(plan.warnings).toContain('Credential fields are not complete yet; the deployment plan will keep secret values as placeholders.');
    expect(plan.warnings).toContain('PayPal app/webhook fields are not complete yet; store payments will stay disabled until PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_WEBHOOK_ID are set.');
    expect(plan.environment?.redactedEnvFile).toContain('DISCORD_TOKEN=<DISCORD_TOKEN>');
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_SECRET_KEY=<SUPABASE_SECRET_KEY>');
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_ACCESS_TOKEN=');
    expect(plan.environment?.redactedEnvFile).toContain('SUPABASE_DISCORD_AUTH_PROVIDER_CONFIGURED=true');
  });

  it('does not import child process execution APIs in the dry-run planner', () => {
    const source = readFileSync(path.join(srcDir, 'main', 'vps-deployment-plan.ts'), 'utf8');

    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn(');
  });

  it('builds a strict-host-key cleanup command for a partially started VPS stack', () => {
    const command = buildFailedVpsQuiesceCommand(buildVpsDeploymentPlan(completeVpsInput));
    expect(command.id).toBe('quiesce-failed-stack');
    expect(command.args).toContain('StrictHostKeyChecking=yes');
    expect(command.args.slice(-5)).toEqual([
      'docker', 'compose', '-f', '/opt/somnibot/docker-compose.prod.yml', 'stop',
    ]);
    expect(command.commandCategory).toBe('rollback');
  });
});
