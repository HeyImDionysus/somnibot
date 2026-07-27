'use client';

import { cn } from '@/lib/utils/cn';
import { type ButtonHTMLAttributes, forwardRef } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

// Blurple hover goes to Discord's own darker blurple rather than an opacity
// step. Fading a solid fill toward the page behind it washes it out; Discord
// darkens instead, which keeps the button feeling solid under the cursor.
const variantStyles = {
  primary: 'bg-discord-accent text-white hover:bg-discord-accent-hover',
  secondary: 'bg-discord-bg-active text-discord-text-primary hover:bg-discord-border-strong',
  danger: 'bg-discord-danger text-white hover:bg-discord-danger/80',
  success: 'bg-discord-success text-white hover:bg-discord-success/80',
  ghost: 'text-discord-text-secondary hover:bg-discord-bg-hover hover:text-discord-text-primary',
};

// Discord's controls are 32/38/44px tall. The old scale bottomed out around
// 24px, which is what made every toolbar feel cramped and hard to hit.
const sizeStyles = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-[38px] px-4 text-sm',
  lg: 'h-11 px-5 text-base',
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
