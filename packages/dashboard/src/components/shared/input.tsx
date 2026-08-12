'use client';

import { cn } from '@/lib/utils/cn';
import { type InputHTMLAttributes, forwardRef, useId } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? `${generatedId}-input`;
    const errorId = `${generatedId}-error`;
    const descriptionIds = [describedBy, error ? errorId : undefined].filter(Boolean).join(' ');
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : invalid}
          aria-describedby={descriptionIds || undefined}
          className={cn(
            'w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary',
            'border border-transparent placeholder:text-discord-text-muted/60',
            'focus:border-discord-accent focus:outline-none',
            error && 'border-discord-danger',
            className,
          )}
          {...props}
        />
        {error && <p id={errorId} className="text-xs text-discord-danger">{error}</p>}
      </div>
    );
  },
);

Input.displayName = 'Input';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, options, className, id, ...props }: SelectProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-discord-text-muted">
          {label}
        </label>
      )}
      <select
        id={id}
        className={cn(
          'w-full rounded-input bg-discord-bg-tertiary px-3 py-2 text-sm text-discord-text-primary',
          'border border-transparent focus:border-discord-accent focus:outline-none',
          className,
        )}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, description, checked, onChange, disabled }: ToggleProps) {
  return (
    <label className={cn('flex items-center justify-between gap-3', disabled && 'opacity-50')}>
      <div>
        <p className="text-sm font-medium text-discord-text-primary">{label}</p>
        {description && <p className="text-xs text-discord-text-muted">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-standard',
          checked ? 'bg-discord-success' : 'bg-discord-bg-tertiary',
          disabled && 'cursor-not-allowed',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-white transition-standard',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </label>
  );
}
