import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planVpsSshPreflight } from '../main/vps-preflight';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..');

describe('VPS SSH preflight planner', () => {
  it('plans a read-only SSH command as an argument array after explicit user action', () => {
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
      explicitUserAction: true,
    });

    expect(plan.status).toBe('ready');
    expect(plan.canRun).toBe(true);
    expect(plan.authMode).toBe('agent-or-default-key');
    expect(plan.command).toEqual({
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
        'sh',
        '-s',
        '--',
        '/opt/somnibot',
      ],
      redactedArgs: [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'StrictHostKeyChecking=yes',
        '--',
        'deploy@somnibot.example.com',
        'sh',
        '-s',
        '--',
        '/opt/somnibot',
      ],
      redactedDisplay: 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -- deploy@somnibot.example.com sh -s -- /opt/somnibot',
      readOnly: true,
    });
    expect(plan.warnings).toContain('No private key path was provided; preflight will rely on the local SSH agent or default SSH keys.');
  });

  it('blocks planning before the explicit click gate', () => {
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
    });

    expect(plan.status).toBe('blocked');
    expect(plan.canRun).toBe(false);
    expect(plan.command).toBeNull();
    expect(plan.blockedReasons).toContain('Explicit user action is required before SSH preflight can run.');
  });

  it('reports missing host, user, and deploy path without producing a command', () => {
    const plan = planVpsSshPreflight({ explicitUserAction: true });

    expect(plan.command).toBeNull();
    expect(plan.blockedReasons).toContain('SSH host is required before preflight can be planned.');
    expect(plan.blockedReasons).toContain('SSH user is required before preflight can be planned.');
    expect(plan.blockedReasons).toContain('Deployment path is required before preflight can be planned.');
  });

  it('rejects unsafe host, user, and path input before command generation', () => {
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com;touch',
      user: 'deploy;rm',
      deployPath: '/opt/somnibot;rm',
      explicitUserAction: true,
    });

    expect(plan.command).toBeNull();
    expect(plan.blockedReasons).toContain('SSH host must be a hostname or IPv4 address using only letters, numbers, dots, and hyphens.');
    expect(plan.blockedReasons).toContain('SSH user must be a simple account name.');
    expect(plan.blockedReasons).toContain('Deployment path must be an absolute path using safe path characters.');
  });

  it('rejects unsafe private key paths without leaking them to log events', () => {
    const privateKeyPath = '../somnibot_deploy';
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
      privateKeyPath,
      explicitUserAction: true,
    });

    expect(plan.command).toBeNull();
    expect(plan.blockedReasons).toContain('Private key path must be an absolute local path without traversal or control characters.');
    expect(JSON.stringify(plan.logEvents)).not.toContain(privateKeyPath);
  });

  it('uses identity-file args while keeping key paths redacted from display and log events', () => {
    const privateKeyPath = '/home/dionysus/.ssh/somnibot_deploy';
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
      privateKeyPath,
      explicitUserAction: true,
    });

    expect(plan.authMode).toBe('identity-file');
    expect(plan.command?.args).toContain(privateKeyPath);
    expect(plan.command?.redactedArgs).toContain('[redacted-private-key-path]');
    expect(plan.command?.redactedDisplay).not.toContain(privateKeyPath);
    expect(plan.redactedInput.privateKeyPath).toBe('[redacted-private-key-path]');
    expect(JSON.stringify(plan.logEvents)).not.toContain(privateKeyPath);
  });

  it('blocks passphrase-protected key preflight and never includes the passphrase in command or logs', () => {
    const passphrase = 'correct horse battery staple';
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
      privateKeyPath: '/home/dionysus/.ssh/somnibot_deploy',
      privateKeyPassphrase: passphrase,
      explicitUserAction: true,
    });

    expect(plan.status).toBe('blocked');
    expect(plan.authMode).toBe('unsupported-passphrase-key');
    expect(plan.command).toBeNull();
    expect(plan.redactedInput.privateKeyPassphrase).toBe('[redacted-passphrase]');
    expect(plan.blockedReasons).toContain('Passphrase-protected key preflight is not supported yet. Load the key into an SSH agent or omit the passphrase.');
    expect(JSON.stringify(plan)).not.toContain(passphrase);
  });

  it('blocks passphrase input without a matching key path', () => {
    const plan = planVpsSshPreflight({
      host: 'somnibot.example.com',
      user: 'deploy',
      deployPath: '/opt/somnibot',
      privateKeyPassphrase: 'secret-passphrase',
      explicitUserAction: true,
    });

    expect(plan.command).toBeNull();
    expect(plan.blockedReasons).toContain('A key passphrase cannot be used without a private key path.');
    expect(JSON.stringify(plan.logEvents)).not.toContain('secret-passphrase');
  });

  it('does not add transient SSH key or passphrase fields to persistent launcher config', () => {
    const configStore = readFileSync(path.join(srcDir, 'main', 'config-store.ts'), 'utf8');

    expect(configStore).not.toContain('vpsSshPrivateKey');
    expect(configStore).not.toContain('privateKeyPassphrase');
    expect(configStore).not.toContain('vpsSshPassphrase');
  });
});
