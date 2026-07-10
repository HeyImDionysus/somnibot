/**
 * Condition Evaluator — Unit Tests
 *
 * Tests evaluateConditions with mock Discord/Supabase objects.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evaluateConditions,
  createRegexBudget,
  EVENT_REGEX_BUDGET_MS,
  type ConditionContext,
  type AutomationCondition,
} from '../features/automations/condition-evaluator.js';

// ── Helpers ────────────────────────────────────────────────

function makeMember(id: string, roleIds: string[]) {
  return {
    id,
    roles: { cache: { has: (rid: string) => roleIds.includes(rid) } },
  } as any;
}

function makeSupabase(mockData: Record<string, any> = {}) {
  const chainable: any = {};
  chainable.from = () => chainable;
  chainable.select = () => chainable;
  chainable.eq = () => chainable;
  chainable.limit = () => chainable;
  chainable.maybeSingle = async () => ({ data: mockData.data ?? null, error: null });
  chainable.single = async () => ({ data: mockData.data ?? null, error: null });
  return chainable;
}

function makeCtx(overrides: Partial<ConditionContext> = {}): ConditionContext {
  return {
    guild: {} as any,
    member: makeMember('user1', ['role-a', 'role-b']),
    channelId: 'ch-general',
    messageContent: 'hello world',
    guildId: 'guild1',
    supabase: makeSupabase(),
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════

describe('evaluateConditions (AND logic)', () => {
  it('returns true for empty conditions', async () => {
    expect(await evaluateConditions([], makeCtx())).toBe(true);
  });

  it('returns true when all conditions pass', async () => {
    const conditions: AutomationCondition[] = [
      { type: 'has_role', config: { value: 'role-a' } },
      { type: 'in_channel', config: { value: 'ch-general' } },
    ];
    expect(await evaluateConditions(conditions, makeCtx())).toBe(true);
  });

  it('returns false when any condition fails', async () => {
    const conditions: AutomationCondition[] = [
      { type: 'has_role', config: { value: 'role-a' } },
      { type: 'in_channel', config: { value: 'ch-other' } },
    ];
    expect(await evaluateConditions(conditions, makeCtx())).toBe(false);
  });

  it('short-circuits on first failure', async () => {
    const conditions: AutomationCondition[] = [
      { type: 'in_channel', config: { value: 'ch-wrong' } },
      { type: 'has_role', config: { value: 'role-a' } },
    ];
    expect(await evaluateConditions(conditions, makeCtx())).toBe(false);
  });
});

describe('has_role / missing_role', () => {
  it('has_role returns true when member has the role', async () => {
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'role-a' } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('has_role returns false when member lacks the role', async () => {
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'role-z' } }],
      makeCtx(),
    );
    expect(result).toBe(false);
  });

  it('has_role returns false when member is null', async () => {
    const result = await evaluateConditions(
      [{ type: 'has_role', config: { value: 'role-a' } }],
      makeCtx({ member: null }),
    );
    expect(result).toBe(false);
  });

  it('missing_role returns true when member lacks the role', async () => {
    const result = await evaluateConditions(
      [{ type: 'missing_role', config: { value: 'role-z' } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('missing_role returns false when member has the role', async () => {
    const result = await evaluateConditions(
      [{ type: 'missing_role', config: { value: 'role-a' } }],
      makeCtx(),
    );
    expect(result).toBe(false);
  });
});

describe('in_channel / not_in_channel', () => {
  it('in_channel matches', async () => {
    const result = await evaluateConditions(
      [{ type: 'in_channel', config: { value: 'ch-general' } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('in_channel rejects wrong channel', async () => {
    const result = await evaluateConditions(
      [{ type: 'in_channel', config: { value: 'ch-other' } }],
      makeCtx(),
    );
    expect(result).toBe(false);
  });

  it('not_in_channel matches', async () => {
    const result = await evaluateConditions(
      [{ type: 'not_in_channel', config: { value: 'ch-other' } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('not_in_channel rejects current channel', async () => {
    const result = await evaluateConditions(
      [{ type: 'not_in_channel', config: { value: 'ch-general' } }],
      makeCtx(),
    );
    expect(result).toBe(false);
  });
});

describe('message_contains', () => {
  it('matches case-insensitive substring', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_contains', config: { value: 'HELLO' } }],
      makeCtx({ messageContent: 'hello world' }),
    );
    expect(result).toBe(true);
  });

  it('returns false for no match', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_contains', config: { value: 'goodbye' } }],
      makeCtx({ messageContent: 'hello world' }),
    );
    expect(result).toBe(false);
  });

  it('returns false when messageContent is null', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_contains', config: { value: 'test' } }],
      makeCtx({ messageContent: null }),
    );
    expect(result).toBe(false);
  });
});

describe('message_matches_regex', () => {
  it('matches a regex pattern', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '\\d+' } }],
      makeCtx({ messageContent: 'order 12345' }),
    );
    expect(result).toBe(true);
  });

  it('rejects non-matching pattern', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '^\\d+$' } }],
      makeCtx({ messageContent: 'not a number' }),
    );
    expect(result).toBe(false);
  });

  it('handles invalid regex gracefully', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '[broken' } }],
      makeCtx({ messageContent: 'test' }),
    );
    expect(result).toBe(false);
  });

  it('rejects overly long patterns', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: 'a'.repeat(201) } }],
      makeCtx({ messageContent: 'aaa' }),
    );
    expect(result).toBe(false);
  });

  it('returns false when messageContent is null', async () => {
    const result = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '.*' } }],
      makeCtx({ messageContent: null }),
    );
    expect(result).toBe(false);
  });
});

describe('message_matches_regex — per-event regex budget (PR #269)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Simulate regex spend with an injected clock: Date.now returns the given
   * values in call order (last value repeats). The evaluator calls Date.now
   * exactly twice per evaluated regex condition (start + end of the vm run),
   * so the schedule controls the "cost" charged to the budget without real
   * slow patterns.
   */
  function mockClock(schedule: number[]) {
    let call = 0;
    return vi
      .spyOn(Date, 'now')
      .mockImplementation(() => schedule[Math.min(call++, schedule.length - 1)]!);
  }

  it('budget matches the automod per-message budget (500ms)', () => {
    expect(EVENT_REGEX_BUDGET_MS).toBe(500);
  });

  it('evaluates later regex conditions as non-match once the budget is exhausted (fail-closed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // First regex "costs" 600ms (> 500ms budget); the second — which WOULD
    // match — must be skipped as a non-match, failing the AND chain.
    mockClock([0, 600]);
    const budget = createRegexBudget();
    const result = await evaluateConditions(
      [
        { type: 'message_matches_regex', config: { value: '\\d+' } },
        { type: 'message_matches_regex', config: { value: 'order' } },
      ],
      makeCtx({ messageContent: 'order 123', regexBudget: budget }),
    );
    expect(result).toBe(false);
    expect(budget.remainingMs).toBeLessThanOrEqual(0);
    expect(budget.exhaustedLogged).toBe(true);
  });

  it('exhaustion affects only regex conditions — results already obtained and non-regex conditions stand', async () => {
    mockClock([0, 600]);
    const budget = createRegexBudget();
    const result = await evaluateConditions(
      [
        // Matches before the budget runs dry (its own evaluation is never cut short)…
        { type: 'message_matches_regex', config: { value: '\\d+' } },
        // …and non-regex conditions still evaluate normally afterwards.
        { type: 'has_role', config: { value: 'role-a' } },
      ],
      makeCtx({ messageContent: 'order 123', regexBudget: budget }),
    );
    expect(result).toBe(true);
    expect(budget.remainingMs).toBeLessThanOrEqual(0);
  });

  it('creates a fresh budget per call when none is supplied (no cross-event leakage)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockClock([0, 600]);
    // First call exhausts its own implicit budget…
    const first = await evaluateConditions(
      [
        { type: 'message_matches_regex', config: { value: '\\d+' } },
        { type: 'message_matches_regex', config: { value: '\\d+' } },
      ],
      makeCtx({ messageContent: '123' }),
    );
    expect(first).toBe(false);
    // …but a subsequent call (a new event) starts with a full budget.
    const second = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '\\d+' } }],
      makeCtx({ messageContent: '123' }),
    );
    expect(second).toBe(true);
  });

  it('aggregates across evaluateConditions calls sharing one budget and logs exhaustion once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockClock([0, 600]);
    const budget = createRegexBudget();
    // Automation 1 spends the whole event budget (and matches).
    const a1 = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '\\d+' } }],
      makeCtx({ messageContent: '123', regexBudget: budget }),
    );
    // Automations 2 and 3 (same event, same budget) are skipped as non-match.
    const a2 = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '\\d+' } }],
      makeCtx({ messageContent: '123', regexBudget: budget }),
    );
    const a3 = await evaluateConditions(
      [{ type: 'message_matches_regex', config: { value: '\\d+' } }],
      makeCtx({ messageContent: '123', regexBudget: budget }),
    );
    expect(a1).toBe(true);
    expect(a2).toBe(false);
    expect(a3).toBe(false);
    const exhaustionWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('Regex evaluation budget exhausted'),
    );
    expect(exhaustionWarns).toHaveLength(1);
  });
});

describe('time_window', () => {
  it('returns true with no constraints', async () => {
    const result = await evaluateConditions(
      [{ type: 'time_window', config: {} }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('filters by day of week', async () => {
    const today = new Date().getUTCDay();
    const otherDay = (today + 3) % 7; // Ensure different from today

    const resultToday = await evaluateConditions(
      [{ type: 'time_window', config: { days: [today] } }],
      makeCtx(),
    );
    expect(resultToday).toBe(true);

    if (today !== otherDay) {
      const resultOther = await evaluateConditions(
        [{ type: 'time_window', config: { days: [otherDay] } }],
        makeCtx(),
      );
      expect(resultOther).toBe(false);
    }
  });

  it('handles hour range', async () => {
    const hour = new Date().getUTCHours();
    const result = await evaluateConditions(
      [{ type: 'time_window', config: { start_hour: hour, end_hour: hour + 1 } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });
});

describe('user_is', () => {
  it('matches correct user', async () => {
    const result = await evaluateConditions(
      [{ type: 'user_is', config: { value: 'user1' } }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });

  it('rejects wrong user', async () => {
    const result = await evaluateConditions(
      [{ type: 'user_is', config: { value: 'user999' } }],
      makeCtx(),
    );
    expect(result).toBe(false);
  });

  it('returns false when member is null', async () => {
    const result = await evaluateConditions(
      [{ type: 'user_is', config: { value: 'user1' } }],
      makeCtx({ member: null }),
    );
    expect(result).toBe(false);
  });
});

describe('unknown condition type', () => {
  it('returns true (permissive default)', async () => {
    const result = await evaluateConditions(
      [{ type: 'some_future_condition', config: {} }],
      makeCtx(),
    );
    expect(result).toBe(true);
  });
});

describe('min_level / max_level', () => {
  it('min_level passes when level is sufficient', async () => {
    const supabase = makeSupabase({ data: { level: 10 } });
    const result = await evaluateConditions(
      [{ type: 'min_level', config: { value: 5 } }],
      makeCtx({ supabase }),
    );
    expect(result).toBe(true);
  });

  it('min_level fails when level is too low', async () => {
    const supabase = makeSupabase({ data: { level: 3 } });
    const result = await evaluateConditions(
      [{ type: 'min_level', config: { value: 5 } }],
      makeCtx({ supabase }),
    );
    expect(result).toBe(false);
  });

  it('min_level defaults to 0 when no data', async () => {
    const supabase = makeSupabase({ data: null });
    const result = await evaluateConditions(
      [{ type: 'min_level', config: { value: 1 } }],
      makeCtx({ supabase }),
    );
    expect(result).toBe(false);
  });

  it('max_level passes when level is below max', async () => {
    const supabase = makeSupabase({ data: { level: 3 } });
    const result = await evaluateConditions(
      [{ type: 'max_level', config: { value: 5 } }],
      makeCtx({ supabase }),
    );
    expect(result).toBe(true);
  });

  it('max_level fails when level is at or above max', async () => {
    const supabase = makeSupabase({ data: { level: 5 } });
    const result = await evaluateConditions(
      [{ type: 'max_level', config: { value: 5 } }],
      makeCtx({ supabase }),
    );
    expect(result).toBe(false);
  });
});
