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

  it('keeps Discord bot invite docs aligned to the launcher happy path', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('Click **Open Bot Invite** in the Discord setup section.');
    expect(readme).toContain('Manual fallback');
    expect(readme).toContain('Scopes," check: `bot` and `applications.commands`.');
  });
});
