/**
 * ErrorBoundary — Catches render errors in any child component tree
 * so a crash in one page/component doesn't take down the entire dashboard.
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional fallback component */
  fallback?: ReactNode;
  /** Name of the section for logging */
  section?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[ErrorBoundary${this.props.section ? `: ${this.props.section}` : ''}] Caught error:`,
      error,
      errorInfo,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex min-h-[300px] flex-col items-center justify-center rounded-card border border-discord-danger/30 bg-discord-danger/5 p-8 text-center"
        >
          <AlertTriangle aria-hidden="true" className="mb-4 h-10 w-10 text-discord-danger" />
          <h2 className="mb-2 text-lg font-semibold text-discord-text-primary">
            Something went wrong
          </h2>
          <p className="mb-1 text-sm text-discord-text-muted">
            {this.props.section
              ? `The ${this.props.section} section encountered an error.`
              : 'This section encountered an error.'}
          </p>
          <p className="mb-4 max-w-md text-xs text-discord-text-muted/70">
            Retry the section. If it fails again, reload the dashboard and check diagnostics.
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="flex items-center gap-2 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white hover:bg-discord-accent/80 transition-colors"
          >
            <RefreshCw aria-hidden="true" size={14} />
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
