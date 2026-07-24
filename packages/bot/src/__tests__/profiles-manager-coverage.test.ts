/**
 * ProfilesManager — coverage tests.
 *
 * Imports the REAL ProfilesManager class and mocks only external boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class {
    data: Record<string, unknown> = {};
    fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setThumbnail(t: string) { this.data.thumbnail = t; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    addFields(...args: any[]) {
      for (const a of args) {
        if (Array.isArray(a)) this.fields.push(...a);
        else this.fields.push(a);
      }
      return this;
    }
  },
}));

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ProfilesManager, registerProfilesManager, invalidateProfilesCache } from '../features/profiles/profiles-manager.js';

// ── Helpers ───────────────────────────────────────────────

function makeSupabase(overrides: Record<string, any> = {}) {
  const fromMock = vi.fn();

  fromMock.mockImplementation((table: string) => {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    // Default resolve based on table name
    const data = overrides[table] ?? null;
    const count = overrides[`${table}_count`] ?? 0;
    chain.then = (resolve: (v: any) => void) => resolve({ data, error: null, count });
    (chain as any)[Symbol.toStringTag] = 'Promise';
    return chain;
  });

  return {
    from: fromMock,
    rpc: vi.fn().mockResolvedValue({ error: null }),
  };
}

function makeInteraction(overrides: Record<string, any> = {}) {
  const targetUser = overrides.targetUser ?? null;
  return {
    guildId: overrides.guildId ?? 'g1',
    user: {
      id: overrides.userId ?? 'u1',
      displayName: 'TestUser',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/test.png'),
      username: 'testuser',
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: vi.fn().mockImplementation((key: string) => {
        if (key === 'title') return overrides.title ?? 'My Title';
        if (key === 'bio') return overrides.bio ?? 'My Bio';
        return null;
      }),
      getUser: vi.fn().mockReturnValue(targetUser),
      getInteger: vi.fn().mockReturnValue(null),
    },
  };
}

// ── Tests ────────────────────────────────────────────────

describe('ProfilesManager', () => {
  let mgr: ProfilesManager;
  let supabase: ReturnType<typeof makeSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = makeSupabase();
    mgr = new ProfilesManager(supabase as any);
  });

  describe('constructor & utility', () => {
    it('creates an instance', () => {
      expect(mgr).toBeInstanceOf(ProfilesManager);
    });

    it('clearCache works', () => {
      mgr.clearCache();
    });

    it('register and invalidate', () => {
      registerProfilesManager(mgr, 'test-guild-id');
      invalidateProfilesCache();
    });
  });

  describe('viewProfile', () => {
    it('shows own profile with wallet, pet, prestige, achievements', async () => {
      supabase = makeSupabase({
        economy_profiles: {
          title: 'King',
          bio: 'Hello world',
          profile_views: 42,
          badge_slots: ['🏆', '⭐'],
        },
        economy_wallets: { wallet: 5000, bank: 10000 },
        economy_pets: { name: 'Fluffy', pet_type: 'lucky', level: 5, prestige: 1 },
        economy_prestige: { prestige_level: 3, multiplier_pct: 30 },
        economy_user_achievements_count: 7,
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewProfile(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalledOnce();
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });

    it('shows profile for target user', async () => {
      const targetUser = {
        id: 'u2',
        displayName: 'OtherUser',
        displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/other.png'),
        username: 'otheruser',
      };

      supabase = makeSupabase({
        economy_profiles: { profile_views: 0 },
        economy_wallets: { wallet: 100, bank: 200 },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction({ targetUser });
      await mgr.viewProfile(interaction as any);
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });

    it('handles no profile (creates one)', async () => {
      // First call returns null (no profile), second returns created
      const fromMock = vi.fn();
      let profileCalls = 0;
      fromMock.mockImplementation((table: string) => {
        const chain: Record<string, any> = {};
        const methods = ['select', 'eq', 'order', 'limit', 'single', 'insert', 'update', 'maybeSingle'];
        for (const m of methods) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        if (table === 'economy_profiles') {
          profileCalls++;
          if (profileCalls === 1) {
            // getOrCreateProfile -> select returns null
            chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
          } else {
            // insert+select returns new profile
            chain.then = (resolve: (v: any) => void) => resolve({ data: { profile_views: 0 }, error: null });
          }
        } else {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
        }
        (chain as any)[Symbol.toStringTag] = 'Promise';
        return chain;
      });

      mgr = new ProfilesManager({ from: fromMock, rpc: vi.fn().mockResolvedValue({ error: null }) } as any);
      const interaction = makeInteraction();
      await mgr.viewProfile(interaction as any);
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });

    it('handles rpc error for view increment', async () => {
      supabase = makeSupabase({
        economy_profiles: { profile_views: 5 },
      });
      supabase.rpc.mockResolvedValue({ error: { message: 'rpc failed' } });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewProfile(interaction as any);
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });

    it('shows profile without pet or prestige', async () => {
      supabase = makeSupabase({
        economy_profiles: { profile_views: 1 },
        economy_wallets: { wallet: 50, bank: 0 },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewProfile(interaction as any);
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });

    it('shows pet with zero prestige (no star)', async () => {
      supabase = makeSupabase({
        economy_profiles: { profile_views: 0 },
        economy_pets: { name: 'Rex', pet_type: 'guard', level: 3, prestige: 0 },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction();
      await mgr.viewProfile(interaction as any);
      expect(interaction.editReply).toHaveBeenCalledOnce();
    });
  });

  describe('setTitle', () => {
    it('sets profile title', async () => {
      supabase = makeSupabase({
        economy_profiles: { title: null },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction({ title: 'Champion' });
      await mgr.setTitle(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Champion'),
      }));
    });
  });

  describe('setBio', () => {
    it('sets profile bio', async () => {
      supabase = makeSupabase({
        economy_profiles: { bio: null },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction({ bio: 'I love SomniBot!' });
      await mgr.setBio(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('Bio updated'),
      }));
    });

    it('truncates a bio longer than the configured bio_max_length', async () => {
      supabase = makeSupabase({
        guild_config: { bio_max_length: 10 },
        economy_profiles: { bio: null },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction({ bio: 'B'.repeat(50) });
      await mgr.setBio(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('truncated'),
      }));
    });

    it('refuses when profiles are disabled', async () => {
      supabase = makeSupabase({
        guild_config: { profiles_enabled: false },
      });
      mgr = new ProfilesManager(supabase as any);

      const interaction = makeInteraction({ bio: 'hi' });
      await mgr.setBio(interaction as any);
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('disabled'),
      }));
    });

    it('ignores a re-delivered write (same interaction id) — no second confirmation', async () => {
      supabase = makeSupabase({ economy_profiles: { bio: null } });
      mgr = new ProfilesManager(supabase as any);

      const first = makeInteraction({ bio: 'hello' });
      (first as any).id = 'int-replay-1';
      await mgr.setBio(first as any);
      expect(first.reply).toHaveBeenCalledTimes(1);

      // Gateway redelivery: a fresh interaction object carrying the same id.
      const replay = makeInteraction({ bio: 'hello' });
      (replay as any).id = 'int-replay-1';
      await mgr.setBio(replay as any);
      // The replay is fenced: no second confirmation is issued.
      expect(replay.reply).not.toHaveBeenCalled();
    });
  });
});
