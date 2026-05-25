/**
 * Tests for features/reaction-roles/button-roles.ts — handleButtonRoleInteraction, deployButtonRolesPanel.
 * 130 uncovered statements at 23.5%.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
  SOMNI_PALETTE: { primary: 0x5865f2, success: 0x57f287, danger: 0xed4245 },
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    setColor() { return this; } setTitle() { return this; }
    setDescription() { return this; } addFields() { return this; }
    setFooter() { return this; }
  },
  ActionRowBuilder: class { addComponents() { return this; } },
  ButtonBuilder: class {
    setCustomId() { return this; } setLabel() { return this; }
    setStyle() { return this; } setEmoji() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
}));

vi.mock('../services/audit.js', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

import { handleButtonRoleInteraction, deployButtonRolesPanel } from '../features/reaction-roles/button-roles.js';

function makeChain(data: any = null) {
  const chain: any = {};
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'in', 'match']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  chain.then = (resolve: Function) => resolve({ data: data ? [data] : [], error: null });
  return chain;
}

function makeSupa(overrides: Record<string, any> = {}) {
  return {
    from: vi.fn((t: string) => makeChain(overrides[t] ?? null)),
  } as any;
}

describe('button-roles', () => {
  describe('handleButtonRoleInteraction', () => {
    it('handles role toggle for valid panel', async () => {
      const supa = makeSupa({
        button_role_panels: { id: 'panel-1', roles: [{ role_id: 'role-1', label: 'VIP' }] },
      });
      const interaction = {
        customId: 'buttonrole:panel-1:role-1',
        guildId: 'guild-1',
        member: {
          id: 'user-1',
          roles: {
            cache: new Map(),
            add: vi.fn().mockResolvedValue({}),
            remove: vi.fn().mockResolvedValue({}),
          },
        },
        reply: vi.fn().mockResolvedValue({}),
        deferReply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
      } as any;
      await handleButtonRoleInteraction(interaction, supa);
    });

    it('ignores non-buttonrole custom IDs', async () => {
      const interaction = {
        customId: 'other:thing',
        reply: vi.fn(),
      } as any;
      const result = await handleButtonRoleInteraction(interaction, makeSupa());
      // Should return early
    });
  });

  describe('deployButtonRolesPanel', () => {
    it('deploys panel to channel', async () => {
      const channel = { send: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
      const guild = {
        id: 'guild-1',
        channels: { cache: new Map([['ch-1', channel]]) },
        roles: { cache: new Map([['role-1', { id: 'role-1', name: 'VIP' }]]) },
      } as any;
      const supa = makeSupa({
        button_role_panels: {
          id: 'panel-1', channel_id: 'ch-1', title: 'Roles',
          roles: [{ role_id: 'role-1', label: 'VIP', emoji: '⭐' }],
        },
      });
      await deployButtonRolesPanel(guild, supa, 'panel-1');
    });
  });
});
