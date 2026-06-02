/**
 * AdventureManager — coverage tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...a: any[]) { return this; }
  },
  ActionRowBuilder: class {
    components: any[] = [];
    addComponents(...c: any[]) { this.components.push(...c); return this; }
  },
  ButtonBuilder: class {
    setCustomId() { return this; }
    setLabel() { return this; }
    setEmoji() { return this; }
    setStyle() { return this; }
  },
  ButtonStyle: { Primary: 1 },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../utils/random.js', () => ({
  randomPick: (arr: any[]) => arr[0],
  randomChance: () => true,
}));

vi.mock('../quests/quests-manager.js', () => ({
  getQuestsManager: () => ({
    trackProgress: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AdventureManager, registerAdventureManager, invalidateAdventureCache, getAdventureManager } from '../features/adventures/adventure-manager.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(tableData: Record<string, any> = {}, rpcResults: Record<string, any> = {}) {
  const fromMock = vi.fn();
  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    const data = tableData[table] ?? null;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null, count: tableData[table + '_count'] ?? 0 });
    chain[Symbol.toStringTag] = 'Promise';
    return chain;
  });
  return {
    from: fromMock,
    rpc: vi.fn().mockImplementation((name: string) => {
      if (rpcResults[name]) return Promise.resolve(rpcResults[name]);
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

function makeGuild() {
  return { id: 'g1' };
}

function makeValkey() {
  return { get: vi.fn(), set: vi.fn(), del: vi.fn() };
}

// ── Tests ────────────────────────────────────────────────

describe('AdventureManager', () => {
  let mgr: AdventureManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase({
      guild_config: {
        economy_adventures_enabled: true,
        economy_adventure_daily_limit: 3,
        economy_adventure_ticket_cost: 100,
        economy_adventure_max_scenes: 10,
      },
      economy_adventures: [
        { id: 'a1', name: 'Dragon Cave', emoji: '🐉', description: 'Explore the cave', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 },
      ],
      economy_adventure_scenes: {
        id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'You enter the cave...',
        choices: [
          { label: 'Go left', emoji: '⬅️', currency: 50, loot: [{ item_name: 'Gold Ring', qty: 1, chance_pct: 100 }], next_scene_index: 1 },
          { label: 'Go right', emoji: '➡️', currency: 0, loot: [], next_scene_index: null },
        ],
        loot: [], is_ending: false, ending_type: null,
      },
      economy_adventure_sessions: null,
      economy_adventure_sessions_count: 0,
    });
    mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
  });

  describe('constructor & utility', () => {
    it('creates instance', () => {
      expect(mgr).toBeInstanceOf(AdventureManager);
    });

    it('invalidateCache clears caches', () => {
      mgr.invalidateCache();
    });

    it('register and get', () => {
      registerAdventureManager(mgr);
      expect(getAdventureManager()).toBe(mgr);
      invalidateAdventureCache();
    });
  });

  describe('startAdventure', () => {
    it('returns error when adventures disabled', async () => {
      supabase = makeSupabase({ guild_config: { economy_adventures_enabled: false } });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBeNull();
    });

    it('returns error when daily limit reached', async () => {
      supabase = makeSupabase({
        guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 },
        economy_adventure_sessions: null,
        economy_adventure_sessions_count: 5,
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBeNull();
    });

    it('returns error when active session exists', async () => {
      supabase = makeSupabase({
        guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 },
        economy_adventure_sessions: [{ id: 's1' }],
        economy_adventure_sessions_count: 0,
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBeNull();
    });

    it('returns error when insufficient funds', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 },
          economy_adventure_sessions: null,
          economy_adventure_sessions_count: 0,
          economy_adventures: [{ id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 }],
        },
        { economy_subtract_balance: { error: { message: 'insufficient' } } },
      );
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBeNull();
    });

    it('starts adventure successfully', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 },
          economy_adventure_sessions: null,
          economy_adventure_sessions_count: 0,
          economy_adventures: [{ id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 }],
          economy_adventure_scenes: {
            id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'You enter...',
            choices: [{ label: 'Go', emoji: '⬅️', currency: 0, loot: [], next_scene_index: 1 }],
            loot: [], is_ending: false, ending_type: null,
          },
        },
        { economy_subtract_balance: { data: true, error: null } },
      );
      // Override the session insert to return session data
      const originalFrom = supabase.from;
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          callCount++;
          if (callCount <= 2) {
            // first two: count check + active session check
            chain.then = (r: (v: any) => void) => r({ data: null, error: null, count: 0 });
          } else {
            // third: insert
            chain.then = (r: (v: any) => void) => r({ data: { id: 'sess1' }, error: null });
          }
        } else if (table === 'economy_adventure_scenes') {
          chain.then = (r: (v: any) => void) => r({
            data: { id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'Scene text', choices: [{ label: 'Go', emoji: '⬅️', currency: 0, loot: [], next_scene_index: 1 }], loot: [], is_ending: false, ending_type: null },
            error: null,
          });
        } else if (table === 'economy_adventures') {
          chain.then = (r: (v: any) => void) => r({
            data: [{ id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 }],
            error: null,
          });
        } else {
          const data = table === 'guild_config' ? { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 } : null;
          chain.then = (r: (v: any) => void) => r({ data, error: null, count: 0 });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBe('sess1');
      expect(result.embed).toBeDefined();
    });

    it('handles session creation error with refund', async () => {
      supabase = makeSupabase(
        {
          guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 },
          economy_adventure_sessions: null,
          economy_adventure_sessions_count: 0,
          economy_adventures: [{ id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 }],
        },
        { economy_subtract_balance: { data: true, error: null }, economy_add_balance: { data: true, error: null } },
      );
      let callCount = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          callCount++;
          if (callCount <= 2) {
            chain.then = (r: (v: any) => void) => r({ data: null, error: null, count: 0 });
          } else {
            chain.then = (r: (v: any) => void) => r({ data: null, error: { code: '23505', message: 'duplicate key' } });
          }
        } else if (table === 'economy_adventure_scenes') {
          chain.then = (r: (v: any) => void) => r({
            data: { id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'Scene', choices: [{ label: 'Go', emoji: '⬅️', currency: 0, loot: [], next_scene_index: 1 }], loot: [], is_ending: false, ending_type: null },
            error: null,
          });
        } else if (table === 'economy_adventures') {
          chain.then = (r: (v: any) => void) => r({
            data: [{ id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 }],
            error: null,
          });
        } else {
          chain.then = (r: (v: any) => void) => r({
            data: table === 'guild_config' ? { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 100, economy_adventure_max_scenes: 10 } : null,
            error: null, count: 0,
          });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1');
      expect(result.sessionId).toBeNull();
    });

    it('filters by adventure type', async () => {
      supabase = makeSupabase({
        guild_config: { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 0, economy_adventure_max_scenes: 10 },
        economy_adventure_sessions: null,
        economy_adventure_sessions_count: 0,
        economy_adventures: [
          { id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 },
          { id: 'a2', name: 'Forest', emoji: '🌲', description: '', adventure_type: 'explore', difficulty: 'easy', min_scenes: 2, max_scenes: 3 },
        ],
        economy_adventure_scenes: {
          id: 'sc1', adventure_id: 'a2', scene_index: 0, text: 'Forest path...',
          choices: [], loot: [], is_ending: false, ending_type: null,
        },
      });
      let sessCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          sessCallCount++;
          if (sessCallCount <= 2) {
            chain.then = (r: (v: any) => void) => r({ data: null, error: null, count: 0 });
          } else {
            chain.then = (r: (v: any) => void) => r({ data: { id: 'sess2' }, error: null });
          }
        } else if (table === 'economy_adventure_scenes') {
          chain.then = (r: (v: any) => void) => r({
            data: { id: 'sc1', scene_index: 0, text: 'Forest', choices: [], loot: [], is_ending: false, ending_type: null },
            error: null,
          });
        } else if (table === 'economy_adventures') {
          chain.then = (r: (v: any) => void) => r({
            data: [
              { id: 'a1', name: 'Cave', emoji: '🐉', description: '', adventure_type: 'dungeon', difficulty: 'normal', min_scenes: 3, max_scenes: 5 },
              { id: 'a2', name: 'Forest', emoji: '🌲', description: '', adventure_type: 'explore', difficulty: 'easy', min_scenes: 2, max_scenes: 3 },
            ],
            error: null,
          });
        } else {
          chain.then = (r: (v: any) => void) => r({
            data: table === 'guild_config' ? { economy_adventures_enabled: true, economy_adventure_daily_limit: 3, economy_adventure_ticket_cost: 0, economy_adventure_max_scenes: 10 } : null,
            error: null, count: 0,
          });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const result = await mgr.startAdventure('u1', 'explore');
      expect(result.sessionId).toBe('sess2');
    });
  });

  describe('handleChoice', () => {
    it('rejects if session not found', async () => {
      supabase = makeSupabase({ economy_adventure_sessions: null });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const interaction = { user: { id: 'u1' }, reply: vi.fn(), update: vi.fn() };
      await mgr.handleChoice(interaction as any, 'nonexistent', 0);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ended') }));
    });

    it('rejects if wrong user', async () => {
      supabase = makeSupabase({
        economy_adventure_sessions: { id: 's1', user_id: 'u2', status: 'active', loot_collected: [], currency_collected: 0, adventure_id: 'a1', current_scene_id: 'sc1' },
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const interaction = { user: { id: 'u1' }, reply: vi.fn(), update: vi.fn() };
      await mgr.handleChoice(interaction as any, 's1', 0);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not your') }));
    });

    it('handles choice that ends adventure (null next_scene_index)', async () => {
      const session = { id: 's1', user_id: 'u1', status: 'active', loot_collected: [], currency_collected: 0, adventure_id: 'a1', current_scene_id: 'sc1' };
      const scene = {
        id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'A fork in the road',
        choices: [
          { label: 'End', emoji: '🏁', currency: 100, loot: [], next_scene_index: null },
        ],
        loot: [], is_ending: false, ending_type: null,
      };
      let callIdx = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          callIdx++;
          if (callIdx === 1) chain.then = (r: (v: any) => void) => r({ data: session, error: null });
          else chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        } else if (table === 'economy_adventure_scenes') {
          chain.then = (r: (v: any) => void) => r({ data: scene, error: null });
        } else if (table === 'economy_items') {
          chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        } else {
          chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const interaction = { user: { id: 'u1' }, reply: vi.fn(), update: vi.fn() };
      await mgr.handleChoice(interaction as any, 's1', 0);
      expect(interaction.update).toHaveBeenCalled();
    });

    it('navigates to ending scene with death outcome', async () => {
      const session = { id: 's1', user_id: 'u1', status: 'active', loot_collected: [{ item_name: 'Gem', qty: 2 }], currency_collected: 100, adventure_id: 'a1', current_scene_id: 'sc1' };
      const scene1 = {
        id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'A dark corridor',
        choices: [{ label: 'Enter', emoji: '🚪', currency: 0, loot: [], next_scene_index: 1 }],
        loot: [], is_ending: false, ending_type: null,
      };
      const scene2 = {
        id: 'sc2', adventure_id: 'a1', scene_index: 1, text: 'A dragon eats you!',
        choices: [], loot: [{ item_name: 'Scale', qty: 1, chance_pct: 100 }], is_ending: true, ending_type: 'death',
      };
      let sessCallCount = 0;
      let sceneCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          sessCallCount++;
          if (sessCallCount === 1) chain.then = (r: (v: any) => void) => r({ data: session, error: null });
          else chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        } else if (table === 'economy_adventure_scenes') {
          sceneCallCount++;
          if (sceneCallCount === 1) chain.then = (r: (v: any) => void) => r({ data: scene1, error: null });
          else chain.then = (r: (v: any) => void) => r({ data: scene2, error: null });
        } else {
          chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const interaction = { user: { id: 'u1' }, reply: vi.fn(), update: vi.fn() };
      await mgr.handleChoice(interaction as any, 's1', 0);
      expect(interaction.update).toHaveBeenCalled();
    });

    it('navigates to non-ending scene', async () => {
      const session = { id: 's1', user_id: 'u1', status: 'active', loot_collected: [], currency_collected: 0, adventure_id: 'a1', current_scene_id: 'sc1' };
      const scene1 = {
        id: 'sc1', adventure_id: 'a1', scene_index: 0, text: 'Start',
        choices: [{ label: 'Next', emoji: '➡️', currency: 10, loot: [{ item_name: 'Key', qty: 1, chance_pct: 100 }], next_scene_index: 1 }],
        loot: [], is_ending: false, ending_type: null,
      };
      const scene2 = {
        id: 'sc2', adventure_id: 'a1', scene_index: 1, text: 'Continue...',
        choices: [{ label: 'Go on', emoji: '➡️', currency: 0, loot: [], next_scene_index: 2 }],
        loot: [{ item_name: 'Coin', qty: 5, chance_pct: 100 }], is_ending: false, ending_type: null,
      };
      let sessCallCount = 0;
      let sceneCallCount = 0;
      supabase.from.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'maybeSingle', 'ilike'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_adventure_sessions') {
          sessCallCount++;
          if (sessCallCount === 1) chain.then = (r: (v: any) => void) => r({ data: session, error: null });
          else chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        } else if (table === 'economy_adventure_scenes') {
          sceneCallCount++;
          if (sceneCallCount === 1) chain.then = (r: (v: any) => void) => r({ data: scene1, error: null });
          else chain.then = (r: (v: any) => void) => r({ data: scene2, error: null });
        } else if (table === 'economy_adventures') {
          chain.then = (r: (v: any) => void) => r({ data: { name: 'Cave', emoji: '🐉' }, error: null });
        } else {
          chain.then = (r: (v: any) => void) => r({ data: null, error: null });
        }
        chain[Symbol.toStringTag] = 'Promise';
        return chain;
      });
      mgr = new AdventureManager(makeGuild() as any, supabase as any, makeValkey() as any);
      const interaction = { user: { id: 'u1' }, reply: vi.fn(), update: vi.fn() };
      await mgr.handleChoice(interaction as any, 's1', 0);
      expect(interaction.update).toHaveBeenCalled();
    });
  });
});
