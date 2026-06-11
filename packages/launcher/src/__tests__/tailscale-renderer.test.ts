import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(__dirname, '..', 'renderer');

function readRendererFile(name: string): string {
  return readFileSync(path.join(rendererDir, name), 'utf8');
}

describe('launcher renderer Tailscale setup wiring', () => {
  it('shows public callback status, approval, probe, and diagnostics controls', () => {
    const html = readRendererFile('index.html');

    expect(html).toContain('id="btn-tailscale-check"');
    expect(html).toContain('id="btn-tailscale-enable"');
    expect(html).toContain('id="btn-tailscale-probe"');
    expect(html).toContain('id="tailscale-command"');
  });

  it('gates Funnel enablement behind the explicit Enable Funnel click handler', () => {
    const renderer = readRendererFile('renderer.js');
    const enableCallCount = renderer.match(/enableTailscaleFunnel\(\)/g)?.length ?? 0;
    const clickHandler = renderer.match(/btnTailscaleEnable\.addEventListener\('click'[\s\S]*?enableTailscaleFunnel\(\)/);

    expect(enableCallCount).toBe(1);
    expect(clickHandler).not.toBeNull();
  });

  it('surfaces the documented DNS propagation wait in the GUI state copy', () => {
    const renderer = readRendererFile('renderer.js');

    expect(renderer).toContain('Public DNS can take up to 10 minutes');
  });

  it('updates the guided setup callback field when that field exists', () => {
    const renderer = readRendererFile('renderer.js');

    expect(renderer).toContain("document.getElementById('publicCallbackBaseUrl')");
    expect(renderer).toContain("callbackField.dispatchEvent(new Event('input'");
  });

  it('keeps Tailscale actions scoped to the regular-local runtime mode', () => {
    const html = readRendererFile('index.html');
    const renderer = readRendererFile('renderer.js');

    expect(html).toContain('id="tailscale-section-header"');
    expect(renderer).toContain("tailscaleSectionHeader.classList.toggle('hidden', isVps)");
    expect(renderer).toContain("if (runtimeMode === 'regular-local')");
    expect(renderer.match(/if \(runtimeMode !== 'regular-local'\) return;/g)?.length).toBe(3);
  });

  it('does not force the selected runtime mode when saving Tailscale callback state', () => {
    const main = readFileSync(path.join(rendererDir, '..', 'main', 'index.ts'), 'utf8');
    const enableHandler = main.match(/ipcMain\.handle\('tailscale:enable-funnel'[\s\S]*?return readiness;/)?.[0] ?? '';

    expect(enableHandler).toContain("cfg.runtimeMode === 'regular-local'");
    expect(enableHandler).not.toContain("runtimeMode: 'regular-local'");
  });
});
