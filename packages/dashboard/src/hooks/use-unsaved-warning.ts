/**
 * useUnsavedWarning — warns users when they try to navigate away with unsaved changes.
 *
 * Uses the browser's `beforeunload` event to show a native "unsaved changes" dialog.
 * Also works with Next.js client-side navigation via `next/navigation`.
 *
 * Usage:
 *   const [dirty, setDirty] = useState(false);
 *   useUnsavedWarning(dirty);
 */
'use client';

import { useEffect } from 'react';

export function useUnsavedWarning(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore custom messages but still show a generic dialog
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      return e.returnValue;
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
}
