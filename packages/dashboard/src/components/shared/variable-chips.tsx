'use client';

/**
 * VariableChips — clickable message-variable buttons.
 *
 * Pages used to list template variables as inert <code> text: the operator had
 * to read {memberNumber}, remember it, retype it into the message box, and get
 * the braces right. Now every variable is a button: clicking inserts it at the
 * cursor of the message field they were just editing (and copies it to the
 * clipboard as well, so it can be pasted elsewhere too).
 *
 * "The field they were just editing" is tracked with one document-level focusin
 * listener: the most recent textarea or text-like input keeps that status even
 * while the click moves focus to the chip — which is exactly the moment we need
 * it.
 *
 * React-controlled inputs ignore direct .value writes (the next render would
 * clobber them), so insertion goes through the native value setter followed by
 * a bubbling `input` event — the same path a real keystroke takes, which lets
 * React's onChange fire and keep state in sync.
 */
import { useCallback, useEffect, useState } from 'react';

export interface VariableDef {
  key: string;
  desc: string;
}

let lastEditable: HTMLTextAreaElement | HTMLInputElement | null = null;
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

function insertIntoLastEditable(text: string): boolean {
  const el = lastEditable;
  if (!el || !el.isConnected) return false;

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

export function VariableChips({ variables }: { variables: VariableDef[] }) {
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    installTracker();
  }, []);

  const onClick = useCallback((key: string) => {
    const inserted = insertIntoLastEditable(key);
    // Copy regardless — harmless when inserted, essential when there was no
    // message box to insert into.
    void navigator.clipboard?.writeText(key).catch(() => { /* clipboard denied */ });
    setFlash(key + (inserted ? ':inserted' : ':copied'));
    setTimeout(() => setFlash(null), 1200);
  }, []);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium text-discord-text-secondary">Variables:</span>
      {variables.map((v) => {
        const state = flash?.startsWith(v.key + ':') ? flash.split(':')[1] : null;
        return (
          <button
            key={v.key}
            type="button"
            title={`${v.desc} — click to insert`}
            onClick={() => onClick(v.key)}
            className={`rounded border px-1.5 py-0.5 font-mono transition-colors ${
              state
                ? 'border-green-500/60 bg-green-500/15 text-green-300'
                : 'border-discord-border bg-discord-bg-tertiary text-discord-text-secondary hover:border-somni-pink hover:text-discord-text-primary'
            }`}
          >
            {state ? (state === 'inserted' ? '✓ inserted' : '✓ copied') : v.key}
          </button>
        );
      })}
    </div>
  );
}
