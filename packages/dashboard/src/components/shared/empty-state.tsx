/**
 * EmptyState — Consistent empty state for pages and sections.
 * Shows an icon, heading, description, and optional action button.
 */
'use client';

import { type LucideIcon, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-6' : 'py-16',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-2xl bg-discord-bg-tertiary/60',
          compact ? 'mb-3 h-10 w-10' : 'mb-4 h-14 w-14',
        )}
      >
        <Icon
          aria-hidden="true"
          size={compact ? 20 : 28}
          className="text-discord-text-muted/60"
        />
      </div>
      <h3
        className={cn(
          'font-semibold text-discord-text-primary',
          compact ? 'text-sm mb-1' : 'text-lg mb-1',
        )}
      >
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            'text-discord-text-muted max-w-sm',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {description}
        </p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            'mt-4 rounded-md bg-discord-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-discord-accent/80',
            compact && 'mt-3 px-3 py-1.5 text-xs',
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
