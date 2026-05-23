/**
 * Action Executor — Unit Tests
 *
 * Tests template variable resolution and action execution flow.
 */
import { describe, it, expect } from 'vitest';

// ── Inline: resolveVars (from action-executor.ts) ──────────

function resolveVars(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(
      new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'),
      value,
    );
  }
  return result;
}

// ── Inline: executeActions flow logic ──────────────────────

interface ActionResult {
  success: boolean;
  error?: string;
}

interface AutomationAction {
  type: string;
  config: Record<string, unknown>;
}

const MAX_ACTIONS = 10;

async function executeActions(
  actions: AutomationAction[],
  handler: (a: AutomationAction) => Promise<ActionResult>,
): Promise<{ executed: number; failed: number; errors: string[] }> {
  let executed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const action of actions) {
    if (executed + failed >= MAX_ACTIONS) {
      errors.push(`Action limit reached (${MAX_ACTIONS})`);
      break;
    }

    try {
      const result = await handler(action);
      if (result.success) {
        executed++;
      } else {
        failed++;
        if (result.error) errors.push(`${action.type}: ${result.error}`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${action.type}: ${msg}`);
    }
  }

  return { executed, failed, errors };
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

describe('resolveVars', () => {
  it('replaces simple variables', () => {
    expect(resolveVars('Hello {user}!', { user: 'Alice' })).toBe('Hello Alice!');
  });

  it('replaces multiple occurrences', () => {
    expect(resolveVars('{x} and {x}', { x: 'yes' })).toBe('yes and yes');
  });

  it('replaces multiple different variables', () => {
    expect(resolveVars('{a} + {b} = {c}', { a: '1', b: '2', c: '3' })).toBe('1 + 2 = 3');
  });

  it('leaves unmatched placeholders as-is', () => {
    expect(resolveVars('Hello {user}', {})).toBe('Hello {user}');
  });

  it('handles empty template', () => {
    expect(resolveVars('', { user: 'Alice' })).toBe('');
  });

  it('handles empty variables', () => {
    expect(resolveVars('Hello', {})).toBe('Hello');
  });

  it('handles special regex characters in keys', () => {
    expect(resolveVars('{user.name}', { 'user.name': 'Alice' })).toBe('Alice');
  });

  it('handles values with special characters', () => {
    expect(resolveVars('{msg}', { msg: 'Hello $100!' })).toBe('Hello $100!');
  });
});

describe('executeActions', () => {
  it('counts successful actions', async () => {
    const actions: AutomationAction[] = [
      { type: 'send_message', config: {} },
      { type: 'add_role', config: {} },
    ];
    const result = await executeActions(actions, async () => ({ success: true }));
    expect(result.executed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('counts failed actions', async () => {
    const actions: AutomationAction[] = [
      { type: 'send_message', config: {} },
      { type: 'add_role', config: {} },
    ];
    const result = await executeActions(actions, async () => ({
      success: false,
      error: 'Channel not found',
    }));
    expect(result.executed).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.errors).toHaveLength(2);
  });

  it('captures exception errors', async () => {
    const actions: AutomationAction[] = [{ type: 'kaboom', config: {} }];
    const result = await executeActions(actions, async () => {
      throw new Error('Boom!');
    });
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('Boom!');
  });

  it('stops at MAX_ACTIONS limit', async () => {
    const actions = Array.from({ length: 15 }, (_, i) => ({
      type: `action_${i}`,
      config: {},
    }));
    const result = await executeActions(actions, async () => ({ success: true }));
    expect(result.executed).toBe(MAX_ACTIONS);
    expect(result.errors).toContain(`Action limit reached (${MAX_ACTIONS})`);
  });

  it('handles empty action list', async () => {
    const result = await executeActions([], async () => ({ success: true }));
    expect(result.executed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('continues after individual failures', async () => {
    let callCount = 0;
    const actions: AutomationAction[] = [
      { type: 'fail', config: {} },
      { type: 'success', config: {} },
    ];
    const result = await executeActions(actions, async (a) => {
      callCount++;
      return a.type === 'success' ? { success: true } : { success: false, error: 'nope' };
    });
    expect(callCount).toBe(2);
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(1);
  });
});
