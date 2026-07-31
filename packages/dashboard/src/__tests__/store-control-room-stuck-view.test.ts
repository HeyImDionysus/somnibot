/**
 * The stuck-row visibility contract of the store control room.
 *
 * This is the logic behind review finding 3689245842: the stuck list was
 * hard-capped at 20 rows with no way to reach the rest, so the summary could
 * count stuck customers the operator could not see or repair. The behaviour
 * now lives in `stuckRowView` precisely so it can be asserted as plain logic —
 * the earlier claim that this repair was untestable without React DOM
 * infrastructure was wrong; only the RENDERING needed a browser, the contract
 * never did.
 */
import { describe, expect, it } from 'vitest';
import {
  STUCK_ROW_DEFAULT_LIMIT,
  stuckRowView,
} from '../components/store/store-control-room';

function rows(stuckCount: number, healthyCount: number) {
  return [
    ...Array.from({ length: stuckCount }, (_, i) => ({ id: `stuck-${i}`, stuck: true })),
    ...Array.from({ length: healthyCount }, (_, i) => ({ id: `ok-${i}`, stuck: false })),
  ];
}

describe('stuckRowView', () => {
  it('caps the collapsed view at the readable default', () => {
    const view = stuckRowView(rows(35, 5), false);

    expect(view.visible).toHaveLength(STUCK_ROW_DEFAULT_LIMIT);
    // The total still tells the truth about what the cap is hiding.
    expect(view.total).toBe(35);
  });

  it('shows EVERY stuck row when expanded — the hard cap is gone', () => {
    const view = stuckRowView(rows(35, 5), true);

    expect(view.visible).toHaveLength(35);
    expect(view.visible.map((row) => row.id)).toContain('stuck-34');
  });

  it('never includes healthy rows in either view', () => {
    for (const showAll of [false, true]) {
      const view = stuckRowView(rows(3, 40), showAll);
      expect(view.visible.every((row) => row.stuck)).toBe(true);
      expect(view.visible).toHaveLength(3);
    }
  });

  it('keeps the expander threshold and the summary count consistent', () => {
    // At exactly the limit there is nothing hidden, so no expander is owed.
    expect(stuckRowView(rows(STUCK_ROW_DEFAULT_LIMIT, 0), false).total)
      .toBe(STUCK_ROW_DEFAULT_LIMIT);
    // One past the limit, the collapsed view hides exactly one row and the
    // total names it.
    const oneOver = stuckRowView(rows(STUCK_ROW_DEFAULT_LIMIT + 1, 0), false);
    expect(oneOver.visible).toHaveLength(STUCK_ROW_DEFAULT_LIMIT);
    expect(oneOver.total).toBe(STUCK_ROW_DEFAULT_LIMIT + 1);
  });
});
