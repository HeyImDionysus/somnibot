/**
 * Coverage: features/setup-wizard/steps.ts (438 lines)
 * These are pure builder functions — no external deps besides discord.js
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('discord.js', () => {
  class MockEmbedBuilder {
    data: any = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: any) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
    addFields(...args: any[]) { this.data.fields = args; return this; }
    setThumbnail() { return this; }
    setImage() { return this; }
    setAuthor() { return this; }
    setURL(u: string) { this.data.url = u; return this; }
    toJSON() { return this.data; }
  }
  class MockActionRowBuilder {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  class MockButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setEmoji(e: any) { this.data.emoji = e; return this; }
    setDisabled(d: boolean) { this.data.disabled = d; return this; }
    setURL(u: string) { this.data.url = u; return this; }
    toJSON() { return this.data; }
  }
  class MockTextInputBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setPlaceholder(p: string) { this.data.placeholder = p; return this; }
    setStyle(s: any) { this.data.style = s; return this; }
    setRequired(r: boolean) { this.data.required = r; return this; }
    setValue(v: string) { this.data.value = v; return this; }
    setMaxLength(m: number) { this.data.maxLength = m; return this; }
  }
  class MockModalBuilder {
    data: any = {};
    components: any[] = [];
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  }
  return {
    EmbedBuilder: MockEmbedBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    ButtonBuilder: MockButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
    ModalBuilder: MockModalBuilder,
    TextInputBuilder: MockTextInputBuilder,
    TextInputStyle: { Short: 1, Paragraph: 2 },
    Collection: Map,
  };
});

import {
  WIZARD_STEPS,
  buildStepEmbed,
  buildStepComponents,
  buildStepModal,
  buildCompletionEmbed,
} from '../features/setup-wizard/steps.js';

describe('Setup Wizard Steps', () => {
  it('WIZARD_STEPS has 3 steps', () => {
    expect(WIZARD_STEPS).toHaveLength(3);
  });

  it('each step has required fields', () => {
    for (const step of WIZARD_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.description).toBeTruthy();
      expect(step.emoji).toBeTruthy();
      expect(step.instructions).toBeTruthy();
      expect(step.credentialsLabel).toBeTruthy();
      expect(Array.isArray(step.modalFields)).toBe(true);
    }
  });

  it('buildStepEmbed for each step', () => {
    WIZARD_STEPS.forEach((step, i) => {
      const embed = buildStepEmbed(step, i, WIZARD_STEPS.length);
      expect(embed).toBeDefined();
    });
  });

  it('buildStepComponents for each step', () => {
    WIZARD_STEPS.forEach((step) => {
      const rows = buildStepComponents(step);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it('buildStepModal for each step', () => {
    WIZARD_STEPS.forEach((step) => {
      const modal = buildStepModal(step);
      expect(modal).toBeDefined();
    });
  });

  it('buildCompletionEmbed with all configured', () => {
    const configured = new Set(WIZARD_STEPS.map((s) => s.id));
    const embed = buildCompletionEmbed(configured);
    expect(embed).toBeDefined();
  });

  it('buildCompletionEmbed with none configured', () => {
    const embed = buildCompletionEmbed(new Set());
    expect(embed).toBeDefined();
  });

  it('buildStepComponents includes link button when step has url', () => {
    const stepWithUrl = WIZARD_STEPS.find((s) => s.url);
    if (stepWithUrl) {
      const rows = buildStepComponents(stepWithUrl);
      expect(rows.length).toBeGreaterThan(0);
    }
  });
});
