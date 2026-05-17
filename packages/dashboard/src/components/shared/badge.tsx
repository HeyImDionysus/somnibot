'use client';

import { cn } from '@/lib/utils/cn';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'danger' | 'warning' | 'success' | 'info' | 'pink' | 'cyan' | 'orange';
  className?: string;
}

const variantStyles = {
  default: 'bg-discord-bg-tertiary text-discord-text-muted',
  danger: 'bg-discord-danger/15 text-discord-danger',
  warning: 'bg-discord-warning/15 text-discord-warning',
  success: 'bg-discord-success/15 text-discord-success',
  info: 'bg-discord-accent/15 text-discord-accent',
  pink: 'bg-somni-pink/15 text-somni-pink',
  cyan: 'bg-somni-cyan/15 text-somni-cyan',
  orange: 'bg-somni-orange/15 text-somni-orange',
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
