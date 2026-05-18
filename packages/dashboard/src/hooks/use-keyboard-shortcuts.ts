/**
 * useKeyboardShortcuts — Global keyboard shortcuts for operator efficiency.
 *
 * Register shortcuts on mount, clean up on unmount.
 * Skips shortcuts when focused on input/textarea/select elements.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { useEffect, useCallback, useRef } from 'react';

export interface Shortcut {
  /** Key combo: 'ctrl+k', 'shift+n', '/', 'escape', etc. */
  key: string;
  /** Handler */
  handler: () => void;
  /** Description for help modal */
  description?: string;
}

/**
 * Parse a key string like 'ctrl+k' into modifiers + key.
 */
function parseKey(combo: string) {
  const parts = combo.toLowerCase().split('+');
  return {
    ctrl: parts.includes('ctrl') || parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts[parts.length - 1],
  };
}

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handler = useCallback((e: KeyboardEvent) => {
    // Don't intercept when typing in inputs
    if (isInputElement(e.target)) return;

    for (const shortcut of shortcutsRef.current) {
      const parsed = parseKey(shortcut.key);
      const keyMatch = e.key.toLowerCase() === parsed.key;
      const ctrlMatch = parsed.ctrl ? (e.ctrlKey || e.metaKey) : true;
      const shiftMatch = parsed.shift ? e.shiftKey : true;
      const altMatch = parsed.alt ? e.altKey : true;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        // Only prevent default for modified shortcuts (avoid breaking native behavior)
        if (parsed.ctrl || parsed.alt) {
          e.preventDefault();
        }
        shortcut.handler();
        return;
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handler]);
}

// ── Pre-built Dashboard Shortcuts ──────────────────────────

export function useDashboardShortcuts(router: { push: (path: string) => void }) {
  useKeyboardShortcuts([
    { key: 'g', handler: () => router.push('/'), description: 'Go to Dashboard' },
    { key: 'mod+k', handler: () => {
      // Toggle command palette (dispatches custom event for CommandPalette to listen)
      document.dispatchEvent(new CustomEvent('toggle-command-palette'));
    }, description: 'Command Palette' },
    { key: '?', handler: () => {
      document.dispatchEvent(new CustomEvent('toggle-shortcuts-help'));
    }, description: 'Show Keyboard Shortcuts' },
  ]);
}
