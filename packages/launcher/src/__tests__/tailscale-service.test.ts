import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SOMNIBOT_FUNNEL_TARGET,
  TAILSCALE_DNS_PROPAGATION_WAIT_MS,
  TailscaleCommandError,
  buildEnableFunnelArgs,
  buildLoginWithAuthKeyArgs,
  enableSomniBotFunnel,
  getTailscaleReadiness,
  loginWithTailscaleAuthKey,
  parseFunnelStatusJson,
  parseFunnelStatusText,
  parseTailscaleStatusJson,
  probePublicCallbackHealth,
  redactTailscaleOutput,
  type TailscaleRunner,
} from '../main/tailscale-service';

function runnerFor(results: Record<string, { stdout?: string; stderr?: string }>): TailscaleRunner {
  return async (args) => {
    const key = args.join(' ');
    const result = results[key];
    if (!result) {
      throw new TailscaleCommandError(`Unexpected command: ${key}`);
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

describe('tailscale-service', () => {
  it('builds the approved Funnel command as an argument array', () => {
    expect(buildEnableFunnelArgs()).toEqual([
      'funnel',
      '--bg',
      '--https=443',
      '--yes',
      SOMNIBOT_FUNNEL_TARGET,
    ]);
  });

  it('builds the auth-key login command using a file reference', () => {
    expect(buildLoginWithAuthKeyArgs('/tmp/somnibot-authkey')).toEqual([
      'up',
      '--auth-key=file:/tmp/somnibot-authkey',
      '--timeout=30s',
    ]);
  });

  it('rejects unsupported Funnel listen ports', () => {
    expect(() => buildEnableFunnelArgs(SOMNIBOT_FUNNEL_TARGET, 3456)).toThrow(
      'Tailscale Funnel can only listen on ports 443, 8443, or 10000.',
    );
  });

  it('redacts Tailscale auth keys and bearer tokens from command output', () => {
    const output = [
      'auth=tskey-auth-k1abcdef1234567890',
      'Authorization: Bearer abc.def.ghi',
      'https://example.ts.net?authkey=tskey-client-secret',
    ].join('\n');

    const redacted = redactTailscaleOutput(output);

    expect(redacted).not.toContain('tskey-auth-k1abcdef1234567890');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('tskey-client-secret');
    expect(redacted).toContain('[redacted-tailscale-key]');
    expect(redacted).toContain('Authorization: Bearer [redacted]');
  });

  it('redacts Tailscale auth keys from command error messages', () => {
    const error = new TailscaleCommandError('failed with tskey-auth-secret and authkey=tskey-client-secret');

    expect(error.message).toContain('[redacted-tailscale-key]');
    expect(error.message).toContain('authkey=[redacted]');
    expect(error.message).not.toContain('tskey-auth-secret');
    expect(error.message).not.toContain('tskey-client-secret');
  });

  it('parses logged-in status JSON and normalizes the machine DNS name', () => {
    const status = parseTailscaleStatusJson(JSON.stringify({
      BackendState: 'Running',
      Self: {
        DNSName: 'somnibot.dionysus.ts.net.',
        HostName: 'somnibot',
      },
      User: {
        LoginName: 'dionysus@example.com',
      },
    }));

    expect(status).toEqual({
      backendState: 'Running',
      loggedIn: true,
      dnsName: 'somnibot.dionysus.ts.net',
      hostName: 'somnibot',
      user: 'dionysus@example.com',
    });
  });

  it('does not treat cached DNS as ready when Tailscale is not running', () => {
    const status = parseTailscaleStatusJson(JSON.stringify({
      BackendState: 'Stopped',
      Self: {
        DNSName: 'somnibot.dionysus.ts.net.',
      },
    }));

    expect(status.loggedIn).toBe(false);
  });

  it('parses Funnel status JSON even when Tailscale changes object shape', () => {
    const status = parseFunnelStatusJson(JSON.stringify({
      Web: {
        'somnibot.dionysus.ts.net:443': {
          Handlers: {
            '/': {
              Proxy: 'http://127.0.0.1:3456',
            },
          },
        },
      },
      AllowFunnel: {
        'somnibot.dionysus.ts.net:443': true,
      },
    }));

    expect(status.enabled).toBe(true);
    expect(status.allowFunnel).toBe(true);
    expect(status.publicUrl).toBe('https://somnibot.dionysus.ts.net');
    expect(status.target).toBe('http://127.0.0.1:3456');
  });

  it('does not treat tailnet-only Serve JSON as public Funnel readiness', () => {
    const status = parseFunnelStatusJson(JSON.stringify({
      Web: {
        'somnibot.dionysus.ts.net:443': {
          Handlers: {
            '/': {
              Proxy: 'http://127.0.0.1:3456',
            },
          },
        },
      },
      AllowFunnel: {
        'somnibot.dionysus.ts.net:443': false,
      },
    }));

    expect(status.enabled).toBe(false);
    expect(status.allowFunnel).toBe(false);
    expect(status.publicUrl).toBe('');
    expect(status.target).toBe('http://127.0.0.1:3456');
  });

  it('preserves non-443 public Funnel ports from status JSON', () => {
    const status = parseFunnelStatusJson(JSON.stringify({
      Web: {
        'somnibot.dionysus.ts.net:8443': {
          Handlers: {
            '/': {
              Proxy: 'http://127.0.0.1:3456',
            },
          },
        },
      },
      AllowFunnel: {
        'somnibot.dionysus.ts.net:8443': true,
      },
    }));

    expect(status.enabled).toBe(true);
    expect(status.publicUrl).toBe('https://somnibot.dionysus.ts.net:8443');
  });

  it('does not combine unrelated JSON hosts and local targets into a false Funnel match', () => {
    const status = parseFunnelStatusJson(JSON.stringify({
      Self: {
        DNSName: 'somnibot.dionysus.ts.net.',
      },
      Web: {
        unrelated: {
          Handlers: {
            '/': {
              Proxy: 'http://127.0.0.1:3456',
            },
          },
        },
      },
    }));

    expect(status.enabled).toBe(false);
    expect(status.publicUrl).toBe('');
    expect(status.target).toBe('');
  });

  it('parses Funnel status text from the CLI fallback', () => {
    const status = parseFunnelStatusText(`
Available on the internet:
|-- https://somnibot.dionysus.ts.net
|--> http://127.0.0.1:3456
`);

    expect(status.enabled).toBe(true);
    expect(status.publicUrl).toBe('https://somnibot.dionysus.ts.net');
    expect(status.target).toBe('http://127.0.0.1:3456');
  });

  it('maps a missing Tailscale CLI to a not-installed readiness state', async () => {
    const readiness = await getTailscaleReadiness(async () => {
      throw new TailscaleCommandError('spawn tailscale ENOENT', { code: 'ENOENT' });
    });

    expect(readiness.state).toBe('not-installed');
    expect(readiness.installed).toBe(false);
    expect(readiness.commandPreview).toEqual(['tailscale', ...buildEnableFunnelArgs()]);
  });

  it('reports a signed-in machine without Funnel as not configured', async () => {
    const readiness = await getTailscaleReadiness(runnerFor({
      version: { stdout: '1.84.0\n' },
      'status --json': {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'somnibot.dionysus.ts.net.' },
        }),
      },
      'funnel status --json': {
        stdout: JSON.stringify({ Web: {} }),
      },
      'funnel status': {
        stdout: 'No serve config\n',
      },
    }));

    expect(readiness.state).toBe('not-configured');
    expect(readiness.installed).toBe(true);
    expect(readiness.loggedIn).toBe(true);
    expect(readiness.dnsPropagationWaitMs).toBe(TAILSCALE_DNS_PROPAGATION_WAIT_MS);
  });

  it('enables Funnel only through the explicit enable command and returns the public URL', async () => {
    const calls: string[] = [];
    const runner: TailscaleRunner = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'funnel' && args[1] === '--bg') {
        return { stdout: 'Available on the internet: https://somnibot.dionysus.ts.net', stderr: '' };
      }
      return runnerFor({
        version: { stdout: '1.84.0\n' },
        'status --json': {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'somnibot.dionysus.ts.net.' },
          }),
        },
        'funnel status --json': {
          stdout: JSON.stringify({
            Web: {
              'somnibot.dionysus.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:3456' } },
              },
            },
            AllowFunnel: {
              'somnibot.dionysus.ts.net:443': true,
            },
          }),
        },
      })(args);
    };

    const readiness = await enableSomniBotFunnel(runner);

    expect(calls[0]).toBe('funnel --bg --https=443 --yes http://127.0.0.1:3456');
    expect(readiness.funnelEnabled).toBe(true);
    expect(readiness.publicCallbackBaseUrl).toBe('https://somnibot.dionysus.ts.net');
  });

  it('logs in with a Tailscale auth key through a temporary file', async () => {
    const calls: string[] = [];
    const runner: TailscaleRunner = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'up') {
        expect(args[1]).toMatch(/^--auth-key=file:/);
        const authKeyPath = args[1].replace('--auth-key=file:', '');
        expect(readFileSync(authKeyPath, 'utf8')).toBe('tskey-auth-secret');
        return { stdout: '', stderr: '' };
      }
      return runnerFor({
        version: { stdout: '1.84.0\n' },
        'status --json': {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'somnibot.dionysus.ts.net.' },
          }),
        },
        'funnel status --json': {
          stdout: JSON.stringify({ Web: {} }),
        },
        'funnel status': {
          stdout: 'No serve config\n',
        },
      })(args);
    };

    const readiness = await loginWithTailscaleAuthKey('tskey-auth-secret', runner);

    expect(calls[0]).toMatch(/^up --auth-key=file:/);
    expect(calls[0]).not.toContain('tskey-auth-secret');
    expect(readiness.state).toBe('not-configured');
  });

  it('uses a configured auth key before enabling Funnel on a signed-out machine', async () => {
    const calls: string[] = [];
    let loggedIn = false;
    let funnelEnabled = false;

    const runner: TailscaleRunner = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'up') {
        loggedIn = true;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'funnel' && args[1] === '--bg') {
        funnelEnabled = true;
        return { stdout: 'Available on the internet: https://somnibot.dionysus.ts.net', stderr: '' };
      }
      if (args.join(' ') === 'version') {
        return { stdout: '1.84.0\n', stderr: '' };
      }
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            BackendState: loggedIn ? 'Running' : 'NeedsLogin',
            Self: { DNSName: loggedIn ? 'somnibot.dionysus.ts.net.' : '' },
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel status --json') {
        return {
          stdout: JSON.stringify(funnelEnabled
            ? {
              Web: {
                'somnibot.dionysus.ts.net:443': {
                  Handlers: { '/': { Proxy: 'http://127.0.0.1:3456' } },
                },
              },
              AllowFunnel: {
                'somnibot.dionysus.ts.net:443': true,
              },
            }
            : { Web: {} }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel status') {
        return { stdout: 'No serve config\n', stderr: '' };
      }
      throw new TailscaleCommandError(`Unexpected command: ${args.join(' ')}`);
    };

    const readiness = await enableSomniBotFunnel(runner, { authKey: 'tskey-auth-secret' });

    expect(calls.some((call) => call.startsWith('up --auth-key=file:'))).toBe(true);
    expect(calls.some((call) => call.startsWith('funnel --bg --https=443'))).toBe(true);
    expect(calls.join('\n')).not.toContain('tskey-auth-secret');
    expect(readiness.funnelEnabled).toBe(true);
    expect(readiness.publicCallbackBaseUrl).toBe('https://somnibot.dionysus.ts.net');
  });

  it('maps Funnel policy failures to a policy approval state without leaking secrets', async () => {
    const readiness = await enableSomniBotFunnel(async () => {
      throw new TailscaleCommandError('policy denied tskey-auth-secret', {
        stderr: 'missing funnel node attribute for tskey-auth-secret',
      });
    });

    expect(readiness.state).toBe('needs-policy');
    expect(readiness.detail).toContain('[redacted-tailscale-key]');
    expect(readiness.detail).not.toContain('tskey-auth-secret');
  });

  it('maps enable attempts while signed out to the login state', async () => {
    const readiness = await enableSomniBotFunnel(async () => {
      throw new TailscaleCommandError('not logged in', {
        stderr: 'not logged in; run tailscale login',
      });
    });

    expect(readiness.state).toBe('not-logged-in');
    expect(readiness.message).toContain('not signed in');
  });

  it('probes the public dashboard health endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
    } as Response));

    const result = await probePublicCallbackHealth(
      'https://somnibot.dionysus.ts.net',
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      ok: true,
      url: 'https://somnibot.dionysus.ts.net/api/health',
      status: 200,
      error: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://somnibot.dionysus.ts.net/api/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('rejects invalid public callback URLs before probing', async () => {
    const fetchImpl = vi.fn();
    const result = await probePublicCallbackHealth(
      'somnibot.dionysus.ts.net',
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('valid HTTP or HTTPS URL');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-Tailscale hosts before probing', async () => {
    const fetchImpl = vi.fn();
    const result = await probePublicCallbackHealth(
      'https://example.com',
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ts.net');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
