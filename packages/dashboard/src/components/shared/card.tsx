'use client';

import { cn } from '@/lib/utils/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'danger' | 'warning' | 'success';
}

// A default card sits ON a content pane, so it uses the ELEVATED tier — one
// step lighter than the pane behind it. It previously used `bg-secondary`, the
// same grey as the sidebar, which left cards indistinguishable from their
// background. Elevation carries the separation now, so the hairline border is
// gone from the default variant; the status variants keep a tinted border
// because there the border colour IS the signal.
const variantStyles = {
  default: 'bg-discord-bg-elevated',
  danger: 'border border-discord-danger/30 bg-discord-danger/10',
  warning: 'border border-discord-warning/30 bg-discord-warning/10',
  success: 'border border-discord-success/30 bg-discord-success/10',
};

export function Card({ children, className, variant = 'default' }: CardProps) {
  return (
    <div className={cn('rounded-card p-5', variantStyles[variant], className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-4 flex items-center justify-between', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  // Discord's UI tops out at weight 500. `font-semibold` (600) is a large part
  // of why every heading read as heavy and cramped.
  return (
    <h3 className={cn('font-medium text-discord-text-primary', className)}>
      {children}
    </h3>
  );
}

export function CardDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-discord-text-muted">{children}</p>;
}
