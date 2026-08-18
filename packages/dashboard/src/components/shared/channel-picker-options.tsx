import type { KeyboardEventHandler, RefObject } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChannelIcon } from './channel-picker-icon';
import type { DiscordChannel } from './channel-picker-model';

interface ChannelPickerOptionsProps {
  readonly allowNone: boolean;
  readonly fieldId: string;
  readonly filteredCount: number;
  readonly grouped: Readonly<Record<string, readonly DiscordChannel[]>>;
  readonly label?: string;
  readonly listboxRef: RefObject<HTMLDivElement | null>;
  readonly multi: boolean;
  readonly onOptionKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  readonly onSelect: (id: string) => void;
  readonly permissionIssue: (channel: DiscordChannel) => string | null;
  readonly search: string;
  readonly selected: readonly string[];
  readonly value: string | readonly string[] | null;
}

export function ChannelPickerOptions({
  allowNone,
  fieldId,
  filteredCount,
  grouped,
  label,
  listboxRef,
  multi,
  onOptionKeyDown,
  onSelect,
  permissionIssue,
  search,
  selected,
  value,
}: ChannelPickerOptionsProps) {
  return (
    <div
      ref={listboxRef}
      id={`${fieldId}-listbox`}
      role="listbox"
      aria-label={label ? `${label} options` : 'Channel options'}
      aria-multiselectable={multi || undefined}
      className="max-h-52 overflow-y-auto py-1"
    >
      {allowNone && !multi ? (
        <button
          type="button"
          role="option"
          data-channel-option="true"
          aria-selected={!value}
          onClick={() => onSelect('')}
          onKeyDown={onOptionKeyDown}
          className={cn(
            'flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
            !value
              ? 'bg-discord-accent/10 text-discord-text-primary'
              : 'text-discord-text-muted hover:bg-discord-bg-tertiary hover:text-discord-text-primary',
          )}
        >
          <span className="italic">None</span>
        </button>
      ) : null}

      {Object.entries(grouped).map(([categoryName, channels], groupIndex) => {
        if (channels.length === 0) return null;
        const categoryId = `${fieldId}-category-${groupIndex}`;
        return (
          <div
            key={categoryName || '__root'}
            role={categoryName ? 'group' : undefined}
            aria-labelledby={categoryName ? categoryId : undefined}
          >
            {categoryName ? (
              <div
                id={categoryId}
                className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-discord-text-muted/60"
              >
                {categoryName}
              </div>
            ) : null}
            {channels.map((channel) => {
              const isSelected = selected.includes(channel.id);
              const issue = permissionIssue(channel);
              return (
                <button
                  key={channel.id}
                  type="button"
                  role="option"
                  data-channel-option="true"
                  aria-disabled={issue !== null || undefined}
                  aria-selected={isSelected}
                  onClick={() => onSelect(channel.id)}
                  onKeyDown={onOptionKeyDown}
                  disabled={issue !== null}
                  title={issue ?? undefined}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
                    issue && 'cursor-not-allowed opacity-50',
                    isSelected
                      ? 'bg-discord-accent/10 text-discord-text-primary'
                      : 'text-discord-text-secondary hover:bg-discord-bg-tertiary hover:text-discord-text-primary',
                  )}
                >
                  <ChannelIcon type={channel.type} />
                  <span className="truncate">{channel.name}</span>
                  {issue ? <span className="ml-auto text-[10px] text-discord-danger">Unavailable</span> : null}
                </button>
              );
            })}
          </div>
        );
      })}

      {filteredCount === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-discord-text-muted">
          {search ? 'No channels match your search' : 'No channels available'}
        </div>
      ) : null}
    </div>
  );
}
