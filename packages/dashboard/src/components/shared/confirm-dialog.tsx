/**
 * ConfirmDialog — Confirmation modal for destructive actions.
 * Prevents accidental deletes, cancellations, etc.
 *
 * Usage:
 *   <ConfirmDialog
 *     open={showDelete}
 *     title="Delete Giveaway"
 *     description="This will permanently delete the giveaway and all its entries."
 *     confirmLabel="Delete"
 *     variant="danger"
 *     onConfirm={() => handleDelete(id)}
 *     onCancel={() => setShowDelete(false)}
 *   />
 *
 * GAP 4: Operator UX Polish
 */
'use client';

import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { AlertTriangle, Trash2, X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

const VARIANT_STYLES = {
  danger: {
    icon: Trash2,
    iconColor: 'text-red-400',
    iconBg: 'bg-red-500/20',
    btnColor: 'bg-discord-danger hover:bg-discord-danger/80',
  },
  warning: {
    icon: AlertTriangle,
    iconColor: 'text-yellow-400',
    iconBg: 'bg-yellow-500/20',
    btnColor: 'bg-yellow-600 hover:bg-yellow-500',
  },
  default: {
    icon: AlertTriangle,
    iconColor: 'text-discord-accent',
    iconBg: 'bg-discord-accent/20',
    btnColor: 'bg-discord-accent hover:bg-discord-accent/80',
  },
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;
  const styles = VARIANT_STYLES[variant];
  const Icon = styles.icon;

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => cancelRef.current?.focus());
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-card border border-discord-border-subtle bg-discord-bg-secondary p-5 shadow-xl animate-in zoom-in-95 fade-in duration-200 sm:p-6"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={loading || undefined}
      >
        {/* Icon + Close */}
        <div className="flex items-start justify-between mb-4">
          <div className={cn('rounded-full p-2.5', styles.iconBg)}>
            <Icon size={20} className={styles.iconColor} aria-hidden="true" />
          </div>
          <button
            type="button"
            aria-label="Close confirmation dialog"
            onClick={onCancel}
            disabled={loading}
            className="inline-flex h-11 w-11 items-center justify-center rounded-input text-discord-text-muted transition-standard hover:bg-discord-bg-hover hover:text-discord-text-primary disabled:opacity-50"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <h2
          id={titleId}
          className="text-lg font-semibold text-discord-text-primary mb-1"
        >
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="text-sm text-discord-text-muted mb-6">
            {description}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={loading}
            className="rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50',
              styles.btnColor,
            )}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Processing…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
