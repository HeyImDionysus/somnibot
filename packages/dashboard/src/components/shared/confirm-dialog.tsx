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

import { useEffect, useRef } from 'react';
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
  const styles = VARIANT_STYLES[variant];
  const Icon = styles.icon;

  // Focus cancel button on open (safer default)
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => cancelRef.current?.focus());
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-discord-border-subtle bg-discord-bg-secondary p-6 shadow-xl animate-in zoom-in-95 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
      >
        {/* Icon + Close */}
        <div className="flex items-start justify-between mb-4">
          <div className={cn('rounded-full p-2.5', styles.iconBg)}>
            <Icon size={20} className={styles.iconColor} />
          </div>
          <button
            onClick={onCancel}
            className="text-discord-text-muted hover:text-discord-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <h2
          id="confirm-title"
          className="text-lg font-semibold text-discord-text-primary mb-1"
        >
          {title}
        </h2>
        {description && (
          <p id="confirm-desc" className="text-sm text-discord-text-muted mb-6">
            {description}
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={loading}
            className="rounded-md bg-discord-bg-tertiary px-4 py-2 text-sm font-medium text-discord-text-secondary hover:bg-discord-bg-primary/50 transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50',
              styles.btnColor,
            )}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
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
