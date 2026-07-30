import { describe, expect, it } from 'vitest';

import { buildSetupCommand } from '../features/setup-wizard/commands.js';
import {
  WIZARD_STEPS,
  buildCompletionEmbed,
  buildStepComponents,
  buildStepEmbed,
  buildStepModal,
} from '../features/setup-wizard/steps.js';

describe('/setup Discord surfaces', () => {
  it('builds the registered guild-only command contract', () => {
    const command = buildSetupCommand().toJSON();

    expect(command.name).toBe('setup');
    expect(command.description).toContain('guided step by step');
    expect(command.dm_permission).toBe(false);
  });

  it('renders every step as valid embeds, buttons, and credential modals', () => {
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
      'supabase_mgmt',
      'deployment',
      'paypal',
    ]);
    expect(new Set(WIZARD_STEPS.map((step) => step.id)).size).toBe(WIZARD_STEPS.length);

    for (const [index, step] of WIZARD_STEPS.entries()) {
      const embed = buildStepEmbed(step, index, WIZARD_STEPS.length).toJSON();
      expect(embed.title).toContain(step.title);
      expect(embed.description).toContain(step.description);
      expect(embed.description?.length).toBeLessThanOrEqual(4096);
      expect(embed.footer?.text).toContain('/setup');

      const rows = buildStepComponents(step).map((row) => row.toJSON());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.components.length).toBeGreaterThanOrEqual(2);
      expect(rows[0]?.components.length).toBeLessThanOrEqual(5);
      const buttonIds = rows[0]?.components
        .map((component) => ('custom_id' in component ? component.custom_id : undefined))
        .filter((id): id is string => Boolean(id)) ?? [];
      expect(new Set(buttonIds).size).toBe(buttonIds.length);
      expect(buttonIds).toContain(`setup:${step.id}:credentials`);
      expect(buttonIds).toContain(`setup:${step.id}:skip`);

      const modal = buildStepModal(step).toJSON();
      expect(modal.custom_id).toBe(`setup:modal:${step.id}`);
      expect(modal.title).toContain(step.title);
      expect(modal.components).toHaveLength(step.modalFields.length);
      expect(modal.components.length).toBeGreaterThan(0);
      expect(modal.components.length).toBeLessThanOrEqual(5);
      const modalFieldIds = modal.components.map((row) => (
        'components' in row ? row.components[0]?.custom_id : undefined
      ));
      expect(new Set(modalFieldIds).size).toBe(modalFieldIds.length);
      expect(modalFieldIds).toEqual(step.modalFields.map((field) => field.customId));
    }
  });

  it('renders honest completion and unreachable-dashboard states', () => {
    const allConfigured = new Set(WIZARD_STEPS.map((step) => step.id));
    const complete = buildCompletionEmbed(allConfigured, {
      url: 'https://dashboard.example.test',
      live: true,
    }).toJSON();
    const unreachable = buildCompletionEmbed(allConfigured, {
      url: 'https://dashboard.example.test',
      live: false,
    }).toJSON();

    expect(complete.title).toContain('Setup Complete');
    expect(complete.description).toContain('Run `/setup` again');
    expect(unreachable.title).toContain('Dashboard Unreachable');
    expect(unreachable.description).toContain('nothing is answering');
  });
});
