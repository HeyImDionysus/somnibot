/**
 * context-menus — coverage tests
 *
 * Tests all context menu handlers with REAL imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => {
  class MockEmbedBuilder {
    data: Record<string, unknown> = {};
    setColor(c: number) { this.data.color = c; return this; }
    setAuthor(a: Record<string, unknown>) { this.data.author = a; return this; }
    setThumbnail(u: string) { this.data.thumbnail = u; return this; }
    addFields(...f: unknown[]) { this.data.fields = f; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setFooter(f: Record<string, unknown>) { this.data.footer = f; return this; }
    setTimestamp() { return this; }
  }

  class MockActionRowBuilder {
    components: unknown[] = [];
    addComponents(...c: unknown[]) { this.components.push(...c); return this; }
  }

  class MockModalBuilder {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setTitle(t: string) { this.data.title = t; return this; }
    addComponents(...c: unknown[]) { this.data.components = c; return this; }
  }

  class MockTextInputBuilder {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: unknown) { this.data.style = s; return this; }
    setPlaceholder(p: string) { this.data.placeholder = p; return this; }
    setRequired(r: boolean) { this.data.required = r; return this; }
    setMaxLength(m: number) { this.data.maxLength = m; return this; }
  }

  class MockContextMenuCommandBuilder {
    data: Record<string, unknown> = {};
    setName(n: string) { this.data.name = n; return this; }
    setType(t: number) { this.data.type = t; return this; }
  }

  class MockButtonBuilder {
    data: Record<string, unknown> = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: unknown) { this.data.style = s; return this; }
  }

  return {
    ContextMenuCommandBuilder: MockContextMenuCommandBuilder,
    ApplicationCommandType: { User: 2, Message: 3 },
    EmbedBuilder: MockEmbedBuilder,
    ActionRowBuilder: MockActionRowBuilder,
    ModalBuilder: MockModalBuilder,
    TextInputBuilder: MockTextInputBuilder,
    TextInputStyle: { Short: 1, Paragraph: 2 },
    ButtonBuilder: MockButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2 },
  };
});

import {
  buildContextMenuCommands,
  handleViewProfile,
  handleWarnUser,
  handleViewPurchases,
  handleCreateTicketFromMessage,
  handleReportMessage,
} from '../features/discord-ux/context-menus.js';

// ── Helpers ───────────────────────────────────────────────

class MockCollection<V> extends Map<string, V> {
  filter(fn: (v: V, k: string) => boolean): MockCollection<V> {
    const result = new MockCollection<V>();
    for (const [k, v] of this) { if (fn(v, k)) result.set(k, v); }
    return result;
  }
  sort(fn?: (a: V, b: V) => number): this {
    const entries = [...this.entries()];
    if (fn) entries.sort(([, a], [, b]) => fn(a, b));
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }
  map<T>(fn: (v: V, k: string) => T): T[] {
    const result: T[] = [];
    for (const [k, v] of this) result.push(fn(v, k));
    return result;
  }
}

function chainBuilder(resolveValue: Record<string, unknown> = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'in']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(resolveValue);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  chain.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(res, rej);
  return chain;
}

function makeUserInteraction(overrides: Record<string, unknown> = {}) {
  const rolesCache = new MockCollection<any>();
  rolesCache.set('r1', { id: 'r1', position: 5, toString: () => '<@&r1>' });
  rolesCache.set('g1', { id: 'g1', position: 0, toString: () => '<@&g1>' });

  return {
    targetUser: {
      id: 'u1',
      displayName: 'TestUser',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discord.com/avatar.png'),
    },
    guild: {
      members: {
        cache: new MockCollection([
          ['u1', {
            roles: { cache: rolesCache },
            joinedAt: new Date('2025-06-01'),
          }],
        ]),
      },
    },
    guildId: 'g1',
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMessageInteraction(overrides: Record<string, unknown> = {}) {
  return {
    targetMessage: {
      id: 'msg1',
      channel: { id: 'ch1' },
      author: { id: 'u2' },
    },
    showModal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildContextMenuCommands', () => {
  it('returns 5 command builders', () => {
    const commands = buildContextMenuCommands();
    expect(commands).toHaveLength(5);
  });

  it('includes View Profile, Warn User, View Purchases, Create Ticket, Report Message', () => {
    const commands = buildContextMenuCommands();
    const names = commands.map((c: any) => c.data.name);
    expect(names).toContain('View Profile');
    expect(names).toContain('Warn User');
    expect(names).toContain('View Purchases');
    expect(names).toContain('Create Ticket');
    expect(names).toContain('Report Message');
  });
});

describe('handleViewProfile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows profile with level, XP, messages, infractions, and roles', async () => {
    const interaction = makeUserInteraction();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'member_levels') {
          return chainBuilder({ data: { level: 15, xp: 3400, total_messages: 120 }, error: null });
        }
        if (table === 'infractions') {
          return chainBuilder({ data: [{ id: 'inf1' }, { id: 'inf2' }], error: null });
        }
        if (table === 'customers') {
          return chainBuilder({
            data: { total_spent_cents: 4999, first_purchase_at: '2025-01-15T00:00:00Z' },
            error: null,
          });
        }
        return chainBuilder();
      }),
    };

    await handleViewProfile(interaction as any, supabase as any, 'g1');
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('handles missing user data (all nulls)', async () => {
    const interaction = makeUserInteraction();
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: null, error: null })),
    };

    await handleViewProfile(interaction as any, supabase as any, 'g1');
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('handles member not in cache', async () => {
    const interaction = makeUserInteraction({
      guild: { members: { cache: new MockCollection() } },
    });
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: null, error: null })),
    };

    await handleViewProfile(interaction as any, supabase as any, 'g1');
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

describe('handleWarnUser', () => {
  it('opens warn modal', async () => {
    const interaction = makeUserInteraction();
    await handleWarnUser(interaction as any);
    expect(interaction.showModal).toHaveBeenCalled();
  });
});

describe('handleViewPurchases', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows no-purchase message when no customer', async () => {
    const interaction = makeUserInteraction();
    const supabase = {
      from: vi.fn().mockReturnValue(chainBuilder({ data: null, error: null })),
    };

    await handleViewPurchases(interaction as any, supabase as any, 'g1');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no purchase history') }),
    );
  });

  it('shows purchase history with orders', async () => {
    let callCount = 0;
    const interaction = makeUserInteraction();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'customers') {
          return chainBuilder({
            data: { id: 'cust1', total_spent_cents: 2500, first_purchase_at: '2025-03-01' },
            error: null,
          });
        }
        if (table === 'orders') {
          return chainBuilder({
            data: [
              {
                order_number: 'ORD-001',
                status: 'completed',
                amount_cents: 1500,
                currency: 'USD',
                created_at: '2025-03-01T12:00:00Z',
                products: { name: 'Premium Role' },
              },
              {
                order_number: 'ORD-002',
                status: 'pending',
                amount_cents: 1000,
                currency: 'USD',
                created_at: '2025-04-01T12:00:00Z',
                products: [{ name: 'VIP Access' }],
              },
              {
                order_number: 'ORD-003',
                status: 'cancelled',
                amount_cents: 500,
                currency: 'USD',
                created_at: '2025-05-01T12:00:00Z',
                products: null,
              },
            ],
            error: null,
          });
        }
        return chainBuilder();
      }),
    };

    await handleViewPurchases(interaction as any, supabase as any, 'g1');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('shows empty orders message', async () => {
    const interaction = makeUserInteraction();
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'customers') {
          return chainBuilder({
            data: { id: 'cust1', total_spent_cents: 0, first_purchase_at: null },
            error: null,
          });
        }
        if (table === 'orders') {
          return chainBuilder({ data: [], error: null });
        }
        return chainBuilder();
      }),
    };

    await handleViewPurchases(interaction as any, supabase as any, 'g1');
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

describe('handleCreateTicketFromMessage', () => {
  it('opens ticket modal', async () => {
    const interaction = makeMessageInteraction();
    await handleCreateTicketFromMessage(interaction as any);
    expect(interaction.showModal).toHaveBeenCalled();
  });
});

describe('handleReportMessage', () => {
  it('opens report modal', async () => {
    const interaction = makeMessageInteraction();
    await handleReportMessage(interaction as any);
    expect(interaction.showModal).toHaveBeenCalled();
  });
});
