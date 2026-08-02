import { describe, expect, it } from 'vitest';
import {
  detectTailscale,
  enableFunnel,
  isTailscaleSetupPermissionError,
  type TailscaleSetupRunner,
} from '../features/setup-wizard/tailscale.js';

function accessDeniedError(): Error & { code: string; stderr: string } {
  return Object.assign(new Error('Access is denied'), {
    code: 'EPERM',
    stderr: String.raw`failed to open \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`,
  });
}

describe('setup wizard Tailscale detection', () => {
  it('recognizes protected Windows Tailscale service access', () => {
    expect(isTailscaleSetupPermissionError(accessDeniedError())).toBe(true);
  });

  it('does not misreport permission-blocked status as signed out', async () => {
    const runner: TailscaleSetupRunner = async (_bin, args) => {
      if (args[0] === 'version') return { stdout: '1.98.9\n', stderr: '' };
      throw accessDeniedError();
    };

    const info = await detectTailscale(runner);

    expect(info.state).toBe('needs-permission');
    expect(info.detail).not.toContain('not signed in');
  });

  it('stops before trying to enable Funnel when service status needs permission', async () => {
    const calls: string[] = [];
    const runner: TailscaleSetupRunner = async (_bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'version') return { stdout: '1.98.9\n', stderr: '' };
      throw accessDeniedError();
    };

    const info = await enableFunnel('http://127.0.0.1:3456', runner);

    expect(info.state).toBe('needs-permission');
    expect(calls).toEqual(['version', 'status --json']);
  });

  it('does not discard confirmed sign-in when Funnel status needs permission', async () => {
    const runner: TailscaleSetupRunner = async (_bin, args) => {
      if (args[0] === 'version') return { stdout: '1.98.9\n', stderr: '' };
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'somnibot.dionysus.ts.net.' },
          }),
          stderr: '',
        };
      }
      throw accessDeniedError();
    };

    const info = await detectTailscale(runner);

    expect(info.state).toBe('needs-permission');
    expect(info.dnsName).toBe('somnibot.dionysus.ts.net');
    expect(info.detail).toContain('signed in');
  });
});
