'use client';

import { cn } from '@/lib/utils/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'danger' | 'warning' | 'success';
}

const variantStyles = {
  default: 'border-discord-border-subtle bg-discord-bg-secondary',
  danger: 'border-discord-danger/30 bg-discord-danger/5',
  warning: 'border-discord-warning/30 bg-discord-warning/5',
  success: 'border-discord-success/30 bg-discord-success/5',
};

export function Card({ children, className, variant = 'default' }: CardProps) {
  return (
    <div className={cn('rounded-card border p-4', variantStyles[variant], className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={cn('font-semibold text-discord-text-primary', className)}>
      {children}
    </h3>
  );
}

export function CardDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-discord-text-muted">{children}</p>;
}
