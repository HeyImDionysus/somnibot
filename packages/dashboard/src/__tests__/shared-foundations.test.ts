import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { Input } from '@/components/shared/input';
import { ConfigSkeleton } from '@/components/shared/loading-skeleton';

const { createElement, Fragment } = React;

beforeAll(() => {
  vi.stubGlobal('React', React);
});

describe('Shared dashboard accessibility foundations', () => {
  it('associates input labels and field errors with a generated control id', () => {
    // Given: a labeled invalid field with existing help text.
    // When: the shared input is rendered without a caller-provided id.
    const markup = renderToStaticMarkup(createElement(Input, {
      label: 'Server name',
      error: 'Enter a server name.',
      'aria-describedby': 'server-name-help',
    }));

    // Then: the control exposes both the existing help and its field error.
    const inputId = markup.match(/<input[^>]*\sid="([^"]+)"/)?.[1];
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(inputId).toBeTruthy();
    expect(markup).toContain(`for="${inputId}"`);
    expect(markup).toContain('aria-invalid="true"');
    expect(describedBy?.split(' ')).toContain('server-name-help');
    expect(markup).toContain(`id="${describedBy?.split(' ')[1]}"`);
  });

  it('renders each confirmation with unique conditional relationships and a named close control', () => {
    // Given: two open confirmation dialogs, only one with a description.
    // When: they are rendered in the same React tree.
    const markup = renderToStaticMarkup(createElement(Fragment, null,
      createElement(ConfirmDialog, {
        open: true,
        title: 'Delete giveaway',
        description: 'This cannot be undone.',
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
      createElement(ConfirmDialog, {
        open: true,
        title: 'Archive workflow',
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    ));

    // Then: their labels do not collide, absent descriptions are not referenced,
    // and each icon-only close button has an accessible name.
    const titleIds = [...markup.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    const descriptionIds = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(titleIds).size).toBe(2);
    expect(descriptionIds).toHaveLength(1);
    for (const titleId of titleIds) expect(markup).toContain(`id="${titleId}"`);
    expect(markup.match(/aria-label="Close confirmation dialog"/g)).toHaveLength(2);
  });

  it('announces empty and loading states without exposing decorative shapes', () => {
    // Given: the shared empty and loading states.
    // When: both are rendered.
    const emptyMarkup = renderToStaticMarkup(createElement(EmptyState, {
      title: 'No scheduled messages',
      description: 'Create one to send an update later.',
    }));
    const loadingMarkup = renderToStaticMarkup(createElement(ConfigSkeleton));

    // Then: each state is programmatically announced while visual-only shapes
    // stay out of the accessibility tree.
    expect(emptyMarkup).toContain('role="status"');
    expect(emptyMarkup).toContain('aria-hidden="true"');
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('Loading configuration');
    expect(loadingMarkup).toContain('aria-hidden="true"');
  });

  it('renders a recoverable error alert without exposing the thrown message', () => {
    // Given: a dashboard section that threw an internal error.
    const boundary = new ErrorBoundary({ children: null, section: 'Licensing' });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('private provider detail'));

    // When: the boundary renders its recovery state.
    const markup = renderToStaticMarkup(boundary.render());

    // Then: assistive technology receives the alert and retry action without
    // leaking the internal error string.
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Retry');
    expect(markup).toContain('The Licensing section encountered an error.');
    expect(markup).not.toContain('private provider detail');
  });
});
