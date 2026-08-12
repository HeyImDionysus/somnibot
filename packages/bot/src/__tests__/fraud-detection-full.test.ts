/**
 * Fraud Detection — Full coverage tests
 * 
 * Tests every fraud signal: purchase velocity, device abuse, IP mismatch,
 * payment patterns, and critical threshold auto-incident creation.
 * Both positive (signal triggered) and negative (below threshold) paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @somnibot/shared
vi.mock('@somnibot/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@somnibot/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  checkPurchaseVelocity,
  checkDeviceAbuse,
  checkIPMismatch,
  checkPaymentPattern,
  checkCriticalThreshold,
  loadFraudThresholds,
  DEFAULT_FRAUD_THRESHOLDS,
} from '../services/fraud-detection.js';

const TEST_SIGNAL_ID = '11111111-1111-4111-8111-111111111111';

function fraudReceipt(
  args: Record<string, unknown>,
  created = true,
): Record<string, unknown> {
  return {
    signal_id: TEST_SIGNAL_ID,
    created,
    guild_id: args.p_guild_id,
    signal_type: args.p_signal_type,
    entity_type: args.p_entity_type,
    entity_id: args.p_entity_id,
    status: 'open',
    severity: args.p_severity,
  };
}

function mockSupaChain(data: any = null, error: any = null, count: number | null = null) {
  const chain: any = {};
  const methods = [
    'select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte',
    'in','is','or','not','order','limit','range','match','ilike','like','filter',
    'contains','textSearch','head','overlaps',
  ];
  for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error }));
  chain.single = vi.fn(async () => ({ data, error }));
  // Support count queries
  chain.then = undefined;
  // Override to resolve with count
  if (count !== null) {
    // For head:true select calls that return {count}
    for (const m of methods) {
      chain[m] = vi.fn((..._: any[]) => chain);
    }
    chain.select = vi.fn((..._: any[]) => chain);
    chain.eq = vi.fn((..._: any[]) => chain);
    chain.gte = vi.fn((..._: any[]) => chain);
    chain.head = vi.fn((..._: any[]) => chain);
    chain.limit = vi.fn((..._: any[]) => chain);
    chain.not = vi.fn((..._: any[]) => chain);
    // The final awaitable returns {count}
    (chain as any)[Symbol.for('vitest.asyncReturn')] = { data, error, count };
  }
  return chain;
}

function createCtx(fromOverrides: Record<string, any> = {}) {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };

  // Build mock from() chains per table
  const fromMap = new Map<string, any>();

  const supabase = {
    from: vi.fn((table: string) => {
      if (fromMap.has(table)) return fromMap.get(table);
      // Default chain that resolves with no data
      return mockSupaChain(null, null, 0);
    }),
    rpc: vi.fn(async (
      fn: string,
      args?: Record<string, unknown>,
    ): Promise<{ data: unknown; error: unknown }> => {
      if (fn === 'fraud_upsert_open_signal_receipt' && args) {
        return { data: fraudReceipt(args), error: null };
      }
      return { data: 1, error: null };
    }),
  };

  // Allow test to configure specific table responses
  const setTableResponse = (table: string, chain: any) => {
    fromMap.set(table, chain);
  };

  return {
    ctx: { supabase: supabase as any, guildId: 'g1', eventBus: eventBus as any },
    supabase,
    eventBus,
    setTableResponse,
  };
}

// Helper: create a chain that resolves as a count query
function countChain(count: number) {
  const chain: any = {};
  const methods = ['select','eq','neq','gte','lt','lte','in','head','limit','not','or','order'];
  for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
  // The chain itself, when awaited, returns {count}
  chain.then = (resolve: any) => resolve({ count, data: null, error: null });
  return chain;
}

// Helper: create a chain that resolves as a data query
function dataChain(data: any[], error: any = null) {
  const chain: any = {};
  const methods = ['select','eq','neq','gte','lt','lte','in','head','limit','not','or','order','filter'];
  for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
  chain.single = vi.fn(async () => ({ data: data[0] ?? null, error }));
  chain.maybeSingle = vi.fn(async () => ({ data: data[0] ?? null, error }));
  chain.then = (resolve: any) => resolve({ data, error, count: null });
  return chain;
}

// Helper: insert chain that returns data
function insertChain(data: any = null, error: any = null) {
  const chain: any = {};
  const methods = ['select','eq','single','insert'];
  for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
  chain.single = vi.fn(async () => ({ data, error }));
  chain.then = (resolve: any) => resolve({ data, error });
  return chain;
}

describe('checkPurchaseVelocity', () => {
  it('does nothing when order count is below threshold', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(3)); // 3 < 5 threshold

    await checkPurchaseVelocity(ctx, 'cust1', 'discord1');

    // Should only query orders, not persist a fraud signal.
    expect(supabase.from).toHaveBeenCalledWith('orders');
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('creates high severity signal when count equals threshold', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const ordersChain = countChain(5);
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') return ordersChain;
      return countChain(0);
    });

    await checkPurchaseVelocity(ctx, 'cust1', 'discord1');

    expect(supabase.rpc).toHaveBeenCalledWith('fraud_upsert_open_signal_receipt', {
      p_guild_id: 'g1',
      p_signal_type: 'velocity',
      p_severity: 'high',
      p_entity_type: 'customer',
      p_entity_id: 'cust1',
      p_discord_id: 'discord1',
      p_description: '5 orders in the last 60 minutes (threshold: 5)',
      p_evidence: { order_count: 5, window_minutes: 60, threshold: 5 },
      p_auto_action: null,
    });
    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      signal: 'velocity',
      severity: 'high',
    }));
  });

  it('creates critical severity signal when count >= 2x threshold', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const ordersChain = countChain(10); // 10 >= 5*2
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') return ordersChain;
      return countChain(0);
    });

    await checkPurchaseVelocity(ctx, 'cust1', 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      severity: 'critical',
    }));
  });

  it('handles null discord_id', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') return countChain(6);
      return countChain(0);
    });

    await checkPurchaseVelocity(ctx, 'cust1', null);

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      discordId: undefined,
    }));
  });
});

describe('checkDeviceAbuse', () => {
  it('does nothing when total sessions are within 3x limit', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(6)); // 6 <= 3*3 = 9

    await checkDeviceAbuse(ctx, 'key1', 3, 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('creates high severity signal when sessions exceed 3x limit', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'license_sessions') return countChain(10); // 10 > 3*3
      return countChain(0);
    });

    await checkDeviceAbuse(ctx, 'key1', 3, 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      signal: 'device_abuse',
      severity: 'high',
    }));
  });

  it('creates critical severity signal when sessions exceed 5x limit', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'license_sessions') return countChain(16); // 16 > 3*5
      return countChain(0);
    });

    await checkDeviceAbuse(ctx, 'key1', 3, 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      severity: 'critical',
    }));
  });

  it('handles zero count (null) from DB', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(0));

    await checkDeviceAbuse(ctx, 'key1', 5, 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('checkIPMismatch', () => {
  it('does nothing when fewer than 5 unique IPs', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(
      dataChain([
        { ip_address: '1.1.1.1' },
        { ip_address: '1.1.1.1' }, // duplicate
        { ip_address: '2.2.2.2' },
        { ip_address: '3.3.3.3' },
      ]),
    );

    await checkIPMismatch(ctx, 'key1', 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('creates medium severity signal for 5-9 unique IPs', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const sessions = Array.from({ length: 6 }, (_, i) => ({ ip_address: `${i}.0.0.1` }));
    supabase.from.mockImplementation((table: string) => {
      if (table === 'license_sessions') return dataChain(sessions);
      return countChain(0);
    });

    await checkIPMismatch(ctx, 'key1', 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      signal: 'ip_mismatch',
      severity: 'medium',
    }));
  });

  it('creates critical severity signal for 10+ unique IPs', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const sessions = Array.from({ length: 12 }, (_, i) => ({ ip_address: `${i}.0.0.1` }));
    supabase.from.mockImplementation((table: string) => {
      if (table === 'license_sessions') return dataChain(sessions);
      return countChain(0);
    });

    await checkIPMismatch(ctx, 'key1', 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      severity: 'critical',
    }));
  });

  it('filters out null IP addresses', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const sessions = [
      { ip_address: '1.0.0.1' },
      { ip_address: null },
      { ip_address: '2.0.0.1' },
      { ip_address: null },
    ];
    supabase.from.mockReturnValue(dataChain(sessions));

    await checkIPMismatch(ctx, 'key1', 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled(); // only 2 unique IPs
  });

  it('handles empty sessions result', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(dataChain([]));

    await checkIPMismatch(ctx, 'key1', 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('checkPaymentPattern', () => {
  it('does nothing when fewer than 3 failed payments', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(2));

    await checkPaymentPattern(ctx, 'cust1', 'discord1');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('creates medium severity signal for 3-4 failed payments', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return countChain(3);
      return countChain(0);
    });

    await checkPaymentPattern(ctx, 'cust1', 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      signal: 'payment_pattern',
      severity: 'medium',
    }));
  });

  it('creates high severity signal for 5+ failed payments', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return countChain(7);
      return countChain(0);
    });

    await checkPaymentPattern(ctx, 'cust1', 'discord1');

    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      severity: 'high',
    }));
  });
});

describe('fraud signal receipt contract', () => {
  it('does not re-alert when the atomic receipt proves an existing signal was refreshed', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(5));
    supabase.rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'fraud_upsert_open_signal_receipt' && args) {
        return { data: fraudReceipt(args, false), error: null };
      }
      return { data: 1, error: null };
    });

    await checkPurchaseVelocity(ctx, 'cust1', 'discord1');

    expect(supabase.rpc).toHaveBeenCalledWith(
      'fraud_upsert_open_signal_receipt',
      expect.objectContaining({
        p_guild_id: 'g1',
        p_signal_type: 'velocity',
        p_entity_type: 'customer',
        p_entity_id: 'cust1',
      }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'fraud.detected',
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails closed when the receipt RPC returns an error', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(5));
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    });

    await expect(checkPurchaseVelocity(ctx, 'cust1', 'discord1')).resolves.toBeUndefined();

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['scalar', TEST_SIGNAL_ID],
    ['array', [{ signal_id: TEST_SIGNAL_ID }]],
    ['invalid signal id', { signal_id: 'not-a-uuid' }],
    ['non-boolean created flag', { created: 'true' }],
    ['wrong guild', { guild_id: 'g2' }],
    ['wrong signal type', { signal_type: 'payment_pattern' }],
    ['wrong entity type', { entity_type: 'license_key' }],
    ['wrong entity id', { entity_id: 'cust2' }],
    ['wrong status', { status: 'confirmed' }],
    ['wrong created severity', { severity: 'critical' }],
    ['prototype-name severity', { severity: 'toString' }],
    ['weaker refresh severity', { created: false, severity: 'medium' }],
  ])('fails closed for a malformed or identity-mismatched %s receipt', async (_name, patch) => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(5));
    supabase.rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== 'fraud_upsert_open_signal_receipt' || !args) {
        return { data: 1, error: null };
      }
      const data = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
        ? { ...fraudReceipt(args), ...patch }
        : patch;
      return { data, error: null };
    });

    await expect(checkPurchaseVelocity(ctx, 'cust1', 'discord1')).resolves.toBeUndefined();

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('reobserves an old critical row before the critical-burst count', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    let observationRefreshed = false;

    const orders = countChain(10);
    const criticalSignals = countChain(0);
    criticalSignals.then = (resolve: any) => resolve({
      count: observationRefreshed ? 1 : 0,
      data: null,
      error: null,
    });
    const incidentData = { id: 'incident-refresh', title: 'test', incident_number: 1 };
    const incidents: any = dataChain([]);
    incidents.insert = vi.fn(() => {
      const inserted: any = {};
      inserted.select = vi.fn(() => inserted);
      inserted.single = vi.fn(async () => ({ data: incidentData, error: null }));
      return inserted;
    });

    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') return orders;
      if (table === 'fraud_signals') return criticalSignals;
      if (table === 'incidents') return incidents;
      if (table === 'incident_events') return insertChain();
      return countChain(0);
    });
    supabase.rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'fraud_upsert_open_signal_receipt' && args) {
        observationRefreshed = true;
        return { data: fraudReceipt(args, false), error: null };
      }
      if (fn === 'nextval_incident') return { data: 99, error: null };
      return { data: null, error: { message: 'unexpected RPC' } };
    });

    await checkPurchaseVelocity(ctx, 'cust1', 'discord1');
    await checkCriticalThreshold(ctx, { threshold: 1 });

    expect(observationRefreshed).toBe(true);
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'fraud.detected',
      expect.anything(),
      expect.anything(),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'incident.created',
      'g1',
      expect.objectContaining({ incidentId: 'incident-refresh' }),
    );
  });
});

describe('checkCriticalThreshold', () => {
  it('does nothing when fewer than 3 critical signals', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const fraudSignals = countChain(2);
    supabase.from.mockReturnValue(fraudSignals);

    await checkCriticalThreshold(ctx);
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(fraudSignals.gte).toHaveBeenCalledWith('last_observed_at', expect.any(String));
    expect(fraudSignals.gte).not.toHaveBeenCalledWith('created_at', expect.any(String));
    expect(fraudSignals.gte).not.toHaveBeenCalledWith('updated_at', expect.any(String));
  });

  it('does nothing when incident already exists for this burst', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    let callCount = 0;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'fraud_signals') return countChain(5);
      if (table === 'incidents') {
        callCount++;
        if (callCount === 1) {
          // First call: check existing incidents → found one
          return dataChain([{ id: 'inc1' }]);
        }
      }
      return countChain(0);
    });

    await checkCriticalThreshold(ctx);
    // Should not create new incident (existing one found)
    expect(eventBus.emit).not.toHaveBeenCalledWith('incident.created', expect.anything(), expect.anything());
  });

  it('creates auto-incident when 3+ critical signals and no existing incident', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    const incidentData = { id: 'inc-new', title: 'test', incident_number: 1 };
    
    supabase.from.mockImplementation((table: string) => {
      if (table === 'fraud_signals') return countChain(4);
      if (table === 'incidents') {
        const chain: any = {};
        const methods = ['select','eq','not','gte','limit','insert','single'];
        for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
        // First call: check for existing → empty
        chain.then = (resolve: any) => resolve({ data: [], error: null });
        // insert().select().single() returns the new incident
        chain.insert = vi.fn(() => {
          const insertChain: any = {};
          insertChain.select = vi.fn(() => insertChain);
          insertChain.single = vi.fn(async () => ({ data: incidentData, error: null }));
          return insertChain;
        });
        return chain;
      }
      if (table === 'incident_events') return insertChain();
      return countChain(0);
    });
    supabase.rpc.mockResolvedValue({ data: 42, error: null });

    await checkCriticalThreshold(ctx);

    expect(supabase.rpc).toHaveBeenCalledWith('nextval_incident');
    expect(eventBus.emit).toHaveBeenCalledWith('incident.created', 'g1', expect.objectContaining({
      severity: 'critical',
      source: 'fraud_auto',
    }));
  });

  it('works without eventBus', async () => {
    const supabase = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: 1, error: null })),
    };
    const ctx = { supabase: supabase as any, guildId: 'g1' };

    const incidentData = { id: 'inc2', title: 'test', incident_number: 1 };
    supabase.from.mockImplementation((table: string) => {
      if (table === 'fraud_signals') return countChain(3);
      if (table === 'incidents') {
        const chain: any = {};
        const methods = ['select','eq','not','gte','limit','insert','single'];
        for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
        chain.then = (resolve: any) => resolve({ data: [], error: null });
        chain.insert = vi.fn(() => {
          const ic: any = {};
          ic.select = vi.fn(() => ic);
          ic.single = vi.fn(async () => ({ data: incidentData, error: null }));
          return ic;
        });
        return chain;
      }
      if (table === 'incident_events') return insertChain();
      return countChain(0);
    });

    // Should not throw — eventBus?.emit is optional chaining
    await expect(checkCriticalThreshold(ctx as any)).resolves.not.toThrow();
  });

  // Finding: concurrent bursts open duplicate fraud_auto incidents. The partial
  // unique index uniq_open_fraud_auto_incident is the fence; the insert that
  // loses the race gets 23505 and must no-op (no incident.created emitted).
  it('no-ops (no incident.created) when the insert loses the unique race (23505)', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'fraud_signals') return countChain(4);
      if (table === 'incidents') {
        const chain: any = {};
        const methods = ['select','eq','not','gte','limit','insert','single'];
        for (const m of methods) chain[m] = vi.fn((..._: any[]) => chain);
        chain.then = (resolve: any) => resolve({ data: [], error: null });
        chain.insert = vi.fn(() => {
          const ic: any = {};
          ic.select = vi.fn(() => ic);
          ic.single = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'duplicate key value' } }));
          return ic;
        });
        return chain;
      }
      if (table === 'incident_events') return insertChain();
      return countChain(0);
    });
    supabase.rpc.mockResolvedValue({ data: 7, error: null });

    await checkCriticalThreshold(ctx);
    expect(eventBus.emit).not.toHaveBeenCalledWith('incident.created', expect.anything(), expect.anything());
  });

  it('honors a configured critical-incident threshold (no fire below it)', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(4)); // 4 < configured 5
    await checkCriticalThreshold(ctx, { threshold: 5 });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('loadFraudThresholds — config controls are now honored bot-side', () => {
  it('returns catalog defaults when the guild has no fraud_rules', async () => {
    const supabase = { from: vi.fn(() => dataChain([])) };
    const thresholds = await loadFraudThresholds(supabase as any, 'g1');
    expect(thresholds).toEqual(DEFAULT_FRAUD_THRESHOLDS);
  });

  it('applies configured thresholds from enabled fraud_rules rows', async () => {
    const rules = [
      { rule_type: 'velocity_limit', config: { threshold: 2, window_minutes: 30 }, enabled: true },
      { rule_type: 'failed_payment', config: { threshold: 4 }, enabled: true },
      { rule_type: 'device_limit', config: { threshold: 4 }, enabled: true },
      { rule_type: 'ip_mismatch', config: { threshold: 7 }, enabled: true },
      { rule_type: 'critical_incident', config: { threshold: 5 }, enabled: true },
    ];
    const supabase = { from: vi.fn(() => dataChain(rules)) };
    const thresholds = await loadFraudThresholds(supabase as any, 'g1');
    expect(thresholds.velocityThreshold).toBe(2);
    expect(thresholds.velocityWindowMs).toBe(30 * 60_000);
    expect(thresholds.failedPaymentThreshold).toBe(4);
    expect(thresholds.deviceAbuseMultiplier).toBe(4);
    expect(thresholds.ipMismatchThreshold).toBe(7);
    expect(thresholds.criticalIncidentThreshold).toBe(5);
  });
});

describe('checkPurchaseVelocity honors a configured threshold', () => {
  it('raises a velocity signal at the lowered threshold (2nd in-window order)', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') return countChain(2);
      return countChain(0);
    });
    await checkPurchaseVelocity(ctx, 'cust1', 'discord1', { threshold: 2, windowMs: 3_600_000 });
    expect(eventBus.emit).toHaveBeenCalledWith('fraud.detected', 'g1', expect.objectContaining({
      signal: 'velocity',
    }));
  });

  it('does not raise a signal below the configured threshold', async () => {
    const { ctx, supabase, eventBus } = createCtx();
    supabase.from.mockReturnValue(countChain(1));
    await checkPurchaseVelocity(ctx, 'cust1', 'discord1', { threshold: 2 });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
