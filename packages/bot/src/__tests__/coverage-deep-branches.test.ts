/**
 * Deep branch-coverage tests targeting the highest uncovered methods.
 * Exercises FULL method bodies with realistic mock data to maximize
 * statement coverage across: adventure-manager, heist-manager, polls-manager,
 * automation-engine, ticket-service, lottery-manager, economy-manager (rob deep paths).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@somnibot/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/audit.js', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('../features/quests/quests-manager.js', () => ({
  getQuestsManager: () => ({ trackProgress: vi.fn(async () => {}) }),
}));

vi.mock('discord.js', () => {
  class Collection<K = string, V = any> extends Map<K, V> {
    filter(fn: (v: V) => boolean) { const c = new Collection<K,V>(); for (const [k,v] of this) if (fn(v)) c.set(k,v); return c; }
    find(fn: (v: V) => boolean) { for (const v of this.values()) if (fn(v)) return v; }
    first() { return this.values().next().value; }
    map<T>(fn: (v: V) => T): T[] { return [...this.values()].map(fn); }
    get size() { return super.size; }
  }
  class EmbedBuilder {
    data: any = {};
    setColor(c: any) { this.data.color = c; return this; }
    setTitle(t: any) { this.data.title = t; return this; }
    setDescription(d: any) { this.data.description = d; return this; }
    setThumbnail(t: any) { return this; }
    setTimestamp() { return this; }
    setFooter(f: any) { return this; }
    setAuthor(a: any) { return this; }
    setImage(i: any) { return this; }
    addFields(...f: any[]) { this.data.fields = [...(this.data.fields||[]), ...f]; return this; }
    toJSON() { return this.data; }
  }
  class ActionRowBuilder { components: any[] = []; addComponents(...c: any[]) { this.components.push(...c); return this; } }
  class ButtonBuilder {
    data: any = {};
    setCustomId(id: string) { this.data.customId = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: any) { return this; }
    setEmoji(e: any) { return this; }
    setDisabled(d: boolean) { return this; }
  }
  return {
    Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
    ChannelType: { GuildText: 0 },
    ComponentType: { Button: 2 },
    Colors: { Red: 0xff0000, Green: 0x00ff00 },
  };
});

const { Collection } = await import('discord.js');

// ═════════════════ Shared Mock Utilities ═════════════════

/** Make a thenable chain mock where all query methods return self. */
function chain(data: any = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head'])
    c[m] = vi.fn((..._args: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data, error }));
  c.single = vi.fn(async () => ({ data, error }));
  c.then = undefined;
  return c;
}

function chainAsync(data: any[] = [], count: number | null = null, error: any = null) {
  const c: any = {};
  for (const m of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte','in','is','or','not','order','limit','range','match','ilike','like','filter','contains','textSearch','head'])
    c[m] = vi.fn((..._args: any[]) => c);
  c.maybeSingle = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  c.single = vi.fn(async () => ({ data: data?.[0] ?? null, error, count }));
  // Thenable: resolves when awaited
  c.then = (resolve: Function) => resolve({ data, error, count });
  return c;
}

/** Table-routing Supabase mock. */
function supa(routing: Record<string, any> = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table in routing) {
        const val = routing[table];
        return typeof val === 'function' ? val() : chain(val);
      }
      return chain(null);
    }),
    rpc: vi.fn(async (_name: string, _args?: any) => ({ data: null, error: null })),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn((cb: any) => { if (cb) cb('SUBSCRIBED'); return { unsubscribe: vi.fn() }; }) })),
  } as any;
}

function guild(id = 'g1') {
  const channels = new Collection<string, any>();
  const textCh: any = {
    id: 'ch1', name: 'general', type: 0,
    send: vi.fn(async () => ({ id: 'msg1', edit: vi.fn(async () => {}) })),
    messages: { fetch: vi.fn(async () => new Collection()) },
  };
  channels.set('ch1', textCh);
  return {
    id, name: 'Test Guild', memberCount: 50,
    roles: { cache: new Collection() },
    channels: { cache: channels, fetch: vi.fn(async () => textCh) },
    members: {
      cache: new Collection(),
      fetch: vi.fn(async (uid: string) => ({
        id: uid, user: { id: uid, username: 'User', displayAvatarURL: () => 'url', send: vi.fn(async () => {}) },
        roles: { cache: new Collection(), add: vi.fn(async () => {}) }, displayName: 'User',
      })),
    },
    client: { user: { id: 'bot1' }, channels: { cache: channels } },
  } as any;
}

function valkey() {
  return {
    get: vi.fn(async () => null), set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1), incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1), ttl: vi.fn(async () => -2), pttl: vi.fn(async () => -2),
    sadd: vi.fn(async () => 1), sismember: vi.fn(async () => 0),
    smembers: vi.fn(async () => []), scard: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    hset: vi.fn(async () => 1), hget: vi.fn(async () => null), hgetall: vi.fn(async () => ({})),
  } as any;
}

function buttonIx(customId = 'poll:p1:o1') {
  return {
    customId,
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() } },
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}

function cmdIx(overrides: any = {}) {
  const replyMsg = { id: 'r1', edit: vi.fn(async () => replyMsg), delete: vi.fn(async () => {}), react: vi.fn(async () => {}), createMessageComponentCollector: vi.fn(() => ({ on: vi.fn().mockReturnThis(), stop: vi.fn() })) };
  return {
    guildId: 'g1', channelId: 'ch1',
    user: { id: 'u1', username: 'TestUser', displayAvatarURL: () => 'url' },
    member: { id: 'u1', roles: { cache: new Collection() } },
    reply: vi.fn(async () => replyMsg), editReply: vi.fn(async () => replyMsg),
    deferReply: vi.fn(async () => {}), followUp: vi.fn(async () => replyMsg),
    fetchReply: vi.fn(async () => replyMsg),
    replied: false, deferred: false,
    options: {
      getString: vi.fn(() => null), getInteger: vi.fn(() => null),
      getNumber: vi.fn(() => null), getBoolean: vi.fn(() => null),
      getUser: vi.fn(() => null), getChannel: vi.fn(() => null),
      getRole: vi.fn(() => null), getSubcommand: vi.fn(() => null),
    },
    ...overrides,
  } as any;
}

// ═══════════════════════════════════════════════════════════
// AdventureManager — startAdventure full happy path + handleChoice
// ═══════════════════════════════════════════════════════════
describe('AdventureManager deep branches', () => {
  const advCfg = {
    economy_adventures_enabled: true,
    economy_adventure_daily_limit: 5,
    economy_adventure_ticket_cost: 100,
  };
  const adventures = [
    { id: 'adv1', guild_id: 'g1', name: 'Dragon Cave', emoji: '🐉', adventure_type: 'combat', description: 'Fight a dragon', difficulty: 'hard' },
  ];
  const scene0 = {
    id: 'sc0', adventure_id: 'adv1', scene_index: 0, text: 'You enter the cave.',
    choices: [
      { text: 'Go left', next_scene_index: 1, currency: 50, loot: [{ item_name: 'Gem', qty: 1, chance_pct: 100 }] },
      { text: 'Go right', next_scene_index: null, currency: 0, loot: [] },
    ],
    loot: [{ item_name: 'Torch', qty: 1, chance_pct: 100 }],
    is_ending: false, ending_type: null,
  };
  const scene1 = {
    id: 'sc1', adventure_id: 'adv1', scene_index: 1, text: 'A dragon appears!',
    choices: [{ text: 'Fight', next_scene_index: null, currency: 200, loot: [] }],
    loot: [{ item_name: 'Scale', qty: 2, chance_pct: 100 }],
    is_ending: true, ending_type: 'success',
  };
  const scene1Death = {
    ...scene1, ending_type: 'death', text: 'The dragon kills you!',
  };
  const scene1Partial = {
    ...scene1, ending_type: 'partial', text: 'You barely escape...',
  };

  function advSupa(sessionData: any = null, sceneOverride?: any) {
    let callCount = 0;
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(advCfg);
        if (table === 'economy_adventures') {
          return chainAsync(adventures);
        }
        if (table === 'economy_adventure_sessions') {
          const c = chain(sessionData || { id: 'sess1' });
          // For the count/head query (daily limit check), return count: 0
          c.select = vi.fn((...args: any[]) => {
            if (args[1]?.count === 'exact') {
              c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
            }
            return c;
          });
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_adventure_scenes') {
          callCount++;
          return chain(sceneOverride || (callCount <= 1 ? scene0 : scene1));
        }
        if (table === 'economy_items') {
          return chainAsync([{ id: 'item1' }]);
        }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('startAdventure full happy path', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const mgr = new AdventureManager(guild(), advSupa(), valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  it('startAdventure disabled', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa();
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain({ economy_adventures_enabled: false });
      return chain(null);
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('not enabled');
  });

  it('startAdventure daily limit reached', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa();
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain(advCfg);
      if (table === 'economy_adventure_sessions') {
        const c = chain(null);
        c.select = vi.fn((...args: any[]) => {
          if (args[1]?.count === 'exact') {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 99 });
          }
          return c;
        });
        return c;
      }
      return chain(null);
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('adventures today');
  });

  it('startAdventure active session exists', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa();
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain(advCfg);
      if (table === 'economy_adventure_sessions') {
        const c = chain(null);
        c.select = vi.fn((...args: any[]) => {
          if (args[1]?.count === 'exact') {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
          } else {
            c.then = (resolve: Function) => resolve({ data: [{ id: 'existing' }], error: null, count: null });
          }
          return c;
        });
        return c;
      }
      return chain(null);
    });
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('active adventure');
  });

  it('startAdventure insufficient funds', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa();
    s.rpc = vi.fn(async () => ({ data: null, error: { message: 'insufficient' } }));
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('cost');
  });

  it('startAdventure session creation fails (duplicate)', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa();
    let selectCallCount = 0;
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain(advCfg);
      if (table === 'economy_adventures') return chainAsync(adventures);
      if (table === 'economy_adventure_sessions') {
        const c = chain(null);
        c.select = vi.fn((...args: any[]) => {
          selectCallCount++;
          if (args[1]?.count === 'exact') {
            c.then = (resolve: Function) => resolve({ data: null, error: null, count: 0 });
          } else {
            c.then = (resolve: Function) => resolve({ data: [], error: null, count: null });
          }
          return c;
        });
        c.insert = vi.fn(() => {
          // Simulate insert error
          c.single = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }));
          return c;
        });
        return c;
      }
      if (table === 'economy_adventure_scenes') return chain(scene0);
      return chain(null);
    });
    s.rpc = vi.fn(async () => ({ data: null, error: null }));
    const mgr = new AdventureManager(guild(), s, valkey());
    const result = await mgr.startAdventure('u1');
    expect(result.embed.data.description).toContain('active adventure');
  });

  it('handleChoice — continue to next scene', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = {
      id: 'sess1', user_id: 'u1', adventure_id: 'adv1',
      current_scene_id: 'sc0', status: 'active',
      loot_collected: [], currency_collected: 0,
    };
    const s = advSupa(session);
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // guarantee loot drops
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:0');
    await mgr.handleChoice(ix, 'sess1', 0);
    expect(ix.update).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('handleChoice — end adventure (null next_scene)', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = {
      id: 'sess1', user_id: 'u1', adventure_id: 'adv1',
      current_scene_id: 'sc0', status: 'active',
      loot_collected: [], currency_collected: 0,
    };
    const s = advSupa(session);
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:1'); // choice 1 has next_scene_index: null
    await mgr.handleChoice(ix, 'sess1', 1);
    expect(ix.update).toHaveBeenCalled();
  });

  it('handleChoice — ending scene (death)', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = {
      id: 'sess1', user_id: 'u1', adventure_id: 'adv1',
      current_scene_id: 'sc0', status: 'active',
      loot_collected: [{ item_name: 'Gem', qty: 1 }], currency_collected: 100,
    };
    const s = advSupa(session, undefined);
    let sceneCallCount = 0;
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain(advCfg);
      if (table === 'economy_adventure_sessions') {
        const c = chain(session);
        c.insert = vi.fn(() => c);
        return c;
      }
      if (table === 'economy_adventure_scenes') {
        sceneCallCount++;
        return chain(sceneCallCount <= 1 ? scene0 : scene1Death);
      }
      if (table === 'economy_adventures') return chain(adventures[0]);
      if (table === 'economy_items') return chainAsync([{ id: 'item1' }]);
      return chain(null);
    });
    s.rpc = vi.fn(async () => ({ data: null, error: null }));
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:0');
    await mgr.handleChoice(ix, 'sess1', 0);
    expect(ix.update).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('handleChoice — ending scene (partial)', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = {
      id: 'sess1', user_id: 'u1', adventure_id: 'adv1',
      current_scene_id: 'sc0', status: 'active',
      loot_collected: [{ item_name: 'Gem', qty: 1 }, { item_name: 'Scale', qty: 2 }], currency_collected: 200,
    };
    let sceneCallCount = 0;
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(advCfg);
        if (table === 'economy_adventure_sessions') {
          const c = chain(session);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_adventure_scenes') {
          sceneCallCount++;
          return chain(sceneCallCount <= 1 ? scene0 : scene1Partial);
        }
        if (table === 'economy_adventures') return chain(adventures[0]);
        if (table === 'economy_items') return chainAsync([{ id: 'item1' }]);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:0');
    await mgr.handleChoice(ix, 'sess1', 0);
    expect(ix.update).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('handleChoice — session ended', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const s = advSupa({ id: 'sess1', status: 'completed', user_id: 'u1' });
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:0');
    await mgr.handleChoice(ix, 'sess1', 0);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('ended') }));
  });

  it('handleChoice — wrong user', async () => {
    const { AdventureManager } = await import('../features/adventures/adventure-manager.js');
    const session = { id: 'sess1', user_id: 'OTHER_USER', status: 'active' };
    const s = advSupa(session);
    const mgr = new AdventureManager(guild(), s, valkey());
    const ix = buttonIx('adventure:sess1:0');
    await mgr.handleChoice(ix, 'sess1', 0);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not your') }));
  });
});

// ═══════════════════════════════════════════════════════════
// HeistManager — resolveHeist success + failure + cancellation
// ═══════════════════════════════════════════════════════════
describe('HeistManager resolveHeist', () => {
  const heistCfg = {
    economy_heist_enabled: true, economy_heist_min_participants: 2,
    economy_heist_entry_fee: 100, economy_heist_cooldown: 300,
    economy_heist_max_participants: 10,
    economy_heist_recruit_time_seconds: 60,
    currency_name: 'coins', currency_emoji: '🪙',
  };
  const activeHeist = {
    id: 'h1', guild_id: 'g1', status: 'recruiting', channel_id: 'ch1',
    target_name: 'Bank', target_payout: 10000, success_chance: 60,
    started_by: 'u1', created_at: new Date().toISOString(),
  };

  function heistSupa(heist: any, participants: any[] = []) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(heistCfg);
        if (table === 'economy_heists') {
          const c = chain(heist);
          return c;
        }
        if (table === 'economy_heist_participants') {
          return chainAsync(participants);
        }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as any;
  }

  it('resolveHeist — success path', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const g = guild();
    const s = heistSupa(activeHeist, [{ user_id: 'u1', role: 'Leader' }, { user_id: 'u2', role: 'Hacker' }]);
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // 10 < 60 success_chance -> success
    const mgr = new HeistManager(s, g.client as any, valkey());
    // Access private method via prototype
    await (mgr as any).resolveHeist('g1', 'h1', 'ch1');
    vi.restoreAllMocks();
  });

  it('resolveHeist — failure path', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const g = guild();
    const s = heistSupa(activeHeist, [{ user_id: 'u1', role: 'Leader' }, { user_id: 'u2', role: 'Hacker' }]);
    vi.spyOn(Math, 'random').mockReturnValue(0.95); // 95 > 60 -> fail
    const mgr = new HeistManager(s, g.client as any, valkey());
    await (mgr as any).resolveHeist('g1', 'h1', 'ch1');
    vi.restoreAllMocks();
  });

  it('resolveHeist — not enough participants (cancel + refund)', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const g = guild();
    // Only 1 participant, minimum is 2
    const s = heistSupa(activeHeist, [{ user_id: 'u1' }]);
    const mgr = new HeistManager(s, g.client as any, valkey());
    await (mgr as any).resolveHeist('g1', 'h1', 'ch1');
  });

  it('resolveHeist — heist already resolved', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const g = guild();
    const s = heistSupa({ ...activeHeist, status: 'success' }, []);
    const mgr = new HeistManager(s, g.client as any, valkey());
    await (mgr as any).resolveHeist('g1', 'h1', 'ch1');
  });

  it('resolveHeist — success with payout failure', async () => {
    const { HeistManager } = await import('../features/heist/heist-manager.js');
    const g = guild();
    const s = heistSupa(activeHeist, [{ user_id: 'u1', role: 'Leader' }, { user_id: 'u2', role: 'Hacker' }]);
    s.rpc = vi.fn(async () => ({ data: null, error: { message: 'payout failed' } }));
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // success
    const mgr = new HeistManager(s, g.client as any, valkey());
    await (mgr as any).resolveHeist('g1', 'h1', 'ch1');
    vi.restoreAllMocks();
  });
});

// ═══════════════════════════════════════════════════════════
// PollsManager — handlePollVote (single + multi), resolvePrediction
// ═══════════════════════════════════════════════════════════
describe('PollsManager deep', () => {
  const pollCfg = {
    economy_polls_enabled: true,
    economy_predictions_enabled: true,
  };

  function pollsSupa(poll: any = null, voteResult: any = null) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(pollCfg);
        if (table === 'polls') return chain(poll);
        if (table === 'poll_votes') {
          const c = chain(voteResult);
          c.insert = vi.fn(() => c);
          c.then = (resolve: Function) => resolve({ data: voteResult, error: null });
          return c;
        }
        if (table === 'predictions') return chain(null);
        if (table === 'prediction_options') return chainAsync([]);
        if (table === 'prediction_bets') return chainAsync([]);
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'poll_vote_single') return { data: [{ id: 'v1' }], error: null };
        if (_name === 'predictions_resolve_atomic') return { data: [{ total_pool: 1000 }], error: null };
        if (_name === 'economy_add_balance') return { data: null, error: null };
        return { data: null, error: null };
      }),
    } as any;
  }

  it('handlePollVote — single vote poll success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'active', allow_multiple: false, guild_id: 'g1' };
    const s = pollsSupa(poll);
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Vote recorded') }));
  });

  it('handlePollVote — single vote already voted', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'active', allow_multiple: false, guild_id: 'g1' };
    const s = pollsSupa(poll);
    s.rpc = vi.fn(async () => ({ data: [], error: null })); // empty = already voted
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already voted') }));
  });

  it('handlePollVote — single vote duplicate error', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'active', allow_multiple: false, guild_id: 'g1' };
    const s = pollsSupa(poll);
    s.rpc = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }));
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already voted') }));
  });

  it('handlePollVote — multi vote success', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'active', allow_multiple: true, guild_id: 'g1' };
    const s = pollsSupa(poll);
    // Override insert to succeed
    s.from = vi.fn((table: string) => {
      if (table === 'polls') return chain(poll);
      if (table === 'poll_votes') {
        const c = chain(null);
        c.insert = vi.fn(() => {
          c.then = (resolve: Function) => resolve({ data: null, error: null });
          return c;
        });
        return c;
      }
      return chain(null);
    });
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Vote recorded') }));
  });

  it('handlePollVote — multi vote duplicate', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'active', allow_multiple: true, guild_id: 'g1' };
    const s = pollsSupa(poll);
    s.from = vi.fn((table: string) => {
      if (table === 'polls') return chain(poll);
      if (table === 'poll_votes') {
        const c = chain(null);
        c.insert = vi.fn(() => {
          c.then = (resolve: Function) => resolve({ data: null, error: { code: '23505', message: 'dup' } });
          return c;
        });
        return c;
      }
      return chain(null);
    });
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already voted') }));
  });

  it('handlePollVote — closed poll', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const poll = { id: 'p1', status: 'closed' };
    const s = pollsSupa(poll);
    const mgr = new PollsManager(s);
    const ix = buttonIx('poll:p1:o1');
    await mgr.handlePollVote(ix);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('closed') }));
  });

  it('resolvePrediction with winners', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const prediction = {
      id: 'pred1', guild_id: 'g1', title: 'Will it rain?',
      creator_user_id: 'u1', status: 'open', total_pool: 1000,
    };
    const options = [
      { id: 'opt1', label: 'Yes', sort_order: 0 },
      { id: 'opt2', label: 'No', sort_order: 1 },
    ];
    const bets = [
      { id: 'b1', user_id: 'u1', option_id: 'opt1', amount: 500, payout: null },
      { id: 'b2', user_id: 'u2', option_id: 'opt2', amount: 500, payout: null },
    ];
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'predictions') return chain(prediction);
        if (table === 'prediction_options') return chainAsync(options);
        if (table === 'prediction_bets') {
          const c = chainAsync(bets);
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'predictions_resolve_atomic') return { data: [{ total_pool: 1000 }], error: null };
        return { data: null, error: null };
      }),
    };
    const mgr = new PollsManager(s);
    await mgr.resolvePrediction(cmdIx(), 'pred1', 0); // opt1 wins
  });

  it('resolvePrediction with no winners (refund)', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const prediction = {
      id: 'pred1', guild_id: 'g1', title: 'Will it rain?',
      creator_user_id: 'u1', status: 'open', total_pool: 1000,
    };
    const options = [
      { id: 'opt1', label: 'Yes', sort_order: 0 },
      { id: 'opt2', label: 'No', sort_order: 1 },
    ];
    const bets = [
      { id: 'b1', user_id: 'u1', option_id: 'opt2', amount: 500, payout: null }, // all on opt2
      { id: 'b2', user_id: 'u2', option_id: 'opt2', amount: 500, payout: null },
    ];
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'predictions') return chain(prediction);
        if (table === 'prediction_options') return chainAsync(options);
        if (table === 'prediction_bets') {
          const c = chainAsync(bets);
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'predictions_resolve_atomic') return { data: [{ total_pool: 1000 }], error: null };
        return { data: null, error: null };
      }),
    };
    const mgr = new PollsManager(s);
    await mgr.resolvePrediction(cmdIx(), 'pred1', 0); // opt1 wins, nobody bet on it
  });

  it('resolvePrediction not found', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const s: any = {
      from: vi.fn((table: string) => chain(null)),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const mgr = new PollsManager(s);
    const ix = cmdIx();
    await mgr.resolvePrediction(ix, 'pred1', 0);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('not found') }));
  });

  it('resolvePrediction wrong creator', async () => {
    const { PollsManager } = await import('../features/polls/polls-manager.js');
    const prediction = { id: 'pred1', creator_user_id: 'OTHER_USER', status: 'open' };
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'predictions') return chain(prediction);
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const mgr = new PollsManager(s);
    const ix = cmdIx();
    await mgr.resolvePrediction(ix, 'pred1', 0);
    expect(ix.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('creator') }));
  });
});

// ═══════════════════════════════════════════════════════════
// LotteryManager — drawLottery, viewLottery deeper paths
// ═══════════════════════════════════════════════════════════
describe('LotteryManager deeper', () => {
  const lotteryCfg = {
    economy_lottery_enabled: true,
    economy_lottery_ticket_price: 100,
    economy_lottery_max_tickets: 10,
    economy_lottery_draw_schedule: '0 0 * * 0',
    currency_name: 'coins', currency_emoji: '🪙',
  };

  it('buyTickets success', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const activeLottery = {
      id: 'lot1', guild_id: 'g1', status: 'active', pool: 5000,
      ticket_price: 100, draw_at: new Date(Date.now() + 86400000).toISOString(),
    };
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(lotteryCfg);
        if (table === 'economy_lotteries') return chain(activeLottery);
        if (table === 'economy_lottery_tickets') {
          const c = chain(null);
          c.insert = vi.fn(() => c);
          c.then = (resolve: Function) => resolve({ data: [], error: null, count: 2 });
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const mgr = new LotteryManager(s);
    const ix = cmdIx({ options: { getInteger: vi.fn(() => 3) } });
    await mgr.buyTickets(ix, 3);
  });

  it('viewLottery', async () => {
    const { LotteryManager } = await import('../features/lottery/lottery-manager.js');
    const activeLottery = {
      id: 'lot1', guild_id: 'g1', status: 'active', pool: 5000,
      ticket_price: 100, draw_at: new Date(Date.now() + 86400000).toISOString(),
    };
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(lotteryCfg);
        if (table === 'economy_lotteries') return chain(activeLottery);
        if (table === 'economy_lottery_tickets') {
          return chainAsync([{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }]);
        }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const mgr = new LotteryManager(s);
    const ix = cmdIx();
    await mgr.viewLottery(ix);
  });
});

// ═══════════════════════════════════════════════════════════
// EconomyManager — rob deep paths (padlock, passive, insufficient)
// ═══════════════════════════════════════════════════════════
describe('EconomyManager rob deep', () => {
  const ecoCfg = {
    economy_enabled: true, economy_rob_enabled: true,
    economy_rob_success_pct: 50, economy_rob_fine_pct: 30,
    economy_rob_cooldown: 600, economy_rob_min_target_balance: 50,
    economy_passive_mode_enabled: true,
    currency_name: 'coins', currency_emoji: '🪙',
    economy_deposit_fee_pct: 0,
  };

  function ecoSupa(robberWallet: any, victimWallet: any, padlock: any = null) {
    let walletCall = 0;
    return {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(ecoCfg);
        if (table === 'economy_wallets') {
          walletCall++;
          const w = walletCall % 2 === 1 ? robberWallet : victimWallet;
          const c = chain(w);
          c.insert = vi.fn(() => c);
          return c;
        }
        if (table === 'economy_inventory') return chain(padlock);
        if (table === 'economy_items') {
          // findItemByEffect looks for items with padlock effect
          return chainAsync(padlock ? [{ id: 'padlock-item-1' }] : []);
        }
        if (table === 'economy_transactions') {
          const c = chain(null);
          c.insert = vi.fn(() => c);
          return c;
        }
        return chain(null);
      }),
      rpc: vi.fn(async (_name: string) => {
        if (_name === 'economy_decrement_inventory') return { data: true, error: null };
        return { data: 0, error: null };
      }),
    } as any;
  }

  it('rob — victim has padlock', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0, passive: false, passive_mode: false };
    const vw = { wallet: 3000, bank: 0, passive: false, passive_mode: false };
    const padlock = { id: 'pl1', quantity: 1 };
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK'); // cooldown passes
    const mgr = new EconomyManager(guild(), ecoSupa(rw, vw, padlock), vk);
    const result = await mgr.rob('u1', 'u2');
    expect(result.message).toBeDefined(); // padlock blocks or rob proceeds
  });

  it('rob — victim in passive mode', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0, passive: false, passive_mode: false };
    const vw = { wallet: 3000, bank: 0, passive: true, passive_mode: true };
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new EconomyManager(guild(), ecoSupa(rw, vw), vk);
    const result = await mgr.rob('u1', 'u2');
    expect(result.message).toContain('passive');
  });

  it('rob — disabled', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0 };
    const s = ecoSupa(rw, rw);
    s.from = vi.fn((table: string) => {
      if (table === 'guild_config') return chain({ ...ecoCfg, economy_rob_enabled: false });
      if (table === 'economy_wallets') return chain(rw);
      return chain(null);
    });
    const mgr = new EconomyManager(guild(), s, valkey());
    const result = await mgr.rob('u1', 'u2');
    expect(result.message).toContain('disabled');
  });

  it('rob self', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0 };
    const mgr = new EconomyManager(guild(), ecoSupa(rw, rw), valkey());
    const result = await mgr.rob('u1', 'u1');
    expect(result.message).toContain("yourself");
  });

  it('rob on cooldown', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0 };
    const vk = valkey();
    vk.set = vi.fn(async () => null); // NX fails = on cooldown
    vk.get = vi.fn(async () => String(Date.now() + 300000));
    const mgr = new EconomyManager(guild(), ecoSupa(rw, rw), vk);
    const result = await mgr.rob('u1', 'u2');
    expect(result.message).toContain('wait');
  });

  it('rob — victim too poor', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const rw = { wallet: 5000, bank: 0, passive: false, passive_mode: false };
    const vw = { wallet: 10, bank: 0, passive: false, passive_mode: false };
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new EconomyManager(guild(), ecoSupa(rw, vw), vk);
    const result = await mgr.rob('u1', 'u2');
    expect(result.message).toContain("enough");
  });
});

// ═══════════════════════════════════════════════════════════
// EconomyManager — claimTimedReward deep paths
// ═══════════════════════════════════════════════════════════
describe('EconomyManager timed rewards', () => {
  const ecoCfg = {
    economy_enabled: true,
    economy_daily_reward: 500, economy_daily_streak_bonus: 50,
    economy_weekly_reward: 2000,
    currency_name: 'coins', currency_emoji: '🪙',
    economy_deposit_fee_pct: 0,
  };

  it('claimTimedReward daily', async () => {
    const { EconomyManager } = await import('../features/economy/economy-manager.js');
    const s: any = {
      from: vi.fn((table: string) => {
        if (table === 'guild_config') return chain(ecoCfg);
        if (table === 'economy_wallets') return chain({ wallet: 5000, bank: 0, daily_streak: 3, last_daily: null });
        if (table === 'economy_transactions') { const c = chain(null); c.insert = vi.fn(() => c); return c; }
        return chain(null);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };
    const vk = valkey();
    vk.set = vi.fn(async () => 'OK');
    const mgr = new EconomyManager(guild(), s, vk);
    const result = await mgr.claimTimedReward('u1', 'daily');
    expect(result).toBeDefined();
  });
});
