/**
 * VariableChips insertion-target resolution (P2 batch, B7).
 *
 * Chips must never insert into an unrelated field. Priority:
 * 1. explicit targetRef (exclusive — degrades to copy when unmounted)
 * 2. containment fallback: last-focused editable, only inside the chips' own
 *    section (nearest section-like ancestor, else the chip row's parent)
 * 3. null → copy-to-clipboard only
 *
 * The resolver only touches closest/parentElement/contains/isConnected, so
 * structural fakes exercise it without a DOM environment.
 */
import { describe, it, expect } from 'vitest';

import { resolveInsertionTarget, type EditableElement } from '@/components/shared/variable-chips';

function fakeEditable(overrides: Partial<{ isConnected: boolean }> = {}): EditableElement {
  return { isConnected: true, ...overrides } as unknown as EditableElement;
}

function fakeContainer(options: {
  scope?: { contains: (el: unknown) => boolean } | null;
  parent?: { contains: (el: unknown) => boolean } | null;
}): HTMLElement {
  return {
    closest: () => options.scope ?? null,
    parentElement: options.parent ?? null,
  } as unknown as HTMLElement;
}

describe('resolveInsertionTarget', () => {
  it('prefers a connected bound ref over everything else', () => {
    const bound = fakeEditable();
    const lastFocused = fakeEditable();
    const container = fakeContainer({ scope: { contains: () => true } });

    expect(resolveInsertionTarget(container, { current: bound }, lastFocused)).toBe(bound);
  });

  it('is exclusive when bound: an unmounted target means copy-only, never another field', () => {
    const lastFocused = fakeEditable();
    const container = fakeContainer({ scope: { contains: () => true } });

    expect(resolveInsertionTarget(container, { current: null }, lastFocused)).toBeNull();
    expect(
      resolveInsertionTarget(container, { current: fakeEditable({ isConnected: false }) }, lastFocused),
    ).toBeNull();
  });

  it('falls back to the last-focused editable only when the section contains it', () => {
    const inside = fakeEditable();
    const containerYes = fakeContainer({ scope: { contains: (el) => el === inside } });
    const containerNo = fakeContainer({ scope: { contains: () => false } });

    expect(resolveInsertionTarget(containerYes, undefined, inside)).toBe(inside);
    expect(resolveInsertionTarget(containerNo, undefined, inside)).toBeNull();
  });

  it('uses the chip row parent as scope when no section-like ancestor exists', () => {
    const sibling = fakeEditable();
    const container = fakeContainer({ scope: null, parent: { contains: (el) => el === sibling } });
    const referenceOnly = fakeContainer({ scope: null, parent: { contains: () => false } });

    expect(resolveInsertionTarget(container, undefined, sibling)).toBe(sibling);
    // Reference-only variable lists (no editable in their block) are copy-only.
    expect(resolveInsertionTarget(referenceOnly, undefined, sibling)).toBeNull();
  });

  it('returns null for missing, disconnected, or unscopeable candidates', () => {
    const container = fakeContainer({ scope: { contains: () => true } });

    expect(resolveInsertionTarget(container, undefined, null)).toBeNull();
    expect(
      resolveInsertionTarget(container, undefined, fakeEditable({ isConnected: false })),
    ).toBeNull();
    expect(resolveInsertionTarget(null, undefined, fakeEditable())).toBeNull();
    expect(
      resolveInsertionTarget(fakeContainer({ scope: null, parent: null }), undefined, fakeEditable()),
    ).toBeNull();
  });
});
