import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('setup documentation alignment', () => {
  it('names the launcher setup GUI as the primary regular-local and VPS setup surface', () => {
    const readme = readRepoFile('README.md');
    const deployment = readRepoFile('DEPLOYMENT.md');
    const runbook = readRepoFile('RUNBOOK.md');

    expect(readme).toContain('The Electron launcher/setup GUI is the primary owner setup surface');
    expect(deployment).toContain('Use the Electron launcher/setup GUI as the primary owner flow');
    expect(runbook).toContain('Use the launcher/setup GUI first for regular-local and VPS setup');
  });

  it('keeps Tailscale and VPS command lines as fallback paths instead of the normal happy path', () => {
    const docs = [
      readRepoFile('README.md'),
      readRepoFile('DEPLOYMENT.md'),
      readRepoFile('RUNBOOK.md'),
    ].join('\n');

    expect(docs).not.toContain('Recommended default: use Tailscale Funnel to expose the local dashboard port');
    expect(docs).not.toContain('http://localhost:3000 for first local setup');
    expect(docs).toContain('Manual fallback');
    expect(docs).toContain('tailscale funnel <dashboard-port>');
    expect(docs).toContain('script-fallback private setup');
    expect(docs).toContain('approval-gated deployment');
  });

  it('keeps PayPal webhook docs aligned to the launcher automation path', () => {
    const docs = [
      readRepoFile('README.md'),
      readRepoFile('DEPLOYMENT.md'),
    ].join('\n');

    expect(docs).toContain('click **Create/Update Webhook**');
    expect(docs).toContain('The launcher creates or updates');
    expect(docs).toContain('Manual fallback');
    expect(docs).toContain('PayPal Developer Dashboard');
  });

  it('keeps Discord bot invite docs aligned to the launcher happy path', () => {
    const readme = readRepoFile('README.md');
    const launcherStep = readme.indexOf('### Step 5: Open the Launcher Setup GUI');
    const inviteStep = readme.indexOf('### Step 6: Invite the Bot to Your Server');
    const startStep = readme.indexOf('### Step 7: First-Time Setup');

    expect(launcherStep).toBeGreaterThan(-1);
    expect(inviteStep).toBeGreaterThan(launcherStep);
    expect(startStep).toBeGreaterThan(inviteStep);
    expect(readme).toContain('Do not click **Set Up & Start** or run the script fallback until after Step 6.');
    expect(readme).toContain('After the bot is authorized in Discord, click **Set Up & Start**.');
    expect(readme).toContain('Discord server readiness as a separate');
    expect(readme).toContain('server membership');
    expect(readme).toContain('Paste one Guild ID if you want the invite locked to one server.');
    expect(readme).toContain('Click **Open Bot Invite**');
    expect(readme).toContain('Discord server\n   setup step.');
    expect(readme).toContain('Manual fallback');
    expect(readme).toContain('Scopes," check: `bot` and `applications.commands`.');
    expect(readme).toContain('re-invite it using the launcher invite flow from Step 6.');
  });
});
