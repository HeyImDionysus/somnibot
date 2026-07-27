'use client';

/**
 * VariableChips — clickable message-variable buttons.
 *
 * Pages used to list template variables as inert <code> text: the operator had
 * to read {memberNumber}, remember it, retype it into the message box, and get
 * the braces right. Now every variable is a button: clicking inserts it at the
 * cursor of the field the chips belong to (and copies it to the clipboard as
 * well, so it can be pasted elsewhere too).
 *
 * Which field the chips "belong to" is resolved in strict order:
 * 1. An explicit `targetRef` — the caller bound the chips to one field, and
 *    they never write anywhere else.
 * 2. Containment fallback — the most recently focused text field, but only if
 *    it lives inside the chips' own section (the nearest section-like ancestor
 *    of the chip row, or its direct parent when the page has none). The old
 *    behavior — a module-wide "last focused input anywhere on the page" —
 *    happily inserted a welcome variable into an unrelated settings field.
 * 3. Otherwise the click is copy-to-clipboard only, and the feedback says
 *    "copied", never "inserted".
 *
 * The last-focused field is tracked with one document-level focusin listener:
 * the most recent textarea or text-like input keeps that status even while the
 * click moves focus to the chip — which is exactly the moment we need it.
 *
 * React-controlled inputs ignore direct .value writes (the next render would
 * clobber them), so insertion goes through the native value setter followed by
 * a bubbling `input` event — the same path a real keystroke takes, which lets
 * React's onChange fire and keep state in sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface VariableDef {
  key: string;
  desc: string;
}

export type EditableElement = HTMLTextAreaElement | HTMLInputElement;

let lastEditable: EditableElement | null = null;
let trackerInstalled = false;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', '']);

function installTracker(): void {
  if (trackerInstalled || typeof document === 'undefined') return;
  trackerInstalled = true;
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement) {
        lastEditable = t;
      } else if (t instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(t.type)) {
        lastEditable = t;
      }
    },
    true,
  );
}

/**
 * Section boundary for the containment fallback. Pages that group settings in
 * semantic containers get scoped there; pages built from plain divs fall back
 * to the chip row's direct parent — which, in every current call site, is the
 * wrapper holding the chips' own field (or holds no field at all, making the
 * chips copy-only, e.g. reference-only variable lists).
 */
const SCOPE_BOUNDARY = 'section, form, fieldset, [role="dialog"]';

/**
 * Decide where a chip click may insert. Returns null for copy-only clicks.
 * Exported for unit tests.
 */
export function resolveInsertionTarget(
  container: HTMLElement | null,
  bound: { readonly current: EditableElement | null } | undefined,
  lastFocused: EditableElement | null,
): EditableElement | null {
  // An explicit binding is exclusive: when the bound field is not mounted the
  // click degrades to copy — it never drifts to some other input.
  if (bound) {
    return bound.current && bound.current.isConnected ? bound.current : null;
  }
  if (!lastFocused || !lastFocused.isConnected || !container) return null;
  const scope =
    (container.closest(SCOPE_BOUNDARY) as HTMLElement | null) ?? container.parentElement;
  return scope && scope.contains(lastFocused) ? lastFocused : null;
}

function insertIntoEditable(el: EditableElement, text: string): boolean {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);

  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return false;

  setter.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));

  el.focus();
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  return true;
}

export function VariableChips({
  variables,
  targetRef,
}: {
  variables: VariableDef[];
  /** Bind the chips to exactly one field; omit to use the containment fallback. */
  targetRef?: { readonly current: EditableElement | null };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    installTracker();
  }, []);

  const onClick = useCallback((key: string) => {
    const target = resolveInsertionTarget(containerRef.current, targetRef, lastEditable);
    const inserted = target !== null && insertIntoEditable(target, key);
    // Copy regardless — harmless when inserted, essential when there was no
    // message box to insert into.
    void navigator.clipboard?.writeText(key).catch(() => { /* clipboard denied */ });
    setFlash(key + (inserted ? ':inserted' : ':copied'));
    setTimeout(() => setFlash(null), 1200);
  }, [targetRef]);

  return (
    <div ref={containerRef} className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium text-discord-text-secondary">Variables:</span>
      {variables.map((v) => {
        const state = flash?.startsWith(v.key + ':') ? flash.split(':')[1] : null;
        return (
          <button
            key={v.key}
            type="button"
            title={`${v.desc} — click to insert or copy`}
            onClick={() => onClick(v.key)}
            className={`rounded border px-1.5 py-0.5 font-mono transition-colors ${
              state
                ? 'border-green-500/60 bg-green-500/15 text-green-300'
                : 'border-discord-border-subtle bg-discord-bg-tertiary text-discord-text-secondary hover:border-somni-pink hover:text-discord-text-primary'
            }`}
          >
            {state ? (state === 'inserted' ? '✓ inserted' : '✓ copied') : v.key}
          </button>
        );
      })}
    </div>
  );
}
