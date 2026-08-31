import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class ElementFixture {
  value = '';
  textContent = '';
  disabled = false;
  readonly handlers = new Map<string, () => unknown>();
  readonly focus = vi.fn();
  addEventListener(event: string, callback: () => unknown) { this.handlers.set(event, callback); }
  async click() { await this.handlers.get('click')?.(); }
}

function setupSurface() {
  const elements = new Map<string, ElementFixture>();
  const element = (id: string) => {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = new ElementFixture();
    elements.set(id, created);
    return created;
  };
  const backupDatabase = vi.fn(async () => ({ status: 'backed-up', backupId: 'owned-backup', message: 'captured' }));
  const rehearseDatabase = vi.fn(async (_request: unknown) => ({ status: 'rehearsed', message: 'validated' }));
  runInNewContext(readFileSync(fileURLToPath(new URL('../renderer/database-recovery.js', import.meta.url)), 'utf8'), {
    document: { getElementById: element }, window: { somnibot: { backupDatabase, rehearseDatabase } },
  });
  return { element, backupDatabase, rehearseDatabase };
}

describe('database recovery renderer behavior', () => {
  it('does not run backup or rehearsal when the controls are merely loaded', () => {
    // Given the real renderer script with an isolated DOM fixture.
    const surface = setupSurface();
    // When it is initialized without an owner click.
    // Then neither database action runs.
    expect(surface.backupDatabase).not.toHaveBeenCalled();
    expect(surface.rehearseDatabase).not.toHaveBeenCalled();
  });

  it('enables rehearsal only after capture and clears transient target credentials after use', async () => {
    // Given a freshly captured backup and explicit target input.
    const surface = setupSurface();
    await surface.element('database-backup').click();
    surface.element('database-recovery-target').value = 'https://target.supabase.co';
    surface.element('database-recovery-password').value = 'transient-secret';
    surface.element('database-recovery-confirmation').value = 'target';
    // When the owner clicks rehearsal.
    await surface.element('database-rehearse').click();
    await Promise.resolve();
    // Then the captured identity is sent and the password is no longer retained in the form.
    expect(surface.rehearseDatabase).toHaveBeenCalledWith(expect.objectContaining({ backupId: 'owned-backup', password: 'transient-secret', confirmation: 'target' }));
    expect(surface.element('database-recovery-password').value).toBe('');
    expect(surface.element('database-rehearse').disabled).toBe(false);
  });

  it('blocks a rehearsal when target details have not been supplied', async () => {
    // Given a captured backup but no target credentials or confirmation.
    const surface = setupSurface();
    await surface.element('database-backup').click();
    // When rehearsal is clicked.
    await surface.element('database-rehearse').click();
    // Then no restore request leaves the renderer.
    expect(surface.rehearseDatabase).not.toHaveBeenCalled();
    expect(surface.element('database-recovery-target').focus).toHaveBeenCalled();
  });
});
