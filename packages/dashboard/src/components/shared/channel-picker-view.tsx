import type {
  FocusEventHandler,
  KeyboardEventHandler,
  RefObject,
} from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ChannelIcon } from './channel-picker-icon';
import type { DiscordChannel } from './channel-picker-model';
import { ChannelPickerOptions } from './channel-picker-options';

interface ChannelPickerViewProps {
  readonly allowNone: boolean;
  readonly className?: string;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly disabled: boolean;
  readonly error?: string;
  readonly fieldId: string;
  readonly filteredCount: number;
  readonly grouped: Readonly<Record<string, readonly DiscordChannel[]>>;
  readonly hint?: string;
  readonly label?: string;
  readonly listboxRef: RefObject<HTMLDivElement | null>;
  readonly loadError: string | null;
  readonly loading: boolean;
  readonly multi: boolean;
  readonly onBlurCapture: FocusEventHandler<HTMLDivElement>;
  readonly onClear: () => void;
  readonly onOptionKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  readonly onRemove: (id: string) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onSearchKeyDown: KeyboardEventHandler<HTMLInputElement>;
  readonly onSelect: (id: string) => void;
  readonly onToggleOpen: () => void;
  readonly onTriggerKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  readonly open: boolean;
  readonly permissionIssue: (channel: DiscordChannel) => string | null;
  readonly placeholder: string;
  readonly search: string;
  readonly searchRef: RefObject<HTMLInputElement | null>;
  readonly selected: readonly string[];
  readonly selectedChannels: readonly DiscordChannel[];
  readonly selectedIssues: readonly string[];
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly value: string | readonly string[] | null;
}

function selectedSummary(
  selectedChannels: readonly DiscordChannel[],
  multi: boolean,
  loading: boolean,
  placeholder: string,
): string {
  if (selectedChannels.length === 0) return loading ? 'Loading…' : placeholder;
  if (multi) return `${selectedChannels.length} channels selected`;
  return selectedChannels[0]?.name ?? placeholder;
}

export function ChannelPickerView({
  allowNone,
  className,
  containerRef,
  disabled,
  error,
  fieldId,
  filteredCount,
  grouped,
  hint,
  label,
  listboxRef,
  loadError,
  loading,
  multi,
  onBlurCapture,
  onClear,
  onOptionKeyDown,
  onRemove,
  onSearchChange,
  onSearchKeyDown,
  onSelect,
  onToggleOpen,
  onTriggerKeyDown,
  open,
  permissionIssue,
  placeholder,
  search,
  searchRef,
  selected,
  selectedChannels,
  selectedIssues,
  triggerRef,
  value,
}: ChannelPickerViewProps) {
  const triggerId = `${fieldId}-trigger`;
  const labelId = `${fieldId}-label`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const listboxId = `${fieldId}-listbox`;
  const activeError = error ?? loadError;
  const issueIds = selectedIssues.map((_issue, index) => `${fieldId}-selection-error-${index}`);
  const describedBy = [
    hint ? hintId : null,
    activeError ? errorId : null,
    ...issueIds,
  ].filter((id): id is string => id !== null).join(' ') || undefined;
  const invalid = activeError !== undefined && activeError !== null || selectedIssues.length > 0;
  const summary = selectedSummary(selectedChannels, multi, loading, placeholder);

  return (
    <div
      className={cn('space-y-1', className)}
      ref={containerRef}
      onBlurCapture={onBlurCapture}
    >
      {label ? (
        <label
          id={labelId}
          htmlFor={triggerId}
          className="mb-1 block text-xs font-medium text-discord-text-muted"
        >
          {label}
        </label>
      ) : null}
      {hint ? <p id={hintId} className="mb-1 text-xs text-discord-text-muted/70">{hint}</p> : null}

      {multi && selectedChannels.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label="Selected channels">
          {selectedChannels.map((channel) => (
            <span
              key={channel.id}
              className="inline-flex min-h-11 items-center gap-1 rounded bg-discord-bg-secondary pl-2 text-xs text-discord-text-secondary"
            >
              <ChannelIcon type={channel.type} />
              {channel.name}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(channel.id)}
                aria-label={`Remove ${channel.name}`}
                className="inline-flex min-h-11 min-w-11 items-center justify-center text-discord-text-muted hover:text-discord-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'flex w-full items-stretch rounded-input border bg-discord-bg-tertiary text-sm transition-colors',
          open
            ? 'border-discord-accent'
            : invalid
              ? 'border-discord-danger'
              : 'border-discord-border-subtle hover:border-discord-border-strong',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          role="combobox"
          disabled={disabled}
          aria-autocomplete="none"
          aria-controls={listboxId}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : placeholder}
          onClick={onToggleOpen}
          onKeyDown={onTriggerKeyDown}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-input px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent focus-visible:ring-offset-2 focus-visible:ring-offset-discord-bg-primary disabled:cursor-not-allowed"
        >
          {!multi && selectedChannels[0] ? <ChannelIcon type={selectedChannels[0].type} /> : null}
          <span className={cn(
            'min-w-0 flex-1 truncate',
            selectedChannels.length === 0 ? 'text-discord-text-muted/60' : 'text-discord-text-primary',
          )}>
            {summary}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn('shrink-0 text-discord-text-muted transition-transform', open && 'rotate-180')}
          />
        </button>
        {selected.length > 0 ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            aria-label="Clear channel selection"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-input text-discord-text-muted hover:text-discord-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-discord-accent disabled:cursor-not-allowed"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="relative z-50">
          <div className="absolute left-0 right-0 top-1 max-h-64 overflow-hidden rounded-lg border border-discord-border-subtle bg-discord-bg-floating shadow-lg">
            <div className="flex min-h-11 items-center gap-2 border-b border-discord-border-subtle px-3 py-2">
              <Search size={14} className="text-discord-text-muted" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={onSearchKeyDown}
                aria-label="Search channels"
                placeholder="Search channels…"
                className="min-w-0 flex-1 bg-transparent text-sm text-discord-text-primary placeholder:text-discord-text-muted/50 outline-none"
              />
            </div>
            <ChannelPickerOptions
              allowNone={allowNone}
              fieldId={fieldId}
              filteredCount={filteredCount}
              grouped={grouped}
              label={label}
              listboxRef={listboxRef}
              multi={multi}
              onOptionKeyDown={onOptionKeyDown}
              onSelect={onSelect}
              permissionIssue={permissionIssue}
              search={search}
              selected={selected}
              value={value}
            />
          </div>
        </div>
      ) : null}

      {activeError ? <p id={errorId} role="alert" className="text-xs text-discord-danger">{activeError}</p> : null}
      {selectedIssues.map((issue, index) => (
        <p
          key={issue}
          id={issueIds[index]}
          role="alert"
          className="text-xs text-discord-danger"
        >
          {issue}
        </p>
      ))}
    </div>
  );
}
