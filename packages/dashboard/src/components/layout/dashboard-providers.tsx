/**
 * DashboardProviders — Client-side providers for the dashboard layout.
 * Wraps children with ToastProvider and ErrorBoundary.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { type ReactNode } from 'react';
import { ToastProvider } from '@/components/shared/toast';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export function DashboardProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ErrorBoundary section="Dashboard">
        {children}
      </ErrorBoundary>
    </ToastProvider>
  );
}
