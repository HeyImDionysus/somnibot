/**
 * Audit page constants (E-A / E-B).
 *
 * Every category actually written to audit_logs (event rail EVENT_TO_AUDIT,
 * bot writeAuditLog callers, dashboard service-role writers) must be present
 * in the filter dropdown and carry its own badge color — previously 13
 * written categories fell through to the gray 'system' fallback and were
 * unfilterable. Both direct-rail actor types (discord/dashboard) must render
 * a real icon instead of the ❓ fallback.
 */
import { describe, it, expect } from 'vitest';
import { CATEGORIES, ACTOR_ICONS, CATEGORY_COLORS } from '@/app/(dashboard)/audit/audit-constants';

/** The full set of category values written across the three rails. */
const WRITTEN_CATEGORIES = [
  // Event rail (bot AuditService EVENT_TO_AUDIT)
  'members', 'moderation', 'tickets', 'commerce', 'subscriptions', 'levels',
  'giveaways', 'sync', 'system', 'economy', 'music', 'polls', 'predictions',
  'temp_channels', 'scheduled_messages', 'starboard', 'stats_channels',
  'custom_commands', 'diagnostics', 'automations', 'webhooks',
  // Direct rail additions (services/audit.ts callers)
  'profiles', 'rbac',
  // Dashboard service-role rail
  'incidents',
];

describe('audit page CATEGORIES', () => {
  it('offers a filter option for every written category', () => {
    const values = CATEGORIES.map((c) => c.value);
    for (const category of WRITTEN_CATEGORIES) {
      expect(values, `missing filter option for '${category}'`).toContain(category);
    }
  });

  it('keeps the all-categories default first', () => {
    expect(CATEGORIES[0]).toEqual({ value: '', label: 'All Categories' });
  });

  it('has a non-empty label and no duplicates', () => {
    const values = CATEGORIES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
    for (const c of CATEGORIES) expect(c.label.length).toBeGreaterThan(0);
  });
});

describe('audit page CATEGORY_COLORS', () => {
  it('styles every filterable category (no gray fallback for real categories)', () => {
    for (const c of CATEGORIES) {
      if (c.value === '') continue;
      expect(CATEGORY_COLORS[c.value], `missing color for '${c.value}'`).toBeTruthy();
    }
  });

  it('keeps the system fallback used by the row renderer', () => {
    expect(CATEGORY_COLORS.system).toContain('gray');
  });
});

describe('audit page ACTOR_ICONS', () => {
  it('covers the event-rail union AND the direct-rail actor types', () => {
    for (const actor of ['user', 'bot', 'system', 'webhook', 'automation', 'discord', 'dashboard']) {
      expect(ACTOR_ICONS[actor], `missing icon for actor '${actor}'`).toBeTruthy();
    }
  });
});
