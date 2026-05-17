'use client';

import { cn } from '@/lib/utils/cn';
import { type ButtonHTMLAttributes, forwardRef } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

const variantStyles = {
  primary: 'bg-discord-accent text-white hover:bg-discord-accent/90',
  secondary: 'bg-discord-bg-tertiary text-discord-text-primary hover:bg-discord-bg-primary/80',
  danger: 'bg-discord-danger text-white hover:bg-discord-danger/90',
  success: 'bg-discord-success text-white hover:bg-discord-success/90',
  ghost: 'text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary',
};

const sizeStyles = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-1.5 text-sm',
  lg: 'px-5 py-2.5 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-input font-medium transition-standard',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent',
          variantStyles[variant],
          sizeStyles[size],
          disabled && 'cursor-not-allowed opacity-50',
          className,
        )}
        disabled={disabled}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';
